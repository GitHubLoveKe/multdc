# 采集任务调度

## 一、概述

采集任务调度是协调层的核心模块，负责将中心控制面定义的任务规格（TaskSpec）转化为区内可执行的采集清单（Zone Manifest），并通过槽位（Slot）机制将采集目标分配至具体的 Job Scheduler 节点与 Agent 实例执行。

本模块是"中心管理 ≠ 中心调度"（P1）原则的直接体现：控制面定义"采什么"，协调面决定"谁来采、在哪采、怎么采"。整个调度过程在区内部闭环完成，不依赖控制面的实时参与。

### 1.1 核心定位

```
┌─────────────────────────────────────────────────────────────────┐
│                      中心控制面 (Control Plane)                   │
│  TaskSpec: 定义 target 列表、指标列表、采集间隔、Agent 类型          │
│  "采什么" — WHAT                                                   │
└──────────────────────────┬──────────────────────────────────────┘
                           │ M2 跨区通道
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      协调层 (Coordination Plane)                  │
│                                                                  │
│  ┌──────────────┐    ┌──────────────────────────────────────┐   │
│  │  Zone Agent   │───▶│       采集任务调度 (本模块)            │   │
│  │  (跨区代理)    │    │                                      │   │
│  └──────────────┘    │  · Zone Manifest 生成                  │   │
│                      │  · 槽位管理与分配                       │   │
│                      │  · 所有权协商 (VRRP-style)              │   │
│                      │  · Epoch Fencing                       │   │
│                      │  · Agent 调度                          │   │
│                      │  · Manifest 分发                       │   │
│                      └──────────────┬───────────────────────┘   │
│                                     │                            │
└─────────────────────────────────────┼────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                      采集层 (Data Plane)                          │
│  Job Scheduler × N  →  Agent × M  →  OTel Collector             │
│  "谁来采" — HOW                                                   │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 设计目标

| 目标编号 | 描述 | 优先级 |
|---------|------|--------|
| G-01 | 控制面不可达时，区内采集调度不受影响（L1 降级） | P0 |
| G-02 | 节点故障后，其槽位在 ≤30s 内被其他节点接管 | P0 |
| G-03 | 杜绝双主（dual-master），宁可留空也不重复采集 | P0 |
| G-04 | Manifest 变更在 ≤5s 内传播至区内所有 Job Scheduler | P1 |
| G-05 | 支持 1~50 个 Job Scheduler 节点的区规模 | P1 |
| G-06 | 槽位重新平衡时对采集中断最小化 | P2 |

### 1.3 适用场景

- 标准多 zone 监控部署，每个 zone 独立运行本调度逻辑
- 区内含 1~50 个 Job Scheduler 节点
- 每个节点运行 1~N 个 Agent 实例（Scrape / SNMP / Probe 类型）
- 区规模适配：Small（1 节点）、Normal（2 节点）、Critical（≥3 节点）

---

## 二、职责边界

### 2.1 本模块负责

| 职责 | 说明 |
|------|------|
| Zone Manifest 生成 | 将 TaskSpec 转化为区级别的完整采集清单，包含槽位分配 |
| 槽位管理 | 维护固定数量的 slot，管理 slot 与 target 的映射关系 |
| 所有权协商 | VRRP-style 对等检测，节点间协商 slot 归属 |
| Epoch Fencing | 通过复合令牌（zone_epoch + slot_version）防止脑裂 |
| Agent 调度 | 在 owned slot 内，将采集任务分配给具体的 Agent 实例 |
| Manifest 分发 | 确保区内每个 Job Scheduler 持有完整一致的 Manifest |
| 采集重平衡 | 节点增减或负载不均时，触发 slot 迁移 |

### 2.2 本模块不负责

| 不负责事项 | 归属 | 说明 |
|-----------|------|------|
| 定义采集目标（target） | 控制面 | 控制面通过 TaskSpec 定义"采什么" |
| 定义采集规则（rule） | 控制面 | 控制面通过 RuleSpec 定义规则 |
| 实际执行采集 | 采集层 Agent | Agent 是纯执行器 |
| 数据写入与存储 | 采集层 OTel Collector / Storage | 数据管道独立于调度 |
| 跨区通信 | Zone Agent（跨区代理） | Zone Agent 负责 M2/M3 接口 |
| 节点注册与实例管理 | 控制面实例注册表 | 协调面只消费注册信息 |
| 告警规则评估 | RC 任务调度模块 | RC 调度独立管理 |

### 2.3 与其他模块的协作关系

```
                    ┌─────────────────────┐
                    │   组件健康 (Health)   │
                    │  节点状态变更通知      │
                    └────────┬────────────┘
                             │ 节点状态事件
                             ▼
