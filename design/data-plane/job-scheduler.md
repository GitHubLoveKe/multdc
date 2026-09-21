# Job Scheduler 作业调度器

> 版本：v1.0 | 日期：2026-09-21
> 状态：设计中

---

## 一、概述

Job Scheduler 是采集层（Data Plane）在每个网区节点上的核心调度组件。它是该区节点的「大脑」，负责持有完整的 Zone Manifest、与同级节点进行 peer 检测、协商 slot 归属、调度本地 Agent 执行采集任务，并向协调层和控制面上报状态。

每个网区部署 N 个 Job Scheduler 节点（N >= 1），它们持有相同的 Zone Manifest 视图，但各自拥有不同的 slot 子集。节点之间通过 VRRP 风格的 peer 检测协议感知彼此状态，通过 epoch fencing 机制防止 split-brain，实现「宁可停采也不双主」的核心安全约束。

### 核心定位

```
Zone Manifest (全区完整视图)
    │
    ▼
┌─────────────────────────────────────────────┐
│ Job Scheduler (每节点一个)                     │
│                                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Manifest │  │   Peer   │  │  Slot    │   │
│  │ Manager  │  │ Detection│  │ Owner    │   │
│  │          │  │ (VRRP)   │  │ Negotiate│   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│       │              │              │         │
│       └──────────────┼──────────────┘         │
│                      │                        │
│               ┌──────┴──────┐                 │
│               │   Agent     │                 │
│               │  Scheduler  │                 │
│               └──────┬──────┘                 │
└──────────────────────┼────────────────────────┘
                       │ Push 采集指令 + Pull 任务同步
                       ▼
                  Agent 采集器
```

---

## 二、职责边界

**本文档负责**：
- Zone Manifest 的本地管理与热更新
- Peer 检测协议（VRRP 风格心跳、状态判定）
- Slot 归属协商（分配、接管、epoch fencing）
- Agent 调度（任务分配、负载均衡、故障重分配）
- 节点状态机（REGISTER → HEALTHY → EXPIRED 等）
- 状态上报（向 Coordinator、Control Plane、Peer 的汇报协议）

**本文档不负责**：
- Zone Manifest 的生成与跨区下发（→ `cross-plane/zone-manifest-protocol.md`）
- Coordinator 的 epoch 签发逻辑（→ `coordination-plane/collection-task-scheduling.md`）
- Agent 的内部采集实现（→ `data-plane/agent.md`）
- 降级阶梯的整体定义（→ `cross-plane/degradation-autonomy.md`）
- OTel Collector 的数据管道管理（→ `data-plane/otel-collector.md`）

---

## 三、功能清单

### 3.1 功能总览

| 功能模块 | 功能项 | 优先级 | 说明 |
|---------|--------|--------|------|
| Manifest 管理 | 接收并持有完整 Zone Manifest | P0 | 从 Zone Agent 获取 |
| Manifest 管理 | Manifest 版本追踪与校验 | P0 | 拒绝低版本，检测跳号 |
| Manifest 管理 | Manifest 热更新（diff 应用） | P0 | 不重启生效 |
| Manifest 管理 | Manifest 本地持久化 | P1 | 重启后恢复 |
| Peer 检测 | 3s 心跳广播 | P0 | VRRP 风格 Advertisement |
| Peer 检测 | 节点状态判定（SUSPECT/EXPIRED） | P0 | 非对称独立检测 |
| Peer 检测 | 节点信息维护（peer table） | P0 | 所有已知节点的状态表 |
| Slot 归属 | 初始 slot 分配 | P0 | 启动时均分 |
| Slot 归属 | 故障接管（takeover） | P0 | 节点失效后多数派投票 |
| Slot 归属 | Epoch fencing | P0 | 复合令牌防 split-brain |
| Slot 归属 | 再均衡响应 | P1 | 响应 Coordinator 的迁移指令 |
| Agent 调度 | Agent 注册与发现 | P0 | 管理本节点所有 Agent |
| Agent 调度 | 采集任务分配 | P0 | 按类型/负载/健康分配 |
| Agent 调度 | Agent 健康监控 | P0 | 周期性检查 |
| Agent 调度 | Agent 故障重分配 | P1 | Agent 失效时迁移 target |
| Agent 调度 | SyncTasks 任务同步 | P0 | Agent 周期性同步任务列表（Pull 安全网） |
| Agent 调度 | 采集间隔层级解析 | P1 | 平台默认 → TaskSpec → Target 三级配置 |
| 状态上报 | Coordinator 心跳（15s） | P0 | alive session |
| 状态上报 | 控制面观测矩阵（10s） | P0 | slot/agent/采集统计 |
| 状态上报 | Peer Advertisement（3s） | P0 | 节点间状态同步 |

