# 告警管理 (Alert Management)

> 版本：v3.0 | 日期：2026-09-24
>
> **v3.0 变更摘要**：在 v2.0 骨架上补齐「通知」「恢复」「静默」三块此前只有骨架的设计，并修正 v2.0 遗留的两处实质缺陷。
>
> 1. **AM 零配置化（DEC-037）**：Alertmanager 收缩为「去重 + resolved 检测」两项职责，**不持有任何用户可配置的策略**。删除控制面板→AM 的策略下发链路与平台→AM 的 silence 回调；AM config 退化为部署期静态模板。DEC-033 的「双向清理」相应改为**单向清理**（只清 Flink 状态）。
> 2. **算子链重排（DEC-037）**：屏蔽算子从 stage 3 前移到 stage 2 并改为**纯 broadcast、无 keyed state**——原位置在去重之后，广播式屏蔽规则永远拿不到事件；抑制算子前移到恢复延迟之前，保证 resolved 能及时摘除活跃根因；`inhibit_released` 走侧输出直达输出算子。
> 3. **通知策略全部落平台侧（DEC-034）**：新增 `notification_scheduler`（PG 扫描 + `SKIP LOCKED`）承担重复通知与自动升级；升级策略收敛到 `escalation_policy` **唯一权威**（原散在三处）；渠道强度由**升级级别**而非 severity 决定；三级「重复通知」语义显式分离。
> 4. **恢复语义五层化（DEC-035）**：明确「无数据即恢复」是 vmalert 默认语义且是危险行为，以规则发布期强制声明 + `up`/`absent` 看门狗补偿，不改恢复语义；Flink 新增恢复延迟与抖动锁定；收敛组改为**组级恢复裁决**；抑制解除改为 Flink 发 `inhibit_released`、平台查账本补发。
> 5. **静默分层（DEC-036）**：**告警屏蔽**（Flink，事件不成立）与**通知静默**（平台，事件成立但不叫人）彻底分离；人工关闭时三选一（不静默 / 屏蔽通知 / 告警屏蔽），**复活是预期行为而非缺陷**。
> 6. **闭环 MC-09 / MC-11 / MC-14 / MC-15**：引入 `dedup_key`；升级链模型定稿；容量超限自动降级为「仅收敛」；规则热更新接受毫秒级版本偏差且**不清 keyed state**。
>
> v2.0 变更（保留）：告警链路重构，AM 降级为存储域去重引擎，新增 Flink 收敛引擎，引入 Kafka 单集群六 topic。对应 DEC-028 ~ DEC-033。

## 一、概述

告警管理模块是中心控制面的核心运维支撑模块，负责消费经 Flink 收敛引擎处理后的最终告警事件，并提供告警认领、跟踪、通知、关闭等完整的告警生命周期管理能力。

### 1.1 告警全生命周期架构

告警链路采用五层架构，各层职责单一、边界清晰：

```
CMDB ──同步──▶ 平台 instance.labels 富化 (host_id/rack_id/switch_id/cluster_id)
                        │ 采集配置下发时注入 target labels
                        ▼
Alloy ──remote_write──▶ vmstorage ──▶ vmselect ──▶ vmalert (规则评估，告警继承拓扑标签)
                                                      │
                                                      ▼
                              Alertmanager (存储域去重 + resolved 检测；零用户配置)
                                                      │ webhook（单一 receiver，send_resolved=true）
                                                      ▼
                                     am-bridge (无状态，webhook → Kafka)
                                                      │
                                          alert.raw ──▶ ┌────────────────────────────────┐
                                          alert.rule ──▶│        Flink 收敛引擎            │
                                          alert.topo ──▶│ 屏蔽→去重→收敛→抑制→恢复延迟→轨迹 │
                                        alert.control◀──│  Broadcast + KeyedState + Timer  │
                                                        └──────┬──────────────┬────────────┘
                                               alert.event ────┘              └──── alert.converged
                                                     │                                   │
                                             账本落库 worker                        平台告警管理
                                          (全量事件 + 处理轨迹)          (入库/认领/通知调度/升级/关闭)
                                                     │                                   │
                                              账本存储 (PG)                    关闭 ──▶ alert.control
                                                                                    （单向清理 Flink 状态）
```

| 层 | 组件 | 角色 | 核心职责 |
|----|------|------|----------|
| 规则评估 | vmalert | 告警产生者 | PromQL 规则评估，产生携带完整拓扑标签的告警事件 |
| 边缘去重 | Alertmanager | **存储域去重引擎（零配置）** | 本存储域内 fingerprint 去重（时间维度）、resolved 检测、重发抑制。**不持有任何用户可配置策略** |
| 传输 | am-bridge + Kafka | 异步投递与缓冲 | webhook 转 Kafka；削峰；解耦上下游故障域 |
| 收敛计算 | **Flink 收敛引擎** | **全局裁决引擎** | 屏蔽、跨域去重（空间维度）、收敛、逐级抑制、恢复延迟与抖动锁定；记录全量事件与处理轨迹；动态规则热更新 |
| 运维管理 | 平台（本模块） | 运维管理面 + **通知决策面** | 最终事件入库、认领、路由匹配、重复通知、自动升级、通知静默、关闭（单向清理 Flink 状态） |

**关键边界：告警管理只在最终事件到达平台后才开始。** 平台不承担去重、收敛、抑制职责，也不感知原始告警量级——这些全部在 Flink 层完成。反过来，**Flink 不参与任何通知决策**：路由、重复通知、升级、通知静默全在平台侧，通知策略变更永不触碰 Flink 作业（见 §6.10）。

### 1.2 三层职责分离

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Alertmanager（存储域内，零用户配置）                                          │
│  · 时间维度去重：同一告警持续 firing 期间的周期性重发抑制（repeat_interval）    │
│  · resolved 检测：显式（vmalert 推送）+ 隐式（resolve_timeout 兜底）           │
│  · send_resolved: true                                                       │
│  · 不做：分组通知、屏蔽、抑制、路由、silence                                   │
│  · 配置来源：部署期静态模板，变更走发布流程，不走 UI                            │
│  · 目的：把 Flink 入口流量削掉约两个数量级                                     │
└────────────────────────────────────────────────────────────────────────────┘
                                    ↓ alert.raw
┌────────────────────────────────────────────────────────────────────────────┐
│  Flink 收敛引擎（平台侧，全局唯一权威）                                        │
│  · 屏蔽：标签匹配 + 时间窗（纯 broadcast，无 keyed state）                     │
│  · 空间维度去重：跨存储/跨网区同 dedup_key 副本裁决（first-wins）+ 续约吸收     │
│  · 收敛：窗口内 N 条同类告警 → 1 条代表事件（管「量」）+ 组级恢复裁决           │
│  · 逐级抑制：拓扑树根因压制子告警（管「因果」）+ 抑制解除信号                   │
│  · 恢复延迟与抖动锁定：治 fire/resolve 交替                                    │
│  · 全量事件账本 + 处理轨迹（命中了哪些规则、被谁收敛/抑制/屏蔽）                 │
│  · 动态规则：broadcast state 热更新，不重启作业                                │
└────────────────────────────────────────────────────────────────────────────┘
                                    ↓ alert.converged（仅最终事件）
┌────────────────────────────────────────────────────────────────────────────┐
│  平台告警管理（本模块）                                                        │
│  · 最终事件入库、展示、检索、明细下钻（收敛组内全部事件）                        │
│  · 路由匹配 → 通知渠道模块（承接原 AM 路由树职责）                              │
│  · notification_scheduler：重复通知、自动升级、认领超时（PG 扫描）              │
│  · 通知静默（alert_notify_mute）：事件照常产生，只是不叫人                       │
│  · 认领、分派、关闭；关闭时单向清理 Flink 状态                                  │
└────────────────────────────────────────────────────────────────────────────┘
```

**收敛与抑制的职责区分**：收敛管「量」（窗口内归并同类告警），抑制管「因果」（根因压制子告警）。二者不可互相替代——告警风暴的量由收敛拦截，因果关系由抑制表达。

**屏蔽与静默的职责区分**：告警屏蔽（Flink）决定**事件是否成立**，被屏蔽的事件不进运营表；通知静默（平台）决定**成立的事件是否叫人**，事件正常入库、正常参与收敛计数、活跃列表可见。二者载体、执行点、语义完全不同，详见 §3.5。

### 1.3 拓扑标签：RCA 的数据基础

逐级抑制依赖拓扑信息，但**不依赖运行时的拓扑流 join**。拓扑以标签形式在采集阶段注入，随指标一路带到告警：

```
CMDB（拓扑原始真源）
  → 平台同步并富化到 instance.labels
  → 采集配置下发时注入 target labels（Alloy http_sd 返回的 target 携带拓扑标签）
  → 指标带标签写入 vmstorage
  → vmalert 评估，告警继承指标标签
  → AM 去重（fingerprint 含拓扑标签）
  → Flink 按拓扑标签 keyBy / broadcast 做 RCA