┌──────────────┐    ┌─────────────────────┐    ┌──────────────────┐
│  行为决策      │◀──▶│  采集任务调度 (本模块) │◀──▶│  冲突仲裁         │
│  重平衡/驱逐   │    │                     │    │  所有权冲突解决    │
└──────────────┘    └────────┬────────────┘    └──────────────────┘
                             │
                    ┌────────┴────────────┐
                    │   RC 任务调度        │
                    │  共享/独立槽位池      │
                    └─────────────────────┘
```

---

## 三、功能清单

### 3.1 Zone Manifest 生成

| 功能项 | 描述 |
|--------|------|
| F-1.1 TaskSpec 解析 | 接收 Zone Agent 转发的 TaskSpec，解析目标列表、指标配置、Agent 类型要求 |
| F-1.2 槽位划分 | 根据 zone 配置的总槽位数，将 targets 均匀分配至各 slot |
| F-1.3 初始分配 | 首次生成 Manifest 时，将 slots 均分至所有已注册 Job Scheduler 节点 |
| F-1.4 版本管理 | 每次 Manifest 变更递增 version，确保全区一致 |
| F-1.5 增量更新 | 支持增量 diff 模式，仅下发变更部分（目标增删、配置变更） |

### 3.2 槽位管理

| 功能项 | 描述 |
|--------|------|
| F-2.1 槽位容量 | 每个 slot 承载 ≤200 个 target（可配置） |
| F-2.2 槽位总数 | zone 配置后固定，变更需全量重映射（高成本操作） |
| F-2.3 槽位状态 | 维护每个 slot 的状态：assigned / unassigned / migrating / fenced |
| F-2.4 Agent 类型匹配 | slot 标记所需 agent_type，确保调度到正确类型的 Agent |
| F-2.5 槽位标签 | 支持 slot 级别的标签（如 priority、zone-affinity），用于调度策略 |

### 3.3 所有权协商

| 功能项 | 描述 |
|--------|------|
| F-3.1 心跳检测 | Job Scheduler 间 3s 周期心跳，VRRP-style 对等检测 |
| F-3.2 故障检测 | 节点连续 N 次心跳未响应，标记为 SUSPECT |
| F-3.3 接管协商 | 故障节点的 slots 由存活节点协商接管 |
| F-3.4 Epoch 令牌 | 每次所有权变更生成新的 epoch_token，防止旧主恢复后冲突 |
| F-3.5 多数派确认 | 接管需多数派确认，无法达成多数则留空（宁缺勿滥） |

### 3.4 Agent 调度

| 功能项 | 描述 |
|--------|------|
| F-4.1 Agent 注册 | Job Scheduler 发现本节点上的 Agent 实例，记录其类型与能力 |
| F-4.2 Agent 分配 | 将 slot 内的采集任务分配给匹配的 Agent |
| F-4.3 Agent 故障重分配 | Agent 故障不影响 slot 所有权，Scheduler 重新分配给其他 Agent |
| F-4.4 Agent 负载均衡 | 同节点多 Agent 时，按能力与负载均衡分配 |
| F-4.5 Agent 健康联动 | 与组件健康模块联动，获取 Agent 实时状态 |

### 3.5 Manifest 分发

| 功能项 | 描述 |
|--------|------|
| F-5.1 全量推送 | Manifest 变更时，Zone Agent 向区内所有 Job Scheduler 全量推送 |
| F-5.2 增量同步 | 大版本变更时支持增量 diff，减少传输量 |
| F-5.3 版本校验 | 每个 Job Scheduler 定期校验自身 Manifest 版本是否为最新 |
| F-5.4 版本回退拒绝 | 拒绝接受低于当前版本的 Manifest，防止乱序 |
| F-5.5 离线节点追赶 | 节点恢复后，主动拉取最新 Manifest 进行同步 |

---

## 四、核心数据模型

### 4.1 ZoneManifest — 区采集清单

```protobuf
// ZoneManifest 是协调层的核心数据结构
// 每个 Job Scheduler 节点持有完整的一份，但 owner_node 字段各节点视角不同
message ZoneManifest {
  // 区标识
  string zone_id = 1;
  
  // Manifest 版本号，单调递增
  // 每次 TaskSpec 变更、slot 重分配、节点增减均递增
  uint64 version = 2;
  
  // 区纪元号
  // 仅在区拓扑发生根本性变化时递增（如 zone 重建）
  // 用于 epoch fencing 的高位部分
  uint64 epoch = 3;
  
  // 槽位分配列表
  repeated SlotAssignment slots = 4;
  
  // 已注册的 Agent 列表
  repeated AgentRegistration agents = 5;
  
  // 生成时间戳
  google.protobuf.Timestamp created_at = 6;
  
  // 来源标识：哪个控制面实例生成
  string source_control_plane_id = 7;
}
```

### 4.2 SlotAssignment — 槽位分配

```protobuf
message SlotAssignment {
  // 槽位 ID，区内唯一
  // 范围 [0, total_slot_count)
  uint32 slot_id = 1;
  
  // 该槽位负责的采集目标列表
  repeated Target targets = 2;
  
  // 当前所有者节点 ID
  // 对应 Job Scheduler 的 node_id
  // 为空表示该 slot 当前无主（unassigned）
  string owner_node = 3;
  
  // Epoch 令牌，复合结构
  // 格式: "{zone_epoch}-{slot_version}"
  // 例: "3-42" 表示 zone_epoch=3, 该 slot 第 42 次所有权变更
  string epoch_token = 4;
  
  // 所需 Agent 类型
  // 如: "scrape" | "snmp" | "probe" | "mixed"
  string agent_type = 5;
  
  // 槽位状态
  SlotState state = 6;
  
  // 槽位标签
  map<string, string> labels = 7;
  
  // 目标数量（冗余字段，便于快速判断容量）
  uint32 target_count = 8;
}