### 3.2 Manifest 管理

#### 3.2.1 Manifest 接收与存储

Job Scheduler 启动时，从 Zone Agent 获取当前 Zone Manifest。Manifest 是全区完整清单，包含所有 slot、target、agent 信息。每个 Job Scheduler 持有的 Manifest 内容完全相同，差异仅在于各自拥有的 slot 子集。

```
Zone Agent                         Job Scheduler (Node A)
    │                                    │
    │  Push Manifest v42                 │
    │───────────────────────────────────▶│
    │                                    │  校验 version > current_version
    │  ACK                               │  存储到内存 + 本地磁盘
    │◀───────────────────────────────────│  应用 diff 到运行态
    │                                    │
```

#### 3.2.2 版本追踪规则

- `version` 单调递增，每次 TaskSpec 变更 +1
- Job Scheduler 拒绝接受 `version <= current_version` 的 Manifest
- 检测到跳号（v41 → v43）时，主动拉取缺失版本或请求全量同步
- Manifest 变更采用 diff 应用模式，避免全量替换的性能开销

#### 3.2.3 热更新流程

```
Manifest v42 → v43 (新增 target T100 到 slot 5)
    │
    ▼
Job Scheduler 处理流程：
    1. 解析 diff：slot 5 新增 target T100
    2. 检查 slot 5 归属：
       ├── 属于本节点 → 将 T100 分配给本地 Agent
       └── 属于其他节点 → 仅更新本地 Manifest 缓存
    3. 更新内存 Manifest 为 v43
    4. 持久化到本地磁盘
    5. 下次 Peer Advertisement 携带新版本的 hash
```

### 3.3 Peer 检测协议

#### 3.3.1 心跳机制

所有 Job Scheduler 节点之间形成全连接 mesh（full mesh），每个节点周期性（默认 3s）向所有其他节点广播 VRRP Advertisement。

```
Node A (3s) ───Advertisement───▶ Node B
Node A (3s) ───Advertisement───▶ Node C
Node B (3s) ───Advertisement───▶ Node A
Node B (3s) ───Advertisement───▶ Node C
Node C (3s) ───Advertisement───▶ Node A
Node C (3s) ───Advertisement───▶ Node B
```

Advertisement 报文内容：

```yaml
VRRPAdvertisement:
  sender_node_id: string          # 发送者标识
  zone_id: string                 # 所属网区
  manifest_version: uint64        # 当前持有的 Manifest 版本
  owned_slots: [uint32]           # 当前拥有的 slot 列表（摘要）
  owned_slots_hash: string        # slot 归属的 hash（快速对比）
  health_status: enum             # HEALTHY / DEGRADED / OVERLOADED
  agent_inventory:                # 本地 Agent 清单摘要
    total: uint32
    healthy: uint32
    by_type: map<string, uint32>  # 各类型 Agent 数量
  epoch_token: string             # 当前 epoch 令牌
  timestamp: timestamp            # 发送时间
  seq: uint64                     # 序列号（用于检测丢失）
```

#### 3.3.2 状态判定逻辑

每个节点独立维护一张 peer table，记录所有已知节点的状态。状态判定是非对称的——每个节点独立判断其他节点的状态，不存在全局共识。

```
                         连续 missed_count
  ┌─────────┐    miss    ┌──────────┐   miss M次    ┌──────────┐
  │ HEALTHY  │──────────▶│ SUSPECT  │──────────────▶│ EXPIRED  │
  └─────────┘            └──────────┘               └──────────┘
       ▲                      │                         │
       │   收到心跳            │ 收到心跳                 │ 收到心跳
       └──────────────────────┘                         │
       ▲                                                │
       └────────────────────────────────────────────────┘
                     (重新收到心跳 → 回到 HEALTHY)
```

判定参数：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| heartbeat_interval | 3s | 心跳发送间隔 |
| suspect_threshold | 3 | 连续 missed 次数 → SUSPECT |
| expired_threshold | 5 | 连续 missed 次数 → EXPIRED |
| skew_tolerance | 500ms | 时间偏差容忍度 |

- **SUSPECT**（疑似故障）：连续 3 次未收到心跳（约 9s）。节点可能网络抖动或负载过高。此时不触发任何操作，仅标记。
- **EXPIRED**（确认过期）：连续 5 次未收到心跳（约 15s）。节点被认为不可用，可触发 slot 接管流程。

#### 3.3.3 非对称检测的意义