```

| 标签 | 来源 | RCA 用途 |
|------|------|----------|
| `host_id` | CMDB | 宿主机故障 → 抑制其上全部实例告警 |
| `switch_id` | CMDB | 网络设备故障 → 抑制下挂实例告警 |
| `rack_id` | CMDB | 机架级故障 → 抑制机架内全部告警 |
| `cluster_id` | CMDB | 集群级故障 → 抑制成员告警 |
| `zone` | 网区继承（已有） | 网区级收敛与筛选 |

这一设计把 RCA 从「流-流 join + 拓扑状态维护」简化为「标签 keyBy + broadcast 查表」，是选择 Flink 方案后最关键的一次复杂度削减。

**已知代价（接受，不做补偿）**：

| 代价 | 说明 | 处理 |
|------|------|------|
| 拓扑标签进入 fingerprint 与 dedup_key | fingerprint = hash(alertname + 全部标签)，`dedup_key` = hash(alertname + 标签 − 来源标识标签)——**拓扑标签不在排除列表内**，因此两者同时变更。CMDB 改变某实例的拓扑归属 → 在飞告警被当作新告警 | 记录为已知行为；Flink 跨域去重按 `dedup_key` first-wins，不会产生错误合并（新旧拓扑归属的告警被视为两条不同告警，而非同一条的两个副本） |
| 标签陈旧窗口 | CMDB 变更 → 平台富化 → http_sd 刷新 → 新样本带新标签，延迟约等于 sd 刷新周期 + 抓取周期 | 窗口内 RCA 按旧拓扑判定，可能漏抑制或误抑制。见 MC-12 |
| 告警必须携带完整拓扑标签 | 否则 Flink 无从 keyBy，RCA 失效 | **硬约束**：vmalert 规则不得裁剪拓扑标签（`labels` / `drop` 配置需校验），写入规则管理规范 |

## 二、职责边界

### vmalert（规则评估引擎）

| 职责 | 说明 |
|------|------|
| 规则评估 | PromQL 告警规则评估，查询 vmselect 获得全局指标可见性 |
| 标签继承 | 告警继承指标的全部标签，**包括 CMDB 拓扑标签，不得裁剪** |
| 推送 AM | 将 firing/resolved 状态推送到共部署的 Alertmanager |

### Alertmanager（存储域去重引擎 — 零用户配置）

| 职责 | 说明 |
|------|------|
| fingerprint 去重 | 本存储域内基于 fingerprint 的精确去重 |
| 重发抑制 | `repeat_interval` 控制持续 firing 告警的重发频率（时间维度削峰） |
| resolved 检测 | 显式路径：vmalert 推 `status: resolved`，即时透传；隐式路径：`resolve_timeout` 内未收到该 fingerprint 任何更新则判定恢复（兜底） |
| 恢复事件穿透 | receiver 必须配 `send_resolved: true`，否则 resolved 到不了下游，Flink 状态只能等 TTL 回收 |

**AM 是零用户配置组件**（v3.0 决策，DEC-037）。它的 config 只有五样东西：一个指向 am-bridge 的 webhook receiver，加上 `group_wait`、`group_interval`、`repeat_interval`、`resolve_timeout` 四个时间参数。**全部由部署模板生成，变更走发布流程，不走控制面板 UI。**

由此删除的能力（v2.0 还保留了一部分，v3.0 全部移除）：

| 不再负责 | 迁移去向 |
|----------|----------|
| 告警分组通知 | Flink 收敛算子 |
| 告警屏蔽 (Silence) — 含用户配置规则与手动关闭时的临时 silence | **Flink 屏蔽算子**（`converge_rule` type=mute）。平台不再回调 AM silence API |
| 告警抑制 (Inhibition) | Flink 逐级抑制算子 |
| 限流与节流 | Flink 收敛算子 + 平台通知限流 |
| 路由树与 receiver 选择 | 平台告警管理（定义）+ 通知渠道模块（执行） |
| 告警状态权威源 | 拆分为：收敛状态权威 = Flink；运维生命周期权威 = 平台 |
| AM 配置渲染 / 下发 / 热加载 | **删除**，退化为部署期静态模板 |

**这样做的收益**：消除一整类故障——「UI 改了但 AM 没生效」「配置渲染错误导致 AM 拒绝加载」「热加载竞态」。少一条配置下发链路、少一个失败点。

**AM 状态是自清理的**：vmalert 停止推送后 `resolve_timeout` 自动回收，vmalert 推 resolved 时立即回收。**平台不需要对 AM 做任何清理动作**——这是 DEC-033「双向清理」在 v3.0 改为「单向清理」的依据。

**AM 明确不做集群**（DEC-029）。理由见 §6.3。

### am-bridge（webhook → Kafka 桥接）

| 职责 | 说明 |
|------|------|
| 协议转换 | 接收 AM webhook，转换为 Kafka 消息写入 `alert.raw` |
| 来源标记 | 注入 `source_am` / `source_storage` / `source_zone_id`，供 Flink 跨域去重记录来源 |
| 无状态多副本 | 无本地状态，可水平扩容；故障时依赖 AM webhook 重试 |

> **注**：Alertmanager 原生不支持 Kafka sink（receiver 仅 webhook/email/slack/pagerduty/wechat 等），因此必须引入 bridge。bridge 是本链路中唯一的自研传输组件，逻辑极薄。

### Flink 收敛引擎（全局裁决引擎）

| 职责 | 说明 |
|------|------|
| 屏蔽 | 标签匹配 + 时间窗，规则由控制面板下发；**纯 broadcast 判定，不分配 keyed state** |
| 跨域去重 | 跨存储/跨网区同 `dedup_key` 副本裁决，first-wins，其余标 `deduped` 并记录来源 |
| 续约吸收 | AM 按 `repeat_interval` 重发的持续 firing 告警，刷新状态 TTL 后标 `renewed`，**只写账本不下传**（见 §6.10 三级重复通知分离） |
| 收敛 | 窗口内同类告警归并为代表事件，记录 `converge_group_id` 与 `converged_count`；**组内全部 resolved 才 emit 组级 resolved** |
| 逐级抑制 | 基于拓扑作用域链的根因压制，记录 `inhibited_by` 与 `scope_matched`；根因恢复 + 宽限期满后侧输出 `inhibit_released` |
| 恢复延迟与抖动锁定 | resolved 延迟 `resolve_hold_s` 再 emit；窗口内交替超阈值则进入抖动锁定 |
| 事件账本 | 全量事件（含被丢弃的）+ 处理轨迹写入 `alert.event` |
| 动态规则 | 从 `alert.rule` broadcast 加载规则，带版本号热更新，不重启作业 |
| 状态清理 | 消费 `alert.control`，按 fingerprint 清除 keyed state |
| AI 分析（Phase 2） | 旁路富化算子，输出推测根因与置信度，**仅建议不决策** |

**Flink 明确不做通知决策**：路由匹配、重复通知、自动升级、通知静默全在平台侧。理由是这些决策依赖 `lifecycle_status`（是否已认领）、`escalation_level` 等平台可变业务状态，而 DEC-033 已定 `claim` 不进流——把它们搬进 Flink 等于让流状态成为平台操作表的镜像，同一事实两个权威源。详见 §6.10。

### 平台告警管理（本模块）

| 职责 | 说明 |
|------|------|
| 最终事件消费 | 从 `alert.converged` 消费 `emit=true` 的事件并入库 |
| 告警认领与跟踪 | 认领、处理、关闭的工作流；认领时配置三个正交开关（见 §3.7） |
| 路由匹配 | 承接原 AM 路由树职责，平台侧存储与匹配，选定 receiver（通知组） |
| 通知调度 | `notification_scheduler`：重复通知、自动升级、认领超时扫描（PG + `SKIP LOCKED`） |
| 通知静默 | `alert_notify_mute`：事件照常产生入库，只是不触发通知（见 §3.5） |
| 恢复处理 | resolved 入库、`resolved_reason` 推断（Phase 2）、按开关决定是否自动关闭与是否发恢复通知 |
| 抑制解除补发 | 收到 `inhibit_released` 后查账本找出仍 firing 的被抑制子告警并补发通知 |
| 明细下钻 | 从收敛代表事件下钻查询账本中被收敛/抑制/屏蔽的全部事件 |
| 根因关联回填 | 消费 `scope_root_declared` 事件，回填已入库告警的 `root_event_id` |
| 关闭单向清理 | 发 `alert.control` 清理 Flink 状态（**不再回调 AM**） |
| 规则配置下发 | 控制面板 UI 配置收敛/抑制/屏蔽规则，写入 PG 并发布到 `alert.rule` |
| 告警历史与分析 | MTTR、频率、误报率、Top-N、趋势、降噪效果 |
| 链路带外监控 | 监控**整条存储侧链路 + Flink** 的心跳与水位，中断时走硬编码最小通知路径 |

### 本模块不负责

| 不负责项 | 归属 |
|----------|------|
| 告警规则的定义与管理 | 规则定义模块（控制面） |
| 告警规则的实时评估 | vmalert（存储侧共部署） |
| 存储域内 fingerprint 去重、resolved 检测 | Alertmanager |
| 屏蔽 / 跨域去重 / 收敛 / 抑制 / 恢复延迟执行 | Flink 收敛引擎 |
| 告警通知的实际发送、渠道管理、升级链定义 | 通知渠道管理模块 (notification-channel) |
| CMDB 拓扑数据维护 | CMDB（外部系统），平台只做同步与标签富化 |

## 三、功能清单

### 3.1 告警事件消费

平台从 `alert.converged` 消费经 Flink 裁决后的最终事件并入库。

| 功能 | 描述 |
|------|------|
| 队列消费 | 消费 `alert.converged`，`isolation.level=read_committed` |
| 格式标准化 | 统一为平台标准告警格式（兼容 AlertManager Webhook 格式，见 §6.8） |
| 幂等入库 | 基于 `event_id` + `fingerprint` 幂等，Flink 从 checkpoint 恢复重放时不产生重复 |
| 消费确认 | offset 提交，至少一次投递 + 幂等 = 有效恰好一次 |
| 根因关联回填 | 收到 `scope_root_declared` 后，为该作用域时间窗内已入库告警回填 `root_event_id` |

**标准告警事件格式（`alert.converged`）：**

```json
{
  "event_id": "evt-uuid",
  "msg_type": "alert" | "scope_root_declared" | "inhibit_released",
  "alert_id": "uuid",
  "fingerprint": "abc123def456",
  "dedup_key": "789xyz000111",
  "status": "firing" | "resolved",
  "source": {
    "zone_id": "zone-east-1",
    "storage_id": "storage-01",
    "am_instance": "am-storage-01",
    "vmalert_id": "vmalert-storage-01"
  },
  "labels": {
    "alertname": "OracleTablespaceHigh",
    "severity": "warning",
    "instance": "ora-prod-01",
    "instance_type": "oracle",
    "zone": "zone-east-1",
    "host_id": "host-07",
    "rack_id": "rack-east-03",
    "switch_id": "sw-east-01",
    "cluster_id": "cluster-db-prod"
  },
  "annotations": {
    "summary": "Oracle 表空间 USERS 使用率 92%",
    "description": "实例 ora-prod-01 的表空间 USERS 使用率已达 92%，超过警告阈值 85%",
    "runbook_url": "https://wiki.internal/runbook/tablespace-high"
  },
  "starts_at": "2026-09-24T10:30:00Z",
  "ends_at": null,
  "generator_url": "http://vmselect:8481/graph?g0.expr=...",
  "convergence": {
    "action": "passed",
    "converge_group_id": null,
    "converged_count": 0,
    "inhibited_by": null,
    "root_event_id": null,
    "rule_hits": []
  },
  "ai_rca": null
}
```

**`scope_root_declared` 事件（根因激活通知）：**

```json
{
  "event_id": "evt-root-uuid",
  "msg_type": "scope_root_declared",
  "scope": { "level": "switch_id", "value": "sw-east-01" },
  "root_alertname": "SwitchDown",
  "severity": "critical",
  "rule_id": "R-003",
  "declared_at": "2026-09-24T10:30:03Z",
  "expires_at": "2026-09-24T11:30:03Z"
}
```

平台收到后，把该作用域内 `declared_at` 前一个时间窗（默认 5min）内已入库的告警回填 `root_event_id`，实现 UI 上的因果折叠。**Flink 不为每条子告警发更正事件**——已放行的告警是当时信息下的正确决策，不追认、不撤回通知。

**`inhibit_released` 事件（抑制解除信号，v3.0 新增）：**

```json
{
  "event_id": "evt-release-uuid",
  "msg_type": "inhibit_released",
  "scope": { "level": "switch_id", "value": "sw-east-01" },
  "root_event_id": "evt-root-uuid",
  "root_alertname": "SwitchDown",
  "released_count": 183,
  "released_at": "2026-09-24T11:31:03Z"
}
```

平台收到后延迟 `trace_settle_s`（默认 15s）查账本 `inhibited_by = root_event_id AND status = firing`，对仍在 firing 的子告警按路由策略补发通知。`released_count` 用于校验账本完整性，不足则重试（最多 3 次，指数退避），最终仍不足则记录差异并告警。详见 §3.3.3。

### 3.2 分层去重

去重分两层，作用在**不同维度**，不是重复劳动：

| 层 | 维度 | 触发条件 | 动作 | 为什么必须在这一层 |
|----|------|----------|------|--------------------|
| AM（存储域内） | **时间** | 同一告警持续 firing，每个评估周期重发 | `repeat_interval` 抑制重发 | 若在 Flink 做，vmalert 每周期重推全部 firing 告警，入口流量放大约两个数量级 |
| Flink（全局） | **空间** | 双写场景下多个存储的 vmalert 产生同一告警 | first-wins，其余 `action=deduped` | 只有全局汇聚点能看见所有网区；AM 之间不组集群即互相不可见 |

**量级说明**：以 5 万实例、5% 同时 firing（2500 条活跃告警）、vmalert 评估周期 1min 计——无 AM 去重时 Flink 入口约 2500 事件/分钟持续灌入；AM `repeat_interval=4h` 将其压到约 2500/4h。差约 240 倍。

**AM 不组集群**。AM 集群（gossip）同步的是 silences 与 notification log，**不同步告警本身**；要做全局去重必须让每个 vmalert 向集群每个成员全量推送，带来 N×M 条跨网区连接、跨 WAN gossip 抖动、以及全量活跃告警集中在中心内存（AM 无原生分片，集群扩的是可用性而非吞吐）等问题，并违反「中心不可用时各区仍能自治运行」的核心设计目标。详见 §6.3。

#### 3.2.1 跨域去重的判定键：`dedup_key`（v3.0 闭环 MC-09）

**v2.0 遗留缺陷**：v2.0 规定跨域去重按 `fingerprint` first-wins 裁决，但 `fingerprint = hash(alertname + sorted labels)`，而 `zone` 是标签之一。因此**最需要去重的两类场景恰好是 fingerprint 失效的场景**：

| 重复来源 | 标签是否相同 | fingerprint 能否去重 |
|----------|--------------|----------------------|
| prime 存储迁移窗口（新旧 prime 短暂同时持有规则） | 相同（同一 vmselect 全局视图） | ✅ 能 |
| 规则包重复下发到同一存储 | 相同 | ✅ 能 |
| **多 DC 实例，规则下发到所有关联 DC** | **`zone` 不同** | ❌ 不能 |
| **实例跨网区迁移期，新旧网区同时评估** | **`zone` 不同** | ❌ 不能 |

**v3.0 决策：引入 `dedup_key`，与 `fingerprint` 并存、各司其职。**

```
fingerprint = hash(alertname + sorted(全部标签))                      # 身份与展示
dedup_key   = hash(alertname + sorted(标签 − 来源标识标签))            # 跨域裁决
```

来源标识标签排除列表（**系统保留，随标签体系演进需同步维护**）：

```
zone, zone_id, source_storage, source_am, dc
```

| 键 | 用途 | 是否含来源标识 |
|----|------|----------------|
| `fingerprint` | AM 域内去重、告警身份展示、`alert.control` 与 keyed state 的 key | 含 |
| `dedup_key` | Flink stage 3 跨域 first-wins 裁决 | **不含** |

计算位置：**am-bridge** 在写 `alert.raw` 时一并算出并注入消息体，Flink 不重复计算。理由：am-bridge 已经是无状态的协议转换点，加一次哈希零成本；放 Flink 则每个 subtask 都要维护排除列表的一致性。

**配套源头治理（RC-05 已裁决为「仅 prime」）**：多 DC 实例的告警规则只下发到 prime 存储域的 vmalert——vmalert 查询 vmselect 已具备全局指标可见性，向多个 vmalert 下发同一规则包既冗余又制造重复。这消除了多 DC 场景的主要重复来源，但**不解决 prime 迁移窗口**，因此 `dedup_key` 仍然必要。`instance-management.md` §3.6.6 已同步修订。

#### 3.2.2 参数对齐（错位会导致去重失效或状态泄漏）

| 参数 | 值 | 约束 |
|------|-----|------|
| AM `repeat_interval` | 4h | — |
| AM `resolve_timeout` | **30m**（v3.0 由默认 5m 调大） | 覆盖 vmalert 正常重启/滚动升级窗口，避免运维动作造成全量伪恢复。调大无代价——真恢复走显式路径即时到达，该参数只影响隐式兜底路径 |
| AM `send_resolved` | `true` | resolved 必须穿透重发抑制，否则 Flink 状态无法回收，只能等 TTL |
| Flink `dedup_key` 状态 TTL | 24h | **必须显著大于 `repeat_interval`**（6 次续约机会），否则 AM 重发时 Flink 已遗忘该键，会把老告警当新告警重新放行 |

完整的参数排序不变式见 §3.11.5，该不变式在配置加载时校验，违反则拒绝启动。

#### 3.2.3 裁决与续约

**跨域去重裁决规则**：first-wins——保留最先到达 `alert.raw` 的那条，其余标 `action=deduped`，轨迹中记 `dedup_of`（保留事件的 `event_id`）+ `source_am` + `source_storage` + `source_zone_id`。保留来源信息是排查双写不一致的唯一线索，不可省略。

**续约吸收**：AM 每 `repeat_interval` 重发的持续 firing 告警，在 stage 3 命中已有 `dedup_key` 状态时：

- **读取状态以刷新 TTL**（`StateTtlConfig` 必须用 `OnReadAndWrite`，只写不读会导致续约无法延长生命周期）
- 标记 `action='renewed'`，`emit=false`
- **只写账本 `alert.event`，不写 `alert.converged`**

这样平台永远只看到「新成立的事件」，`alert_route.repeat_notify_s` 成为唯一的人工重复提醒权威。账本代价为「每 fingerprint 每 4h 一行」，可忽略；收益是运维能从账本直接读出「这条告警持续了多久」。

**迁移期 `source_zone_id` 归属**：以 first-wins 先到者为准（实现简单，可能记到旧网区），账本保留双来源供事后核对。Phase 2 视运营反馈决定是否改为按 `instance.zone_id` 当前值归属（需 Flink 查实例归属，引入额外依赖，暂不做）。

### 3.3 收敛与抑制（Flink 侧执行）

#### 3.3.1 输入流

| 流 | topic | keyBy | 用途 |
|----|-------|-------|------|
| 主流 | `alert.raw` | `dedup_key`（stage 3 起）；stage 1~2 无 key | 待裁决的告警事件 |
| 规则流 | `alert.rule` | broadcast | 动态收敛/抑制/屏蔽规则，带版本号热更新 |
| 控制流 | `alert.control` | fingerprint | 关闭信号，清理 keyed state |
| 拓扑流（可选） | `alert.topo` | broadcast | 实时拓扑变更。**默认不用**，拓扑以标签为主；仅当规则需要实时拓扑而非采集时快照拓扑时启用 |

**控制流与主流的 key 不一致，需在消息体里弥合**：`alert.control` 按 fingerprint 分区，而主流在 stage 3 之后按 `dedup_key` 分区。Flink **不能**为了找 `dedup_key` 去反查运营表（违反「Flink 不做重 I/O」）。因此 **control 消息体必须同时携带 `fingerprint` 与 `dedup_key`**，由平台在发送前从 `alert_event` 读出填入；Flink 收到后按消息体内的 `dedup_key` 二次 keyBy 到主流分区。**这是清理能生效的前提，实现时不可省略**（详见 §3.9）。

#### 3.3.2 算子链（v3.0 重排）

| # | 算子 | keyBy / 状态 | 逻辑 | action |
|---|------|--------------|------|--------|
| 1 | 规整 | — | 拆 AM 分组包为单条事件；赋 `event_id`、`recv_at`；提取 `topo_scope` 作用域链 | — |
| **2** | **屏蔽** | **broadcast only（无 keyed state）** | 匹配屏蔽规则（标签正则 + 时间窗），命中即丢弃 | `muted` |
| 3 | 跨域去重 | `dedup_key`（keyed，TTL 24h） | first-wins 裁决；续约吸收（刷 TTL，不下传） | `deduped` / `renewed` |
| 4 | 收敛 | 规则派生键（如 `alertname+zone`、`switch_id`），`MapState<fingerprint, status>` | 窗口 T 内 N 条 → 1 条代表事件；**组内全部 resolved 才 emit 组级 resolved** | `converged` |
| 5 | 逐级抑制 | 根因状态用 **broadcast**（含被抑制计数） | 事件作用域链命中任一活跃根因 → 压制；根因 resolved + `grace_s` → 侧输出 `inhibit_released` | `inhibited` |
| 6 | 恢复延迟与抖动 | fingerprint（keyed） | resolved 延迟 `resolve_hold_s` 再 emit；交替超阈值进入抖动锁定 | `resolve_held` / `flapping_locked` |
| 7 | AI 富化（Phase 2） | 旁路 async | 按收敛组触发，输出 `ai_rca`，超时降级 | 不改变 action |
| 8 | 轨迹与输出 | — | 全量事件 + 轨迹 → `alert.event`；`action=passed` 及收敛代表事件、`inhibit_released` → `alert.converged` | `passed` |

**v3.0 相对 v2.0 的三处调整，都是修正实质缺陷，不是风格偏好：**

| 调整 | 原设计的问题 |
|------|--------------|
| **屏蔽前移到去重之前** | 原位置在 stage 3（去重之后）。持续 firing 的告警会先在去重算子被吸收为 `renewed`，**永远到不了屏蔽算子**——广播式屏蔽规则（如维护窗口 `zone=edge-*`）形同虚设。只有「人工关闭后 state 被清、下一条被当作新告警」这一条路径能走到屏蔽 |
| **屏蔽改为纯 broadcast、去掉 keyed state** | 屏蔽判定是「标签是否匹配某条活跃规则的 matchers + 当前是否在规则窗口内」，纯查表、每事件独立、无需历史。原设计标为 `fingerprint (keyed)` 是错的，白白为每条被屏蔽告警分配 RocksDB 状态——维护窗口屏蔽一万个目标时，这一万份状态是纯浪费 |
| **抑制前移到恢复延迟之前** | resolved 事件必须先到达抑制算子把自己从活跃根因集合摘掉。原链序（抖动在抑制前）会让被 hold 住的 resolved 延迟清理根因状态，导致根因已恢复、子告警仍被错误压制 |

**`inhibit_released` 走 stage 5 的侧输出直达 stage 8**，不经过 stage 6。它是控制信号不是告警事件，不该被恢复延迟和抖动逻辑处理。

**时序代价**：根因 resolved 后，`grace_s`(60s) 与 `resolve_hold_s`(60s) 是串联的。根因自身的恢复通知延迟 60s；`inhibit_released` 只经 `grace_s`（60s）。平台侧感知到的整体解禁时延约 60~120s，可接受。

#### 3.3.3 逐级抑制的实现

拓扑是一棵树（cluster → rack → switch → host → instance）。Stage 1 把每条告警的拓扑标签展开为作用域链：

```
scopes = ["cluster:cluster-db-prod", "rack:rack-east-03",
          "switch:sw-east-01", "host:host-07", "instance:ora-prod-01"]
```

**根因状态用 broadcast state，不用 keyed state。** 理由：keyed state 只能按单一 key 查询，而一条子告警需要检查它全部 5 个祖先作用域；用 keyed state 就得把事件按作用域炸开再重聚合，算子复杂度高一个量级。而活跃根因天然是低基数（不会同时有一千个交换机在故障），broadcast 到每个 subtask 全量持有完全可行。

| 子流 | 行为 |
|------|------|
| 根因识别 | `alertname ∈ root_alertnames`（规则配置）且携带拓扑作用域标签 → 写 broadcast `activeRoots[scope] = {root_event_id, rule_id, severity, declared_at, expires_at, inhibited_count}`；同时向 `alert.converged` 发 `scope_root_declared` |
| 抑制判定 | 每条事件扫自己的 `scopes`，命中任一活跃根因 → `action=inhibited`，记 `inhibited_by`、`scope_matched`、命中规则，并对该根因的 `inhibited_count` +1 |
| 抑制解除 | 根因 resolved + `grace_s`（默认 60s）→ 从 broadcast 移除，并**侧输出 `inhibit_released`**（携带 `scope`、`root_event_id`、`released_count`）直达 stage 8 |
| 状态回收 | 移除后另有 TTL 兜底防泄漏 |
| 容量保护 | 见下方「容量边界与降级」 |

**多级根因冲突**：rack 级与 switch 级根因同时活跃且互为祖先时，取**作用域更高层**（rack 覆盖 switch）作为 `inhibited_by`，但轨迹中记录全部命中，便于事后还原完整抑制链。

**抑制解除为什么走平台补发，而不是 Flink 内 re-emit**（v3.0 决策）：

| 方案 | 做法 | 评价 |
|------|------|------|
| i：Flink 内补发 | broadcast 维护 `root_cause → Set<fingerprint>` 反向索引，解禁时逐个 re-emit | **要求被抑制的事件在 keyed state 里全量保留 → 抑制不减少 state 量，风暴期 RocksDB 照涨**；且 broadcast 侧无法直接按 fingerprint emit，需注回主流 union |
| **ii：平台侧补发（选定）** | Flink 只发一条 `inhibit_released`；平台查账本 `inhibited_by = root_event_id AND status = firing` 补发通知 | **Flink 无需为被抑制事件保留 keyed state（只写账本），state 量真正下降**；账本查询走已建的 `idx_trace_root` 索引 |

方案 ii 把 I/O 推给平台，符合「Flink 不做重 I/O」的既定划分，并让「抑制降低状态量」这个降噪收益真正兑现。

**方案 ii 的时序约束（必须处理）**：账本 worker 有延迟（目标 P95 < 10s，见 §3.4）。平台收到 `inhibit_released` 时账本可能尚未写完全部子事件。处理方式：

1. 延迟 `trace_settle_s`（默认 15s）后再查
2. 用 `released_count` 校验实际查到的条数；不足则重试（最多 3 次，指数退避）
3. 最终仍不足 → 记录差异并告警。这本身是账本链路健康的信号，不可静默吞掉

**容量边界与降级（v3.0 闭环 MC-14）**：

| 状态 | 上限 | 超限行为 |
|------|------|----------|
| broadcast 活跃根因条数 | 10k | **自动降级为「仅收敛不抑制」模式**：停止写入新根因，已有根因继续生效至自然回收；同时触发 critical 告警 |
| 单个收敛组成员数（`MapState` 条目） | `converge_group_max_members`（默认 1000） | **拆分新组**，`converge_group_id` 加序号后缀（`cg-uuid#2`）；轨迹记录拆分事件 |

