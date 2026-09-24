# 规则检测 (Rule Check)

> 版本：v3.0 | 日期：2026-09-24
> 状态：设计中
>
> **v3.0 变更摘要**：配合 `alert-management.md` v3.0（DEC-034 ~ DEC-037）。
>
> 1. **AM 零配置化**：config 退化为部署期静态模板（§5.3），删除控制面板下发与平台 silence 回调。
> 2. **引入 `dedup_key`**（DEC-RC-06，闭环 RC-08）：跨域去重判定键由 fingerprint 改为剔除来源标识标签后的哈希，由 am-bridge 计算注入，并作为 `alert.raw` 的 partition key。
> 3. **RC-05 裁决为「仅 prime」**：规则包只下发 prime 存储域的 vmalert，非 prime 不部署 vmalert（§3.4.1）。
> 4. **`resolve_timeout` 5m → 30m**，`send_resolved: true` 列为硬约束（§3.5.2）。
> 5. **新增 §3.5.4「vmalert 故障 = 全量伪恢复」**：这是比 Flink 单点更危险的失效模式，带外心跳必须覆盖整条存储侧链路，并给出检测指标（§5.4）。
> 6. **新增 §3.5.5「规则发布期强制声明指标缺失行为」**：治理「无数据即恢复」的伪恢复，复用 DEC-RC-05 的发布期拦截模式。
>
> v2.0 变更（保留）：vmalert 恢复为独立组件并与存储共部署（DEC-026），查询 vmselect 获得全局可见性；AM 降级为存储域去重引擎；告警必须携带完整 CMDB 拓扑标签（DEC-RC-05）。

---

## 一、概述

规则检测模块负责周期性评估告警规则、生成告警事件。采用 VictoriaMetrics 生态的开源组件 **vmalert** 作为规则评估引擎，部署在存储侧（与 vmstorage + Alertmanager 共部署），通过查询 vmselect 获取全局指标视图进行规则评估。

### 架构演进说明

> **v1.0 → v2.0 重大变更（2026-09-23）：**
>
> 旧架构中，RC（RuleCheck）部署在 DC 侧，通过 VRRP peer 组和 slot 协商机制分配规则组，查询本地存储。
>
> 新架构中，vmalert 作为独立组件部署在存储侧，与 vmstorage + Alertmanager 共部署。规则评估不再需要 DC 侧的 peer 组/slot 协商——vmalert 查询 vmselect（fan-out 到所有 vmstorage），拥有全局指标视图。告警规则由控制面板分发到 prime 存储的 vmalert。

### 核心定位

```
┌──────────────────────────────────────────────────────────────────────┐
│ 存储侧部署                                                           │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Storage Instance (部署单元)                                   │   │
│  │                                                               │   │
│  │  ┌──────────────┐  ┌──────────┐  ┌─────────────┐            │   │
│  │  │  vmstorage    │  │ vmalert  │  │Alertmanager │            │   │
│  │  │  (数据存储)    │  │ (规则    │  │ (去重/恢复  │            │   │
│  │  │              │  │  评估)   │  │  检测)      │            │   │
│  │  └──────┬───────┘  └────┬─────┘  └──────┬──────┘            │   │
│  │         │               │               │                    │   │
│  │         └───────────────┼───────────────┘                    │   │
│  └─────────────────────────┼────────────────────────────────────┘   │
│                            │                                         │
│                            ▼                                         │
│                    消息队列 → 平台                                     │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│ 完整告警链                                                            │
│                                                                      │
│  Alloy ──remote_write──▶ vmstorage                                   │
│                             │                                        │
│                             ▼                                        │
│                          vmselect (fan-out 聚合到所有 vmstorage)      │
│                             │                                        │
│                             ▼                                        │
│                          vmalert (评估告警规则, 查询 vmselect)        │
│                             │                                        │
│                             ▼                                        │
│                          Alertmanager (仅存储域去重 + resolved)       │
│                             │                                        │
│                             ▼                                        │
│                          am-bridge → Kafka → Flink 收敛引擎 → 平台     │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 二、职责边界

**本文档负责**：
- vmalert 规则评估引擎的核心逻辑
- vmalert 的存储侧部署模型（与 vmstorage + AM 共部署）
- 告警规则的分发机制（控制面板 → **仅** prime 存储的 vmalert，RC-05 已裁决）
- 规则热加载与更新
- 告警生成与转发（vmalert → Alertmanager → am-bridge → Kafka → Flink 收敛引擎 → 平台）
- vmalert 的查询路径（查询 vmselect）
- **告警标签完整性**：确保 CMDB 拓扑标签（`host_id`/`rack_id`/`switch_id`/`cluster_id`）不被规则裁剪（DEC-030 硬约束）
- **AM 静态配置模板**：AM 零用户配置化后，其 config 由部署模板生成，模板归属本文档（§5.3）
- **恢复语义的存储侧行为**：「无数据即恢复」是 vmalert 默认语义，规则发布期强制声明缺失行为（§3.5.5）
- **存储侧带外心跳指标**：vmalert/AM 故障会导致全量伪恢复，其检测指标由本文档定义（§3.5.4 / §5.4）

**本文档不负责**：
- RuleSpec 的定义与管理（→ `control-plane/`）
- 规则包的分发协议（→ `cross-plane/zone-manifest-protocol.md`）
- Alertmanager 的存储域去重与 resolved 检测逻辑（→ 存储层部署，职责见 `control-plane/alert-management.md` §2）
- 跨域去重、收敛、逐级抑制、屏蔽、恢复延迟、事件账本（→ Flink 收敛引擎，见 `control-plane/alert-management.md` §3.2~§3.4、§3.11）
- 路由、重复通知、自动升级、通知静默（→ 平台侧，见 `control-plane/alert-management.md` §3.5~§3.6 与 `control-plane/notification-channel.md`）
- vmalert 组件本身的实现与维护（→ VictoriaMetrics 社区）
- 存储层的部署与管理（→ `data-plane/storage.md`）
- Alloy 的采集与写入（→ `data-plane/alloy.md`）

---

## 三、功能清单

### 3.1 功能总览

| 功能模块 | 功能项 | 优先级 | 说明 |
|---------|--------|--------|------|
| 规则评估 | vmalert 规则评估 | P0 | vmalert 原生 PromQL 求值与规则状态机管理 |
| 规则评估 | 评估间隔调度 | P0 | vmalert 按 evaluation_interval 周期执行 |
| 规则评估 | 规则热加载 | P0 | 通过 vmalert reload API 热加载规则文件 |
| 部署模型 | vmalert + vmstorage + AM 共部署 | P0 | 存储侧部署单元 |
| 部署模型 | prime 存储接收告警规则 | P0 | 规则分发到 prime 存储的 vmalert |
| 查询路径 | vmalert → vmselect 查询 | P0 | 全局指标视图 |
| 规则包管理 | 控制面板推送规则包 | P0 | 推送到 prime 存储的 vmalert |
| 规则包管理 | 规则包版本追踪 | P0 | 版本校验，增量更新 |
| 规则包管理 | 规则文件热加载 | P1 | 写入规则目录后调用 reload API |
| 告警输出 | vmalert 告警生成 | P0 | vmalert 规则触发时生成告警 |
| 告警输出 | 告警格式转换 | P0 | 添加 zone_id 等平台标签，转发至 Alertmanager |
| 告警输出 | 健康上报 | P1 | vmalert 运行状态上报 |

### 3.2 规则评估引擎

vmalert 作为独立组件部署在存储侧，查询 vmselect 获取全局指标视图进行规则评估。

#### 3.2.1 评估流程

```
vmalert 评估周期触发 (每 evaluation_interval):
    │
    ▼