非对称检测意味着 Node A 可能认为 Node B 已 EXPIRED，但 Node C 仍认为 Node B 是 HEALTHY。这是正常且预期的行为。Slot 接管需要多数派共识（见 3.4），非对称检测只是提供输入信息，不直接触发状态变更。

### 3.4 Slot 归属协商

#### 3.4.1 初始分配

网区启动时，所有 slot 需要在 Job Scheduler 节点间均分。

```
总 slot 数: 12
节点数: 3 (A, B, C)
每节点分配: 12 / 3 = 4 slots

Node A: slot [0, 1, 2, 3]
Node B: slot [4, 5, 6, 7]
Node C: slot [8, 9, 10, 11]
```

初始分配由 Coordinator 协调完成（L0 模式），或由节点间协商完成（L3 模式）。

分配算法：
1. 计算 `base_count = total_slots / node_count`
2. 计算 `remainder = total_slots % node_count`
3. 前 `remainder` 个节点各多分配 1 个 slot
4. 生成分配方案，Coordinator 签发 epoch token

#### 3.4.2 故障接管（Takeover）

当某节点被多数派判定为 EXPIRED 时，其拥有的 slot 需要被其他节点接管。

```
Node B 被判定 EXPIRED
    │
    ▼
Node A 和 Node C 检测到 B 过期
    │
    ▼
接管协商流程：
    1. Node A 广播 "B 的 slot [4,5,6,7] 待接管" 提案
    2. Node C 评估自身负载，回复可接管的 slot 子集
    3. 多数派达成共识（A 接管 [4,5]，C 接管 [6,7]）
    4. 向 Coordinator 请求签发新 epoch token
    5. Coordinator 签发 → 接管生效
    6. 如果 Coordinator 不可用（L3）→ 多数派投票直接生效
```

**关键约束**：
- 接管需要 >50% 存活节点同意（多数派原则）
- 无法达成多数派时，slot 留空（宁可停采也不双主）
- 接管后的 slot 归属仍携带 epoch token，防止旧节点恢复后冲突

#### 3.4.3 Epoch Fencing

Epoch fencing 是防止 split-brain 的核心机制。每个 slot 的归属由一个复合令牌唯一标识：

```
EpochToken = zone_epoch + ":" + slot_version

zone_epoch:    由 Coordinator 签发，全区统一的纪元编号
slot_version:  该 slot 的归属版本号（每次归属变更 +1）
```

```
示例：
  zone_epoch = "ze-42"
  slot 5 的归属历史：
    ze-42:1 → Node A (初始分配)
    ze-42:2 → Node C (Node A 故障后接管)
    ze-43:1 → Node B (新 epoch 后重新分配)
```

Epoch token 的作用：
- Agent 执行采集时携带 epoch token
- 如果旧节点恢复并尝试执行已不属于自己的 slot，其 epoch token 过期，数据被拒绝
- Coordinator 通过 epoch token 判断归属的合法性

#### 3.4.4 「空洞优于双主」原则

当出现以下情况时，slot 暂时无人拥有（空洞）：
- 节点故障，但存活节点无法达成接管多数派
- 网络分区导致多个分区各自无法形成多数派
- Epoch token 签发失败（Coordinator 不可用且无法多数派投票）

空洞是安全的——该 slot 的 target 暂停采集，但不会产生重复数据或归属冲突。空洞在 Coordinator 恢复或网络恢复后自动修复。

### 3.5 Agent 调度

#### 3.5.1 Agent 注册

节点上的每种 Agent 类型在启动时向本地 Job Scheduler 注册：

```yaml
AgentRegistration:
  agent_id: string              # Agent 唯一标识
  agent_type: string            # scrape / snmp / probe / oracle / mysql / ...
  node_id: string               # 所在节点
  capacity: uint32              # 最大可承载 target 数
  supported_protocols: [string] # 支持的协议列表
  version: string               # Agent 版本
  metadata: map<string, string> # 扩展信息
```

#### 3.5.2 任务分配策略

Job Scheduler 根据以下因素决定将 target 分配给哪个 Agent：

```
分配决策流程：
    1. 类型匹配：target 需要的 agent_type 必须与 Agent 声明的类型一致
    2. 容量检查：Agent 当前 target 数 < capacity
    3. 负载均衡：在满足 1、2 的 Agent 中，选择 current_targets 最少的
    4. 健康检查：排除 state 为 error 或 offline 的 Agent
    5. 亲和性（可选）：优先分配给上次执行同一 target 的 Agent（减少上下文切换）
```

#### 3.5.3 Agent 故障处理