enum SlotState {
  SLOT_STATE_UNSPECIFIED = 0;
  SLOT_STATE_ASSIGNED = 1;     // 正常分配，有明确 owner
  SLOT_STATE_UNASSIGNED = 2;   // 无主，等待分配
  SLOT_STATE_MIGRATING = 3;    // 迁移中，from_node → to_node
  SLOT_STATE_FENCED = 4;       // 被隔离，不参与调度
}
```

### 4.3 Target — 采集目标

```protobuf
message Target {
  // 实例 ID，全局唯一
  // 对应控制面实例注册表中的 instance_id
  string instance_id = 1;
  
  // 采集端点
  // 如: "http://10.0.1.5:9100/metrics"
  string endpoint = 2;
  
  // 采集间隔
  // 如: "15s", "30s", "1m"
  google.protobuf.Duration scrape_interval = 3;
  
  // 指标路径
  // 默认: "/metrics"
  string metrics_path = 4;
  
  // 凭证引用 ID
  // 注意：这里只存引用，不存实际凭证
  // 实际凭证由 Agent 通过安全通道从凭证服务获取
  string credential_id = 5;
  
  // 附加标签
  // 会附加到采集到的指标上
  map<string, string> labels = 6;
  
  // 超时时间
  google.protobuf.Duration scrape_timeout = 7;
  
  // 是否启用
  bool enabled = 8;
}
```

### 4.4 AgentRegistration — Agent 注册

```protobuf
message AgentRegistration {
  // Agent 实例 ID
  string agent_id = 1;
  
  // 所在节点 ID
  string node_id = 2;
  
  // Agent 类型
  AgentType agent_type = 3;
  
  // Agent 状态
  AgentState state = 4;
  
  // 当前负载（已分配的 target 数量）
  uint32 current_load = 5;
  
  // 最大容量
  uint32 max_capacity = 6;
  
  // 支持的能力列表
  repeated string capabilities = 7;
  
  // 最后心跳时间
  google.protobuf.Timestamp last_heartbeat = 8;
}

