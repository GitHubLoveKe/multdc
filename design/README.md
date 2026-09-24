# 多网区监控采集平台 — 功能模块设计索引

> 版本：v1.2 | 日期：2026-09-24
> 上游文档：`项目架构雏形与冲突分析.md`（v3）
> 状态：功能模块拆分设计，含冲突标注与多方案对比
>
> **v1.2 更新（2026-09-24）**：告警处理层（§2.5）补齐 DEC-034 ~ DEC-037 的组件变化——AM 零配置化、新增 `notification_scheduler`(A6) 与带外心跳监控(A7)、关闭清理改单向、Flink 算子链重排、引入 `dedup_key`。C4/C5 职责描述同步更新。
>
> **v1.1 更新（2026-09-24）**：新增 §2.5 告警处理层（A1~A5），对应 DEC-028 ~ DEC-033。

---

## 一、架构总览

本平台采用三层架构，职责分离、降级自治：

```
中心控制面 (Management Plane)
  │  唯一定义权威，不参与实时调度
  │  期望态下发（低频、版本化）
  ▼
协调层 (Coordination Plane)
  │  区内实时权威，中心不可用时照常服务
  │  区内闭环（高频、本地决策）
  ▼
采集层 (Data Plane)
     执行采集、检测、存储、查询
```

**核心设计原则**：

| # | 原则 | 含义 |
|---|------|------|
| P1 | 集中管理 ≠ 集中调度 | 中心是唯一定义权威，但不是实时裁决权威 |
| P2 | 任务内容与归属解耦 | 全区 Manifest 广播，归属只是轻量映射 |
| P3 | 检测权分布式化 | VRRP 式 peer 互探，中心只做观测与仲裁 |
| P4 | RC 与存储绑定 | RC 仅部署在有本地存储的网区（模式 B/C） |
| P5 | Job + Agent 分离 | Job Scheduler 调度，Agent 采集，职责清晰 |
| P6 | OTel Collector 统一数据管道 | 不采集、不调度，专注多输入多输出路由 |
| P7 | VM 优先 | 时序存储全链路统一 VictoriaMetrics |
| P8 | 任务路由 / 读取路由 / RC 路由 三路分离 | 各路由独立决策，互不耦合 |

---

## 二、模块索引

### 2.1 中心控制面 (Control Plane)

中心控制面是全局唯一「定义权威」，负责「做什么」，不参与「怎么做」。

| # | 模块 | 文档 | 核心职责 | 状态 |
|---|------|------|---------|------|
| C1 | 网区管理 | [control-plane/zone-management.md](control-plane/zone-management.md) | Zone 注册/发现、网段映射、拓扑维护、自动推荐 | 设计中 |
| C2 | 实例管理 | [control-plane/instance-management.md](control-plane/instance-management.md) | 实例台账、分类管理（Oracle/MySQL/Linux/Windows）、快速测试、CMDB 拓扑同步与标签富化 | 设计中 |
| C3 | 实例状态维护 | [control-plane/instance-status.md](control-plane/instance-status.md) | 周期性从 TSDB 拉取中间件状态、状态机维护、异常检测 | 设计中 |
| C4 | 告警管理 | [control-plane/alert-management.md](control-plane/alert-management.md) | 最终事件消费、告警认领（含三个正交开关）、路由匹配、通知调度（重复通知/自动升级/通知静默）、关闭与单向状态清理、全量事件账本与处理轨迹检索、动态收敛/抑制/屏蔽规则管理、降噪效果分析 | 设计中 |
| C5 | 通知渠道管理 | [control-plane/notification-channel.md](control-plane/notification-channel.md) | 通知渠道配置、通知组管理（receiver 目标）、模板渲染（firing/resolved 分模板）、限流与投递幂等、渠道健康与主备切换、**升级链定义（唯一权威）**、硬编码最小通知路径 | 设计中 |
| C6 | 指标维护 | [control-plane/metric-management.md](control-plane/metric-management.md) | 常用查询集、用户自定义查询、指标元数据管理 | 设计中 |
| C7 | 凭据服务 | [control-plane/credential-service.md](control-plane/credential-service.md) | 凭据存储/分发、访问控制、轮换策略 | 设计中 |
| C8 | 统一查询入口 | [control-plane/query-gateway.md](control-plane/query-gateway.md) | 查询网关、路由决策、Grafana 集成、跨区混合查询 | 设计中 |

**关于采集任务定义与 RC 任务定义的归属说明**：