1. vmalert 加载当前存储实例的规则组文件
    │
    ▼
2. 对每个规则组：
    │
    ├── 2a. 遍历规则组中的每条规则
    │       │
    │       ▼
    │   vmalert 执行 PromQL 查询
    │   └── 查询 vmselect (fan-out 到所有 vmstorage)
    │       │
    │       ▼
    │   vmalert 原生评估表达式
    │   ├── 结果非零 → 规则条件满足
    │   │   ├── 首次满足 → 状态变为 PENDING，记录 pending_at
    │   │   ├── 已 PENDING 且持续 >= for → 状态变为 FIRING，发送告警到 Alertmanager
    │   │   └── 已 FIRING → 保持 firing 状态
    │   │
    │   └── 结果为零 → 规则条件不满足
    │       ├── 已 PENDING → 状态清除（假触发）
    │       ├── 已 FIRING → 状态变为 RESOLVED，发送 resolved 告警到 Alertmanager
    │       └── 无状态 → 无操作
    │
    └── 2b. vmalert 记录评估统计（耗时、结果数、错误）
    │
    ▼
3. vmalert 将告警发送到同部署的 Alertmanager
```

vmalert 的最小化定制部分：
- **规则文件热加载**：控制面板推送新规则包后写入 vmalert 规则文件目录，通过 vmalert 的 HTTP reload API 触发热加载
- **告警格式转换**：vmalert 发送告警前，添加 `zone_id` 等平台标签
- **健康上报**：定期上报 vmalert 运行状态（评估耗时、错误数、规则包版本等）

#### 3.2.2 规则状态机

规则状态机由 vmalert 原生管理，状态转换与原生 vmalert 行为一致：

```
               条件满足
                 │
                 ▼
  ┌────────┐  ┌────────┐   持续 >= for   ┌────────┐
  │  IDLE  │─▶│ PENDING │───────────────▶│ FIRING │
  └────────┘  └────┬────┘               └────┬───┘
                   │                          │
              条件不满足                  条件不满足
                   │                          │
                   ▼                          ▼
              ┌────────┐               ┌──────────┐
              │ (清除)  │               │ RESOLVED │
              └────────┘               └──────────┘
```

| 状态 | 含义 | 动作 |
|------|------|------|
| IDLE | 规则条件未满足 | 无（vmalert 内部管理） |
| PENDING | 规则条件刚满足，等待持续时间 | vmalert 记录 pending_at |
| FIRING | 规则条件持续满足超过 for 时间 | vmalert 发送告警到 Alertmanager |
| RESOLVED | 规则条件不再满足 | vmalert 发送 resolved 告警到 Alertmanager |

#### 3.2.3 vmalert 规则文件格式

控制面板推送的规则包采用 vmalert 兼容格式（YAML）：

```yaml
# vmalert 规则文件
groups:
  - name: <rule_group_name>
    interval: <evaluation_interval>    # 评估间隔
    rules:
      - alert: <alert_name>
        expr: <promql_expr>            # PromQL 表达式
        for: <duration>                # 持续时间阈值
        labels:
          zone_id: <zone_id>           # 网区 ID
          severity: <severity>         # critical | warning | info
        annotations:
          summary: <summary>
          description: <description>