enum AgentType {
  AGENT_TYPE_UNSPECIFIED = 0;
  AGENT_TYPE_SCRAPE = 1;    // Prometheus 风格 HTTP 采集
  AGENT_TYPE_SNMP = 2;      // SNMP 采集
  AGENT_TYPE_PROBE = 3;     // 主动探测（Blackbox 风格）
  AGENT_TYPE_MIXED = 4;     // 多类型混合
}

enum AgentState {
  AGENT_STATE_UNSPECIFIED = 0;
  AGENT_STATE_ACTIVE = 1;
  AGENT_STATE_DRAINING = 2;
  AGENT_STATE_OFFLINE = 3;
  AGENT_STATE_ERROR = 4;
}
```

### 4.5 辅助数据结构

```protobuf
// 节点视角的槽位所有权映射
// 每个 Job Scheduler 维护自己视角的 OwnershipView
message OwnershipView {
  string my_node_id = 1;
  uint64 manifest_version = 2;
  
  // 本节点拥有的 slot 列表
  repeated uint32 owned_slots = 3;
  
  // 本节点各 slot 的 epoch_token
  map<uint32, string> slot_epoch_tokens = 4;
  
  // 已知的其他节点所有权视图（用于冲突检测）
  map<string, NodeOwnershipClaim> peer_claims = 5;
}

message NodeOwnershipClaim {
  string node_id = 1;
  repeated uint32 claimed_slots = 2;
  uint64 claim_version = 3;      // 声称的版本号
  google.protobuf.Timestamp claim_time = 4;
}

// 槽位容量配置
message SlotConfig {
  string zone_id = 1;
  uint32 total_slots = 2;         // 总槽位数
  uint32 max_targets_per_slot = 3; // 每槽最大 target 数，默认 200
  uint32 rebalance_threshold = 4;  // 重平衡触发阈值（偏差百分比）
}
```

### 4.6 数据模型关系图

```
ZoneManifest (1)
  ├── SlotAssignment (N)
  │     ├── Target (M)         // 每个 slot 包含多个 target
  │     └── labels, state      // slot 元数据
  ├── AgentRegistration (K)
  │     └── capabilities       // Agent 能力声明
  └── OwnershipView (per node)
        ├── owned_slots         // 本节点视角
        └── peer_claims         // 其他节点声称

关键约束:
  - sum(slot.target_count) == total targets in TaskSpec
  - total_slots 在 zone 创建后固定
  - 每个 slot 最多 1 个 owner_node（非 MIGRATING 状态时）
  - owner_node 为空的 slot 数量应最小化
```

---

## 五、接口与交互

### 5.1 内部接口（区内部件通信）

#### 5.1.1 Manifest 接收接口（Zone Agent → 采集任务调度）

```
接口: OnManifestReceived
方向: Zone Agent → 采集任务调度模块
触发: Zone Agent 从控制面接收到新的 TaskSpec/Manifest
协议: 区内 gRPC