```
Agent 故障检测与重分配：
    │
    ▼
Job Scheduler 检测到 Agent 健康检查失败
    │
    ├── 同类型有其他健康 Agent → 将 target 迁移到同类型 Agent
    │
    ├── 同类型无其他 Agent → 标记 target 为 pending
    │   └── 等待新 Agent 注册或节点间协调
    │
    └── 如果 Agent 间歇性故障 → 加入 quarantine 列表
        └── 不再分配新 target，等待恢复或手动干预
```

#### 3.5.4 Push + Pull 双模任务分配

任务分配采用 Push 为主、Pull 为辅的双模机制：

**Push 模式（主路径）**：
- 当 Manifest 变更、slot 归属变化、或新 target 需要分配时，Job Scheduler 主动发送 CollectionInstruction 到 Agent
- 事件驱动，延迟低（毫秒级）
- Agent 收到指令后自行完成采集和数据推送

**Pull 模式（安全网）**：
- Agent 每 30s 向 Job Scheduler 发送 SyncTasks 请求，携带当前持有的任务列表
- Job Scheduler 对比自身视图，返回 diff（需要新增/删除/更新的任务）
- 补偿因网络抖动、消息丢失等原因导致的任务不一致
- SyncTasks 也是 Agent 向 Scheduler 报告存活状态的机会

**Agent 自主执行**：
- Agent 收到采集任务后，自主按 scrape_interval 周期执行采集
- 采集数据由 Agent 直接推送到 OTel Collector（不经过 Scheduler）
- Agent 向 Scheduler 上报的是采集元数据（成功/失败/耗时），而非数据本身

#### 3.5.5 采集间隔配置层级

采集间隔（scrape_interval）遵循以下优先级（从高到低）：

```
平台默认值 (platform_default_scrape_interval)
    │
    ▼  被 TaskSpec 覆盖
TaskSpec 级别 (task_scrape_interval)
    │
    ▼  被 Target 级别覆盖
Target 级别 (target_scrape_interval)
```

| 层级 | 配置来源 | 默认值 | 说明 |
|------|---------|--------|------|
| 平台默认 | 平台全局配置 | 60s | 所有任务的默认采集间隔 |
| TaskSpec 级别 | 控制面任务定义 | 继承平台默认 | 特定任务类型的采集间隔 |
| Target 级别 | 实例台账配置 | 继承 TaskSpec | 特定目标的采集间隔 |

CollectionInstruction 中的 scrape_interval 字段已经过层级解析，Agent 直接使用最终值。

#### 3.5.6 Agent 生命周期管理

```
               注册
                │
                ▼
  ┌─────── REGISTER ───────┐
  │                         │
  │   健康检查通过           │
  │        │                │
  │        ▼                │
  │    WARMING (预热)       │
  │   (分配少量 target      │
  │    验证采集正常)         │
  │        │                │
  │        ▼                │
  │    HEALTHY (健康)       │
  │   (正常承载 target)     │
  │        │                │
  │   ┌────┼────┐           │
  │   │    │    │           │
  │   ▼    ▼    ▼           │
  │ ERROR  │  DRAINING      │
  │(故障)  │  (排空中)       │
  │   │    │    │           │
  │   ▼    │    ▼           │
  │ QUAR-  │  OFFLINE       │
  │ ANTINED│  (已下线)       │
  │        │                │
  └────────┼────────────────┘
           │
      恢复健康 → 回到 HEALTHY
```

### 3.6 节点状态机

#### 3.6.1 完整状态定义

```
                    ┌──────────────────────────────────────────────┐
                    │                                              │
  ┌──────────┐     │     ┌──────────┐     ┌──────────┐           │
  │ REGISTER │─────┼────▶│ WARMING  │────▶│ HEALTHY  │           │
  └──────────┘     │     └──────────┘     └──────────┘           │
                   │          │               │    │              │
                   │          │ 异常           │    │ 主动下线     │
                   │          ▼               │    ▼              │
                   │     ┌──────────┐         │ ┌──────────┐     │
                   │     │ EXPIRED  │         │ │ DRAINING │     │
                   │     └──────────┘         │ └────┬─────┘     │
                   │                          │      │            │
                   │     ┌──────────┐         │      ▼            │
                   │     │ SUSPECT  │         │  ┌──────────┐    │
                   │     └────┬─────┘         │  │ OFFLINE  │    │
                   │          │               │  └──────────┘    │
                   │          │ 确认故障       │                  │
                   │          ▼               │                  │
                   │     ┌──────────┐         │                  │
                   │     │ EXPIRED  │         │                  │
                   │     └────┬─────┘         │                  │
                   │          │               │                  │
                   │          ▼               │                  │
                   │     ┌──────────┐         │                  │
                   │     │ FENCED   │         │                  │
                   │     └──────────┘         │                  │
                   │                          │                  │
                   │     ┌──────────┐         │                  │
                   └────▶│QUARANTINED│◀───────┘                  │
                         └──────────┘                            │
                                                                 │
                         隔离恢复 ───────────────────────────────┘
```