```

关键约束：
- `instance` 标签来自指标数据（PromQL 查询结果），而非 vmalert 节点注入
- vmalert 通过 HTTP reload API（`/-/reload`）热加载新规则文件
- vmalert 自动处理规则 diff（新增/删除/修改），无需手动管理

### 3.3 部署模型

#### 3.3.1 存储侧共部署

```
每个存储实例的部署单元:

  ┌──────────────────────────────────────────────────┐
  │  Storage Instance (部署单元)                       │
  │                                                    │
  │  ┌──────────────┐  ┌──────────┐  ┌─────────────┐ │
  │  │  vmstorage    │  │ vmalert  │  │Alertmanager │ │
  │  │  (数据存储)    │  │ (规则    │  │ (去重/恢复  │ │
  │  │              │  │  评估)   │  │  检测)      │ │
  │  └──────┬───────┘  └────┬─────┘  └──────┬──────┘ │
  │         │               │               │         │
  │         │    ┌──────────┴──────────┐    │         │
  │         │    │ vmselect             │    │         │
  │         │    │ (fan-out 到所有      │    │         │
  │         │    │  vmstorage)         │    │         │
  │         │    └──────────┬──────────┘    │         │
  │         │               │               │         │
  │         └───────────────┼───────────────┘         │
  │                         │                          │
  └─────────────────────────┼──────────────────────────┘
                            │
                            ▼
                    消息队列 → 平台
```

#### 3.3.2 vmalert 查询 vmselect 的优势

| 特性 | 说明 |
|------|------|
| 全局指标视图 | vmselect fan-out 到所有 vmstorage，vmalert 可评估跨区规则 |
| 统一查询入口 | vmalert 只需配置一个 vmselect 地址 |
| 去重保证 | vmselect 内置去重，vmalert 查询结果无重复 |
| 简化部署 | vmalert 不需要知道底层有多少 vmstorage 实例 |

### 3.4 规则包管理

#### 3.4.1 规则分发机制

告警规则由控制面板分发到 prime 存储的 vmalert：

```
规则分发流程:

  控制面板
    │
    │  1. 规则变更事件
    │
    ▼
  DC 网关
    │
    │  2. 推送规则包到 prime 存储的 vmalert
    │     (通过 HTTP API 或配置文件分发)
    │
    ▼
  prime vmstorage 的 vmalert
    │
    │  3. 写入规则文件目录
    │  4. 调用 reload API 热加载
    │
    ▼
  vmalert 开始评估新规则

  注: 规则**仅**分发到 prime 存储的 vmalert（RC-05 已裁决，2026-09-24）。
      理由: DEC-026 后 vmalert 查询 vmselect 已具备全局指标可见性，
            向多个 vmalert 下发同一规则包既冗余，又制造跨域重复告警。
      非 prime 存储不部署 vmalert、不评估规则。
      残留: prime 迁移窗口内新旧 prime 可能短暂同时持有规则，
            由 Flink 的 dedup_key first-wins 兜底（DEC-RC-06）。
```

#### 3.4.2 规则包结构

```yaml
RulePackage:
  zone_id: string                       # 目标网区
  storage_id: string                    # 目标存储实例
  version: uint64                       # 规则包版本号
  updated_at: timestamp

  rule_groups:
    - group_id: string
      name: string                      # 规则组名称
      evaluation_interval: duration     # 评估间隔

      rules:
        - rule_id: string
          alert_name: string            # 告警名称
          expr: string                  # PromQL 表达式
          for: duration                 # 持续时间
          severity: string              # critical | warning | info
          labels:                       # 告警标签
            zone_id: string
          annotations:                  # 告警注释
            summary: string
            description: string
```

#### 3.4.3 规则包热更新

```
规则包更新流程:
    │
    ▼
1. 控制面板推送新规则包到 vmalert
   (通过 DC 网关分发)
    │
    ▼
2. vmalert 校验规则包
   ├── version > current_version → 接受
   ├── version <= current_version → 忽略
   └── 完整性校验通过 → 继续
    │
    ▼
3. 写入 vmalert 规则文件目录
   ├── 新增规则组 → 写入新规则文件
   ├── 删除规则组 → 删除对应规则文件
   ├── 修改规则 → 更新规则文件内容
   └── 修改评估间隔 → 更新规则文件中的 interval
    │
    ▼
4. 调用 vmalert reload API (/-/reload) 触发热加载
   ├── vmalert 自动处理规则 diff（新增/删除/修改）
   ├── 已触发的告警：如果规则被删除，告警自动 RESOLVED
   └── 新增的规则：从 IDLE 状态开始评估
```

### 3.5 告警生成与转发

#### 3.5.1 告警格式

```yaml
Alert:
  # vmalert 生成的原始告警
  alert_name: string                    # 告警名称

  # 标签（用于 Prometheus fingerprint 计算）
  labels:
    zone_id: string                     # 网区 ID
    rule_id: string                     # 规则 ID
    severity: string                    # critical | warning | info
    instance: string                    # 触发告警的实例（来自 PromQL 结果）
    # ... 规则定义中的其他标签

  # 状态
  state: enum                           # FIRING | RESOLVED
  starts_at: timestamp                  # 触发时间
  ends_at: timestamp                    # 解决时间

  # 注释
  annotations:
    summary: string                     # 告警摘要
    description: string                 # 告警描述
    value: string                       # 触发值

  # 元数据（不参与 fingerprint 计算）
  metadata:
    source_zone_id: string              # 来源网区 ID
    source_storage_id: string           # 来源存储 ID
    eval_duration: duration             # 评估耗时
    query_series_count: uint32          # 查询返回的序列数