选择「自动降级为仅收敛」而非「丢弃新根因」或「淘汰最旧根因」的理由：**宁可少抑制，不可丢事件**。抑制失效的后果是多通知（吵），淘汰根因的后果是子告警在根因仍活跃时被错误放行、或根因仍活跃却发了解禁信号（乱）；两者都比"吵"更难排查。超 10k 本身说明规则配错（不会同时有一千个交换机在故障），降级 + 告警足以让运维发现。

#### 3.3.4 抑制时序：先放行，后抑制

**问题**：交换机 sw-01 故障，T+0s 下挂 200 个实例的 `InstanceDown` 先触发，T+3s `SwitchDown` 才触发（规则 `for:` 更长）。子告警到达时根因状态尚不存在。

**决策：允许子告警在根因到达前放行，根因到达后逐级抑制后续事件。不做滞留，不做回溯撤回。**

| 被否决的方案 | 否决理由 |
|--------------|----------|
| 统一滞留窗口（所有子告警延迟 Δ 再判定） | 给全部告警增加延迟，critical 不可接受 |
| 选择性滞留（仅非 critical 且作用域有待决根因） | 需要预判"是否可能有根因"，逻辑复杂且收益有限 |
| 回溯撤回（发更正事件折叠已放行告警） | 已发出的通知无法真正撤回；且已放行告警在当时信息下是正确决策，不应追认 |

**因此，风暴的量由收敛算子（Stage 4）拦截，而非抑制算子。** 前 3 秒那 200 条子告警是在根因已知之前放行的，抑制拦不住它们；拦住它们的是窗口收敛（T 内 N 条 → 1 条代表事件）。这两个算子职责严格分离：收敛管量，抑制管因果。

**辅助优化（建议但非强制）**：拓扑层规则（`SwitchDown` / `HostDown`）的 `for:` 配置得短于其下挂实例层规则，让根因尽量先到，缩小放行窗口。这条写入规则管理规范，作为规则评审检查项。

**平台侧关联**：根因激活时 Flink 发一条 `scope_root_declared`，平台据此回填该作用域内时间窗中已入库告警的 `root_event_id`。一条事件解决 UI 因果折叠，Flink 无需维护历史事件的引用。

#### 3.3.5 AI 分析算子（Phase 2）

引入 AI 算子做规则无法表达的跨信号关联（如关联发布事件、指标异常形态与告警簇），但必须满足以下硬护栏：

| 约束 | 理由 |
|------|------|
| **只能建议，不能决策抑制** | 一次幻觉就是一批真实告警被静默丢弃且无人察觉。抑制权归确定性规则 |
| AsyncFunction + 超时 + 降级 | 同步调用会阻塞算子，延迟无上界；超时必须回落到无 AI 结果继续走主链路 |
| 按收敛组触发，不按单事件 | 成本控制。建议仅对 `converged_count > 阈值` 或「量大但无规则命中」的不明风暴调用 |
| 输出为 `ai_rca` 附加字段 | 推测根因、置信度、关联证据；落账本与运营表，供运维参考与事后复盘 |
| 主链路不等待 | 旁路富化，AI 算子故障不影响告警投递 |
| 模型私有化部署 | 多网区隔离环境，告警内容含内网拓扑与实例信息，不得出网 |

#### 3.3.6 恢复延迟与抖动锁定（stage 6）

v2.0 的抖动抑制是**事后**介入：fire/resolve 交替 ≥ N 次才聚合，抖动已经发生并被下游看到了。v3.0 改为**事前**延迟：

```
收到 resolved(fingerprint)
  ├─ 不 emit，注册 timer(now + resolve_hold_s)          # 默认 60s
  │
  ├─ timer 到期前收到同 fingerprint 的 firing
  │     → 取消 timer，吞掉这次 resolved（action='resolve_held'，只写账本）
  │     → flapping_count++
  │     → 若 flapping_count ≥ flapping_threshold_n（默认 3）于 flapping_window_s（默认 600s）内
  │           → 进入「抖动锁定」：后续 fire/resolve 均不 emit，只写账本（action='flapping_locked'）
  │           → 直到状态稳定（无变化）超过 flapping_window_s 才解锁，并 emit 当前真实状态
  │
  └─ timer 到期无 firing → emit resolved
```

keyed state 增量：`flapping_count`、`hold_timer` 标志、`locked_until`。都在 fingerprint 维度，与既有 stage 3/6 同键，无新增 keyBy。

**显式代价**：真恢复的通知延迟增加 `resolve_hold_s`（60s）。这个代价可接受——恢复通知晚一分钟没有运维损失，而抖动导致的反复叫人损失很大。

**为什么必须在 Flink 治而不能在规则层治**：`for:` 只延迟 firing，不延迟 resolved；表达式一空告警立刻 resolved。规则层无法表达迟滞阈值（Prometheus 规则模型不支持单规则双阈值，拆两条规则 + recording rule 做状态保持的复杂度不值当）。详见 §3.11.2。

#### 3.3.7 收敛组的恢复裁决（stage 4）

v2.0 未定义「代表事件 resolved 但组内还有 firing」时的行为。三个候选：

| 选项 | 语义 | 问题 |
|------|------|------|
| 1：换代表 | 组内选下一个 firing 的作为新代表 | **平台上的代表 `event_id` 跳变 → 已建立的认领关系丢失**（认领挂在 event_id 上） |
| 2：直接透传 | 代表 resolved 就 emit 组 resolved | 组内还有 300 条在 firing 却告诉运维「好了」，**错误** |
| **3：组级裁决（选定）** | **只有组内全部 fingerprint 都 resolved，才 emit 组级 resolved** | 需维护组内成员状态 |

选 3 的两条理由：收敛组的语义就是「这一批是同一件事」，一件事只要还有一个子问题没好就没好；且它保住了代表 `event_id` 的稳定性，认领关系不会跳变。

**实现变更**：stage 4 的 keyed state 从 `ValueState<counter>` 改为 `MapState<fingerprint, status>`，keyBy 仍是规则派生的 `converge_group_id`。RocksDB `MapState` 原生支持。成员数上限见 §3.3.3「容量边界与降级」。

### 3.4 事件账本与处理轨迹

Flink 在处理过程中记录**全量事件**（含被去重/屏蔽/收敛/抑制而丢弃的）及其**处理轨迹**，写入 `alert.event`，由独立账本 worker 落库。

| 功能 | 描述 |
|------|------|
| 全量记录 | 每条进入 Flink 的事件都留痕，无论最终 action 为何 |
| 命中规则记录 | 记录评估过的规则、命中的规则、规则版本号 |
| 收敛状态记录 | `converge_group_id`、`converged_count`、代表事件 `event_id` |
| 抑制链记录 | `inhibited_by`、`scope_matched`、全部命中的祖先作用域 |
| 去重来源记录 | `dedup_of`、`source_am`、`source_storage`，用于排查双写不一致 |
| 明细下钻 | 平台从收敛代表事件下钻，查询账本中同 `converge_group_id` 的全部事件 |
| 状态清理留痕 | 被 `alert.control` 清理时回填 `state_cleared_at` |

**处理轨迹模型（`alert.event` 消息体）：**

```json
{
  "event_id": "evt-uuid",
  "fingerprint": "abc123def456",
  "dedup_key": "789xyz000111",
  "recv_at": "2026-09-24T10:30:00.123Z",
  "status": "firing",
  "alertname": "OracleTablespaceHigh",
  "severity": "warning",
  "source": {
    "zone_id": "zone-east-1",
    "storage_id": "storage-01",
    "am_instance": "am-storage-01"
  },
  "labels": { "...": "完整标签，含拓扑标签" },
  "annotations": { "...": "..." },
  "starts_at": "2026-09-24T10:30:00Z",
  "ends_at": null,
  "topo_scope": {
    "cluster_id": "cluster-db-prod",
    "rack_id": "rack-east-03",
    "switch_id": "sw-east-01",
    "host_id": "host-07"
  },
  "action": "passed|deduped|renewed|converged|inhibited|muted|resolve_held|flapping_locked",
  "emit": true,
  "rule_hits": [
    {
      "rule_id": "R-017", "rule_type": "converge", "rule_version": 12,
      "matched_at": "2026-09-24T10:30:00.130Z",
      "detail": { "converge_key": "alertname+zone", "window_s": 60, "threshold_n": 10 }
    },
    {
      "rule_id": "R-003", "rule_type": "inhibit", "rule_version": 12,
      "matched_at": "2026-09-24T10:30:00.131Z",
      "detail": { "scope_matched": "switch:sw-east-01", "root_event_id": "evt-root-uuid" }
    },
    {
      "rule_id": "R-021", "rule_type": "mute", "rule_version": 3,
      "matched_at": "2026-09-24T10:30:00.129Z",
      "detail": { "reason": "edge 网区计划内维护窗口", "created_by": "operator-zhangsan" }
    }
  ],
  "converge_group_id": "cg-uuid",
  "converged_count": 47,
  "dedup_of": null,
  "inhibited_by": "evt-root-uuid",
  "scope_matched": "switch:sw-east-01",
  "ai_rca": null,
  "flink_job_version": "1.4.0",
  "state_cleared_at": null
}
```

**账本落库路径**：Flink → `alert.event` → 账本 worker → 存储。账本 worker 是独立 consumer group，与平台运营消费完全隔离，账本积压不会阻塞告警运营链路。写入采用批量提交（建议 500 行 / 1s），压力表现为 consumer lag 而非数据库连接打满——这正是 Kafka 作为缓冲层的目的。

**账本新鲜度是运营体验的一部分**：已认领告警同样参与收敛抑制，运维下钻查看明细读的是账本表。因此账本 worker 的 lag 直接表现为「详情页明细缺失」，需要独立的 lag 告警，目标 P95 < 10s（比运营链路更紧）。

**v3.0 新增依赖：账本新鲜度还决定抑制解除补发的正确性。** 平台收到 `inhibit_released` 后要查账本找出仍 firing 的被抑制子告警（§3.3.3）。若账本 lag 过大，查询会漏掉尚未落库的子事件，导致「根因恢复了但部分子告警从未通知过任何人」。因此：

- `trace_settle_s`（默认 15s）必须 **> 账本 lag 的 P99**，不能只大于 P95
- 用 `released_count` 校验实际查到条数，不足则重试，最终不足要告警——**不可静默接受差异**
- 账本 lag 告警的严重级别应从「影响体验」上调为「影响告警完整性」

### 3.5 两类静默：告警屏蔽（Flink）与通知静默（平台）

> **v3.0 变更**：AM 不再持有任何 silence。屏蔽能力全部由 Flink 屏蔽算子承担；同时明确区分「告警屏蔽」与「通知静默」两类语义完全不同的静默，二者载体、执行点、后果均不同。

#### 3.5.1 两者的分界

| 维度 | 告警屏蔽（降噪） | 通知静默（免打扰） |
|------|------------------|--------------------|
| 决定什么 | 事件**是否成立** | 事件已成立，**是否叫人** |
| 执行位置 | **Flink** stage 2 屏蔽算子 | **平台** `notification_scheduler` |
| 配置载体 | `converge_rule`（`rule_type=mute`） | `alert_notify_mute` |
| 下发路径 | `alert.rule` compacted topic → broadcast | **不下发**，平台内存缓存 |
| 判定依赖 | 标签 + 时间窗 | `lifecycle_status`、`escalation_level`、`claimed_by` 等业务状态 |
| 是否入账本 | 是（`action=muted`, `emit=false`） | 是（`action=passed`, `emit=true`） |
| 是否进 `alert_event` | **否**——活跃告警列表看不到 | **是**——活跃告警列表可见 |
| 是否参与收敛计数 | 不参与（stage 2 就被拦） | **参与**（`converged_count` 照常增长） |
| 是否触发升级 | 不适用（无事件） | 否（升级计时暂停） |
| 原因记录 | `converge_rule.reason` → 账本 `rule_hits[].detail` | `alert_notify_mute.reason` |
| 匹配粒度 | 标签正则，可批量 | 精确到 alert_id / fingerprint，或标签批量 |
| 典型语义 | 「这批是已知问题 / 维护窗口，别产生告警」 | 「我在处理，别再催我」 |

一句话：**告警屏蔽决定这条告警存不存在，通知静默决定这条告警吵不吵。** 通知静默对 Flink 完全透明——Flink 不知道它的存在，因此被通知静默的告警仍正常参与收敛、正常入库、正常在列表可见。

**UI 必须把这句话原文写出来**，否则用户在关闭对话框里选错——②在告警列表里还看得见（只是不吵），③在告警列表里完全看不见（只能去账本查）。

#### 3.5.2 告警屏蔽（控制面板配置 → Flink 执行）

| 功能 | 描述 |
|------|------|
| 屏蔽规则创建 | 用户在控制面板 UI 创建（时间窗口 + 标签匹配，支持正则），**`reason` 强制填写** |
| 规则下发 | 写入 PG `converge_rule`（`rule_type=mute`），发布到 `alert.rule` compacted topic，Flink broadcast 热加载 |
| 屏蔽预览 | 创建前基于**账本历史事件**预览该规则会匹配哪些告警（v3.0：不再查 AM，AM 已无此数据） |
| 屏蔽历史 | 记录规则创建、修改、过期、撤销历史，含操作人与原因 |
| 屏蔽留痕 | 被屏蔽事件仍全量记入账本，`action=muted`，可在账本中检索「这条告警为什么没通知」 |

**相对 AM silence 的收益**：AM silence 会阻止告警进入下游，被屏蔽的告警在 AM 之后就彻底消失、无从审计；Flink 屏蔽发生在告警已进入平台侧之后，**事件完整留痕**。这是屏蔽下沉带来的额外收益，也是「降噪效果分析」（§3.8）能够量化屏蔽率的前提。

#### 3.5.3 通知静默（平台侧执行）

| 功能 | 描述 |
|------|------|
| 静默创建 | 三种来源：认领时勾选（`source='claim'`）、关闭时选择（`source='close'`）、独立创建（`source='manual'`） |
| 强制原因 | `reason` 不允许为空。事后追责与交接都靠它 |
| 强制期限 | `ends_at` 必填，**上限 7d**，超过需分次续期。「临时静默」三年后还在生效、没人记得为什么——这是监控系统的经典死法，与 DEC-RC-05 的静默失败同源 |
| 到期提示 | 到期前 10m，若该 fingerprint 仍在 firing → 提示「续期 / 解除 / 保持」，**不允许静默到期后突然开始吵而无人知晓** |
| 压制范围 | **只压催促类通知**（重复提醒、升级），**不压状态变更类通知**（resolved）。是否发恢复通知由 `notify_on_resolve` 独立决定，两个开关不会互相打架 |
| 升级计时 | 静默期间**暂停**：记 `remaining = next_escalation_at - now()`，置 `next_escalation_at = NULL`；解除时 `next_escalation_at = now() + remaining`。否则「静默 2 小时，一解除就立刻升到总监」 |

**静默安全阀（v3.0 决策，DEC-036）**：静默期间若事态显著恶化，强制解除并通知一次，记审计。触发条件任一：

- `converged_count` 相对静默时刻增长超过 10 倍
- 本告警所属收敛组被更高级作用域的根因抑制（说明出现了更大的故障）

理由：severity 变化会产生新 fingerprint（是一条新告警，不受原静默影响，自动就对了），但同一 fingerprint 下规模扩大 100 倍时，若严格尊重静默就变成了盲区。**宁可偶尔打扰，不可让静默成为盲区。**

**severity 变化的行为说明**：`severity` 是标签，变化即 fingerprint 变化 → 产生一条**新告警**，不受原静默影响、不受原认领影响。这是正确行为，需在 UI 上把新旧两条告警通过 `instance` + `alertname` 关联展示，避免运维以为是重复。

#### 3.5.4 静默相关的可观测性

| 指标 | 用途 |
|------|------|
| `alert_mute_active_count{type=notify\|alert}` | 当前生效的静默数，异常增长要告警 |
| `alert_muted_total{type, reason_category}` | 被静默压制的事件量，衡量降噪效果与滥用 |
| `alert_mute_expired_still_firing_total` | 静默到期时告警仍 firing 的次数，触发续期提示 |
| `alert_mute_safety_valve_triggered_total` | 安全阀触发次数，频繁触发说明静默被滥用或阈值配错 |