> 用户在初始需求中将「采集任务管理」和「RC 任务管理」列在控制面，但以 `#` 标注了对其归属的疑问。
>
> **本设计的处理方式**：将任务管理拆分为「定义」与「调度」两层——
> - **控制面**负责 TaskSpec / RuleSpec 的**定义与版本管理**（做什么、采集什么指标、什么频率、用什么 Agent 类型）
> - **协调面**负责 Zone Manifest 的**生成、slot 分配与运行时调度**（谁来做、分到哪个 slot、哪个 Agent 执行）
>
> 这一拆分与核心原则 P1（集中管理 ≠ 集中调度）完全一致。TaskSpec 的「定义」是全局权威行为；Manifest 的「生成与调度」是区内实时行为。
>
> **替代方案**：将 TaskSpec 定义也下沉到协调面（适用于网区完全自治、中心只做审计的场景），但当前阶段不建议——会丧失全局一致性视图。
>
> 详见 [cross-plane/decisions-log.md](cross-plane/decisions-log.md) DEC-001。

### 2.2 协调层 (Coordination Plane)

协调层是区内「实时权威」，负责「怎么做」——将控制面的期望态转化为区内实际执行。

| # | 模块 | 文档 | 核心职责 | 状态 |
|---|------|------|---------|------|
| K1 | 采集任务调度 | [coordination-plane/collection-task-scheduling.md](coordination-plane/collection-task-scheduling.md) | Manifest 生成、slot 分配、Agent 调度、epoch fencing | 设计中 |
| K2 | RC 任务调度 | [coordination-plane/rc-task-scheduling.md](coordination-plane/rc-task-scheduling.md) | RC 任务跟随存储、规则包分发、RC slot 管理 | 设计中 |
| K3 | 组件健康 | [coordination-plane/component-health.md](coordination-plane/component-health.md) | 主动探测 + 组件自报 + peer 互报、节点状态机 | 设计中 |
| K4 | 冲突仲裁 | [coordination-plane/conflict-arbitration.md](coordination-plane/conflict-arbitration.md) | 归属冲突、2/偶数节点投票、split-brain 防护 | 设计中 |
| K5 | 行为决策 | [coordination-plane/behavior-decision.md](coordination-plane/behavior-decision.md) | 再均衡、驱离、冷却策略、迁移抑制 | 设计中 |

**关键设计约束**：
- 采集任务调度（K1）与 RC 任务调度（K2）共享 Job Scheduler 的 slot 归属协商机制，但 RC 任务有额外的存储绑定约束
- 组件健康（K3）的节点状态机是冲突仲裁（K4）和行为决策（K5）的输入
- 协调层在 L1（中心不可达）时仍能独立工作

### 2.3 采集层 (Data Plane)

采集层是执行层，负责实际的采集、检测、数据存储与查询代理。

| # | 模块 | 文档 | 核心职责 | 状态 |
|---|------|------|---------|------|
| D1 | Job Scheduler | [data-plane/job-scheduler.md](data-plane/job-scheduler.md) | 持有 Manifest、peer 互探、slot 归属协商、调度 Agent | 设计中 |
| D2 | Agent | [data-plane/agent.md](data-plane/agent.md) | 多类型采集执行器（Scrape/SNMP/Probe 等） | 设计中 |
| D3 | OTel Collector | [data-plane/otel-collector.md](data-plane/otel-collector.md) | 统一数据管道、多输入多输出路由、标签注入 | 设计中 |
| D4 | RC RuleCheck | [data-plane/rc-rulecheck.md](data-plane/rc-rulecheck.md) | 规则检测引擎、与存储绑定、区内取数巡检 | 设计中 |
| D5 | Zone Query Proxy | [data-plane/zone-query-proxy.md](data-plane/zone-query-proxy.md) | 区内查询聚合、按存储模式分支 | 设计中 |
| D6 | Storage | [data-plane/storage.md](data-plane/storage.md) | 三种存储模式（A/B/C）、VM 集群管理 | 设计中 |

### 2.4 跨层协议

| 文档 | 内容 |
|------|------|
| [cross-plane/zone-manifest-protocol.md](cross-plane/zone-manifest-protocol.md) | Zone Manifest 格式、下发协议、降级广播机制 |
| [cross-plane/degradation-autonomy.md](cross-plane/degradation-autonomy.md) | 四级降级阶梯（L0-L3）详细定义 |
| [cross-plane/decisions-log.md](cross-plane/decisions-log.md) | 所有设计决策、冲突记录、多方案对比 |

### 2.5 告警处理层 (Alert Processing)

> **v1.1 新增（2026-09-24，DEC-028 ~ DEC-033）**：告警链路重构后新增的平台侧组件。这些组件不属于「定义权威」的控制面，也不属于区内执行的采集层，因此单列。详细设计见 [control-plane/alert-management.md](control-plane/alert-management.md)。
>
> **v1.2 更新（2026-09-24，DEC-034 ~ DEC-037）**：AM 收缩为**零用户配置**组件（config 由部署模板生成，不走 UI）；新增 A6 `notification_scheduler`（平台侧通知调度）与 A7 带外心跳监控；关闭清理由双向改为**单向**（不再回调 AM silence）；Flink 算子链重排。