| 状态 | 含义 | 可执行操作 | 持续时间 |
|------|------|-----------|---------|
| REGISTER | 节点刚启动，注册到 Coordinator | 无 | 短暂 |
| WARMING | 预热中，接收 Manifest，建立 peer 连接 | 接收数据，不承载 slot | 10-30s |
| HEALTHY | 正常运行，承载 slot | 全部操作 | 持续 |
| SUSPECT | 疑似故障（被其他节点检测） | 仍执行采集（自身视角可能正常） | 短暂 |
| EXPIRED | 确认过期，slot 待接管 | 无（被隔离） | 直到恢复 |
| FENCED | 被 epoch fencing 隔离 | 无（必须人工干预或 Coordinator 解除） | 持久 |
| DRAINING | 主动下线中，排空 slot | 迁移 slot，不接收新 target | 直到排空 |
| OFFLINE | 已下线 | 无 | 持久 |
| QUARANTINED | 隔离观察（间歇性故障） | 有限操作（不承载新 slot） | 直到恢复 |

#### 3.6.2 状态转换条件

| 转换 | 触发条件 | 动作 |
|------|---------|------|
| REGISTER → WARMING | Coordinator 确认注册 | 开始接收 Manifest |
| WARMING → HEALTHY | Manifest 加载完成 + peer 连接建立 | 开始承载 slot |
| HEALTHY → SUSPECT | 被 peer 检测为疑似故障 | 标记，不立即操作 |
| SUSPECT → EXPIRED | 被多数派确认过期 | 触发 slot 接管 |
| SUSPECT → HEALTHY | 重新收到 peer 心跳 | 清除嫌疑标记 |
| EXPIRED → FENCED | epoch token 过期 | 完全隔离 |
| HEALTHY → DRAINING | 管理员发起下线 | 开始 slot 迁移 |
| DRAINING → OFFLINE | 所有 slot 迁移完成 | 完全下线 |
| HEALTHY → QUARANTINED | 间歇性故障被检测 | 限制操作 |
| QUARANTINED → HEALTHY | 连续 N 次健康检查通过 | 恢复正常 |

### 3.7 状态上报

#### 3.7.1 上报目标与频率

| 上报目标 | 频率 | 内容 | 协议 |
|---------|------|------|------|
| Coordinator | 15s | 存活心跳、epoch 确认 | gRPC/HTTP |
| Control Plane | 10s | 观测矩阵（slot/agent/采集统计） | HTTP (via Zone Agent) |
| Peer 节点 | 3s | VRRP Advertisement | UDP/HTTP |

#### 3.7.2 观测矩阵

```yaml
ObservationMatrix:
  node_id: string
  timestamp: timestamp
  report_interval: duration         # 实际报告间隔

  # Slot 状态
  slot_status:
    owned: uint32                   # 本节点拥有的 slot 数
    active: uint32                  # 正在执行的 slot 数
    pending: uint32                 # 待分配的 slot 数
    failed: uint32                  # 执行失败的 slot 数
    per_slot:                       # 每个 slot 的详细状态
      - slot_id: uint32
        state: "active" | "pending" | "failed"
        epoch_token: string
        agent_id: string            # 执行该 slot 的 Agent
        targets_total: uint32
        targets_success: uint32
        targets_failed: uint32

  # Agent 状态
  agent_status:
    total: uint32
    healthy: uint32
    by_type:
      - type: string
        count: uint32
        healthy: uint32
        avg_load: float             # 平均负载 (current_targets / capacity)

  # 采集统计
  collection_stats:
    total_scrapes: uint64           # 累计采集次数
    scrape_success_rate: float      # 采集成功率
    avg_scrape_duration: duration   # 平均采集耗时
    last_scrape_timestamp: timestamp

  # 节点资源
  node_resources:
    cpu_usage: float
    memory_usage: float
    network_rx_bytes: uint64
    network_tx_bytes: uint64
```

---

## 四、核心数据模型

### 4.1 NodeState（节点状态）