请求:
  ManifestDelivery {
    zone_id: string
    manifest: ZoneManifest
    delivery_type: "full" | "incremental"
    delta: ManifestDelta (仅 incremental 时有效)
  }

处理流程:
  1. 校验 manifest.version > current_version（拒绝旧版本）
  2. 若 delivery_type == "full"：替换本地 Manifest
  3. 若 delivery_type == "incremental"：应用 delta 到本地 Manifest
  4. 重新计算本地节点的 slot 分配
  5. 触发 Agent 重调度
  6. 返回确认（含新 version）
```

#### 5.1.2 所有权协商接口（Job Scheduler ↔ Job Scheduler）

```
接口: NegotiateOwnership
方向: Job Scheduler 节点间对等通信
触发: 心跳超时检测到节点疑似故障 / 节点恢复后重新声明所有权
协议: VRRP-style 多播 / 单播 gRPC

请求 (OwnershipClaim):
  node_id: string
  claimed_slots: [uint32]
  epoch_token: string
  claim_version: uint64
  timestamp: Timestamp

响应 (OwnershipResponse):
  accepted: bool
  conflicting_slots: [uint32]    // 如有冲突
  counter_claim: OwnershipClaim  // 反声称

协商流程:
  1. 节点 A 检测到节点 B 心跳超时
  2. 节点 A 发起 OwnershipClaim，声明接管 B 的 slots
  3. 其他存活节点验证 claim：
     a. 检查自身是否也声称同一 slots
     b. 比较 epoch_token（高者优先）
     c. epoch 相同则比较 node_id（字典序大者优先）
  4. 多数派同意后，claim 生效
  5. 无法达成多数派 → slots 留空（不分配）
```

#### 5.1.3 Agent 调度接口（采集任务调度 → Agent）

```
接口: AssignSlot
方向: Job Scheduler → 本地 Agent
触发: slot 分配变更 / Agent 注册 / Agent 故障恢复

请求 (SlotAssignment):
  slot_id: uint32
  targets: [Target]
  epoch_token: string
  agent_type: string
  execution_config: {
    scrape_timeout: duration
    honor_labels: bool
    sample_limit: uint32
  }

响应 (AssignmentAck):
  agent_id: string
  accepted: bool
  error: string (if not accepted)

执行流程:
  1. Job Scheduler 将 slot 内的 targets 分配给匹配的 Agent
  2. Agent 确认接受后开始执行采集
  3. Agent 按 target.endpoint 周期采集
  4. 采集数据写入本地 OTel Collector
```

#### 5.1.4 心跳接口（Job Scheduler ↔ Job Scheduler）

```
接口: Heartbeat
方向: Job Scheduler 节点间对等
周期: 3s
协议: UDP 多播 / gRPC 单播

请求 (HeartbeatMessage):
  node_id: string
  timestamp: Timestamp
  status: "alive" | "degraded"
  owned_slots: [uint32]          // 当前拥有的 slots
  slot_epoch_tokens: {uint32: string}  // slot → epoch_token 映射
  load_info: {
    cpu_usage: float
    memory_usage: float
    active_targets: uint32
  }

处理:
  1. 收到心跳 → 重置该节点的超时计时器
  2. 连续 3 次（默认）未收到 → 标记节点为 SUSPECT
  3. 连续 5 次（默认）未收到 → 标记节点为 EXPIRED，触发接管流程
  4. 检查 peer 声明的 owned_slots 与本地记录是否一致
     不一致 → 触发冲突仲裁
```

### 5.2 外部接口（跨层/跨区通信）

#### 5.2.1 控制面接口（M2）

```
接口: ControlPlaneManifestSync
方向: 控制面 → Zone Agent → 采集任务调度
协议: 跨区 gRPC (M2 接口)