### 3.6 告警路由与通知（平台侧执行）

> **v3.0 变更**：AM 不再持有路由树与 receiver 配置（v2.0 已定），v3.0 进一步把**重复通知、自动升级、通知静默**全部落到平台侧的 `notification_scheduler`，并明确「通知策略变更永不触碰 Flink」。

#### 3.6.1 为什么通知策略不放 Flink

| 理由 | 说明 |
|------|------|
| **升级依赖认领状态** | 升级触发条件是 `claimed_at IS NULL AND now() - starts_at > 阈值`。`lifecycle_status` / `claimed_by` 是平台的可变业务状态，DEC-033 已定 `claim` 不进流。把它们搬进 Flink 等于让流状态成为平台操作表的镜像——同一事实两个权威源 |
| **通知是重 I/O 副作用** | 短信网关 429、退避重试、主渠道故障切备用、发送记录落库。放进 Flink 会让 checkpoint 被外部延迟拖住，checkpoint 慢直接反压收敛链路 |
| **变更频率差一个数量级** | 收敛规则是月级变更，路由与接收人是周级甚至日级。为改一个手机号去 broadcast 新规则或重启作业，运维成本不成比例 |
| **爆炸半径** | Flink 已是收敛环节的硬单点（MC-13）。把通知也放进去，等于让「没人被叫醒」和「降噪失效」共享同一故障域，且通知侧 bug 无法通过重启收敛作业隔离修复 |

**量级不是反对理由**：到达平台的事件已被 Flink 收敛过，通知调度器面对的是收敛后的量。若仍扛不住，正确的修法是提高收敛强度，不是把通知搬进 Flink。调度器本身可通过 `SKIP LOCKED` 水平扩展。

#### 3.6.2 路由与分级

| 功能 | 描述 |
|------|------|
| 路由规则定义 | 基于告警标签的路由树，平台侧存储与匹配 |
| 多级路由 | severity → team → 通知组 |
| 路由测试 | 给定告警标签，测试匹配哪条路由 |
| 默认路由 | **不可删除、永远兜底**。未匹配任何规则的告警走默认路由 |
| 通知聚合缓冲 | 通知发送前的短聚合窗口（默认 30s），把同一接收者的多条通知合并为一条消息 |
| 未匹配告警 | 暴露 `notify_no_route_matched_total`，**该指标本身要告警** |

**通知聚合缓冲与 Flink 收敛不重复**：Flink 收敛削减的是**事件量**（同类告警归并），平台缓冲合并的是**消息条数**（同一接收者 30s 内的多条不同告警合成一条钉钉消息）。两个不同层面，都需要。

**告警分级采用两层模型**，把「问题多严重」与「叫人叫多响」解耦：

| 层 | 名称 | 谁定 | 可变性 | 用途 |
|----|------|------|--------|------|
| L1 | `severity` | 告警规则（vmalert `labels.severity`），控制面板 → 规则分发 | 随规则版本变，事件生命周期内不变 | 路由树过滤、收敛/抑制规则匹配 |
| L2 | `notify_level` | 平台在通知时刻派生：`f(severity, converged_count, escalation_level, 未处理时长)` | 每次通知重算 | 选择渠道强度 |

L2 不落表，是路由匹配时算出的瞬时值。这样「一个收敛组代表 500 条子事件」可以自动比「代表 2 条」叫得更响，而不需要改规则。

**路由树示例：**

```
root route:
  ├── severity=critical ──▶ 通知组「核心业务值班」
  │   └── team=dba ──▶ 通知组「DBA 值班」
  │   └── team=network ──▶ 通知组「网络值班」
  ├── severity=warning ──▶ 通知组「日常运维」
  │   └── zone=edge-* ──▶ 通知组「边缘运维」
  ├── severity=info ──▶ 通知组「邮件归档」
  └── default（不可删除）──▶ 通知组「默认值班」
```

**receiver 的归属（闭环 notification-channel MC-12）**：`alert_route.receiver_id` 指向 `notification_group.group_id`。**告警管理定「发给哪个组」，通知渠道模块定「组里有什么、怎么发」。** 值班排班功能 v3.0 不做，通知组为静态成员组，升级链仍可用，只是组成员需人工维护。

#### 3.6.3 三级「重复通知」语义分离

这是最容易配错的地方——**三处都叫「重复」，语义完全不同**：

| # | 旋钮 | 位置 | 语义 | 值 | 是否触达人 |
|---|------|------|------|-----|-----------|
| 1 | AM `repeat_interval` | 存储域 AM | **下游状态续约心跳**：持续 firing 的告警周期性重新下发，防止 Flink keyed state TTL 过期后把老告警当新告警 | 4h（TTL 24h，6 次续约） | **否**——被 stage 3 吸收为 `renewed` |
| 2 | `rate_limit.dedup.window_seconds` | 通知渠道模块 | **投递幂等护栏**：同一通知请求重复到达时不重发 | 300s | 是（去重） |
| 3 | `alert_route.repeat_notify_s` | 本模块 | **人工重复提醒**：未处理告警的周期性再提醒 | 14400s | 是 |

三者必须独立配置。**#1 的续约事件绝不能变成人工通知**，否则每 4 小时 on-call 就被叫一次，`repeat_notify_s` 形同虚设——这正是 §3.2.3「续约吸收」存在的原因。

#2 在 `notification-channel.md` §3.4 中已改名为「投递幂等窗口」，避免与 #3 混淆。

#### 3.6.4 通知调度器（`notification_scheduler`）

平台侧新增组件，无状态、可多副本，扫描 `alert_event` 驱动重复通知与升级：

```sql
SELECT ... FROM alert_event
 WHERE lifecycle_status IN ('unclaimed','claimed','resolving')
   AND (next_escalation_at <= now() OR last_notify_at + repeat_notify_s <= now())
   AND NOT (notify_muted AND notify_mute_until > now())
 ORDER BY next_escalation_at NULLS LAST
 LIMIT n
 FOR UPDATE SKIP LOCKED
```

`SKIP LOCKED` 解决多副本竞争（PG 原生支持），无需选主。所需索引：`idx_escalation (lifecycle_status, next_escalation_at)`。

> **实现注**：`repeat_notify_s` 不是 `alert_event` 的列，它在 `alert_route` 上。上面的 SQL 为示意，实际实现需 join `alert_route`（或把匹配出的 `repeat_notify_s` / `escalation_policy_id` 在路由匹配时冗余写入 `alert_event`，避免调度扫描 join）。**推荐冗余写入**——调度器是高频扫描，join 路由表的代价随活跃告警数线性增长。

调度器承担四项职责：

| 职责 | 触发条件 | 动作 |
|------|----------|------|
| 重复通知 | `last_notify_at + repeat_notify_s <= now()` 且未静默 | 按原路由重发，`notify_kind='repeat'`，`notify_count++` |
| 自动升级 | `next_escalation_at <= now()` 且未静默 | 升级到 `escalation_policy.levels[n+1]`，见 §3.6.5 |
| 恢复处理 | 收到 resolved 事件 | 按 `auto_close_on_resolve` / `notify_on_resolve` 分支，见 §3.7.3 |
| 抑制解除补发 | 收到 `inhibit_released` | 延迟 `trace_settle_s` 后查账本补发，见 §3.3.3 |

#### 3.6.5 自动升级（闭环 MC-11）

**升级链的唯一权威是 `notification-channel.md` 的 `escalation_policy` 表。** v2.0 把升级配置散在三处，v3.0 收敛：

| 原位置 | 字段 | v3.0 处置 |
|--------|------|-----------|
| `alert_route.escalation_s` | 单个秒数阈值 | **删除**，改为 `escalation_policy_id` 外键 |
| `escalation_policy.levels` | 完整多级链 | **保留为唯一权威** |
| `notification_group.escalation_config` | 组内嵌升级配置 | **删除**，与 `escalation_policy` 重复且必然漂移 |

MC-11 三个待决问题的答案：

| MC-11 问题 | 答案 |
|------------|------|
| 升级到谁 | `escalation_policy.levels[n].target_group_id` → 通知组，逐级上移（一线 → 二线 → 负责人 → 总监） |
| 升级几次后停止 | `escalation_level >= max(levels)` **或** `lifecycle_status IN ('resolved','closed')`，两者任一即停 |
| 电话通知触发条件 | **不由 severity 直接决定，由升级级别决定**——`levels[n].channels` 含 `phone` 才打电话 |

最后一条是关键设计选择：同一套机制既能表达「critical 立刻电话」（把它的 level 1 配成 `delay=0, channels=[phone,sms]`），也能表达「warning 30 分钟没人理才打电话」。渠道强度是升级链的属性，不是 severity 的属性。

#### 3.6.6 恢复通知策略

| 决定 | 取值 | 理由 |
|------|------|------|
| 路由 | 沿用原告警 `alert_route` 匹配出的通知组 | 保证恢复通知到达同一批人 |
| 渠道强度 | **降级**：resolved 只发钉钉/企微/邮件，**不发短信/电话**，即使原 severity=critical | 问题已解决，不需要叫人 |
| 接收者范围 | 若 `escalation_level > 0`，发给**该 alert_id 历史上所有被通知过的人**，不只是当前级别 | 总监被叫醒了，应该告诉他问题好了 |

第三条需反查 `notification_record`（`WHERE alert_id = ? AND status='sent'`），已有 `idx_alert` 索引，成本可控。通知渠道模块需为此增加 resolved 专用模板变量：`{{.Duration}}`、`{{.EscalatedTo}}`、`{{.ClaimedBy}}`。

#### 3.6.7 维护模型

**核心性质：任何通知策略变更都不触碰 Flink。** Flink 只从 `alert.rule` 看收敛/抑制/屏蔽规则，通知策略永不进流。

| 配置对象 | 归属 | 变更频率 | 生效方式 |
|----------|------|----------|----------|
| `severity`（规则标签） | 规则定义 | 低 | 规则分发 → vmalert reload |
| `converge_rule`（收敛/抑制/屏蔽） | 本模块 | 低 | `alert.rule` → Flink broadcast |
| `alert_route`（路由树） | 本模块 | 中 | 平台内存缓存 + 版本号，秒级生效 |
| `escalation_policy`（升级链） | 通知渠道 | 中 | 同上 |
| `notification_group` / `channel` | 通知渠道 | 中（无值班表，成员需人工维护） | 同上 |
| AM config | 部署模板 | **极低** | 走发布流程，不走 UI |

维护工具：

1. **路由测试**（§3.6.2）+ **模板预览**（通知渠道模块）
2. **通知策略回放**（Phase 2）：拿账本最近 N 条事件跑一遍草稿策略，输出「会通知谁、几次、走哪些渠道」。账本已免费存在，这个工具几乎零额外成本，却是防止路由改错的最有效手段
3. **变更审计**：每次策略改动记录 actor + diff。理由与 DEC-RC-05 同类——**路由配错是静默失败**，告警被无声吞掉且没有任何报错。配合「默认路由不可删除」+ `notify_no_route_matched_total` 指标构成三道防线

### 3.7 告警认领与跟踪

#### 3.7.1 功能清单

| 功能 | 描述 |
|------|------|
| 告警列表 | 展示当前活跃告警（支持过滤/排序/分组），仅含 `emit=true` 的最终事件 |
| 告警认领 | 运维人员认领告警，标记「我正在处理」；**认领时同时配置三个正交开关**（见 §3.7.2） |
| 认领超时 | 超过阈值未认领，由 `notification_scheduler` 自动升级 |
| 处理记录 | 认领后可添加处理记录/备注 |
| 状态流转 | unclaimed → claimed → resolving → resolved → closed |
| 收敛组展开 | 从代表事件下钻查询账本，展示被收敛的全部明细 |
| 抑制链展开 | 展示 `root_event_id` 指向的根因告警，以及同一根因下的全部被抑制告警 |
| 手动关闭 | 触发单向清理，见 §3.9 |

**已认领告警同样参与收敛与抑制**（v2.0 决策，v3.0 保留）。认领不改变 Flink 行为，`alert.control` 不承载 `claim` 信号。理由：告警风暴的量级不允许为单个认领动作放开降噪；处理人需要明细时通过账本下钻获取，账本保留了全量事件。

#### 3.7.2 认领时的三个正交开关

| 开关 | 默认 | 语义 |
|------|------|------|
| `notify_muted` | false | 通知静默：事件照常产生入库，但压制**催促类**通知（重复提醒、升级）。写 `alert_notify_mute`，强制 `reason` + `ends_at` |
| `auto_close_on_resolve` | false | 收到 resolved 后是否自动关闭。默认 false——保守，不自动销毁人工上下文 |
| `notify_on_resolve` | true | 收到 resolved 后是否发恢复通知（策略见 §3.6.6） |

三者任意组合都合法。`notify_muted` 只压催促类、不压状态变更类，因此与 `notify_on_resolve` 不会互相打架——静默中的告警恢复时，只要 `notify_on_resolve=true` 仍会发恢复通知。

#### 3.7.3 生命周期状态机

```
  ┌───────────┐
  │  firing   │  ← Flink 输出最终事件（alert.converged, emit=true）
  └─────┬─────┘
        │
        ▼
  ┌───────────┐
  │ unclaimed │  ← 等待认领；scheduler 按 escalation_policy 计时
  └─────┬─────┘
        │ 运维人员认领（可勾选通知静默 / 自动关闭 / 恢复通知）
        ▼
  ┌───────────┐     超时未处理
  │  claimed  │ ──────────────▶ 升级通知（静默期间计时暂停）
  └─────┬─────┘
        │ 开始处理
        ▼
  ┌───────────┐
  │ resolving │  ← 处理中
  └─────┬─────┘
        │
        │ ◀── 收到 resolved（经 Flink 恢复延迟 + 组级裁决）
        ▼
  ┌───────────┐
  │ resolved  │  ← 保留 claimed_by/claimed_at 供 MTTR 统计
  └─────┬─────┘
        │
        ├─ auto_close_on_resolve=true ──▶ closed（closed_by='system:auto-resolve'）
        ├─ auto_close_on_resolve=false ──▶ 停在 resolved，等人确认
        │                                   兜底：resolved_after_close_s（默认 7d）后自动归档关闭
        └─ 人工关闭（可在任意 firing 态触发）──▶ closed + 单向清理（§3.9）
```

**resolved 不自动 closed**（v3.0 决策）。理由：resolved 是「指标恢复了」，closed 是「人确认这件事处理完了」，两者不是一回事——指标恢复可能是伪恢复（§3.11），也可能是临时缓解。但必须有 `resolved_after_close_s`（默认 7d）兜底归档，避免 resolved 事件无限堆积。

#### 3.7.4 关闭与静默的组合（三种，关闭对话框强制三选一）

| 选项 | 平台动作 | Flink 动作 | 下一个窗口的行为 |
|------|----------|------------|------------------|
| **① 不静默** | `closed`，发 `alert.control(close)` | 清 keyed state | vmalert 仍 firing → AM 重新下发 → Flink 无 state → **重新准入并正常通知**（告警复活） |
| **② 关闭 + 屏蔽通知** | `closed` + 写 `alert_notify_mute(source='close')` | 清 keyed state | 复活后**事件正常产生、入账本、进活跃列表**，通知调度器命中静默 → 不通知、不升级 |
| **③ 关闭 + 告警屏蔽** | `closed` + 下发 `converge_rule(type=mute, ttl_s=静默时长)` | 清 keyed state + 加载 mute 规则 | 复活后 Flink stage 2 命中 → `action='muted'`, `emit=false` → **只写账本，不进活跃列表，不通知** |

**复活是预期行为，不是缺陷。** 静默的作用不是防止复活，而是控制复活之后的行为。若关闭时不选静默，下一个窗口告警重新出现并正常通知——这正确反映了「问题还在」。

配套指标 `alert_revived_after_close_total`：关闭后复活次数。占比过高说明规则阈值配得不合理（关不掉的问题不该靠关闭处理），是规则调优的输入信号。

**为什么 v3.0 不再需要 AM silence**：v2.0 依赖 AM silence 阻止重推。v3.0 中 AM 零配置、平台不回调 AM API，选项③改由 Flink mute 规则拦截。代价是被屏蔽告警仍会走完 vmalert → AM → am-bridge → Kafka → Flink 才被拦下，但 AM 对持续 firing 告警每 `repeat_interval=4h` 才重发一次，10 万条被屏蔽告警也只产生约 7 events/sec，Flink 在 stage 2 一次 broadcast 查表后丢弃——**代价可忽略**。

### 3.8 告警历史与分析

| 功能 | 描述 | 数据源 |
|------|------|--------|
| 告警历史查询 | 按时间范围、标签、状态查询历史告警 | 运营表 `alert_event` |
| 明细下钻 | 展开收敛组、抑制链、被屏蔽事件 | 账本表 `alert_event_trace` |
| MTTR 统计 | 从 firing 到 resolved 的平均修复时间 | 运营表 |
| 告警频率分析 | 各规则/网区/实例的告警频率 | 账本表（含被收敛的原始量） |
| **降噪效果分析** | 收敛率、抑制率、屏蔽率、去重率，按规则维度统计 | 账本表（`action` 分布 + `rule_hits`） |
| 误报率分析 | 触发后快速关闭（< 5min）的比例 | 运营表 |
| Top-N 告警 | 最频繁的告警规则/实例/根因 | 账本表 |
| 告警趋势 | 告警数量时间趋势（原始量 vs 最终量双线） | 账本表 + 运营表 |