| # | 组件 | 部署位置 | 核心职责 | 状态 |
|---|------|----------|----------|------|
| A1 | Alertmanager | 存储侧（与 vmalert 共部署） | **存储域内去重 + resolved 检测**，仅此两项。**零用户配置**——config 由部署模板生成，变更走发布流程。不做分组/屏蔽/抑制/路由/silence。AM 之间**不组集群**，状态由 `resolve_timeout`(30m) 自清理 | 设计中 |
| A2 | am-bridge | 存储侧或平台侧 | 无状态 webhook → Kafka 桥接（AM 原生无 Kafka sink）；注入来源标识与 **`dedup_key`**（跨域去重键，剔除 `zone` 等来源标识标签后重新哈希） | 设计中 |
| A3 | Kafka | 平台侧 | 单集群六 topic：`alert.raw`（key=`dedup_key`）/ `alert.rule` / `alert.topo` / `alert.control` / `alert.event` / `alert.converged`。缓冲削峰，隔离故障域 | 设计中 |
| A4 | **Flink 收敛引擎** | 平台侧 | **全局唯一裁决点**：屏蔽（纯 broadcast）→ 跨域去重（`dedup_key` first-wins + 续约吸收）→ 收敛（组级恢复裁决）→ 逐级抑制（拓扑 RCA + 抑制解除信号）→ 恢复延迟与抖动锁定；全量事件账本 + 处理轨迹；动态规则 broadcast 热更新。**不参与任何通知决策** | 设计中 |
| A5 | 账本落库 worker | 平台侧 | 独立 consumer group 消费 `alert.event`，批量落库（前期 PG 分区，阈值触发后迁 ClickHouse）。lag 影响明细下钻**与抑制解除补发的正确性** | 设计中 |
| A6 | **notification_scheduler** | 平台侧（C4 内） | 重复通知、自动升级、认领超时、恢复处理、抑制解除补发。PG 扫描 + `FOR UPDATE SKIP LOCKED`，无状态可多副本。**通知策略变更永不触碰 Flink** | 设计中 |
| A7 | **带外心跳监控** | 独立于告警链路 | 监控**整条存储侧链路 + Flink**（Alloy/vmstorage/vmselect/vmalert/AM/bridge/Kafka/Flink）存活；超时走**硬编码最小通知路径**（不经路由策略、不经 Flink/Kafka，直连短信电话）。vmalert 挂掉 = 全量伪恢复，比 Flink 挂掉危险一个量级 | 设计中 |

**告警链路**：

```
vmalert → AM(A1 去重+resolved) → am-bridge(A2 +dedup_key) → Kafka(A3) → Flink(A4)
                                                                          ├→ alert.event → 账本 worker(A5) → 账本存储
                                                                          └→ alert.converged → C4 告警管理
                                                                                                 ↓
                                                              A6 通知调度 → C5 通知渠道 → 运维人员
                                                              关闭 → alert.control → 单向清理 Flink 状态

A7 带外心跳 ⟂ 独立监控以上全链路，故障时走硬编码最小通知路径
```

**关键边界（三条）**：

1. **告警管理（C4）只在最终事件到达平台后才开始。** 去重、收敛、抑制、屏蔽全部在 A1/A4 完成，C4 不承担这些职责，也不感知原始告警量级。
2. **Flink（A4）不参与任何通知决策。** 路由匹配、重复通知、自动升级、通知静默全在平台侧（A6 + C5），因为这些决策依赖认领状态等平台可变业务状态，而 `claim` 不进流。
3. **两类静默分属不同层。** 告警屏蔽（Flink，决定事件是否成立，被屏蔽事件不进活跃列表）vs 通知静默（平台，事件照常产生入库，只是不叫人）。详见 alert-management.md §3.5。

---

## 三、模块依赖关系

```
                    ┌─────────────────────────────────────────┐
                    │           中心控制面 (Control Plane)       │
                    │                                          │
  ┌──────────┐      │  C1 网区管理 ──→ C2 实例管理              │
  │ 用户/UI  │─────▶│       │               │                  │
  └──────────┘      │       ▼               ▼                  │
                    │  C8 查询网关    TaskSpec / RuleSpec       │
                    │       ▲            │                      │
                    │       │            ▼                      │
                    │  C6 指标维护   C4 告警管理 ← C5 通知渠道   │
                    │                  ▲                        │
                    │  C7 凭据服务     │                        │
                    │  C3 实例状态     │                        │
                    └────────┬─────────┘                        │
                             │ TaskSpec / RuleSpec (版本化下发)   │
                             ▼
                    ┌─────────────────────────────────────────┐
                    │          协调层 (Coordination Plane)       │
                    │                                          │
                    │  K1 采集调度 ◄── K3 组件健康              │
                    │       │            │                      │
                    │       │      K4 冲突仲裁                  │
                    │       │            │                      │
                    │  K2 RC调度  ◄── K5 行为决策               │
                    └────────┬─────────────────────────────────┘
                             │ Zone Manifest + slot 归属
                             ▼
                    ┌─────────────────────────────────────────┐
                    │           采集层 (Data Plane)              │
                    │                                          │
                    │  D1 Job Scheduler ──调度──→ D2 Agent      │
                    │        │                        │         │
                    │        │                        ▼         │
                    │        │               D3 OTel Collector  │
                    │        │                        │         │
                    │  D4 RC RuleCheck ◄──取数── D6 Storage     │
                    │                                          │
                    │  D5 Zone Query Proxy ──→ 查询网关          │
                    └─────────────────────────────────────────┘
```