```yaml
NodeState:
  node_id: string                   # 节点唯一标识
  zone_id: string                   # 所属网区
  state: enum                       # REGISTER | WARMING | HEALTHY | SUSPECT |
                                    # EXPIRED | FENCED | DRAINING | OFFLINE | QUARANTINED
  owned_slots: [uint32]             # 当前拥有的 slot ID 列表
  agents: [AgentStatus]             # 本节点所有 Agent 状态
  last_heartbeat: timestamp         # 最后发送心跳时间
  epoch_token: string               # 当前 epoch 令牌 (zone_epoch:slot_version)
  manifest_version: uint64          # 当前持有的 Manifest 版本
  started_at: timestamp             # 节点启动时间
  resources:
    cpu_usage: float                # CPU 使用率 (0.0 ~ 1.0)
    memory_usage: float             # 内存使用率
    memory_total: uint64            # 总内存 (bytes)
    memory_available: uint64        # 可用内存 (bytes)
```

### 4.2 AgentStatus（Agent 状态）

```yaml
AgentStatus:
  agent_id: string                  # Agent 唯一标识
  agent_type: string                # scrape | snmp | probe | oracle | mysql | windows | custom
  state: enum                       # idle | collecting | error | offline
  current_targets: uint32           # 当前承载的 target 数量
  capacity: uint32                  # 最大可承载 target 数
  last_collection: timestamp        # 最后一次成功采集时间
  error_count: uint32               # 累计错误次数
  consecutive_errors: uint32        # 连续错误次数（用于故障判定）
  registered_at: timestamp          # 注册时间
  metadata: map<string, string>     # 扩展信息
```

### 4.3 PeerEntry（Peer 表项）

```yaml
PeerEntry:
  node_id: string                   # 对端节点 ID
  last_advertisement: timestamp     # 最后收到的 Advertisement 时间
  missed_count: uint32              # 连续未收到心跳的次数
  detected_state: enum              # HEALTHY | SUSPECT | EXPIRED
  advertised_slots: [uint32]        # 对端声称拥有的 slot
  advertised_epoch: string          # 对端的 epoch token
  advertised_manifest_version: uint64
  rtt_ms: float                     # 往返延迟 (ms)
  seq_last: uint64                  # 最后收到的序列号
  seq_expected: uint64              # 期望的下一个序列号
```

### 4.4 SlotAssignment（Slot 归属记录）

```yaml
SlotAssignment:
  slot_id: uint32                   # Slot ID
  owner_node_id: string             # 归属节点 ID
  epoch_token: string               # Epoch fencing token
  assigned_at: timestamp            # 分配时间
  targets: [TargetRef]              # 该 slot 包含的 target 引用
  state: enum                       # ACTIVE | PENDING | FAILED | VACANT

TargetRef:
  instance_id: string               # 关联控制面实例台账
  endpoint: string                  # 采集地址
  agent_type_required: string       # 所需 Agent 类型
```

### 4.5 CollectionInstruction（采集指令）

```yaml
CollectionInstruction:
  instruction_id: string            # 指令唯一 ID
  slot_id: uint32                   # 所属 slot
  epoch_token: string               # 当前 epoch
  target: Target                    # 采集目标完整配置
  scrape_interval: duration         # 采集间隔
  scrape_timeout: duration          # 采集超时
  credential_ref: string            # 凭据引用（非实际凭据）
  output_endpoint: string           # 数据推送目标（OTel Collector 地址）
  labels:                           # 附加标签
    zone_id: string
    slot_id: string
    agent_id: string
    node_id: string
```

---

## 五、接口与交互

### 5.1 与 Zone Agent 的交互

```
Zone Agent                              Job Scheduler
    │                                        │
    │  PushManifest(manifest)                │
    │───────────────────────────────────────▶│
    │                                        │  校验、存储、应用 diff
    │  ManifestAck(version, node_id)         │
    │◀───────────────────────────────────────│
    │                                        │
    │  PullStatus(node_id)                   │
    │───────────────────────────────────────▶│
    │                                        │
    │  ObservationMatrix                     │
    │◀───────────────────────────────────────│
    │                                        │
```

| 接口 | 方向 | 协议 | 频率 | 说明 |
|------|------|------|------|------|
| PushManifest | ZA → JS | HTTP/gRPC | 事件驱动 | Manifest 变更时推送 |
| ManifestAck | JS → ZA | HTTP/gRPC | 响应 | 确认接收 |
| PullStatus | ZA → JS | HTTP | 10s | 拉取观测矩阵 |
| ReportAlert | JS → ZA | HTTP | 事件驱动 | 上报异常事件 |

### 5.2 与 Coordinator 的交互