说明:
  - Zone Agent 通过 M2 接口从控制面拉取最新 TaskSpec
  - 拉取周期: 10s（正常）/ 30s（降级模式 L1）
  - 控制面推送变更通知（push notification），Zone Agent 主动拉取
  - 采集任务调度模块不直接与控制面通信，通过 Zone Agent 中转

降级行为:
  - L1（控制面不可达）: Zone Agent 停止拉取，区内使用最后已知 Manifest
  - 采集调度不受影响，仅冻结任务定义变更
```

#### 5.2.2 健康上报接口

```
接口: ReportSchedulingHealth
方向: 采集任务调度 → 组件健康模块
周期: 10s

上报内容:
  SchedulingHealth {
    zone_id: string
    total_slots: uint32
    assigned_slots: uint32
    unassigned_slots: uint32
    migrating_slots: uint32
    node_slot_distribution: {string: uint32}  // node_id → slot_count
    last_manifest_version: uint64
    last_manifest_sync_time: Timestamp
    pending_ownership_claims: uint32
    agent_utilization: {string: float}  // agent_id → utilization_ratio
  }
```

### 5.3 交互时序图

#### 5.3.1 Manifest 生成与分发流程

```
控制面          Zone Agent          采集任务调度          Job Scheduler × N
  │                │                    │                      │
  │──TaskSpec──▶   │                    │                      │
  │  (M2 push)     │                    │                      │
  │                │──ManifestDelivery─▶│                      │
  │                │                    │                      │
  │                │                    │──生成 ZoneManifest──▶│
  │                │                    │  (slot 划分, 初始分配) │
  │                │                    │                      │
  │                │                    │──Broadcast Manifest─▶│
  │                │                    │                      │
  │                │                    │◀──────Ack(version)───│
  │                │                    │                      │
  │                │                    │──AssignSlot──────────▶│
  │                │                    │  (每个节点收到自己的    │
  │                │                    │   slot 分配)          │
  │                │                    │                      │
  │                │                    │◀──────AssignmentAck───│
  │                │                    │                      │
```

#### 5.3.2 节点故障与接管流程

```
Job Scheduler A    Job Scheduler B    Job Scheduler C    (故障节点 D)
  │                  │                  │                    │
  │◀──Heartbeat(3s)─▶│◀──Heartbeat──▶  │                    │
  │                  │                  │                    │
  │   [D 心跳超时 ×3] │                  │                    │
  │                  │                  │                    │
  │──OwnershipClaim──▶│                  │                    │
  │  "我接管 D 的     │                  │                    │
  │   slots [5,6,7]" │                  │                    │
  │                  │                  │                    │
  │◀─OwnershipResp───│                  │                    │
  │  "同意, 无冲突"   │                  │                    │
  │                  │                  │                    │
  │──OwnershipClaim──────────────────▶  │                    │
  │                                    │                    │
  │◀─OwnershipResp─────────────────────│                    │
  │  "同意"           │                  │                    │
  │                  │                  │                    │
  │  [多数派确认: A+B+C = 3/3]          │                    │
  │  [更新 epoch_token: "3-42"→"3-43"] │                    │
  │  [重新分配 Agent]  │                  │                    │
  │                  │                  │                    │
```

---

## 六、设计决策与替代方案

### 6.1 槽位分配策略

#### 当前方案：均等分配（Equal Distribution）

```
总槽位数 = 100, 节点数 = 3

节点 A: slots [0..32]   → 33 slots
节点 B: slots [33..65]  → 33 slots
节点 C: slots [66..99]  → 34 slots

算法: slot_count[i] = total_slots / N + (i < total_slots % N ? 1 : 0)
```

**优点:**
- 实现简单，负载均衡天然达成
- 节点增减时只需迁移少量 slots
- 可预测性强

**缺点:**
- 未考虑节点异构性（CPU/内存差异）
- 未考虑 target 异构性（某些 target 采集代价更高）

#### 替代方案：加权分配（Weighted Distribution）

```
节点权重基于: w[i] = f(cpu, memory, network_bandwidth)
slot_count[i] = total_slots × w[i] / sum(w)