```

#### 3.5.2 告警转发

告警转发路径：vmalert → Alertmanager（同部署，仅去重）→ am-bridge → Kafka `alert.raw` → Flink 收敛引擎 → Kafka `alert.converged` → 平台

```
vmalert            Alertmanager(同部署)      am-bridge        Flink 收敛引擎        平台
  │                       │                    │                    │                │
  │ 告警(Prometheus格式)  │                    │                    │                │
  │──────────────────────▶│                    │                    │                │
  │                  域内 fingerprint 去重      │                    │                │
  │                  + repeat_interval 抑制     │                    │                │
  │                  + resolved 检测            │                    │                │
  │                       │──webhook──────────▶│                    │                │
  │                       │  (send_resolved)   │ 注入 dedup_key      │                │
  │                       │                    │──alert.raw────────▶│                │
  │                       │                    │      屏蔽/跨域去重/收敛/逐级抑制/恢复延迟│
  │                       │                    │                    │─alert.converged▶│
  │                       │                    │                    │     认领/通知调度/关闭
```

Alertmanager 负责（v3.0 收窄至零用户配置，DEC-028/DEC-037）：
- **fingerprint 去重**：hash(alertname + sorted labels)，存储域内精确去重
- **重发抑制**：`repeat_interval` 控制持续 firing 告警的重发频率（时间维度削峰，约两个数量级）
- **resolved 检测**：显式路径（vmalert 推 `status: resolved`，即时透传）+ 隐式路径（`resolve_timeout` 兜底）
- **输出**：单一 webhook receiver → am-bridge → Kafka

**AM receiver 必须配置 `send_resolved: true`**（硬约束）。否则 resolved 事件到不了下游，Flink 的 keyed state 无法回收只能等 TTL，收敛组的组级恢复裁决（`alert-management.md` §3.3.7）与抑制解除（§3.3.3）都会失效。

**AM `resolve_timeout` 由默认 5m 调大到 30m**（v3.0，DEC-035）。理由：vmalert 每个评估周期向 AM 推送**全量当前 firing 集合**，`repeat_interval` 节流的是**通知**不是**摄入**，因此只要 vmalert 活着，`resolve_timeout` 永不触发。它只在 vmalert 停止推送时起作用——而那种情况下触发它是**错的**（vmalert 挂了不等于告警都好了，见 §3.5.4）。调大无代价：真恢复走显式路径即时到达。

Alertmanager **不再负责**：分组通知、静默、抑制、限流、路由树——全部下沉到 Flink 收敛引擎或平台侧。

> **AM 是零用户配置组件**（DEC-037）。其 config 只有：一个指向 am-bridge 的 webhook receiver + `group_wait` / `group_interval` / `repeat_interval` / `resolve_timeout` 四个时间参数。**全部由部署模板生成，变更走发布流程，不走控制面板 UI。** 平台不再回调 AM silence API，AM 状态由 `resolve_timeout` 自清理。

> **AM 之间不组集群**（DEC-029）：每个存储域的 AM 只看见本域 vmalert 的告警。跨存储/跨网区的重复由 Flink 按 `dedup_key` 统一裁决（first-wins）。

#### 3.5.3 告警去重策略

| 层级 | 维度 | 策略 | 说明 |
|------|------|------|------|
| vmselect（查询层） | 数据 | `-dedup` + `-replicationFactor` | 保证 vmalert 查询结果无重复序列 |
| Alertmanager（存储域） | **时间** | fingerprint 去重 + `repeat_interval` | 同一告警持续 firing 期间的周期性重发抑制 |
| **Flink 收敛引擎（全局）** | **空间** | **`dedup_key`** first-wins | `dedup_key = hash(alertname + sorted(labels − 来源标识标签))`，排除 `zone`/`zone_id`/`source_storage`/`source_am`/`dc`。保留最先到达者，其余标 `action=deduped` 并记录 `dedup_of`/`source_am`/`source_storage`/`source_zone_id` |
| vmalert 本地 | — | 无需去重 | 由 AM 与 Flink 分层处理 |

**`fingerprint` 与 `dedup_key` 并存、各司其职**（v3.0 闭环 RC-08 / `alert-management.md` MC-09）：

| 键 | 计算方 | 用途 |
|----|--------|------|
| `fingerprint` | vmalert / AM | AM 域内去重、告警身份展示、`alert.control` 路由 |
| `dedup_key` | **am-bridge** 注入 | Flink 跨域裁决、`alert.raw` 的 Kafka partition key |

`dedup_key` 由 am-bridge 计算并注入（bridge 已是无状态协议转换点，加一次哈希零成本；放 Flink 则每个 subtask 都要维护排除列表的一致性）。**`alert.raw` 必须以 `dedup_key` 为 partition key**——跨域重复的两条告警 fingerprint 不同但 `dedup_key` 相同，只有落到同一分区，first-wins 才能在单 subtask 内完成裁决。

**为什么单靠 fingerprint 不够**：fingerprint 含 `zone` 标签，而多 DC 实例与跨网区迁移这两类最主要的跨域重复场景中 `zone` 恰好不同，first-wins 会漏判。**最需要去重的场景恰好是 fingerprint 失效的场景。**

**参数对齐约束**（DEC-029 / DEC-035）：

```
scrape_interval (15~60s)
  < vmalert group_interval (~1m)
    < Flink resolve_hold_s (60s)
      < AM resolve_timeout (30m)
        < AM repeat_interval (4h)
          < Flink state TTL (24h)