```
Coordinator                             Job Scheduler
    │                                        │
    │  HeartbeatReq(node_id)                 │
    │◀───────────────────────────────────────│
    │  HeartbeatResp(alive, epoch)           │
    │───────────────────────────────────────▶│
    │                                        │
    │  IssueEpoch(zone_epoch)                │
    │◀───────────────────────────────────────│
    │  EpochResp(epoch_token)                │
    │───────────────────────────────────────▶│
    │                                        │
    │  RebalanceCmd(migration_plan)          │
    │───────────────────────────────────────▶│
    │                                        │  执行 slot 迁移
    │  RebalanceResult(success, details)     │
    │◀───────────────────────────────────────│
    │                                        │
```

| 接口 | 方向 | 协议 | 频率 | 说明 |
|------|------|------|------|------|
| Heartbeat | JS → Co | gRPC | 15s | 存活心跳 |
| IssueEpoch | JS → Co | gRPC | 事件驱动 | 请求签发 epoch |
| RebalanceCmd | Co → JS | gRPC | 事件驱动 | 下发再均衡指令 |
| SlotTakeover | JS → Co | gRPC | 事件驱动 | 请求接管 slot |

### 5.3 与 Peer 节点的交互

```
Job Scheduler (A)                       Job Scheduler (B)
    │                                        │
    │  VRRP Advertisement (3s)               │
    │───────────────────────────────────────▶│
    │                                        │
    │  VRRP Advertisement (3s)               │
    │◀───────────────────────────────────────│
    │                                        │
    │  TakeoverProposal(slots, new_owner)    │
    │───────────────────────────────────────▶│
    │                                        │  评估负载
    │  TakeoverVote(accept, counter_proposal)│
    │◀───────────────────────────────────────│
    │                                        │
```

| 接口 | 方向 | 协议 | 频率 | 说明 |
|------|------|------|------|------|
| VRRP Advertisement | JS ↔ JS | UDP/HTTP | 3s | Peer 心跳 |
| TakeoverProposal | JS → JS | HTTP | 事件驱动 | 提议接管故障节点的 slot |
| TakeoverVote | JS → JS | HTTP | 响应 | 投票响应 |
| StateSync | JS ↔ JS | HTTP | 事件驱动 | 状态同步（Manifest hash 对比等） |

### 5.4 与 Agent 的交互

```
Job Scheduler                             Agent
    │                                       │
    │  RegisterAgent(registration)           │
    │◀──────────────────────────────────────│
    │  RegisterResp(agent_id, status)        │
    │───────────────────────────────────────▶│
    │                                        │
    │  AssignTask(instruction)               │
    │───────────────────────────────────────▶│
    │                                        │  执行采集
    │  TaskResult(success, metrics_ref)      │  数据推送到 OTel Collector
    │◀──────────────────────────────────────│
    │                                        │
    │  HealthCheck(agent_id)                 │
    │───────────────────────────────────────▶│
    │  HealthResp(status, load)              │
    │◀──────────────────────────────────────│
    │                                        │
    │  RevokeTask(instruction_id, reason)    │
    │───────────────────────────────────────▶│
    │                                        │  停止采集
    │  RevokeAck(agent_id)                   │
    │◀──────────────────────────────────────│
    │                                        │
    │  SyncTasks (30s)                       │
    │  { current_tasks: [task_id, ...] }     │
    │───────────────────────────────────────▶│
    │                                        │  对比 Scheduler 视图
    │  SyncTasksResponse                     │  返回 diff
    │  { add_tasks: [...],                   │
    │    remove_tasks: [...],                │
    │    update_tasks: [...] }               │
    │◀───────────────────────────────────────│
```

| 接口 | 方向 | 协议 | 频率 | 说明 |
|------|------|------|------|------|
| RegisterAgent | Agent → JS | HTTP/gRPC | 启动时 | Agent 注册 |
| AssignTask | JS → Agent | HTTP/gRPC | 事件驱动 | 分配采集任务 |
| TaskResult | Agent → JS | HTTP/gRPC | 每次采集后 | 上报采集结果 |
| HealthCheck | JS → Agent | HTTP | 5s | 健康检查 |
| RevokeTask | JS → Agent | HTTP/gRPC | 事件驱动 | 撤销采集任务 |
| SyncTasks | Agent → JS | HTTP/gRPC | 30s | Agent 同步任务列表（Pull 安全网） |
| SyncTasksResponse | JS → Agent | HTTP/gRPC | 响应 | 返回任务 diff（新增/删除/更新） |

---

## 六、设计决策与替代方案

### DEC-JS-01：Peer 检测协议选型