**降噪效果分析是 v2.0 新增的关键能力**：因为账本保留了全量事件与命中规则，平台首次能够量化回答「这条收敛规则拦掉了多少噪声」「这个根因抑制了多少子告警」，从而支撑规则的持续调优。这是把处理轨迹落库而非只留在 Flink 状态里的直接收益。

### 3.9 关闭与状态清理（单向）

> **v3.0 变更**：DEC-033 的「双向清理」（Flink 状态 + AM silence）改为**单向清理**。AM 零配置化后平台不再回调 AM API，且 AM 状态是自清理的（`resolve_timeout` 兜底回收），无需外部干预。

```
运维人员点击关闭（三选一，见 §3.7.4）
        │
        ├─▶ ① 发布 alert.control：{type:"close", fingerprint, dedup_key, alert_id, operator, at}
        │      Flink 收到后：
        │        · 按 fingerprint 查出 dedup_key，二次 keyBy 到主流分区（§3.3.1）
        │        · 清除该 dedup_key 的 keyed state（去重 / 收敛 / 恢复延迟状态）
        │        · 从活跃收敛组的 MapState 中摘除该成员；若组内已空则回收组
        │        · 若该事件是根因，从 broadcast activeRoots 移除并侧输出 inhibit_released
        │        · 账本回填 state_cleared_at
        │
        ├─▶ ② 若选择「屏蔽通知」：写 alert_notify_mute(source='close', reason, ends_at)
        │      若选择「告警屏蔽」：下发 converge_rule(type=mute, reason, ttl_s=ends_at)
        │      若不静默：跳过
        │
        └─▶ ③ 更新平台运营表 lifecycle_status = closed，记录 closed_by / closed_at
```

**为什么 Flink 状态必须通过 control topic 清理**：Flink 的 keyed state 无法从外部直接删除——Queryable State 已废弃，State Processor API 仅支持离线批处理。唯一可行的在线方式是向同一 keyed 流注入控制事件，由算子内部执行 `state.clear()`。这是设计约束，不是可选项。

**`alert.control` 必须携带 `dedup_key`**：v3.0 引入 `dedup_key` 后，主流在 stage 3 之后按 `dedup_key` 分区，而平台只天然持有 `fingerprint`。control 消息若只带 fingerprint，无法路由到正确的 subtask，清理会静默失效。平台从 `alert_event` 读出 `dedup_key` 一并写入 control 消息。

**清理完整性无法外部校验（接受的残留风险）**：Flink keyed state 没有对外可查接口，无法验证某 fingerprint 的状态是否真的清干净了。兜底措施：

| 措施 | 说明 |
|------|------|
| 状态 TTL | 全部 keyed state 挂 TTL（24h），泄漏状态自然回收 |
| 活跃计数指标 | Flink 导出活跃 dedup_key 数、活跃根因数、收敛组数与组内成员数等指标 |
| 定期核对 | 平台侧活跃告警集合与 Flink 导出的活跃计数周期性比对，偏差超阈值告警 |
| 复活计数 | `alert_revived_after_close_total` 异常升高，间接说明清理生效但源头仍在评估（预期行为）或清理未生效（缺陷） |

### 3.10 链路可用性与带外监控

**Flink 是告警链路的硬单点**（v2.0 决策：不做降级旁路）。它故障时 `alert.converged` 断流，运维人员收不到告警。不做旁路的理由是：Flink 故障时把 `alert.raw` 全量放给平台，等于在最糟的时刻制造最大的一波噪声风暴——未去重、未收敛、未抑制的原始告警直接冲击通知渠道，比断流更危险。

#### 3.10.1 带外心跳必须覆盖整条存储侧链路（v3.0 扩展，DEC-033 修订）

v2.0 的带外心跳只覆盖 Flink。这是不够的——**存储侧链路故障的后果比 Flink 故障更严重**：

| 组件故障 | 后果 | 危险程度 |
|----------|------|----------|
| Flink 挂掉 | `alert.converged` 断流，收不到新告警 | 高（吵→静） |
| am-bridge / Kafka 挂掉 | 同上 | 高 |
| **vmalert 挂掉** | 停止向 AM 推送 → `resolve_timeout`(30m) 后 AM 把该 vmalert 名下**全部告警判定 resolved** → **全量伪恢复 + 全量静默** | **极高** |
| **vmstorage / vmselect 挂掉** | vmalert 表达式查不到数据 → 结果为空 → 同样全量伪恢复 | **极高** |
| **Alloy 挂掉** | 指标断流 → 同上 | **极高** |

Flink 挂掉是「降噪失效」（原本吵），存储侧挂掉是「告警全清」（彻底静）。**后者危险一个量级，而它在 v2.0 中没有被覆盖。**

| 措施 | 优先级 | 说明 |
|------|--------|------|
| **带外心跳监控** | **必须** | 覆盖 **Alloy 上报存活 / vmstorage / vmselect / vmalert / AM / am-bridge / Kafka / Flink** 全链路，每 10s 向独立于本链路的通道发送心跳指标；超时即触发 critical「告警链路中断」 |
| **硬编码最小通知路径** | **必须** | 心跳告警**不经路由策略、不经 Flink、不经 Kafka**，直连短信/电话给平台管理员。理由：故障的可能正是路由策略本身，或 Flink 本身。这条路径必须在代码里写死，不可配置 |
| Flink 作业 HA | 必须 | Standby JobManager + checkpoint 落可靠存储（S3/OSS/HDFS），故障自动 failover |
| 链路水位告警 | 必须 | 各 topic consumer lag、checkpoint 时长与失败率、backpressure、broadcast 根因条数、收敛组成员数 |
| 伪恢复比例告警 | 必须 | `alert_resolved_by_reason_total{reason="data_missing"}` 占比突增 = 采集链路出问题的信号（§3.11.4） |
| AM 侧兜底信号 | 建议 | bridge 或 Kafka 不可达时 AM webhook 失败重试并暴露失败计数，作为链路中断的第二信号源 |
| 账本 worker lag | 必须 | 独立告警，目标 P95 < 10s（影响明细下钻与抑制解除补发） |
| 恢复对账 | 必须 | 从 checkpoint 恢复后 `read_committed` 保证不重复投递；平台按 `event_id` 幂等入库；恢复期漏掉的告警由 AM `repeat_interval` 重发自然补回 |

### 3.11 告警恢复语义

#### 3.11.1 恢复的五层责任

「恢复」在链路上有五层含义，混在一起是多数恢复相关缺陷的来源：

| 层 | 触发条件 | 是否权威 | 时延 | 关键参数 |
|----|----------|----------|------|----------|
| L1 vmalert | 本轮评估表达式为空 | **权威源头** | 即时（无反向延迟） | `group_interval` |
| L2 AM 显式 | 收到 vmalert 推的 `status: resolved` | 透传 | 即时 | receiver `send_resolved: true` |
| L3 AM 隐式 | `resolve_timeout` 内未收到该 fingerprint 更新 | **兜底，非主路径** | 30m | `resolve_timeout` |
| L4 Flink | 恢复延迟 + 抖动裁决 + 组级裁决 + 抑制解除 | **最终裁决** | `resolve_hold_s` | 见 §3.3.6 / §3.3.7 |
| L5 平台 | 人工关闭 / resolved→closed 流转 | 业务终态 | 人工 | `auto_close_on_resolve`、`resolved_after_close_s` |

**核心认知：L1 是「信号」，L4 才是「决定」。** vmalert 说恢复了不代表要通知运维恢复了——中间要过抖动裁决、组级裁决、抑制解除裁决。

**Flink keyed state TTL 过期不是恢复**（常见误解）。TTL 过期只是状态回收，不产生 resolved 事件；若告警仍在 firing 而 state 过期，下一条事件会被当作新告警重新准入 → 重复通知。这正是 `repeat_interval(4h) < TTL(24h)` 约束存在的原因。

#### 3.11.2 「无数据即恢复」是默认语义，且是危险的

**在 Prometheus/vmalert 语义下，「恢复」不是独立信号，而是「本轮评估表达式结果为空」的推论。** 表达式为空有两种原因——条件不再成立（真恢复），或者**样本消失了**（伪恢复）。vmalert 层面无法区分这两者。

后果：exporter 挂了、网络断了、采集任务被误删，`tablespace_usage > 85` 会**静默 resolved**，把一个正在处理的活告警清掉。

评估过的三条治理路径：

| 方案 | 做法 | 结论 |
|------|------|------|
| **A：接受默认语义 + 强制看门狗（选定）** | 每条阈值规则配套 `up == 0` 或 `absent()` 告警 | **可行** |
| B：Flink 区分 `resolved_because_empty` / `resolved_because_condition_false` | 让下游知道恢复原因 | **不可行**——AM webhook 与 vmalert 都不携带该信息，除非改 vmalert |
| C：规则写成 `(expr) and on(instance) up == 1` | 试图用表达式规避 | **无效**——`and` 在无数据时结果仍为空，照样 resolved，等于没改 |

**方案 A 的落地形式**（复用 DEC-RC-05「拓扑标签不得剥离」的同一套治理逻辑——把静默失败挡在规则发布环节，而非运行环节）：

控制面板创建/编辑告警规则时，**强制回答「指标缺失时的期望行为」**，三选一，不填不允许发布：

| 选项 | 覆盖场景 | 成本 |
|------|----------|------|
| 1：配套 `up == 0` 看门狗 | exporter / 网络整体中断（最常见） | 低，可按采集任务批量生成 |
| 2：配套 `absent(metric)` 看门狗 | exporter 活着但该指标消失（采集插件坏了、label 改名了） | 高，只对关键指标做 |
| 3：显式声明「可容忍伪恢复」 | info 级、非关键指标 | 零，但留审计记录 |

**已有的逐级抑制恰好让大规模伪恢复变得无害**：交换机挂掉 → 下挂实例指标消失 → 一批告警伪恢复 + 一批 `up == 0` 告警 firing → 交换机根因告警 firing → 逐级抑制把 `up == 0` 子告警压掉。运维最终看到「1 条根因告警 + 一批恢复」，这是**正确**结果。危险只存在于孤立的单点缺失（无父设备告警），而那正是 `up == 0` 看门狗覆盖的场景。

#### 3.11.3 抖动无法在规则层根治

`for:` 只延迟 firing，**不延迟 resolved**。表达式一空告警立刻 resolved，指标在阈值附近徘徊时产生 fire→resolve→fire 高频抖动。规则层无解（迟滞阈值需拆两条规则 + recording rule 做状态保持，复杂度不值当），**必须在 Flink stage 6 治**，见 §3.3.6。

#### 3.11.4 区分真恢复与伪恢复（`resolved_reason`）

方案 B 已判定不可行，但**平台可以推断**：resolved 事件入库时异步查一次 vmselect，看该 instance 在 `[resolved_at - 10m, resolved_at]` 区间是否有样本、`up` 值为何。

| 推断结果 | `resolved_reason` |
|----------|-------------------|
| 区间内有样本且 `up == 1` | `condition_cleared`（真恢复） |
| 区间内无样本，或 `up == 0` | `data_missing`（伪恢复，需关注） |
| 来自 AM `resolve_timeout` 隐式路径 | `resolve_timeout` |
| 人工关闭 | `manual_close` |
| 命中 mute / 静默 | `silenced` |

成本：每条 resolved 一次 vmselect 查询（resolved 量远小于 firing 量）。**Phase 2 实现，但字段 v3.0 就留出**——事后给按天分区的账本表加字段代价高得多。

配套指标 `alert_resolved_by_reason_total{reason=...}`：`data_missing` 占比突增就是采集链路出问题的信号，**该指标本身要告警**，并已列入 §3.10.1 带外监控。

#### 3.11.5 参数排序不变式

```
scrape_interval (15~60s)
  < vmalert group_interval (~1m，vmalert 每轮向 AM 推全量 firing)
    < Flink resolve_hold_s (60s)
      < AM resolve_timeout (30m)
        < AM repeat_interval (4h)
          < Flink dedup_key state TTL (24h)
```

| 参数 | 位置 | 默认 | 说明 |
|------|------|------|------|
| `resolve_hold_s` | Flink stage 6 | 60s | 恢复延迟，治抖动 |
| `flapping_threshold_n` | Flink stage 6 | 3 | 抖动锁定阈值 |
| `flapping_window_s` | Flink stage 6 | 600s | 抖动计数窗口 / 锁定解除的稳定期 |
| `converge_group_max_members` | Flink stage 4 | 1000 | 组内成员上限，超出拆组 |
| `grace_s` | Flink stage 5 | 60s | 根因 resolved 后的解禁宽限 |
| `trace_settle_s` | 平台 | 15s | 账本落库等待，供抑制解除补发查询 |
| `resolve_timeout` | AM | **30m**（原 5m） | 隐式恢复兜底 |
| `repeat_interval` | AM | 4h | 续约心跳 |
| Flink state TTL | Flink | 24h | 必须 > `repeat_interval` |
| `notify_buffer_s` | 平台 | 30s | 通知聚合缓冲 |
| `repeat_notify_s` | 平台 | 14400s | 人工重复提醒 |
| `resolved_after_close_s` | 平台 | 7d | resolved 未人工关闭时的兜底归档 |
| `mute max ttl` | 平台 / Flink | 7d | 静默上限，不允许永久 |

**该不变式必须在配置加载时校验，违反则拒绝启动。** 这类「参数排序错了链路就自相矛盾」的约束靠人记不住——例如 TTL 小于 `repeat_interval` 会导致老告警被反复当作新告警重新通知，且现象与「去重失效」难以区分。

## 四、核心数据模型

### 4.1 AlertEvent（运营表 — 最终告警事件）

仅存 `emit=true` 的最终事件。**可变**（认领/通知/关闭反复更新状态），因此固定使用 PG，不迁移到列式存储。

```sql
CREATE TABLE alert_event (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    alert_id         VARCHAR(64)   NOT NULL UNIQUE,    -- 全局告警 ID
    event_id         VARCHAR(64)   NOT NULL,           -- Flink 输出的事件 ID（幂等键）
    fingerprint      VARCHAR(64)   NOT NULL,           -- 告警指纹
    source_zone_id   VARCHAR(64)   NOT NULL,
    source_storage   VARCHAR(64),                      -- 来源存储实例
    source_am        VARCHAR(64),                      -- 来源 AM 实例
    status           ENUM('firing', 'resolved')        NOT NULL,
    lifecycle_status ENUM('unclaimed', 'claimed', 'resolving',
                         'resolved', 'closed')
                     NOT NULL DEFAULT 'unclaimed',
    alertname        VARCHAR(128)  NOT NULL,
    severity         ENUM('critical', 'warning', 'info') NOT NULL,
    dedup_key        VARCHAR(64),                      -- v3.0：跨域去重键（§3.2.1），alert.control 需携带
    labels           JSON          NOT NULL,
    annotations      JSON,
    topo_scope       JSON,                             -- 拓扑作用域（冗余存储，便于关联查询）
    starts_at        TIMESTAMP     NOT NULL,
    ends_at          TIMESTAMP,
    claimed_by       VARCHAR(64),
    claimed_at       TIMESTAMP,
    resolved_at      TIMESTAMP,
    resolved_reason  ENUM('condition_cleared', 'data_missing', 'resolve_timeout',
                          'manual_close', 'silenced'),  -- v3.0：Phase 2 回填，字段先留（§3.11.4）
    closed_by        VARCHAR(64),
    closed_at        TIMESTAMP,
    -- v2.0：收敛与抑制关联
    converge_group_id VARCHAR(64),                     -- 收敛组 ID（本条为代表事件）
    converged_count   INT           DEFAULT 0,         -- 该组收敛的事件数
    inhibited_by      VARCHAR(64),                     -- 抑制本条的根因 event_id
    root_event_id     VARCHAR(64),                     -- 关联根因（由 scope_root_declared 回填）
    inhibit_released  BOOLEAN       NOT NULL DEFAULT FALSE,  -- v3.0：本条是抑制解除后的补发
    ai_rca            JSON,                            -- AI 分析结果（Phase 2）
    has_trace         BOOLEAN       NOT NULL DEFAULT TRUE,  -- 账本中是否有明细
    -- v3.0：升级与通知（§3.6.4 / §3.6.5）
    escalation_policy_id VARCHAR(64),                  -- 绑定的升级策略（唯一权威在 notification-channel）
    escalation_level  INT           NOT NULL DEFAULT 0,-- 已升级到第几级
    next_escalation_at TIMESTAMP,                      -- 下次升级时间；静默期间置 NULL
    escalation_paused_at TIMESTAMP,                    -- 静默开始时刻，用于解除时重算剩余时间
    last_notify_at    TIMESTAMP,                       -- 上次人工通知时间（repeat_notify_s 基准）
    notify_count      INT           NOT NULL DEFAULT 0,
    -- v3.0：认领期开关与通知静默（§3.7.2 / §3.5.3）
    auto_close_on_resolve BOOLEAN   NOT NULL DEFAULT FALSE,
    notify_on_resolve     BOOLEAN   NOT NULL DEFAULT TRUE,
    notify_muted          BOOLEAN   NOT NULL DEFAULT FALSE,  -- 缓存自 alert_notify_mute，同事务写入
    notify_mute_until     TIMESTAMP,
    created_at       TIMESTAMP     NOT NULL,
    updated_at       TIMESTAMP     NOT NULL,
    INDEX idx_fingerprint (fingerprint),
    INDEX idx_dedup_key (dedup_key),
    INDEX idx_zone_status (source_zone_id, status),
    INDEX idx_lifecycle (lifecycle_status),
    INDEX idx_starts (starts_at),
    INDEX idx_converge_group (converge_group_id),
    INDEX idx_root_event (root_event_id),
    INDEX idx_escalation (lifecycle_status, next_escalation_at),  -- scheduler 扫描主索引
    INDEX idx_repeat_notify (lifecycle_status, last_notify_at)
);
```