```

TTL 必须显著大于 `repeat_interval`（6 次续约机会），否则 AM 重发时 Flink 已遗忘该键，会把老告警当新告警放行。该不变式在配置加载时校验，违反则拒绝启动。

**拓扑标签硬约束**（DEC-030）：fingerprint 与 `dedup_key` 都包含拓扑标签，因此 CMDB 拓扑标签（`host_id`/`rack_id`/`switch_id`/`cluster_id`）必须完整保留在告警中。vmalert 规则的 `labels` 覆写与 `drop` 配置需经校验——标签被裁剪会导致 Flink 无法 keyBy，逐级抑制**静默失效**（告警仍正常产生，只是不再被抑制，故障时表现为告警风暴）。

#### 3.5.4 vmalert 故障 = 全量伪恢复（v3.0 新增，必须带外监控）

**vmalert 停止向 AM 推送后，`resolve_timeout`（30m）到期，AM 会把该 vmalert 名下全部告警判定为 resolved**——全量伪恢复 + 全量静默。存储侧任一环（Alloy / vmstorage / vmselect）故障导致 vmalert 查询结果为空时，效果相同（表达式为空即恢复，见 `alert-management.md` §3.11.2）。

| 组件故障 | 后果 | 危险程度 |
|----------|------|----------|
| Flink / am-bridge / Kafka 挂掉 | 断流，收不到**新**告警 | 高 |
| **vmalert 挂掉** | **全量伪恢复 + 全量静默**，且会主动撤销正在处理的活告警 | **极高** |
| **vmstorage / vmselect / Alloy 挂掉** | 同上 | **极高** |

「告警全清」比「收不到新告警」危险一个量级——后者运维会察觉（没告警了），前者运维会**误以为问题都好了**。

**因此带外心跳必须覆盖整条存储侧链路，不能只覆盖 Flink**（DEC-033 v3.0 修订）：Alloy 上报存活 / vmstorage / vmselect / vmalert / AM / am-bridge / Kafka / Flink。心跳告警走**硬编码最小通知路径**（不经路由策略、不经 Flink、不经 Kafka，直连短信/电话），因为故障的可能正是路由策略本身。详见 `alert-management.md` §3.10.1 与 `notification-channel.md` §3.8。

**补偿措施**：`resolve_timeout` 调大到 30m（覆盖 vmalert 正常重启窗口，第一道廉价防线）+ 带外心跳（根本手段）+ 规则层强制配套 `up == 0` / `absent()` 看门狗（§3.5.5）。

#### 3.5.5 规则发布期强制声明「指标缺失时的行为」（v3.0 新增）

vmalert 语义下**「无数据」= 表达式为空 = 告警恢复**，无法在引擎层区分「条件不再成立」与「样本消失」。治理方式不是改恢复语义，而是**在规则发布环节强制声明**（复用 DEC-RC-05 的同一套逻辑——把静默失败挡在发布期而非运行期）：

控制面板创建/编辑告警规则时，必须三选一，不填不允许发布：

| 选项 | 覆盖场景 | 成本 |
|------|----------|------|
| 1：配套 `up == 0` 看门狗 | exporter / 网络整体中断（最常见） | 低，可按采集任务批量生成 |
| 2：配套 `absent(metric)` 看门狗 | exporter 活着但该指标消失（采集插件坏了、label 改名了） | 高，只对关键指标做 |
| 3：显式声明「可容忍伪恢复」 | info 级、非关键指标 | 零，但留审计记录 |

已有的逐级抑制使大规模伪恢复变得无害：交换机故障 → 下挂实例指标消失 → 一批告警伪恢复 + 一批 `up == 0` firing → 交换机根因告警 firing → 逐级抑制压掉 `up == 0` 子告警。运维最终看到「1 条根因 + 一批恢复」，这是正确结果。危险只存在于孤立单点缺失，而那正是 `up == 0` 覆盖的场景。

---

## 四、核心数据模型

### 4.1 VmalertState（vmalert 实例状态）

```yaml
VmalertState:
  vmalert_id: string                    # vmalert 实例唯一标识
  storage_id: string                    # 关联存储实例 ID
  zone_id: string                       # 所属网区
  state: enum                           # RUNNING | DEGRADED | STOPPED
  datasource_url: string                # vmselect 查询地址
  notifier_url: string                  # Alertmanager 通知地址
  rule_package_version: uint64          # 当前规则包版本
  total_groups: uint32                  # 规则组总数
  total_rules: uint32                   # 规则总数
  firing_rules: uint32                  # 当前 firing 的规则数
  pending_rules: uint32                 # 当前 pending 的规则数
  last_eval_duration: duration          # 最后一次全量评估耗时
  last_eval_errors: uint32              # 最后一次评估的错误数
  started_at: timestamp                 # 启动时间
```

### 4.2 RuleGroupState（规则组状态）

```yaml
RuleGroupState:
  group_id: string                      # 规则组 ID
  storage_id: string                    # 所属存储实例
  evaluation_interval: duration         # 评估间隔
  last_eval_at: timestamp               # 最后评估时间
  last_eval_duration: duration          # 最后评估耗时
  last_eval_result: enum                # SUCCESS | FAILED | TIMEOUT
  total_rules: uint32                   # 规则总数
  firing_rules: uint32                  # 当前 firing 的规则数
  pending_rules: uint32                 # 当前 pending 的规则数
```

### 4.3 RuleState（规则状态）

```yaml
RuleState:
  rule_id: string                       # 规则 ID
  group_id: string                      # 所属规则组
  alert_name: string                    # 告警名称
  state: enum                           # IDLE | PENDING | FIRING | RESOLVED
  pending_at: timestamp                 # 进入 PENDING 的时间
  firing_at: timestamp                  # 进入 FIRING 的时间
  resolved_at: timestamp                # 进入 RESOLVED 的时间
  last_eval_at: timestamp               # 最后评估时间
  last_eval_result: bool                # 最后评估结果 (true = 条件满足)
  active_labels: map<string, string>    # 触发告警的标签集合
  active_value: float64                 # 触发值
  alert_id: string                      # 关联的告警 ID