| 方案 | 描述 | 优点 | 缺点 | 适用场景 |
|------|------|------|------|---------|
| A：VRRP 风格心跳（当前） | 周期性广播 Advertisement，独立检测 | 简单；去中心化；无额外依赖 | 检测延迟固定（受心跳间隔约束） | 推荐方案 |
| B：Raft 共识 | 使用 Raft 的 leader election 机制 | 强一致性；成熟算法 | 引入 Raft 依赖；过度设计（只需检测，不需共识日志） | 需要强一致性选举的场景 |
| C：Gossip 协议 | 随机节点间传播状态信息 | 大规模场景效率高 | 小规模场景 overhead 大；收敛时间不确定 | >10 节点的大规模区 |

**[建议]**：方案 A。网区节点数通常为 2-5 个，VRRP 风格足够。Raft 引入不必要的复杂性，Gossip 在小规模下没有优势。

### DEC-JS-02：Slot 分配策略

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：均分（当前） | total_slots / node_count | 简单；可预测 | 不考虑节点能力差异 |
| B：加权分配 | 按节点能力（CPU/内存/网络）加权 | 更公平；充分利用资源 | 能力评估复杂；动态变化时调整困难 |
| C：能力感知 | 根据 Agent 类型和容量分配 | 精确匹配 | 实现复杂；Agent 变化时频繁重分配 |

**[建议]**：阶段 1 用方案 A（均分），阶段 2 评估方案 B（加权）。方案 C 留作长期优化。

### DEC-JS-03：Agent 任务调度模式

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：纯 Push（Scheduler 主动分配） | Scheduler 主动发送采集指令到 Agent | 控制力强；实时性好 | 消息丢失时 Agent 可能遗漏任务；需要可靠消息投递 |
| B：纯 Pull（Agent 轮询 Scheduler） | Agent 主动拉取待执行的采集任务 | 解耦；Agent 自主控制节奏 | 延迟较高；轮询开销 |
| C：Push 主 + Pull 辅（当前） | Push 为主要分配方式，Agent 每 30s 通过 SyncTasks 同步任务列表作为安全网 | 实时性好 + 一致性保障；Push 保证低延迟分配，Pull 兜底防止消息丢失 | 需要两套机制 |

**[建议]**：方案 C（Push 主 + Pull 辅）。事件驱动的 Push 模式保证任务分配的实时性，Agent 周期性 SyncTasks（默认 30s）作为安全网，确保因网络抖动等原因遗漏的 Push 消息能被补偿。SyncTasks 携带 Agent 当前任务列表，Scheduler 对比后返回 diff（需要新增/删除的任务）。

### DEC-JS-04：Peer 通信传输协议

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：HTTP | 基于 HTTP 的 Advertisement | 简单；可调试；与生态兼容 | overhead 较大 |
| B：UDP | 原始 UDP 广播 | 低延迟；低 overhead | 不可靠；需自行实现确认 |
| C：gRPC streaming | 长连接流式传输 | 高效；双向；类型安全 | 连接管理复杂 |

**[建议]**：阶段 1 用方案 A（HTTP），简单可靠。阶段 2 评估方案 C（gRPC streaming）以降低大规模场景下的开销。

---

## 七、冲突与开放问题

| ID | 问题 | 影响 | 状态 |
|----|------|------|------|
| C11 | Job Scheduler → Agent 调度协议未最终定义（HTTP vs gRPC vs MQ） | 影响 Agent 接口设计和性能 | 待确认 |
| C15 | Agent 故障时的重分配策略未明确（同节点优先 vs 跨节点均衡） | 影响故障恢复速度和负载均衡 | 待确认 |
| JS-01 | 2 节点区 VRRP 检测的特殊处理：1 节点故障 = 无法达成多数派 | 2 节点区可用性受限 | 待确认（参见 DA-03） |
| JS-02 | Manifest diff 算法的复杂度与正确性保证 | 大 Manifest 时 diff 计算可能成为瓶颈 | 待压测 |
| JS-03 | Peer 检测的时间偏差处理：节点时钟不同步时的影响 | 可能导致误判 SUSPECT/EXPIRED | 待确认 |
| JS-04 | 节点 FENCED 状态的自动恢复机制：是否需要人工干预 | 影响运维自动化程度 | 待确认 |
| JS-05 | 大规模 slot（>5000）时 Peer Advertisement 报文大小 | 影响网络开销和解析性能 | 待压测 |
| JS-06 | Agent 调度中的亲和性策略：是否优先保持 target-Agent 绑定 | 影响采集稳定性和上下文切换开销 | 待确认 |