**`notify_muted` / `notify_mute_until` 是缓存，不是权威源。** 权威源是 `alert_notify_mute` 表（§4.5），二者由**同一事务**写入。冗余的目的是让 `notification_scheduler` 的扫描避免 join 大表——扫描条件可直接写成 `AND NOT (notify_muted AND notify_mute_until > now())`。

### 4.2 AlertEventTrace（账本表 — 全量事件与处理轨迹）

**Append-only，不可变**。前期 PG 按天分区，量级触发后迁移 ClickHouse（见 §6.6）。

```sql
CREATE TABLE alert_event_trace (
    event_id          VARCHAR(64)   NOT NULL,
    recv_at           TIMESTAMP(3)  NOT NULL,           -- 分区键
    fingerprint       VARCHAR(64)   NOT NULL,
    dedup_key         VARCHAR(64),                      -- v3.0：跨域去重键
    status            ENUM('firing', 'resolved') NOT NULL,
    action            ENUM('passed', 'deduped', 'renewed', 'converged', 'inhibited',
                           'muted', 'resolve_held', 'flapping_locked') NOT NULL,
    emit              BOOLEAN       NOT NULL,
    alertname         VARCHAR(128)  NOT NULL,
    severity          VARCHAR(16),
    source_zone_id    VARCHAR(64),
    source_storage    VARCHAR(64),
    source_am         VARCHAR(64),
    labels            JSON          NOT NULL,
    annotations       JSON,
    topo_scope        JSON,
    rule_hits         JSON,                             -- 命中的规则（含 rule_id/type/version/detail/reason）
    converge_group_id VARCHAR(64),
    converged_count   INT,
    dedup_of          VARCHAR(64),                      -- 跨域去重时保留事件的 event_id
    inhibited_by      VARCHAR(64),
    scope_matched     VARCHAR(128),                     -- 命中的作用域，如 switch:sw-east-01
    resolved_reason   VARCHAR(32),                      -- v3.0：Phase 2 回填（§3.11.4）
    ai_rca            JSON,
    flink_job_version VARCHAR(32),
    starts_at         TIMESTAMP,
    ends_at           TIMESTAMP,
    raw_payload       JSON,                             -- AM 原始 webhook 载荷
    state_cleared_at  TIMESTAMP,                        -- 被 alert.control 清理时回填
    PRIMARY KEY (event_id, recv_at),
    INDEX idx_trace_fingerprint (fingerprint, recv_at),
    INDEX idx_trace_dedup_key (dedup_key, recv_at),
    INDEX idx_trace_converge (converge_group_id),
    INDEX idx_trace_action (action, recv_at),
    INDEX idx_trace_alertname (alertname, recv_at),
    INDEX idx_trace_root (inhibited_by)                 -- 抑制解除补发的查询路径（§3.3.3）
) PARTITION BY RANGE COLUMNS(recv_at) (
    -- 按天分区，由定时任务预创建并滚动清理
);
```

**`action` 枚举在 v3.0 的变化**：

| 值 | 状态 | 含义 |
|----|------|------|
| `passed` / `deduped` / `converged` / `inhibited` / `muted` | v2.0 保留 | — |
| ~~`flapping_suppressed`~~ | **删除** | 被 `resolve_held` + `flapping_locked` 取代（§3.3.6 的两阶段设计） |
| `renewed` | **新增** | AM 按 `repeat_interval` 重发的续约，刷新 TTL 后只写账本不下传（§3.2.3） |
| `resolve_held` | **新增** | resolved 被 `resolve_hold_s` timer 暂扣，尚未裁决 |
| `flapping_locked` | **新增** | 抖动锁定期间的 fire/resolve，只写账本不 emit |

`inhibit_released` 不是 `action` 值——它是 stage 5 侧输出的**独立消息类型**（`msg_type`），走 `alert.converged`，不落账本的 action 维度。

### 4.3 ConvergeRule（动态规则 — 收敛/抑制/屏蔽/抖动/去重）

规则存 PG，发布到 `alert.rule` compacted topic，Flink broadcast 热加载。**版本号单调递增**，Flink 以版本判定新旧，避免乱序覆盖。

```sql
CREATE TABLE converge_rule (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    rule_id          VARCHAR(64)   NOT NULL UNIQUE,
    rule_name        VARCHAR(128)  NOT NULL,
    rule_type        ENUM('dedup', 'converge', 'inhibit',
                          'mute', 'flapping') NOT NULL,
    priority         INT           NOT NULL DEFAULT 100,  -- 数值小者优先
    matchers         JSON          NOT NULL,              -- 标签匹配（支持正则）
    scope_keys       JSON,                                -- 作用域标签: ["switch_id","host_id"]
    window_s         INT,                                 -- 收敛/抖动窗口
    threshold_n      INT,                                 -- 收敛/抖动阈值
    root_alertnames  JSON,                                -- inhibit: 根因告警名集合
    grace_s          INT           DEFAULT 60,            -- inhibit: 根因 resolved 后的宽限期
    ttl_s            INT,                                 -- 状态 TTL
    -- v3.0 新增：恢复与抖动（§3.3.6 / §3.11.5），按规则粒度覆盖全局默认
    resolve_hold_s   INT,                                 -- 恢复延迟，NULL 则用全局默认 60s
    flapping_threshold_n INT,                             -- 抖动锁定阈值，默认 3
    flapping_window_s INT,                                -- 抖动计数窗口，默认 600s
    converge_group_max_members INT,                       -- 收敛组成员上限，默认 1000
    reason           VARCHAR(512),                        -- mute 类型强制填写（§3.5.2）
    enabled          BOOLEAN       NOT NULL DEFAULT TRUE,
    version          BIGINT        NOT NULL,              -- 单调递增，broadcast 用
    created_by       VARCHAR(64),
    updated_by       VARCHAR(64),
    created_at       TIMESTAMP     NOT NULL,
    updated_at       TIMESTAMP     NOT NULL,
    INDEX idx_rule_type (rule_type, enabled),
    INDEX idx_rule_version (version)
);
```

**发布期校验**（控制面板在写入前强制检查，不通过则拒绝发布）：

| 规则类型 | 校验项 |
|----------|--------|
| `mute` | `reason` 非空；`ttl_s ≤ 7d`（不允许永久屏蔽）；预览匹配结果需操作者确认 |
| `inhibit` | `root_alertnames` 非空；`scope_keys` 非空；`grace_s ≥ resolve_hold_s`（否则解禁信号早于根因恢复通知，UI 上因果倒置） |
| `converge` | `window_s`、`threshold_n` 非空；`converge_group_max_members ≤ 10000` |
| 全部 | 规则不得裁剪拓扑标签的作用域键（否则 RCA 静默失效，同 DEC-RC-05） |

### 4.4 AlertRoute（告警路由规则 — 平台侧执行）

> **v3.0 变更**：`escalation_s` 删除，改为 `escalation_policy_id` 外键——升级配置收敛到 `escalation_policy` 唯一权威（§3.6.5）。`receiver_id` 明确指向通知渠道模块的 `notification_group.group_id`。

```sql
CREATE TABLE alert_route (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    route_name       VARCHAR(128)  NOT NULL,
    matchers         JSON          NOT NULL,
    receiver_id      VARCHAR(64)   NOT NULL,           -- → notification_group.group_id
    escalation_policy_id VARCHAR(64),                  -- → escalation_policy.policy_id（通知渠道模块）
    notify_buffer_s  INT           DEFAULT 30,         -- 通知聚合缓冲窗口
    repeat_notify_s  INT           DEFAULT 14400,      -- 人工重复提醒间隔（§3.6.3 的第 3 级）
    require_claim    BOOLEAN       DEFAULT FALSE,      -- 是否强制认领（§6.9）
    is_default       BOOLEAN       NOT NULL DEFAULT FALSE,  -- 默认路由，不可删除（§3.6.2）
    continue         BOOLEAN       DEFAULT FALSE,
    parent_id        BIGINT,
    enabled          BOOLEAN       NOT NULL DEFAULT TRUE,
    version          BIGINT        NOT NULL,           -- 平台内存缓存按版本号刷新
    created_at       TIMESTAMP     NOT NULL,
    updated_at       TIMESTAMP     NOT NULL,
    UNIQUE INDEX idx_default (is_default)              -- 配合应用层保证只有一条默认路由
);
```

**`is_default` 的路由不可删除、不可禁用**（应用层强制）。这是「路由配错导致告警被静默吞掉」的最后一道防线，另两道是 `notify_no_route_matched_total` 指标与变更审计（§3.6.7）。

### 4.5 AlertNotifyMute（通知静默 — v3.0 新增）

平台侧载体，**不下发到 Flink、不下发到任何区域 AM**。语义与 `converge_rule(type=mute)` 的区别见 §3.5.1。

```sql
CREATE TABLE alert_notify_mute (
    id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
    mute_id       VARCHAR(64)  NOT NULL UNIQUE,
    scope_type    ENUM('alert','fingerprint','label') NOT NULL,
    alert_id      VARCHAR(64),                    -- scope_type='alert'
    fingerprint   VARCHAR(64),                    -- scope_type='fingerprint'
    matchers      JSON,                           -- scope_type='label'
    reason        VARCHAR(512) NOT NULL,          -- 强制，不允许空
    starts_at     TIMESTAMP    NOT NULL,
    ends_at       TIMESTAMP    NOT NULL,          -- 强制，上限 7d，不允许永久
    source        ENUM('claim','close','manual') NOT NULL,   -- 三种创建来源（§3.5.3）
    created_by    VARCHAR(64)  NOT NULL,
    status        ENUM('active','expired','revoked') NOT NULL DEFAULT 'active',
    created_at    TIMESTAMP    NOT NULL,
    updated_at    TIMESTAMP    NOT NULL,
    INDEX idx_scope (scope_type, fingerprint, ends_at),
    INDEX idx_active (status, ends_at)            -- 到期前 10m 提示的扫描索引
);
```

### 4.6 AlertAnalytics（告警分析统计）

```sql
CREATE TABLE alert_analytics (
    id                 BIGINT       PRIMARY KEY AUTO_INCREMENT,
    alertname          VARCHAR(128) NOT NULL,
    zone_id            VARCHAR(64),
    instance_id        VARCHAR(64),
    period_start       TIMESTAMP    NOT NULL,
    period_end         TIMESTAMP    NOT NULL,
    total_raw_events   INT          NOT NULL DEFAULT 0,  -- v2.0：账本原始事件数
    total_emitted      INT          NOT NULL DEFAULT 0,  -- v2.0：最终输出数
    dedup_count        INT          DEFAULT 0,
    renewed_count      INT          DEFAULT 0,           -- v3.0：续约吸收数（§3.2.3）
    converged_count    INT          DEFAULT 0,
    inhibited_count    INT          DEFAULT 0,
    muted_count        INT          DEFAULT 0,           -- 告警屏蔽（Flink）
    notify_muted_count INT          DEFAULT 0,           -- v3.0：通知静默（平台）
    flapping_count     INT          DEFAULT 0,
    revived_count      INT          DEFAULT 0,           -- v3.0：关闭后复活次数
    false_resolve_count INT         DEFAULT 0,           -- v3.0：resolved_reason='data_missing'
    false_positives    INT          DEFAULT 0,
    escalated_count    INT          DEFAULT 0,           -- v3.0：触发升级的告警数
    avg_resolve_time_s INT,
    max_resolve_time_s INT,
    INDEX idx_period (period_start, period_end)
);
```

`total_raw_events` 与 `total_emitted` 的比值即降噪率，是评估规则有效性的核心指标。`revived_count` 占比过高说明规则阈值配得不合理（关不掉的问题不该靠关闭处理）；`false_resolve_count` 占比突增说明采集链路有问题（§3.11.4）。

## 五、接口与交互

### 5.1 上游依赖

| 来源 | 交互内容 | 协议 |
|------|----------|------|
| `alert.converged` (Kafka) | Flink 输出的最终告警事件 + `scope_root_declared` + `inhibit_released` | Kafka 消费（read_committed） |
| 控制面板 UI | 收敛/抑制/屏蔽规则配置；路由与通知策略配置 | HTTP API |
| CMDB | 拓扑数据同步 → `instance.labels` 富化 | 定时同步 / CDC |
| vmselect | `resolved_reason` 推断查询（Phase 2，§3.11.4） | PromQL HTTP API |
| 实例状态维护 | 实例状态变更事件（可选告警源） | 内部事件 |
| 运维人员 | 告警认领/关闭/静默操作 | REST API |

> **v3.0 删除**：原「Alertmanager API — 手动关闭时创建 silence」一行已移除。AM 零配置化后平台不再回调 AM（DEC-037），关闭改为单向清理 Flink 状态（§3.9）。

### 5.2 下游提供

| 消费方 | 提供内容 | 协议 |
|--------|----------|------|
| `alert.control` (Kafka) | 关闭信号（含 `fingerprint` + `dedup_key`），供 Flink 清理状态 | Kafka 生产 |
| `alert.rule` (Kafka) | 规则变更，供 Flink broadcast 热加载 | Kafka 生产 |
| 通知渠道管理 | 通知请求（告警内容 + 通知组 + `notify_kind` + `notify_level`） | 内部 API / 消息队列 |
| Web UI | 告警列表、详情、明细下钻、历史、分析 | REST API |
| Grafana | 告警面板数据 | REST API |

### 5.3 Kafka Topic 契约

单 Kafka 集群，六个 topic。**不引入第二套 MQ**——两个 broker 意味着两套 offset 管理、两处 lag 告警、两套故障域，而单集群双 topic 提供同等的解耦能力。

| topic | 生产者 | 消费者 | key | 类型 | 保留 | 用途 |
|-------|--------|--------|-----|------|------|------|
| `alert.raw` | am-bridge | Flink | `dedup_key` | 普通 | 7d | AM 去重后的原始告警；bridge 注入 `dedup_key`（§3.2.1） |
| `alert.rule` | 控制面板 | Flink (broadcast) | rule_id | **compacted** | 永久 | 动态规则下发；compacted 保证 Flink 重启可全量 bootstrap（并配合 `open()` PG seed，见 MC-15） |
| `alert.topo` | CMDB 同步 | Flink (broadcast) | instance_id | **compacted** | 永久 | 实时拓扑变更（可选，默认不用） |
| `alert.control` | 平台 | Flink | fingerprint | 普通 | 7d | 关闭信号 → 清理 keyed state；消息体**必须含 `dedup_key`**（§3.9） |
| `alert.event` | Flink | 账本 worker | fingerprint | 普通 | 7d | 全量事件 + 处理轨迹 |
| `alert.converged` | Flink | 平台告警管理 | fingerprint | 普通 | 7d | 最终事件 + `scope_root_declared` + `inhibit_released` |

> **v3.0 变更**：`alert.raw` 的 key 由 `fingerprint` 改为 `dedup_key`。跨域重复的两条告警 fingerprint 不同（`zone` 标签不同）但 `dedup_key` 相同，改 key 后它们落到同一分区，stage 3 的 first-wins 才能在单 subtask 内完成裁决——**否则两条副本在不同 subtask 上各自 first-wins，去重当场失效**。这是引入 `dedup_key` 后必须同步的调整。

**一致性配置**：Flink sink 使用事务性生产者 + exactly-once；**所有消费端必须设 `isolation.level=read_committed`**，否则会读到未提交的事务消息。

**为什么 `alert.event` 与 `alert.converged` 分成两个 topic**：量级差 1~2 个数量级，消费者不同（账本 worker vs 平台运营），故障域必须隔离。合并成一个 topic 会让账本积压直接阻塞告警运营。

### 5.4 对外 API