```

---

## 五、接口与交互

### 5.1 vmalert → vmselect 查询

```
vmalert                                 vmselect
  │                                         │
  │  GET /api/v1/query                      │
  │  ?query=<promql_expr>                   │
  │  &time=<eval_time>                      │
  │────────────────────────────────────────▶│
  │                                         │
  │  vmselect 内部 fan-out 到所有 vmstorage │
  │  合并 + 去重后返回                      │
  │                                         │
  │  Response:                              │
  │  {                                      │
  │    status: "success",                   │
  │    data: {                              │
  │      resultType: "vector" | "matrix",   │
  │      result: [...]                      │
  │    }                                    │
  │  }                                      │
  │◀────────────────────────────────────────│
```

| 接口 | 方向 | 协议 | 频率 | 说明 |
|------|------|------|------|------|
| Instant Query | vmalert → vmselect | HTTP (Prometheus API) | evaluation_interval | 即时查询 |
| Range Query | vmalert → vmselect | HTTP (Prometheus API) | 按需 | 范围查询（部分规则需要） |

### 5.2 控制面板 → vmalert 规则分发

```
DC 网关                                vmalert (prime 存储)
  │                                         │
  │  POST /api/v1/rules                     │
  │  RulePackage {                          │
  │    version: 42,                         │
  │    rule_groups: [...]                   │
  │  }                                      │
  │────────────────────────────────────────▶│
  │                                         │
  │  写入规则文件目录                         │
  │  POST /-/reload                         │
  │────────────────────────────────────────▶│
  │                                         │
  │  200 OK                                 │
  │◀────────────────────────────────────────│
```

| 接口 | 方向 | 协议 | 频率 | 说明 |
|------|------|------|------|------|
| PushRulePackage | DC 网关 → vmalert | HTTP | 事件驱动 | 规则包推送 |
| Reload | DC 网关 → vmalert | HTTP | 事件驱动 | 触发热加载 |

### 5.3 vmalert → Alertmanager 告警转发

```
vmalert                                 Alertmanager (同部署)
  │                                         │
  │  POST /api/v2/alerts                    │
  │  [                                      │
  │    {                                    │
  │      "labels": {                        │
  │        "alertname": "HighCPU",          │
  │        "zone_id": "zone-1",             │
  │        "severity": "critical",          │
  │        "instance": "ora-01",            │
  │        "host_id": "host-07",            │
  │        "rack_id": "rack-east-03",       │
  │        "switch_id": "sw-east-01",       │
  │        "cluster_id": "cluster-db-prod"  │
  │      },                                 │
  │      "annotations": {                   │
  │        "summary": "CPU usage > 90%",    │
  │        "description": "..."             │
  │      },                                 │
  │      "startsAt": "2026-09-23T10:00:00Z" │
  │    }                                    │
  │  ]                                      │
  │────────────────────────────────────────▶│
  │                                         │
  │  200 OK                                 │
  │◀────────────────────────────────────────│
```

**AM 静态配置模板**（v3.0，DEC-037：AM 零用户配置，本文件由部署模板生成，不经控制面板下发）：

```yaml
# alertmanager.yml — 每个存储域一份，仅参数值可能不同
global:
  resolve_timeout: 30m          # v3.0：由默认 5m 调大，覆盖 vmalert 重启窗口（§3.5.2）

route:
  receiver: am-bridge           # 单一 receiver，无路由树
  group_by: ['...']             # 保留全部标签，不做归并（归并在 Flink）
  group_wait: 10s
  group_interval: 1m
  repeat_interval: 4h           # 下游状态续约心跳，必须 < Flink state TTL(24h)

receivers:
  - name: am-bridge
    webhook_configs:
      - url: http://am-bridge:8080/webhook
        send_resolved: true     # 硬约束：缺失则 Flink 状态无法回收
        max_alerts: 0           # 0 = 不分批，bridge 侧拆包

# 无 inhibit_rules、无 silence 配置面、无多 receiver
```

**该文件中不出现任何用户可配置项**。变更（如调整 `repeat_interval`）走发布流程，不走 UI。这消除了「UI 改了但 AM 没生效」「配置渲染错误导致 AM 拒绝加载」「热加载竞态」三类故障。

### 5.4 可观测性接口

```
vmalert 暴露的指标和 API:

  GET /metrics                          # Prometheus 格式自身指标
  GET /api/v1/rules                     # 当前加载的规则列表和状态
  GET /api/v1/alerts                    # 当前活跃的告警列表
  POST /-/reload                        # 触发热加载
  GET /-/health                         # 健康检查

  指标包括：
  · vmalert_alerts_firing_total        # firing 告警总数
  · vmalert_alerts_pending_total       # pending 告警总数
  · vmalert_iteration_duration_seconds # 评估迭代耗时
  · vmalert_iteration_errors_total     # 评估迭代错误总数
  · vmalert_rule_groups_loaded         # 加载的规则组数