示例:
  节点 A (8C16G): weight=2.0 → 50 slots
  节点 B (4C8G):  weight=1.0 → 25 slots
  节点 C (4C8G):  weight=1.0 → 25 slots
```

**评估:** 作为未来迭代方向。当前阶段所有 Job Scheduler 节点假定同构，均等分配足够。加权分配增加了复杂度（权重计算、动态调整），需在实测中验证收益。

**决策:** 当前采用均等分配，预留加权分配扩展点（SlotConfig 中可加入 weight 字段）。

### 6.2 对等检测协议

#### 当前方案：VRRP-style 心跳

```
                    ┌──────────────────────────┐
                    │   VRRP-style 心跳检测      │
                    │                          │
                    │  · 3s 周期多播/单播心跳     │
                    │  · 3 次超时 → SUSPECT      │
                    │  · 5 次超时 → EXPIRED      │
                    │  · 多数派确认后接管         │
                    │  · Epoch Fencing 防脑裂    │
                    └──────────────────────────┘
```

**优点:**
- 成熟稳定，VRRP 在负载均衡领域广泛验证
- 检测速度快（3s 周期，9s 内发现故障）
- 去中心化，无额外依赖
- 与 Job Scheduler 的分布式特性一致

**缺点:**
- 2 节点场景无法达成多数派（需额外机制）
- 心跳风暴：大规模集群中多播心跳可能拥塞

#### 替代方案 A：Raft-based 检测

```
引入 Raft 共识组:
  - 所有 Job Scheduler 参与 Raft 选举
  - Leader 负责所有权分配
  - 节点故障通过 Raft term 变更检测

评估:
  + 天然解决 2 节点问题（可通过 pre-vote 扩展）
  + 强一致性保证
  - 引入 Leader 概念，与 P3（分布式检测）原则冲突
  - Job Scheduler 数量可能很多（50+），Raft 规模过大
  - 增加实现复杂度
```

#### 替代方案 B：Gossip 协议

```
去中心化 Gossip:
  - 每个节点随机选择 2~3 个 peer 传播状态
  - O(log N) 轮传播至全集群
  - 最终一致性模型

评估:
  + 大规模场景效率更高
  + 网络容忍度好
  - 收敛时间不确定（对小规模场景反而不如直接心跳）
  - 所有权协商需要强一致性，gossip 的最终一致性不够
```

**决策:** 当前采用 VRRP-style，适合 1~50 节点规模。若未来区规模超过 50 节点，考虑引入分层 gossip。

### 6.3 Manifest 更新策略

#### 当前方案：全量推送 + 增量可选

```
正常流程:
  控制面 TaskSpec 变更 → 生成新 Manifest → 全量推送至 Zone Agent
  Zone Agent → 全量广播至区内所有 Job Scheduler

增量模式（大 Manifest 优化）:
  控制面计算 diff → 仅发送变更部分
  Job Scheduler 本地应用 diff

触发条件:
  - Manifest 大小 > 1MB 时自动启用增量模式
  - 或控制面显式指定 delivery_type = "incremental"
```

#### 替代方案：纯增量 Diff

```
始终使用增量 diff:
  - 首次同步仍为全量
  - 后续所有变更均为 diff
  - 每个 Job Scheduler 维护完整 Manifest 状态

评估:
  + 减少网络传输量
  - diff 丢失会导致状态不一致
  - 需要额外的全量校验机制（定期 full reconcile）
  - 实现复杂度高
```

**决策:** 全量推送为主，增量可选。简单可靠优先。定期（每 60s）进行一次全量校验确保一致性。

### 6.4 Epoch Fencing 机制

```
Epoch Token 结构:
  ┌─────────────────┬─────────────────┐
  │   zone_epoch     │  slot_version    │
  │   (uint32)       │  (uint32)        │
  │   高位            │  低位            │
  └─────────────────┴─────────────────┘

  zone_epoch:   区级别纪元，仅在区拓扑根本变化时递增
  slot_version: 槽位级别版本，每次所有权变更递增