```
# 告警事件（运营表）
GET    /api/v1/alerts                          # 查询活跃告警列表
GET    /api/v1/alerts/{alert_id}               # 查询告警详情
POST   /api/v1/alerts/{alert_id}/claim         # 认领（body 含三个开关：notify_muted /
                                               #   auto_close_on_resolve / notify_on_resolve）
POST   /api/v1/alerts/{alert_id}/resolve       # 标记解决
POST   /api/v1/alerts/{alert_id}/close         # 关闭（body 含 mute_mode: none|notify|alert + reason + ends_at）
POST   /api/v1/alerts/{alert_id}/note          # 添加处理备注

# 明细下钻（账本表）
GET    /api/v1/alerts/{alert_id}/trace          # 该告警的完整处理轨迹（命中规则、action）
GET    /api/v1/converge-groups/{group_id}       # 展开收敛组内全部事件
GET    /api/v1/alerts/{alert_id}/inhibited      # 展开被本告警（作为根因）抑制的全部子告警
GET    /api/v1/alerts/{alert_id}/root           # 查询抑制本告警的根因

# 告警历史与分析
GET    /api/v1/alerts/history                   # 查询历史告警
GET    /api/v1/alerts/analytics                 # 告警分析统计
GET    /api/v1/alerts/analytics/mttr            # MTTR 统计
GET    /api/v1/alerts/analytics/topn            # Top-N 告警
GET    /api/v1/alerts/analytics/noise-reduction # 降噪效果分析（收敛率/抑制率/屏蔽率/去重率/复活率/伪恢复率）

# 事件账本检索（全量，含被丢弃事件）
GET    /api/v1/trace/events                     # 按时间/标签/action/rule_id/dedup_key 检索账本
GET    /api/v1/trace/events/{event_id}          # 单条事件完整轨迹

# 收敛/抑制/屏蔽规则管理（下发到 Flink 执行）
GET    /api/v1/converge-rules                   # 查询规则列表
POST   /api/v1/converge-rules                   # 创建规则（发布到 alert.rule，含发布期校验）
PUT    /api/v1/converge-rules/{rule_id}         # 更新规则（版本 +1，热加载）
DELETE /api/v1/converge-rules/{rule_id}         # 删除规则
POST   /api/v1/converge-rules/preview           # 基于账本历史预览规则匹配效果
POST   /api/v1/converge-rules/{rule_id}/toggle  # 启用/停用

# 通知静默管理（平台侧执行，不下发）
GET    /api/v1/notify-mutes                     # 查询静默列表（含即将到期）
POST   /api/v1/notify-mutes                     # 创建静默（reason 与 ends_at 强制）
PUT    /api/v1/notify-mutes/{mute_id}           # 更新/续期
DELETE /api/v1/notify-mutes/{mute_id}           # 撤销（status=revoked）
GET    /api/v1/notify-mutes/expiring            # 即将到期且告警仍 firing 的静默（供提示）

# 路由与通知管理（平台侧执行）
GET    /api/v1/alert-routes                     # 查询路由树
POST   /api/v1/alert-routes                     # 创建路由
PUT    /api/v1/alert-routes/{route_id}          # 更新路由（版本 +1，内存缓存刷新）
DELETE /api/v1/alert-routes/{route_id}          # 删除路由（默认路由拒绝删除）
POST   /api/v1/alert-routes/test                # 测试路由匹配
POST   /api/v1/alert-routes/replay              # 通知策略回放：用账本历史事件试算草稿策略（Phase 2）

# 链路健康
GET    /api/v1/pipeline/health                  # 全链路水位：各 topic lag、Flink 心跳、checkpoint 状态
GET    /api/v1/pipeline/heartbeat               # 带外心跳状态（Alloy/vmstorage/vmselect/vmalert/AM/bridge/Kafka/Flink）
GET    /api/v1/pipeline/flink/state             # Flink 活跃状态计数（dedup_key 数/根因数/收敛组数/组内成员数）
GET    /api/v1/pipeline/params                  # 参数不变式校验结果（§3.11.5）
GET    /api/v1/am/status                        # 查询各存储域 AM 运行状态（只读，AM 无配置面）
```

> **v3.0 删除**：`POST /api/v1/am/config/reload`。AM 零配置化后配置由部署模板生成，热加载入口不再存在（DEC-037）。

### 5.5 告警处理完整流程

```
vmalert    AM(存储域)  am-bridge   Kafka      Flink收敛引擎    账本worker   平台告警管理   运维人员
   │           │          │          │             │              │            │            │
   │─告警事件─▶│          │          │             │              │            │            │
   │           │─域内去重─▶│          │             │              │            │            │
   │           │(repeat   │          │             │              │            │            │
   │           │ 抑制)    │          │             │              │            │            │
   │           │─webhook─▶│          │             │              │            │            │
   │           │(send_    │─alert.raw▶             │              │            │            │
   │           │ resolved)│  +dedup_key             │              │            │            │
   │           │          │────────────▶│           │              │            │            │
   │           │          │          │      ①屏蔽(broadcast,无keyed state)       │            │
   │           │          │          │      ②跨域去重(dedup_key first-wins/续约吸收)           │
   │           │          │          │      ③收敛(组级裁决) ④逐级抑制 ⑤恢复延迟+抖动           │
   │           │          │          │      ⑥轨迹                             │  │            │
   │           │          │          │◀─alert.event│              │            │            │
   │           │          │          │────────────────────────────▶│            │            │
   │           │          │          │                    批量落库(账本)          │            │
   │           │          │          │◀alert.converged            │            │            │
   │           │          │          │─────────────────────────────────────────▶│            │
   │           │          │          │                              幂等入库/展示 │            │
   │           │          │          │                              路由匹配→通知组           │
   │           │          │          │                              通知缓冲30s  │            │
   │           │          │          │                              ─发送通知───────────────▶│
   │           │          │          │                              scheduler扫描:           │
   │           │          │          │                              重复通知/升级/静默过滤     │
   │           │          │          │                                          │            │
   │           │          │          │                              ◀──认领(三开关)───────────│
   │           │          │          │                              更新状态+写notify_mute    │
   │           │          │          │                              ◀──下钻明细──│────────────│
   │           │          │          │                              查账本表     │            │
   │           │          │          │                              ─返回47条明细▶│           │
   │           │          │          │                                          │            │
   │           │          │          │                              ◀──手动关闭(三选一)───────│
   │           │          │          │◀──────────────────────────── alert.control │            │
   │           │          │          │────────────▶│ 按dedup_key清keyed state     │            │
   │           │          │          │             │ 从收敛组MapState/根因摘除      │            │
   │           │          │          │             │ 账本回填 state_cleared_at     │            │
   │           │          │          │             │ (AM不参与清理，状态自回收)     │            │
   │           │          │          │                              更新运营表 closed          │
   │           │          │          │                              +写mute(若选②/③)          │
   │           │          │          │                                          │            │
   │─resolved─▶│          │          │             │              │            │            │
   │           │─webhook─▶│─alert.raw▶────────────▶│ 恢复延迟60s   │            │            │
   │           │          │          │             │ 组级裁决(全部resolved?)     │            │
   │           │          │          │             │ 根因摘除+grace 60s          │            │
   │           │          │          │◀inhibit_released(侧输出)     │            │            │
   │           │          │          │─────────────────────────────────────────▶│            │
   │           │          │          │                       延迟15s查账本→补发被抑制子告警     │
   │           │          │          │◀resolved(emit)          │            │            │
   │           │          │          │─────────────────────────────────────────▶│            │
   │           │          │          │                       auto_close? notify_on_resolve?   │
   │           │          │          │                       主动清Flink state（不等TTL）      │
```

## 六、设计决策与替代方案

### 6.1 收敛引擎选型（DEC-028）[已确认]

**决策：采用 Flink 作为收敛引擎。**

**背景**：需要在告警链路上实现动态规则、收敛、逐级抑制、抖动抑制，并记录全量事件与处理轨迹。核心决定因素是**收敛规则需要多强的表达能力**。

**候选方案**：

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：自研轻引擎 | Go/Java 服务 + Redis/PG 状态 | 运维成本最低（1 个服务）；数据模型完全可控 | 无 exactly-once；无 CEP；拓扑关联需自己管 join 状态，复杂度高 |
| B：复用夜莺类开源引擎 | 采用 n9e 的告警事件处理层 | 内置聚合/抑制/屏蔽规则 + UI + 事件账本，开箱即用 | **规则模型只支持标签匹配，无法表达拓扑 RCA**；n9e 是平台而非库，自带 UI/用户体系/订阅升级通知，与本模块正面重叠；集成需禁用其分发层并写适配器 |
| **C：Flink 作业** | KeyedState + Timer + Broadcast + CEP | 拓扑关联 RCA 原生支持；动态规则 broadcast 热更新不重启；exactly-once；状态可溢盘（RocksDB）无内存天花板 | 运维成本高：集群 + checkpoint 存储 + savepoint 升级流程；全部收敛逻辑与规则 DSL 需自研 |

**选择理由**：拓扑关联 RCA 是硬性需求（MC-10 告警风暴的核心解法）。方案 B 的规则模型只有标签匹配，无法表达「交换机故障 → 抑制其下挂全部实例告警」；方案 A 要实现同等的有状态关联，复杂度会逼近甚至超过引入 Flink 的运维成本。方案 C 的 keyed state + timer + broadcast 恰好匹配这个问题形态。

**否决 B 的补充理由**：夜莺不是库而是平台。为「只要引擎」而引入它，意味着接受它的事件数据模型、禁用它的 dispatch/subscribe/escalation 半边、再写一层适配到 `alert.converged`——同时它的 UI 与本模块 UI 并列做相似的事。表面上的复用价值低于实际。

### 6.2 去重分层：AM 存储域内 + Flink 全局（DEC-029）[已确认]

**决策：AM 做存储域内时间维度去重，Flink 做全局空间维度去重。AM 之间不组集群。**

| 方案 | 覆盖 | 评价 |
|------|------|------|
| 仅 AM 本域去重 | 同域重发 | 双写场景产生重复告警，跨域冲突无人裁决 |
| 仅 Flink 统一去重 | 同域重发 + 跨域重复 | 语义唯一，但 vmalert 每评估周期重推全部 firing 告警，Flink 入口流量放大约 240 倍——恰好在最需要削峰的地方放大风暴 |
| **分层去重（选定）** | 同域重发（AM）+ 跨域重复（Flink） | AM 削峰约两个数量级；Flink 是唯一全局裁决点；AM 之间零耦合 |

两层作用在不同维度，不是重复劳动：AM 管时间（同一告警的周期性重发），Flink 管空间（跨网区的同 fingerprint 副本）。

**必须对齐的参数**：Flink fingerprint 状态 TTL（24h）> AM `repeat_interval`（4h）；AM `send_resolved=true` 且 resolved 穿透重发抑制。详见 §3.2。

### 6.3 AM 中心化集群（DEC-029）[已否决]

**提议**：平台侧部署一个大型 AM 集群统一去重，所有 vmalert 推送到该集群。

**否决理由**：

| 问题 | 说明 |
|------|------|
| AM 集群语义被误解 | gossip 集群同步的是 silences 与 notification log，**不同步告警本身**。要全局去重必须让每个 vmalert 向集群每个成员全量推送。推论：**LB + 多副本 ≠ 去重**——轮询到不同副本的同 fingerprint 告警互不可见，去重当场失效 |
| 集群扩可用性不扩吞吐 | 每个成员处理全量告警（全复制），AM 全量活跃告警驻内存且无原生分片。风暴下的内存上限 = 单个 AM 上限，加机器无解 |
| N×M 跨网区连接 | 每个网区 vmalert 需连通中心集群每个成员 + gossip 端口。与 DEC-021「简化防火墙规则」的方向相反 |
| 跨 WAN gossip 脆弱 | memberlist `peer_timeout` 默认 15s、gossip 间隔按局域网调参。跨网区高延迟/丢包导致成员列表反复抖动，表现为通知重复或丢失 |
| **违反核心设计目标** | `cross-plane/degradation-autonomy.md` 明确「中心不可用时，各区仍能自治运行」。中心 AM 集群意味着中心故障或 WAN 分区时**全网区去重与告警投递一起断**——而告警链路是降级时最不能失效的一条 |

**结论**：「平台侧统一去重」的诉求正确，但正确的执行组件是 Flink（天然全局汇聚点、keyed state 可溢盘、无需 N×M 连接、不破坏网区自治），不是 AM 集群。见 DEC-029。

### 6.4 拓扑数据来源：CMDB → 标签富化（DEC-030）[已确认]

**决策：CMDB 为拓扑原始真源，平台同步后富化到 `instance.labels`，采集下发时注入 target labels。Flink 不做运行时拓扑 join。**

| 方案 | 描述 | 评价 |
|------|------|------|
| **A：拓扑标签化（选定）** | 拓扑在采集阶段变成标签，随指标流转到告警 | RCA 退化为标签 keyBy + broadcast 查表；无需 CDC、无需 join 状态、无需 lookup I/O |
| B：Flink 运行时 join | 拓扑表通过 CDC 进 Flink，与告警流做 join | 需维护拓扑流状态与一致性；CMDB 变更需实时传播；算子复杂度高一个量级 |

选择 A 是本设计中收益最大的一次复杂度削减。代价（fingerprint 随拓扑变更、标签陈旧窗口）已评估并接受，见 §1.3 与 MC-12。

**连带硬约束**：vmalert 规则不得裁剪拓扑标签，否则 Flink 无从 keyBy，RCA 静默失效。需在规则管理模块增加校验。

### 6.5 抑制时序：先放行，后抑制（DEC-031）[已确认]

**决策：父级根因事件到达前允许子告警放行；根因到达后逐级抑制后续事件。不做滞留，不做回溯撤回。**

否决的方案与理由见 §3.3.4。核心判断：已放行的告警在当时信息下是正确决策，不应追认；已发出的通知也无法真正撤回。风暴的量由收敛算子拦截，因果由抑制算子表达，二者职责严格分离。

**根因状态用 broadcast state 而非 keyed state**：一条子告警需检查其全部祖先作用域（cluster/rack/switch/host/instance），keyed state 只能按单 key 查询，会导致事件炸开-重聚合的复杂度；活跃根因天然低基数，broadcast 全量持有可行。上限 10k 条并加告警。

### 6.6 消息通道与账本存储演进：单 Kafka 六 topic，PG → ClickHouse（DEC-032）[已确认]

**决策：运营表固定 PG；账本表前期 PG 按天分区，量级触发后迁移 ClickHouse。**

两张表访问模式相反，不可共用存储：

| | 运营表 `alert_event` | 账本表 `alert_event_trace` |
|---|---|---|
| 内容 | 仅 `emit=true` 最终事件 | 全量事件 + 处理轨迹 |
| 量级 | 小（收敛后） | 大（高 1~2 个数量级） |
| 是否更新 | **是**（认领/通知/关闭反复 UPDATE） | **否**（append-only） |
| 主访问 | 按 `alert_id` 高频点查 + 列表筛选 | 时间范围扫描 + 多维筛选 + 聚合分析 |
| 存储 | **PG，不换** | PG 分区 → ClickHouse |

**列式存储适用性结论**：对账本合适（append-only + 大范围扫描聚合，正是列式强项），对运营表不合适（列式在 UPDATE 上很弱——ClickHouse 的 mutation 是重写 part 而非行更新，而运营表的核心就是状态流转）。

**迁移触发阈值**（写成可观测指标，不拍时间）：

- 账本单分区 > 5000 万行，或日增 > 500 万行
- 分析类查询（MTTR / Top-N / 趋势 / 降噪效果）P95 > 3s
- 账本 worker 出现持续 lag

**前期 PG 足够的理由**：告警量是尖峰型而非持续高吞吐。5 万实例正常日也许几百条告警，一次交换机故障瞬间几千条。按天分区 + 合适索引可支撑很久。

**架构保障**：账本 worker 是 `alert.event` 的唯一消费者，换存储只是 worker 内部实现变更，Flink 与 topic 契约不动。Kafka 缓冲层同时把存储选型变成了可延后的决定。

### 6.7 无降级旁路 + 带外心跳补偿（DEC-033）[已确认，v3.0 修订两处]

**决策：不做 Flink 故障时的 `alert.raw` 直连旁路；Flink 作业 HA + 带外心跳监控为必须项。**

**否决旁路的理由**：Flink 故障时把未去重、未收敛、未抑制的原始告警全量放给平台，等于在最糟的时刻制造最大的一波噪声风暴，直接冲击通知渠道。比断流更危险。

**代价**：Flink 成为告警链路硬单点，故障时运维完全收不到告警。必须以带外心跳补偿——由链路之外的组件监控链路自身，超时触发 critical「告警链路中断」并走独立通知路径（不经 Flink、不经 Kafka）。详见 §3.10 与 MC-13。

**v3.0 修订**：

| 修订项 | 原内容 | v3.0 |
|--------|--------|------|
| 双向清理 → 单向清理 | 关闭时既清 Flink 状态又回调 AM silence | AM 零配置化（DEC-037）后不再回调 AM；AM 状态由 `resolve_timeout` 自清理。见 §3.9 |
| 带外心跳范围 | 仅覆盖 Flink | **扩展到整条存储侧链路**（Alloy / vmstorage / vmselect / vmalert / AM / bridge / Kafka / Flink）。vmalert 挂掉导致全量伪恢复，比 Flink 挂掉危险一个量级。见 §3.10.1 与 MC-13 |

「已认领告警同样参与收敛抑制、`alert.control` 不承载 `claim`」这一决策 v3.0 保留不变——通知静默（§3.5.3）在平台侧实现了「别催我」，无需让 Flink 感知认领。

### 6.8 告警格式兼容性（DEC-028）[已确认]

**决策**：告警事件格式兼容 Prometheus AlertManager Webhook 格式，在此基础上扩展 `convergence`、`topo_scope`、`ai_rca` 等平台字段。

**理由**：AM Webhook 格式已是事实标准；vmalert/AM 原生支持；便于对接现有告警系统与工具；账本保留 `raw_payload` 原始载荷，扩展字段不破坏可追溯性。

### 6.9 告警认领工作流 [建议]

**建议**：采用可选认领模式，非强制。可通过 `alert_route.require_claim` 按路由决定是否要求认领。

**理由**：info 级别告警无需认领；强制认领增加运维负担。

**v2.0 补充**：认领状态**不影响 Flink 行为**——已认领告警同样参与收敛与抑制，明细通过账本下钻获取。见 §3.7。

**v3.0 补充**：认领时配置三个正交开关（`notify_muted` / `auto_close_on_resolve` / `notify_on_resolve`），把「我在处理，别催我」和「恢复了自动关掉」这两件此前无处表达的事变成一等公民。见 §3.7.2。

### 6.10 通知策略归属与三级重复通知分离（DEC-034）[已确认]

**决策：重复通知、自动升级、告警分级、多渠道路由全部放平台侧，Flink 不参与任何通知决策。**

| 方案 | 描述 | 评价 |
|------|------|------|
| A：放 Flink | 用 keyed state + timer 实现重复通知与升级 | 升级依赖 `lifecycle_status` / `claimed_by` 等平台可变业务状态，DEC-033 已定 `claim` 不进流；搬进来等于让流状态成为平台操作表的镜像。且外部渠道 I/O 会拖住 checkpoint，反压收敛链路 |
| **B：放平台（选定）** | 新增 `notification_scheduler`，PG 扫描 + `SKIP LOCKED` | 通知策略变更永不触碰 Flink；策略是 DB 行 + 内存缓存，秒级生效；调度器可水平扩展 |