```

**带外心跳必须采集的存储侧指标**（v3.0，DEC-033 修订 / §3.5.4）：

| 指标 | 来源 | 判据 |
|------|------|------|
| `vmalert_iteration_duration_seconds` 的 `scrape_timestamp_seconds` 新鲜度 | vmalert | 超过 3 个评估周期无推进 → vmalert 卡死或挂掉 |
| `vmalert_alerts_firing_total` | vmalert | **骤降至 0 或骤降 >80% 而实例数未变** → 全量伪恢复信号 |
| `vmalert_iteration_errors_total` 增速 | vmalert | 突增 → vmselect 查询失败，表达式可能全空 |
| `vm_storage_rows_added_to_storage` 增速 | vmstorage | 骤降 → 写入断流 |
| `up{job="alloy"}` | vmselect 查询 | 采集端存活 |
| AM `/-/health` + webhook 失败计数 | AM | AM 存活与下游可达性 |

**`vmalert_alerts_firing_total` 骤降是最有价值的一条**：它是「全量伪恢复」的直接前兆，且不需要理解任何业务规则就能判定。该指标的告警必须走硬编码最小通知路径，不能走本链路（本链路此时正是故障对象）。

---

## 六、设计决策与替代方案

### DEC-RC-01：规则评估引擎选型

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：vmalert（当前） | 使用 VictoriaMetrics vmalert 开源组件 | 成熟稳定；与 VM 生态完全兼容；社区维护 | 定制能力受限于 vmalert 扩展点 |
| B：自研 PromQL 引擎 | 自行实现 PromQL 求值和规则状态机 | 完全可控 | 开发成本高；与生态不兼容；维护负担 |
| C：Alloy 内置告警 | 使用 Alloy 内置的告警能力 | 减少组件数 | 告警与采集耦合；无全局视图 |

**[决策 2026-09-23]**：方案 A（vmalert）。vmalert 作为独立组件部署在存储侧，查询 vmselect 获取全局视图。方案 C 曾被短暂采用（2026-09-22），但已废弃（2026-09-23），因为告警评估应与存储层共部署而非在采集节点。

### DEC-RC-02：vmalert 部署位置

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：存储侧共部署（当前） | vmalert 与 vmstorage + AM 共部署 | 查询路径短；职责清晰；全局视图 | 存储节点资源需求增加 |
| B：DC 侧部署（旧方案） | vmalert 部署在 DC 节点上 | 靠近数据源 | 无全局视图；DC 节点复杂；peer 组协商开销 |
| C：独立部署 | vmalert 独立于存储部署 | 灵活 | 增加部署复杂度；查询路径更长 |

**[决策 2026-09-23]**：方案 A。vmalert 查询 vmselect 获得全局视图，与 AM 共部署减少通知路径延迟。DC 侧不再部署任何告警评估组件。

### DEC-RC-03：规则分发方式

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：控制面板推送（当前） | 控制面板通过 DC 网关推送规则到 prime 存储的 vmalert | 实时性好；集中管理 | 需要控制面板与存储侧的通信 |
| B：vmalert 定时拉取 | vmalert 定时从控制面板拉取规则 | 简单 | 更新延迟；增加控制面板负载 |
| C：拉取 + 紧急通知 | vmalert 定时拉取 + 紧急变更时通知立即拉取 | 平衡 | 需要两套机制 |

**[决策 2026-09-23]**：方案 A。控制面板推送模式实时性最好，规则变更立即生效。DC 网关作为控制面对 DC 的唯一出口，天然适合做规则分发。

### DEC-RC-04：告警管理架构

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：Alertmanager（当前） | 告警发送到同部署的 Alertmanager 统一处理 | 成熟生态；去重开箱即用；存储域内削峰 | 引入 Alertmanager 依赖 |
| B：vmalert 本地处理 | vmalert 自行处理告警去重和分组 | 无外部依赖 | 重复造轮子；功能有限 |
| C：vmalert 直推 Kafka | 跳过 AM，vmalert webhook 直接进 Kafka | 组件更少 | vmalert 每评估周期重推全部 firing 告警，下游入口流量放大约 240 倍 |

**[决策 2026-09-23]**：方案 A（Alertmanager）。Alertmanager 是 Prometheus 生态的标准告警管理组件。

> **v2.0 修订（2026-09-24，DEC-028/DEC-029）**：仍选方案 A，但 **AM 的职责范围收窄为「存储域去重引擎」**——仅保留 fingerprint 去重、`repeat_interval` 重发抑制、resolved 检测。分组通知、静默、抑制、限流、路由全部下沉到 Flink 收敛引擎与平台通知渠道模块。方案 C 明确否决：AM 的时间维度削峰是 Flink 能在风暴下存活的前提。

> **v3.0 修订（2026-09-24，DEC-037）**：AM 进一步收缩为**零用户配置组件**。删除控制面板→AM 的策略下发链路与平台→AM 的 silence 回调；config 退化为部署期静态模板（§5.3）；`resolve_timeout` 由 5m 调大到 30m；平台关闭告警时改为单向清理 Flink 状态。方案 C 的否决理由在 v3.0 依然成立且更强——AM 现在只做两件事，但这两件事（时间维度削峰 + resolved 检测）是 Flink 能在风暴下存活的前提。

### DEC-RC-05：告警必须携带完整 CMDB 拓扑标签

**[决策 2026-09-24，DEC-030]**：vmalert 告警规则**不得裁剪** CMDB 拓扑标签（`host_id` / `rack_id` / `switch_id` / `cluster_id`）。

**理由**：Flink 的逐级抑制（RCA）依赖告警携带的拓扑作用域链做 keyBy 与 broadcast 查表。标签缺失时 Flink 无从判定父子关系，抑制**静默失效**——告警仍正常产生和通知，只是不再被压制，故障时直接表现为告警风暴，且没有任何错误信号提示配置有问题。

**落地要求**：

| 要求 | 位置 |
|------|------|
| 规则包的 `labels` 覆写与 `drop` 配置需校验，禁止移除拓扑标签 | 规则分发前的控制面校验 |
| 规则评审检查项 | 规则管理规范 |
| 拓扑标签覆盖率统计（缺失比例） | 实例管理模块（`instance-management.md` §3.7.2） |

**连带影响**：拓扑标签参与 fingerprint 与 `dedup_key` 计算。CMDB 变更实例的拓扑归属会导致两者同时变更，在飞告警被当作新告警。已评估并接受，见 `alert-management.md` MC-12。

### DEC-RC-06：跨域去重采用 `dedup_key` 而非 fingerprint

**[决策 2026-09-24，闭环 RC-08]**：Flink 跨域去重的判定键为 `dedup_key = hash(alertname + sorted(labels − 来源标识标签))`，排除 `zone` / `zone_id` / `source_storage` / `source_am` / `dc`。`fingerprint` 保留用于 AM 域内去重与告警身份展示。

**理由**：fingerprint 含 `zone` 标签，而多 DC 实例与跨网区迁移这两类最主要的跨域重复场景中 `zone` 恰好不同——**最需要去重的场景恰好是 fingerprint 失效的场景**。这不是实现细节问题，是判定键选错。

**否决的替代方案**：

| 方案 | 否决理由 |
|------|----------|
| 继续用 fingerprint | 漏判跨域重复，双写与迁移场景产生重复告警 |
| `instance_id + alertname` | 同一实例上同一 alertname 的多个合法并存告警（如不同表空间）会被错误合并 |
| 只靠「规则不重复下发」消除源头 | 已采纳为配套措施（RC-05 裁决为「仅 prime」），但**不解决 prime 迁移窗口**，`dedup_key` 仍必要 |

**落地要求**：

| 要求 | 位置 |
|------|------|
| `dedup_key` 由 **am-bridge** 计算并注入消息体 | bridge 已是无状态协议转换点，加一次哈希零成本；放 Flink 则每个 subtask 都要维护排除列表一致性 |
| `alert.raw` 的 Kafka partition key 改为 `dedup_key` | 跨域副本必须落到同一分区，first-wins 才能在单 subtask 内裁决 |
| `alert.control` 消息体必须携带 `dedup_key` | 主流在 stage 3 后按 `dedup_key` 分区，Flink 不能为找 key 反查运营表（违反「不做重 I/O」） |
| 来源标识标签排除列表列为**系统保留** | 新增来源类标签时必须同步该列表，否则跨域去重静默失效 |

详见 `alert-management.md` §3.2.1。

---

## 七、冲突与开放问题

| ID | 问题 | 影响 | 状态 |
|----|------|------|------|
| RC-01 | vmalert 评估大量规则（>1000 条）时的性能 | 评估耗时可能超过评估间隔 | 待压测 |
| RC-02 | vmalert 查询 vmselect 的性能影响 | 大量并发 PromQL 查询对 vmselect 的压力 | 待压测 |
| RC-03 | 规则包中 PromQL 表达式的安全性 | 恶意或错误的 PromQL 可能导致 vmalert OOM | 待确认（需要查询限制） |
| RC-04 | prime 存储故障时的告警规则迁移 | 是否需要自动迁移到新的 prime 存储 | 待确认 |
| ~~RC-05~~ | ~~非 prime 存储是否需要规则评估~~ | **v3.0 裁决为「仅 prime」**。DEC-026 后 vmalert 查询 vmselect 已具备全局指标可见性，向多个 vmalert 下发同一规则包既冗余又制造跨域重复告警。`instance-management.md` §3.6.6 已同步修订 | **已闭环（2026-09-24）** |
| ~~RC-08~~ | ~~跨域重复告警的判定键~~ | **v3.0 引入 `dedup_key`**（剔除来源标识标签后重新哈希），由 am-bridge 计算注入，`alert.raw` 以其为 partition key。见 DEC-RC-06 与 `alert-management.md` MC-09 | **已闭环（2026-09-24）** |
| RC-09 | **vmalert / 存储侧故障导致全量伪恢复** | vmalert 停止推送后 `resolve_timeout`(30m) 到期，AM 把其名下全部告警判定 resolved；vmstorage/vmselect/Alloy 故障导致表达式为空时效果相同。「告警全清」比「收不到新告警」危险一个量级，因为运维会误以为问题都好了 | **已接受 + 补偿**：带外心跳扩展到整条存储侧链路 + `resolve_timeout` 调大 + 规则强制配套 `up`/`absent` 看门狗。见 §3.5.4 / §3.5.5 |
| RC-10 | `dedup_key` 来源标识标签排除列表的维护 | 新增来源类标签（如未来的 `region`、`site`）时若未同步排除列表，跨域去重会**静默失效**——两条本应判重的告警因新标签不同而被当作两条 | 待确认：排除列表应列为系统保留标签并纳入标签管理规范；建议增加「跨域重复率」指标作为失效信号 |
| RC-06 | vmalert 版本升级与定制扩展点的兼容性 | 需确保定制不受 vmalert 升级影响 | 待确认 |
| RC-07 | DC 侧 peer 组/slot 协商的废弃迁移 | 旧部署中 RC peer 组的处理 | 已废弃（2026-09-23） |

---

## 八、废弃内容

> 以下内容在 v2.0（2026-09-23）中废弃，保留索引以供追溯。

| 废弃项 | 原内容 | 替代方案 |
|--------|--------|----------|
| RC Peer 组 | VRRP 风格的 RC 节点 peer 组 | vmalert 存储侧独立部署，无需 peer 协商 |
| RC Slot 协商 | epoch fencing 风格的规则组归属协商 | 规则由控制面板直接分发到 prime 存储 |
| DC 侧 RC 部署 | vmalert 部署在 DC 节点上 | vmalert 部署在存储侧，与 vmstorage + AM 共部署 |
| RC → 本地存储查询 | vmalert 直接查询本地 VM/vmselect | vmalert 查询全局 vmselect |
| RC ↔ Scheduler 交互 | RC 从 Scheduler 拉取规则包 | 控制面板推送规则到 vmalert |
| Mode A 不部署 RC | Mode A 区无告警能力 | 所有存储实例都部署 vmalert |
| RCAdvertisement 心跳 | RC 节点间心跳协议 | 不再需要，vmalert 独立运行 |
| RuleGroupTakeover | 规则组接管提案/投票 | 不再需要，无 peer 组概念 |