比较规则:
  1. zone_epoch 大者胜
  2. zone_epoch 相同，slot_version 大者胜
  3. 完全相同，node_id 字典序大者胜

Fencing 语义:
  - 旧主恢复后，携带旧 epoch_token 尝试参与
  - 新主拒绝旧 epoch_token，强制旧主重新注册
  - 确保任何时刻，一个 slot 最多一个有效 owner
```

---

## 七、冲突与开放问题

### 7.1 已识别冲突

| 冲突编号 | 描述 | 影响范围 | 当前状态 |
|---------|------|---------|---------|
| CS-01 | 槽位总数固定，变更成本高 | 全区 | 需设计在线变更方案或明确"不可变"约束 |
| CS-02 | 2 节点区无法达成多数派 | Normal 规模区 | 依赖冲突仲裁模块的 2 节点方案 |
| CS-03 | VRRP 多播在部分云网络中受限 | 网络配置 | 需确认是否回退为单播心跳 |
| CS-04 | Agent 故障与 slot 所有权的解耦边界 | Agent 调度 | Agent 全部故障时 slot owner 是否应释放 |

### 7.2 开放问题

| 问题编号 | 问题 | 候选方案 | 建议 |
|---------|------|---------|------|
| OQ-01 | 槽位总数如何确定？ | (a) 基于预估 target 数量自动计算 (b) 管理员手动配置 (c) 基于节点数 × 每节点容量 | 建议 (a)+(b)：自动计算 + 手动覆盖 |
| OQ-02 | Manifest 大小上限？ | (a) 无上限 (b) 10MB 硬限制 (c) 按节点数动态调整 | 建议 (b)，超出时分片 |
| OQ-03 | 心跳协议是否支持 TLS？ | (a) 明文 (b) mTLS (c) 可选 TLS | 建议 (c)，默认 mTLS，开发环境可关闭 |
| OQ-04 | slot 迁移期间采集是否中断？ | (a) 允许短暂重叠（≤1 scrape interval） (b) 严格不中断（先建后拆） | 建议 (a)，短暂重叠代价低 |
| OQ-05 | 如何检测"僵尸"slot（owner 已死但未触发接管）？ | (a) 心跳超时自动检测 (b) 定期全量扫描 (c) 两者结合 | 建议 (c) |

### 7.3 风险项

| 风险编号 | 风险描述 | 概率 | 影响 | 缓解措施 |
|---------|---------|------|------|---------|
| R-01 | 心跳网络分区导致误判节点故障 | 中 | 高 | 三源交叉验证（主动探测 + 自报告 + 对等报告） |
| R-02 | Manifest 全量推送在大 zone 中造成网络压力 | 低 | 中 | 增量 diff + 分片推送 |
| R-03 | Epoch token 溢出（极端长期运行） | 极低 | 低 | uint32 上限 42 亿，足够 |
| R-04 | 所有 Job Scheduler 同时重启 | 极低 | 高 | Manifest 持久化到本地磁盘，重启后恢复 |

### 7.4 待决设计点

1. **槽位容量硬限制 vs 软限制**: 200 targets/slot 是硬限制还是软限制？建议硬限制，但留出配置空间。
2. **Manifest 签名机制**: 是否需要控制面对 Manifest 进行签名，防止篡改？当前假设区内通信可信。
3. **Agent 类型扩展**: 未来新增 Agent 类型时，slot 的 agent_type 字段是否需要支持多类型？当前用 "mixed" 覆盖。
4. **跨区 slot 迁移**: 是否支持将 slot 从一个区迁移到另一个区？当前设计不支持，slot 是区内概念。