**核心收益是可维护性**：收敛规则是月级变更，路由与接收人是周级甚至日级。两者的变更频率差一个数量级，绑在同一个发布单元里会让高频变更承担低频变更的发布风险。

**三级「重复通知」必须显式分离**（否则互相打架）：AM `repeat_interval`（下游状态续约心跳，不触达人）/ 通知渠道模块的投递幂等窗口（防重复投递）/ `alert_route.repeat_notify_s`（人工重复提醒）。详见 §3.6.3。

**升级策略收敛到唯一权威**：v2.0 把升级配置散在 `alert_route.escalation_s`、`escalation_policy.levels`、`notification_group.escalation_config` 三处，必然漂移。v3.0 只保留 `escalation_policy.levels`。详见 §3.6.5，闭环 MC-11。

### 6.11 恢复语义与伪恢复治理（DEC-035）[已确认]

**决策：恢复分五层，vmalert 是信号源、Flink 是最终裁决、平台是业务终态。「无数据即恢复」是 vmalert 默认语义且危险，以规则发布期强制声明 + `up`/`absent` 看门狗补偿，不改恢复语义。**

否决的方案：让 Flink 区分「条件不再成立」与「样本消失」——AM webhook 与 vmalert 都不携带该信息，除非改 vmalert，不现实。`(expr) and on(instance) up == 1` 也无效，`and` 在无数据时结果仍为空，照样 resolved。

**Flink 新增两项裁决**：恢复延迟 + 抖动锁定（治抖动，规则层无法根治，因为 `for:` 不延迟 resolved）；收敛组组级恢复裁决（组内全部 resolved 才 emit，保住代表 `event_id` 稳定性从而保住认领关系）。

**抑制解除改为平台补发**：Flink 只发 `inhibit_released`，平台查账本补发。这样 Flink 无需为被抑制事件保留 keyed state，「抑制降低状态量」的收益才真正兑现。详见 §3.3.3。

**AM `resolve_timeout` 由 5m 调大到 30m**：该参数只在 vmalert 停止推送时起作用，而那种情况下触发它就是错的（vmalert 挂了不等于告警都好了）。调大零代价——真恢复走显式路径即时到达。

**`resolved_reason` 字段 v3.0 留出、Phase 2 回填**：事后给按天分区的账本表加字段代价高得多。

### 6.12 静默分层与关闭语义（DEC-036）[已确认]

**决策：告警屏蔽（Flink，决定事件是否成立）与通知静默（平台，决定成立的事件是否叫人）彻底分离。人工关闭时三选一，复活是预期行为而非缺陷。**

**v2.0 的理解偏差已修正**：v2.0 把「关闭后告警复活」当作缺陷，用 AM silence 去防。v3.0 认识到静默的作用不是防止复活，而是控制复活之后的行为——问题还在却不报警，比报警更危险。

| 关闭选项 | 事件是否产生 | 是否进活跃列表 | 是否通知 |
|----------|--------------|----------------|----------|
| ① 不静默 | 是 | 是 | **是**（复活） |
| ② 屏蔽通知 | 是 | **是** | 否 |
| ③ 告警屏蔽 | 只入账本 | **否** | 否 |

**静默安全阀**：静默期间 `converged_count` 增长超 10 倍、或本组被更高级根因抑制 → 强制解除并通知一次。宁可偶尔打扰，不可让静默成为盲区。详见 §3.5.3。

**两条硬约束防静默变成事故源**：`reason` 强制填写；`ends_at` 强制有上限（7d），不允许永久静默。配套到期前 10m 提示续期。

### 6.13 AM 零配置化与算子链重排（DEC-037）[已确认]

**决策：Alertmanager 收缩为「去重 + resolved 检测」，不持有任何用户可配置策略；config 退化为部署期静态模板。Flink 算子链重排。**

**AM 零配置化删除的能力**：控制面板→AM 策略下发链路、平台→AM silence 回调、AM 配置渲染/热加载。DEC-033 的「双向清理」相应改为单向。

| 收益 | 说明 |
|------|------|
| 消除一整类故障 | 「UI 改了但 AM 没生效」「配置渲染错误导致 AM 拒绝加载」「热加载竞态」 |
| 少一条链路 | 配置下发链路从 2 条（规则→vmalert、策略→AM）减为 1 条 |
| AM 状态自清理 | `resolve_timeout` 兜底回收，平台无需干预 |
| 代价可忽略 | 被屏蔽告警仍走完 vmalert→AM→bridge→Kafka→Flink，但 AM 每 4h 才重发一次，10 万条被屏蔽告警约 7 events/sec |

**算子链重排修正了两处 v2.0 实质缺陷**：

| 缺陷 | 后果 |
|------|------|
| 屏蔽算子在去重之后 | 持续 firing 的告警先被去重算子吸收为 `renewed`，**广播式屏蔽规则永远拿不到事件**，形同虚设 |
| 屏蔽算子标记为 keyed | 屏蔽判定是纯查表、无需历史，为每条被屏蔽告警分配 RocksDB 状态是纯浪费 |
| 抖动算子在抑制之前 | resolved 被 hold 住时无法及时摘除活跃根因，根因已恢复而子告警仍被压制 |

详见 §3.3.2。

## 七、冲突与开放问题

### ~~MC-04: Mode A 告警覆盖缺口~~ [已作废]

Mode A/B/C 概念已被 DEC-003 / DEC-009 整体废弃。存储独立化后所有存储统一为 vmstorage，vmalert 存储侧共部署并查询 vmselect 获得全局可见性，「无本地 RC」的问题不复存在。原 §3.7「Mode A 告警覆盖方案」于 v2.0 删除。

### ~~MC-09: 跨域重复告警的判定键~~ [v3.0 已闭环]

**原冲突**：`fingerprint = hash(alertname + sorted labels)` 含 `zone` 标签，导致**多 DC 实例**与**跨网区迁移**这两类最主要的跨域重复场景中，两条告警的 fingerprint 并不相同，DEC-029 规定的 first-wins 无法识别它们为重复。最需要去重的场景恰好是去重失效的场景。

**v3.0 裁决：采纳方案 C（`dedup_key`）+ 方案 D 部分采纳（RC-05 裁决为「仅 prime」）。**

```
fingerprint = hash(alertname + sorted(全部标签))                 # 身份、展示、control 路由
dedup_key   = hash(alertname + sorted(标签 − 来源标识标签))       # 跨域裁决
来源标识标签排除列表：zone, zone_id, source_storage, source_am, dc
```

计算位置为 am-bridge（已是无状态协议转换点，加一次哈希零成本）；`dedup_key` 随消息注入 `alert.raw`，Flink stage 3 以它 keyBy。`fingerprint` 保留用于 AM 域内去重与告警身份展示。

RC-05 裁决为「仅 prime 存储域评估规则」消除了多 DC 场景的主要重复来源（vmalert 查询 vmselect 已具备全局可见性，向多个 vmalert 下发同一规则包既冗余又制造重复），但**不解决 prime 迁移窗口**，因此 `dedup_key` 仍然必要。`instance-management.md` §3.6.6 已同步修订。

**残留事项**（不阻塞实现）：

| 事项 | 处理 |
|------|------|
| 排除列表需随标签体系演进维护 | 列为系统保留标签，写入标签管理规范；新增来源类标签时必须同步该列表，否则跨域去重会静默失效 |
| 迁移期 `source_zone_id` 归属 | Phase 1 用 first-wins 先到者为准（实现简单，可能记到旧网区），账本保留双来源；Phase 2 视运营反馈修正 |

详见 §3.2.1。

### ~~MC-10: 告警风暴的处理策略~~ [已闭环]

**原冲突描述**：核心组件故障时同时触发大量关联告警（如交换机故障导致其下所有实例不可达）。原问题：是否需要自动根因分析？是否抑制子告警？还是简单聚合？

**v2.0 解决方案**（三者都做，职责分离）：

| 手段 | 算子 | 解决什么 |
|------|------|----------|
| 收敛 | Stage 4 | **量**：窗口内 N 条同类告警 → 1 条代表事件，其余留账本可下钻。这是拦截风暴首波（根因到达前）的唯一手段 |
| 逐级抑制 | Stage 5 | **因果**：根因激活后，其拓扑作用域链下的后续子告警全部压制，记 `inhibited_by` |
| 自动根因分析 | Stage 7（Phase 2） | **解释**：AI 算子输出推测根因与置信度，仅建议不决策抑制 |
| 降噪效果分析 | §3.8 | **调优**：账本全量留痕使收敛率/抑制率可量化，支撑规则持续优化 |

### ~~MC-11: 告警升级策略~~ [v3.0 已闭环]

**原冲突**：告警认领超时后的升级路径未明确——升级到谁？升级几次后停止？电话通知的触发条件？

**v3.0 裁决**（详见 §3.6.5）：

| 原问题 | 答案 |
|--------|------|
| 升级到谁 | `escalation_policy.levels[n].target_group_id` → 通知组，逐级上移（一线 → 二线 → 负责人 → 总监） |
| 升级几次后停止 | `escalation_level >= max(levels)` **或** `lifecycle_status IN ('resolved','closed')`，任一即停 |
| 电话通知触发条件 | **不由 severity 直接决定，由升级级别决定**——`levels[n].channels` 含 `phone` 才打电话 |

配套变更：升级配置从三处（`alert_route.escalation_s` / `escalation_policy.levels` / `notification_group.escalation_config`）收敛到 `escalation_policy.levels` **唯一权威**；执行者为平台侧 `notification_scheduler`（PG 扫描 + `SKIP LOCKED`）；静默期间升级计时暂停、解除时按剩余时间重算（§3.5.3）。

**遗留**：值班排班功能 v3.0 不做，升级链指向**静态通知组**，组成员需人工维护。这不影响升级机制本身的正确性，但意味着「谁在值班」没有系统化表达。若将来引入排班，只需在 `notification_group` 的成员解析处加一层，路由与升级链不动。

### MC-12: CMDB 拓扑标签陈旧窗口 [已接受]

**描述**：CMDB 拓扑变更到告警携带新标签，需经过「CMDB → 平台富化 → http_sd 刷新 → 新样本」一个事件周期。窗口内 RCA 按旧拓扑判定，可能漏抑制或误抑制。同时拓扑标签变更会改变 fingerprint，在飞告警被当作新告警。

**v3.0 补充**：`dedup_key` 的排除列表只含来源标识标签，**不含拓扑标签**。因此拓扑变更同样会改变 `dedup_key`，在飞告警会被当作新告警重新准入。这与 fingerprint 的行为一致，是同一个已接受代价的两个表现，不额外处理。

**处理**：接受，不做补偿。理由：补偿需要 Flink 维护实时拓扑状态（即 §6.4 的方案 B），复杂度收益比不划算。

**待观测**：上线后统计因拓扑变更导致的误抑制/漏抑制比例。若显著，可考虑对拓扑变更事件做短暂（如 2 个抓取周期）的抑制降级——即拓扑刚变更时放宽抑制条件，宁可多告警不可漏告警。

### MC-13: 告警链路硬单点风险 [已接受 + 补偿，v3.0 扩大补偿范围]

**描述**：v2.0 引入 Flink 后，告警链路多了一个单点。Flink 故障时 `alert.converged` 断流，运维收不到任何告警。已否决降级旁路（§6.7），因此风险不可消除，只能补偿。

**v3.0 的关键修正：Flink 不是最危险的单点。** 存储侧链路故障的后果严重一个量级：

| 组件故障 | 后果 |
|----------|------|
| Flink / am-bridge / Kafka 挂掉 | 断流，收不到**新**告警（原本吵 → 变静） |
| **vmalert 挂掉** | 停止向 AM 推送 → `resolve_timeout`(30m) 后 AM 把其名下**全部告警判定 resolved** → **全量伪恢复 + 全量静默** |
| **vmstorage / vmselect / Alloy 挂掉** | vmalert 表达式查不到数据 → 结果为空 → 同样全量伪恢复 |

「告警全清」比「收不到新告警」危险，因为前者还会**主动撤销正在处理的活告警**，运维会以为问题都好了。

**补偿措施**（详见 §3.10.1）：

| 措施 | 优先级 |
|------|--------|
| 带外心跳覆盖**整条存储侧链路 + Flink**（v2.0 只覆盖 Flink） | **必须** |
| **硬编码最小通知路径**：心跳告警不经路由策略、不经 Flink、不经 Kafka，直连短信/电话给平台管理员。代码写死，不可配置——故障的可能正是路由策略本身 | **必须** |
| Flink 作业 HA + checkpoint | 必须 |
| 链路水位告警（各 topic lag、checkpoint、backpressure、broadcast 根因数、收敛组成员数） | 必须 |
| 伪恢复比例告警（`alert_resolved_by_reason_total{reason="data_missing"}`） | 必须 |
| AM 侧 webhook 失败计数 | 建议 |

**残留风险**：带外心跳通道自身也可能故障。需确保该通道与告警链路完全独立（不同集群、不同网络路径、不同通知渠道），并定期演练验证。

**遗留待决**：心跳超时阈值（建议 30s，即 3 个心跳周期）与「告警链路中断」的通知对象名单——后者需要人工确认，不宜由本设计指定。

### ~~MC-14: broadcast 根因状态与收敛组的容量边界~~ [v3.0 已闭环]

**原冲突**：逐级抑制的根因状态用 broadcast state，每个 subtask 全量持有一份，设计假设活跃根因低基数（< 10k）。超大规模级联故障时可能超出预期。同时 v3.0 引入的收敛组 `MapState` 也有无界增长风险。

**v3.0 裁决：超限自动降级，不丢弃、不淘汰。**

| 状态 | 上限 | 超限行为 |
|------|------|----------|
| broadcast 活跃根因条数 | 10k | **自动降级为「仅收敛不抑制」**：停止写入新根因，已有根因继续生效至自然回收；触发 critical 告警 |
| 单个收敛组成员数 | `converge_group_max_members`（默认 1000） | **拆分新组**，`converge_group_id` 加序号后缀（`cg-uuid#2`），轨迹记录拆分事件 |

否决「丢弃新根因」与「淘汰最旧根因」的理由：**宁可少抑制，不可丢事件**。抑制失效的后果是多通知（吵，可容忍）；淘汰根因的后果是子告警在根因仍活跃时被错误放行、或根因仍活跃却发出了解禁信号（乱，难排查）。

不按作用域层级分别设上限：分层上限（switch 1k / host 10k）增加了配置面但收益不明确——超 10k 本身说明规则配错（不会同时有一千个交换机在故障），降级 + 告警足以让运维发现。

### ~~MC-15: 规则版本与状态一致性~~ [v3.0 已闭环]

**原冲突**：动态规则通过 broadcast 热更新，变更瞬间不同 subtask 存在毫秒级传播差异；规则变更后已有 keyed state（如进行中的收敛窗口）是否应按新规则重算。

**v3.0 裁决**：

| 问题 | 裁决 | 理由 |
|------|------|------|
| 是否接受短暂版本不一致 | **接受** | 影响面毫秒级；`version` 单调递增保证最终一致；轨迹已记录 `rule_version`，事后可还原 |
| 规则变更是否清空 keyed state | **不清空** | 清空会导致收敛窗口重置、全量重新准入 → **重复通知风暴**。宁可新旧规则混合生效一段时间 |
| UI 是否标注「按已废弃版本规则裁决」 | **标注** | 轨迹已有 `rule_version`，UI 对已停用规则加删除线标记即可，零额外存储 |

**v3.0 新发现的关联问题：冷启动时规则不完整。** Flink broadcast state 模式中 broadcast 流与 keyed 流是**交错消费**的，没有「所有广播元素先处理完」的保证。作业重启后若主流积压事件先于 `alert.rule` 规则到达，会出现短暂漏屏蔽/漏抑制——正好在最不该出错的时候（重启通常伴随故障）。

| 方案 | 评价 |
|------|------|
| **A：`open()` 时同步从 PG 全量拉规则做 seed（选定）** | 简单可靠；一次性有界查询，不违反「Flink 不做重 I/O」；引入启动期对 PG 的依赖（PG 本就是规则源） |
| B：接受 warmup 窗口 | 等于承认会漏屏蔽，不可接受 |
| **C：savepoint 自带 broadcast state（选定，与 A 并用）** | 正常恢复时自动带出，快且无 PG 依赖。但仅对 savepoint 恢复有效，首次部署与 state 不兼容的重启仍需 A |

**A + C 并用**：正常重启走 savepoint；`open()` 做一次 PG seed 作为兜底与首次部署路径，按 `version` 比对，PG 更新则覆盖。

### MC-16: 跨时区通知静默期 [待确认 — v3.0 重新打开]

**描述**：不同网区可能跨时区，通知静默期（如夜间不通知）按接收者所在时区还是按网区时区？

**v3.0 变化**：原计划挂在值班表的 `timezone` 字段上，但**值班排班功能已决定不做**（§3.6.5 遗留），载体消失，问题重新打开。

**建议**：采用**全局统一时区**（部署级配置，默认 `Asia/Shanghai`）。理由：最简单；多网区大概率在同一国家、同一时区；即使跨时区，夜间静默按运维团队所在时区计算比按网区计算更符合直觉（是人在睡觉，不是机房在睡觉）。若将来确需精确到人，时区应挂在**用户资料**上而非新建表。