---

## 四、全局冲突与待决策汇总

### 4.1 模块级冲突

| ID | 冲突 | 涉及模块 | 严重程度 | 当前状态 |
|----|------|---------|---------|---------|
| MC-01 | 任务定义归属：控制面 vs 协调面 | C1/K1 | P0 | 本设计采用「定义在控制面，调度在协调面」拆分方案 |
| ~~MC-02~~ | ~~RC 任务是否需要独立 slot 池~~ | ~~K1/K2~~ | — | **已作废**：Slot 模型整体废弃（DEC-010/DEC-014），Alloy clustering 替代；RC/vmalert 移至存储侧共部署（DEC-026） |
| MC-03 | 实例状态维护的数据源选择 | C3/D6 | P1 | TSDB 直查 vs 中间件缓存，见 instance-status.md |
| ~~MC-04~~ | ~~模式 A 网区的告警覆盖缺失~~ | ~~C4/D4~~ | — | **已作废**：Mode A/B/C 概念整体废弃（DEC-003/DEC-009/DEC-022）。vmalert 存储侧共部署并查询 vmselect 获得全局可见性（DEC-026），「无本地 RC」问题不复存在。见 alert-management.md MC-04 |
| MC-05 | Grafana 数据源自动维护的复杂度 | C8/D5 | P1 | 三阶段方案，见 query-gateway.md |
| MC-06 | 跨区混合查询的性能与一致性 | C8/K1 | P1 | fan-out 聚合 vs 中心汇聚，见 query-gateway.md |
| MC-07 | 凭据扩散与 Manifest 全区广播的矛盾 | C7/K1 | P0 | Manifest 不含凭据，只含 credential_id 引用 |
| MC-16 | 跨时区通知静默期 | C5 | P2 | 值班排班不做后失去 timezone 载体；建议全局统一时区，见 notification-channel.md NC-MC-14 |
| RC-09 | vmalert / 存储侧故障 = 全量伪恢复 | A1/A7/D4 | P0 | **已接受 + 补偿**：带外心跳覆盖整条存储侧链路 + `resolve_timeout` 30m + 规则强制配套看门狗。见 rc-rulecheck.md §3.5.4 |
| RC-10 | `dedup_key` 来源标识标签排除列表的维护 | A2/A4 | P1 | 新增来源类标签未同步列表会导致跨域去重静默失效，见 rc-rulecheck.md |

### 4.2 全局待决策

| ID | 决策项 | 候选方案 | 阻塞模块 |
|----|--------|---------|---------|
| GD-01 | 跨区连通模型 | M1/M2/M3/M2+M3 | K1, C1 |
| GD-02 | 网区数量与单区规模 | 需业务方提供 | 全局 |
| GD-03 | 每区节点数 | ≥3 / 2 / 1 | D1, K4 |
| GD-04 | 凭据安全模型 | 模型 1/2/3 | C7 |
| GD-05 | scrape/probe slot 独立性 | 独立池 / 共享池 | K1, D1 |
| GD-06 | 中心是否需要长期存储 | 做 / 不做 | C8, D6 |

---

## 五、文档约定

### 5.1 每个模块文档的标准结构

```
# 模块名称

## 一、概述
## 二、职责边界
## 三、功能清单
## 四、核心数据模型
## 五、接口与交互
## 六、设计决策与替代方案
## 七、冲突与开放问题
```

### 5.2 标注约定

- **[已确认]**：已做出决策，有明确方案
- **[待确认]**：需要进一步讨论或业务方输入
- **[冲突]**：与其他模块或文档存在矛盾
- **[替代方案]**：提供了多种可选设计
- **[建议]**：设计者的推荐方案及理由

### 5.3 上游引用

本套文档的架构基础来自 `项目架构雏形与冲突分析.md`（v3），该文档综合了以下 5 份输入：
1. v0.2 架构设计
2. 需求整理与 Plan-v2
3. 需求审视与实施 Plan
4. 分区规模接入方案
5. 需求梳理 v3
