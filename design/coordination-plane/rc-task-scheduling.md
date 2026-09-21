# RC 任务调度

## 一、概述

RC（RuleCheck）任务调度模块负责在具有本地存储的区（Mode B / Mode C）内，将规则检查任务分配至具体的 RC 节点执行。RC 调度复用采集任务调度的 Job Scheduler 对等检测和槽位协商机制，但受限于"RC 绑定存储"（P4）原则，仅在存在本地 TSDB 的区中部署。

本模块是"P8：任务/读取/RC 路由三条独立路径"原则的组成部分，确保规则评估路径独立于采集路径和查询路径。

### 1.1 核心定位

```
┌──────────────────────────────────────────────────────────────────────┐
│                        中心控制面 (Control Plane)                      │
│  RuleSpec: 定义告警规则、评估间隔、通知目标                              │
│  "评什么" — WHAT                                                       │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ M2 跨区通道
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        协调层 (Coordination Plane)                     │
│                                                                       │
│  ┌──────────────┐    ┌───────────────────────────────────────────┐   │
│  │  Zone Agent   │───▶│       RC 任务调度 (本模块)                 │   │
│  │  (跨区代理)    │    │                                           │   │
│  └──────────────┘    │  · RuleSpec → RC 任务清单                   │   │
│                      │  · RC 槽位管理（独立/共享/节点绑定）          │   │
│                      │  · RC 节点对等检测（RC ↔ RC）               │   │
│                      │  · 规则包分发                               │   │
│                      │  · RC 告警输出转发 (C4)                     │   │
│                      └──────────────┬────────────────────────────┘   │
│                                     │                                 │
└─────────────────────────────────────┼─────────────────────────────────┘
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        采集层 (Data Plane)                             │
│                                                                       │
│  ┌────────────┐    ┌────────────┐    ┌────────────┐                  │
│  │ RC Node × M │───▶│ 本地存储    │◀───│ 采集 Agent  │                  │
│  │ (规则评估)   │    │ VM local /  │    │ (数据写入)  │                  │
│  └──────┬─────┘    │ VM cluster  │    └────────────┘                  │
│         │          └────────────┘                                     │
│         │ 告警输出                                                      │
│         ▼                                                              │
│  ┌────────────────┐                                                   │
│  │ Zone Query Proxy│◀── 告警转发至控制面 (C4)                          │
│  └────────────────┘                                                   │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.2 设计目标

| 目标编号 | 描述 | 优先级 |
|---------|------|--------|
| G-01 | Mode A 区不部署 RC，无本地规则告警能力 | P0 |
| G-02 | RC 仅从本地存储读取数据，不跨区查询 | P0 |
| G-03 | RC 节点故障后，其规则任务在 ≤60s 内被接管 | P1 |
| G-04 | 规则包变更在 ≤10s 内传播至所有 RC 节点 | P1 |
| G-05 | RC 调度与采集调度互不干扰 | P1 |
| G-06 | 告警输出可靠传递至控制面告警管理 | P1 |

### 1.3 存储模式与 RC 部署关系

```
┌─────────────────────────────────────────────────────────────────┐
│                    存储模式 vs RC 部署矩阵                        │
├──────────┬──────────────┬──────────────┬────────────────────────┤
│ 存储模式  │ 本地 TSDB    │ 远程写入     │ RC 部署                │
├──────────┼──────────────┼──────────────┼────────────────────────┤
│ Mode A   │ 无           │ 仅远程→中心   │ ✗ 不部署               │
│          │              │              │   告警由中心 RC 覆盖    │
├──────────┼──────────────┼──────────────┼────────────────────────┤
│ Mode B   │ VM 单节点    │ 双写：本地+远程│ ✓ 部署                │
│          │              │              │   RC 读本地 VM          │
├──────────┼──────────────┼──────────────┼────────────────────────┤
│ Mode C   │ VM 集群      │ 可选远程写入  │ ✓ 部署                │
│          │              │              │   RC 读 VM 集群         │
└──────────┴──────────────┴──────────────┴────────────────────────┘
```

### 1.4 适用场景

- Mode B 区：单节点 VM + RC，RC 与 Job Scheduler 可同节点部署
- Mode C 区：VM 集群 + RC 节点池，RC 独立部署
- Mode A 区：本模块不激活，但保留配置入口以便模式切换

---

## 二、职责边界

### 2.1 本模块负责

| 职责 | 说明 |
|------|------|
| RC 任务清单生成 | 将 RuleSpec 转化为区内可执行的 RC 任务列表 |
| RC 槽位管理 | 管理 RC 任务的槽位分配（独立/共享/节点绑定，见设计决策） |
| RC 节点对等检测 | RC 节点间的 VRRP-style 心跳检测（独立于 Job Scheduler 检测组） |
| 规则包分发 | 将规则定义分发至各 RC 节点 |
| RC 故障接管 | RC 节点故障时，其规则任务由其他 RC 节点接管 |
| 告警输出转发 | 将 RC 评估产生的告警通过 C4 接口转发至控制面 |
| RC 健康上报 | 向组件健康模块上报 RC 运行状态 |

### 2.2 本模块不负责

| 不负责事项 | 归属 | 说明 |
|-----------|------|------|
| 定义告警规则 | 控制面 RuleSpec | 控制面是规则定义的唯一权威 |
| 数据采集 | 采集任务调度 / Agent | RC 只读取已存储的数据 |
| 数据存储 | 采集层 Storage | RC 消费存储层数据，不管理存储 |
| 告警通知与静默 | 控制面告警管理 | RC 仅产出告警，通知策略由控制面管理 |
| 查询路由 | Zone Query Proxy | 查询路径独立于 RC 路径（P8） |
| 节点注册 | 控制面实例注册表 | RC 节点注册由控制面管理 |

### 2.3 与采集任务调度的关系

```
┌────────────────────────────────────────────────────────────────┐
│                    采集任务调度 vs RC 任务调度                     │
├──────────────────┬──────────────────┬──────────────────────────┤
│ 维度              │ 采集任务调度       │ RC 任务调度               │
├──────────────────┼──────────────────┼──────────────────────────┤
│ 部署条件          │ 所有区            │ 仅 Mode B/C 区            │
│ 数据方向          │ 写入（采集→存储）  │ 读取（存储→评估→告警）     │
│ 对等检测组        │ JS ↔ JS          │ RC ↔ RC（独立组）          │
│ 槽位来源          │ 采集槽位池         │ 待定（见设计决策）          │
│ 故障接管          │ 采集 slot 接管     │ RC slot 接管              │
│ 输出目标          │ OTel Collector    │ 控制面告警管理 (C4)        │
│ 降级行为          │ L1 冻结定义       │ L1 冻结规则变更            │
└──────────────────┴──────────────────┴──────────────────────────┘
```

---

## 三、功能清单

### 3.1 RC 任务清单生成

| 功能项 | 描述 |
|--------|------|
| F-1.1 RuleSpec 解析 | 接收 Zone Agent 转发的 RuleSpec，解析规则组、评估间隔、告警条件 |
| F-1.2 规则分组 | 按规则组（RuleGroup）划分任务单元，每组作为最小调度粒度 |
| F-1.3 存储绑定检查 | 验证本地存储可用性，不可用则告警并降级 |
| F-1.4 RC 任务分配 | 将 RuleGroup 分配至 RC 槽位/节点 |
| F-1.5 规则版本管理 | 每次 RuleSpec 变更递增规则版本号 |

### 3.2 RC 槽位管理

| 功能项 | 描述 |
|--------|------|
| F-2.1 槽位模式选择 | 根据配置选择独立槽位池/共享槽位池/节点绑定模式 |
| F-2.2 槽位容量 | RC 槽位的规则组容量管理 |
| F-2.3 槽位状态 | 维护 RC 槽位状态：assigned / unassigned / migrating / fenced |
| F-2.4 存储亲和性 | RC 槽位优先分配给与存储同节点的 RC 实例（减少网络开销） |

### 3.3 RC 节点对等检测

| 功能项 | 描述 |
|--------|------|
| F-3.1 RC 心跳 | RC 节点间独立的心跳通道，周期 3s |
| F-3.2 故障检测 | RC 节点连续 N 次心跳未响应，标记为 SUSPECT |
| F-3.3 接管协商 | 故障 RC 节点的规则任务由存活 RC 节点接管 |
| F-3.4 Epoch Fencing | 复用采集调度的 epoch fencing 机制 |
| F-3.5 独立检测组 | RC ↔ RC 检测组与 JS ↔ JS 检测组完全独立 |

### 3.4 规则包分发

| 功能项 | 描述 |
|--------|------|
| F-4.1 全量分发 | 规则变更时，向所有 RC 节点推送完整规则包 |
| F-4.2 增量更新 | 大规则包支持增量 diff 更新 |
| F-4.3 版本校验 | RC 节点定期校验规则版本一致性 |
| F-4.4 规则热加载 | RC 节点接收新规则后热加载，无需重启 |

### 3.5 告警输出

| 功能项 | 描述 |
|--------|------|
| F-5.1 告警聚合 | RC 节点产出的告警在区内聚合 |
| F-5.2 告警转发 | 通过 C4 接口将告警转发至控制面告警管理 |
| F-5.3 告警缓冲 | 控制面不可达时，告警在区内缓冲（有上限） |
| F-5.4 告警去重 | 接管期间的重复告警去重 |

---

## 四、核心数据模型

### 4.1 RCManifest — RC 任务清单

```protobuf
// RCManifest 描述一个区内所有 RC 任务的分配情况
message RCManifest {
  string zone_id = 1;
  uint64 version = 2;
  uint64 epoch = 3;
  
  // RC 槽位列表
  repeated RCSlotAssignment rc_slots = 4;
  
  // RC 节点注册列表
  repeated RCNodeRegistration rc_nodes = 5;
  
  // 存储模式
  StorageMode storage_mode = 6;
  
  // 本地存储连接信息
  StorageEndpoint storage_endpoint = 7;
  
  google.protobuf.Timestamp created_at = 8;
}

enum StorageMode {
  STORAGE_MODE_UNSPECIFIED = 0;
  STORAGE_MODE_A = 1;  // 无本地 TSDB
  STORAGE_MODE_B = 2;  // 本地 VM 单节点
  STORAGE_MODE_C = 3;  // 本地 VM 集群
}
```

### 4.2 RCSlotAssignment — RC 槽位分配

```protobuf
message RCSlotAssignment {
  uint32 slot_id = 1;
  
  // 该槽位负责的规则组
  repeated RuleGroup rule_groups = 2;
  
  // 所有者 RC 节点
  string owner_node = 3;
  
  // Epoch 令牌
  string epoch_token = 4;
  
  // 槽位状态
  RCSlotState state = 5;
  
  // 评估间隔（取组内最小值）
  google.protobuf.Duration min_eval_interval = 6;
  
  // 规则数量
  uint32 rule_count = 7;
}

enum RCSlotState {
  RC_SLOT_STATE_UNSPECIFIED = 0;
  RC_SLOT_STATE_ASSIGNED = 1;
  RC_SLOT_STATE_UNASSIGNED = 2;
  RC_SLOT_STATE_MIGRATING = 3;
  RC_SLOT_STATE_FENCED = 4;
}
```

### 4.3 RuleGroup — 规则组

```protobuf
message RuleGroup {
  // 规则组 ID，控制面分配
  string group_id = 1;
  
  // 规则组名称
  string name = 2;
  
  // 评估间隔
  google.protobuf.Duration interval = 3;
  
  // 规则列表
  repeated Rule rules = 4;
  
  // 规则版本
  uint64 rule_version = 5;
  
  // 数据来源：本地存储的哪些 metric
  repeated string source_metrics = 6;
}

message Rule {
  string rule_id = 1;
  string alert_name = 2;
  string expr = 3;                    // PromQL 表达式
  google.protobuf.Duration for_duration = 4;  // 持续时间
  map<string, string> labels = 5;
  map<string, string> annotations = 6;
  RuleSeverity severity = 7;
}

enum RuleSeverity {
  RULE_SEVERITY_UNSPECIFIED = 0;
  RULE_SEVERITY_INFO = 1;
  RULE_SEVERITY_WARNING = 2;
  RULE_SEVERITY_CRITICAL = 3;
}
```

### 4.4 RCNodeRegistration — RC 节点注册

```protobuf
message RCNodeRegistration {
  string node_id = 1;
  string rc_instance_id = 2;
  
  // RC 节点状态
  RCNodeState state = 3;
  
  // 当前负载（已分配的规则组数量）
  uint32 current_load = 4;
  
  // 最大容量（规则组数量上限）
  uint32 max_capacity = 5;
  
  // 本地存储连接状态
  bool storage_connected = 6;
  
  // 查询延迟（毫秒，反映存储访问性能）
  uint32 query_latency_ms = 7;
  
  google.protobuf.Timestamp last_heartbeat = 8;
}

enum RCNodeState {
  RC_NODE_STATE_UNSPECIFIED = 0;
  RC_NODE_STATE_ACTIVE = 1;
  RC_NODE_STATE_DEGRADED = 2;
  RC_NODE_STATE_DRAINING = 3;
  RC_NODE_STATE_OFFLINE = 4;
}
```

### 4.5 RCAlert — RC 告警输出

```protobuf
message RCAlert {
  string alert_id = 1;
  string rule_id = 2;
  string alert_name = 3;
  
  // 告警状态
  AlertState state = 4;
  
  // 触发时间
  google.protobuf.Timestamp fired_at = 5;
  
  //  resolved 时间
  google.protobuf.Timestamp resolved_at = 6;
  
  // 告警标签
  map<string, string> labels = 7;
  
  // 告警注解
  map<string, string> annotations = 8;
  
  // 来源信息
  string source_zone_id = 9;
  string source_rc_node_id = 10;
  
  // 去重键（接管期间防重复）
  string dedup_key = 11;
}

enum AlertState {
  ALERT_STATE_UNSPECIFIED = 0;
  ALERT_STATE_PENDING = 1;   // 触发但未持续够 for 时间
  ALERT_STATE_FIRING = 2;    // 正在告警
  ALERT_STATE_RESOLVED = 3;  // 已恢复
}
```

### 4.6 数据模型关系图

```
RCManifest (1 per zone)
  ├── RCSlotAssignment (N)
  │     └── RuleGroup (M)
  │           └── Rule (K)
  ├── RCNodeRegistration (J)
  └── StorageEndpoint (1)

告警输出流:
  RCNode → RCAlert → 区内聚合 → C4 转发 → 控制面告警管理

关键约束:
  - Mode A 区: RCManifest 为空，不创建任何 RCSlotAssignment
  - RC 节点必须 storage_connected = true 才能接受任务
  - 每个 RuleGroup 最多分配给一个 RC 节点
  - RC 槽位与采集槽位的关系取决于槽位模式选择（见设计决策）
```

---

## 五、接口与交互

### 5.1 内部接口

#### 5.1.1 规则包接收接口（Zone Agent → RC 任务调度）

```
接口: OnRuleSpecReceived
方向: Zone Agent → RC 任务调度模块
触发: Zone Agent 从控制面接收到新的 RuleSpec
协议: 区内 gRPC

请求:
  RuleSpecDelivery {
    zone_id: string
    rule_spec: RuleSpec          // 完整规则定义
    delivery_type: "full" | "incremental"
    rule_version: uint64
  }

前置检查:
  1. 检查 zone.storage_mode ∈ {B, C}
     → Mode A 区直接返回 "RC_NOT_APPLICABLE"
  2. 检查本地存储连通性
     → 存储不可达则告警，但仍接收规则包（缓存待用）

处理流程:
  1. 解析 RuleSpec，生成/更新 RCManifest
  2. 按规则组分配到 RC 槽位
  3. 向各 RC 节点分发规则包
  4. RC 节点热加载新规则
  5. 返回确认
```

#### 5.1.2 RC 心跳接口（RC ↔ RC）

```
接口: RCHeartbeat
方向: RC 节点间对等
周期: 3s
协议: gRPC 单播

请求 (RCHeartbeatMessage):
  node_id: string
  timestamp: Timestamp
  status: "alive" | "degraded"
  owned_rule_groups: [string]
  storage_connected: bool
  query_latency_ms: uint32
  eval_queue_depth: uint32        // 待评估规则队列深度
  last_eval_duration_ms: uint32   // 上一次评估耗时

处理:
  1. 收到心跳 → 重置超时计时器
  2. 连续 3 次未收到 → SUSPECT
  3. 连续 5 次未收到 → EXPIRED，触发 RC 接管
  4. 检查 storage_connected：
     → 若 peer 报告存储断连，标记该节点为 DEGRADED
  5. 检查 eval_queue_depth：
     → 若持续 > 阈值，标记为 overloaded，考虑迁移部分规则组
```

#### 5.1.3 RC 接管接口

```
接口: RCNegotiateOwnership
方向: RC 节点间对等
触发: RC 节点故障检测后

流程:
  1. 节点 A 检测到 RC 节点 B 心跳超时
  2. 节点 A 发起 OwnershipClaim，声明接管 B 的 rule_groups
  3. 其他存活 RC 节点验证：
     a. 检查自身是否声称同一 rule_groups
     b. 比较 epoch_token
     c. 比较 node_id
  4. 多数派同意后生效
  5. 接管节点从本地存储读取数据，开始评估接管的规则组

注意:
  - RC 接管后需要重建评估状态（如 for 持续时间计时器）
  - 短暂内的重复告警通过 dedup_key 去重
```

#### 5.1.4 告警转发接口（RC 任务调度 → 控制面）

```
接口: ForwardAlerts (C4)
方向: RC 任务调度 → 控制面告警管理
协议: 跨区 gRPC (M3 接口)

请求:
  AlertBatch {
    zone_id: string
    alerts: [RCAlert]
    batch_id: string
    batch_timestamp: Timestamp
  }

响应:
  AlertAck {
    accepted_count: uint32
    rejected_alerts: [{alert_id, reason}]
  }

降级行为:
  - 控制面不可达时，告警在区内缓冲
  - 缓冲上限: 10000 条告警
  - 超出上限后，按时间淘汰最旧告警
  - 控制面恢复后，批量补发缓冲告警
```

### 5.2 交互时序图

#### 5.2.1 RC 规则分发与评估流程

```
控制面       Zone Agent      RC 任务调度      RC Node A      RC Node B     本地存储
  │              │               │               │              │             │
  │──RuleSpec──▶ │               │               │              │             │
  │  (M2 push)   │               │               │              │             │
  │              │──RuleSpec──▶  │               │              │             │
  │              │  Delivery     │               │              │             │
  │              │               │               │              │             │
  │              │               │──检查存储模式──▶│              │             │
  │              │               │  (Mode B/C?)   │              │             │
  │              │               │               │              │             │
  │              │               │──分发规则包───▶│              │             │
  │              │               │──分发规则包────────────────▶│             │
  │              │               │               │              │             │
  │              │               │               │──热加载规则──│              │
  │              │               │               │              │──热加载规则──│
  │              │               │               │              │             │
  │              │               │               │──查询数据──────────────────▶│
  │              │               │               │◀──返回结果─────────────────│
  │              │               │               │              │             │
  │              │               │               │──评估规则     │              │
  │              │               │               │  (PromQL)     │              │
  │              │               │               │              │             │
  │              │               │◀──告警────────│              │             │
  │              │               │               │              │             │
  │◀──AlertBatch─│◀──────────────│               │              │             │
  │  (C4/M3)     │               │               │              │             │
```

#### 5.2.2 RC 节点故障接管流程

```
RC Node A       RC Node B       RC Node C      (故障: RC Node D)
  │               │               │                │
  │◀─HB(3s)──▶   │◀──HB(3s)──▶  │                │
  │               │               │                │
  │  [D 心跳超时 ×3]│               │                │
  │               │               │                │
  │──RCClaim────▶ │               │                │
  │  "接管 D 的    │               │                │
  │   Group 5,6"  │               │                │
  │               │               │                │
  │◀─RCResponse───│               │                │
  │  "同意"        │               │                │
  │               │               │                │
  │──RCClaim────────────────────▶ │                │
  │                              │                │
  │◀─RCResponse─────────────────│                │
  │  "同意"                      │                │
  │                              │                │
  │  [多数派确认: A+B+C = 3/3]   │                │
  │  [更新 epoch_token]          │                │
  │                              │                │
  │──从本地存储读取 Group 5,6 数据──               │
  │──重建评估状态                 │                │
  │──开始评估（可能产生重复告警）  │                │
  │──通过 dedup_key 去重          │                │
```

---

## 六、设计决策与替代方案

### 6.1 RC 槽位模型

这是本模块最核心的设计决策，有三种候选方案：

#### 方案 A：独立槽位池（推荐）

```
┌──────────────────────────────────────────────────────────┐
│                    独立槽位池方案                           │
│                                                          │
│  采集槽位池                    RC 槽位池                    │
│  ┌────┬────┬────┬────┐      ┌────┬────┬────┐            │
│  │ S0 │ S1 │ S2 │ S3 │      │ R0 │ R1 │ R2 │            │
│  │采集│采集│采集│采集│      │规则│规则│规则│            │
│  └────┴────┴────┴────┘      └────┴────┴────┘            │
│                                                          │
│  所有权协商: JS ↔ JS          所有权协商: RC ↔ RC          │
│  检测组: JS 组               检测组: RC 组                │
│  故障域: 独立                 故障域: 独立                  │
└──────────────────────────────────────────────────────────┘

优点:
  + 采集与 RC 完全解耦，互不影响
  + RC 故障不影响采集，采集故障不影响 RC
  + 可独立调整 RC 槽位数
  + RC 可以部署在不同节点上（灵活拓扑）

缺点:
  - 需要维护两套槽位系统
  - RC 节点可能需要额外的硬件资源
  - 管理复杂度增加

适用场景: Mode C（VM 集群，RC 独立部署）
```

#### 方案 B：共享槽位池

```
┌──────────────────────────────────────────────────────────┐
│                    共享槽位池方案                           │
│                                                          │
│  统一槽位池                                               │
│  ┌──────────┬──────────┬──────────┬──────────┐          │
│  │ S0       │ S1       │ S2       │ S3       │          │
│  │ 采集+RC  │ 采集+RC  │ 采集+RC  │ 采集+RC  │          │
│  │          │          │          │          │          │
│  │ JS owns  │ JS owns  │ JS owns  │ JS owns  │          │
│  │ RC owns  │ RC owns  │ RC owns  │ RC owns  │          │
│  └──────────┴──────────┴──────────┴──────────┘          │
│                                                          │
│  每个 slot 有两个 owner:                                  │
│    - 采集 owner (Job Scheduler 节点)                      │
│    - RC owner (RC 节点，可能与采集 owner 不同)              │
│                                                          │
│  所有权协商: 采集和 RC 各自独立协商                         │
└──────────────────────────────────────────────────────────┘

优点:
  + 统一管理，减少系统复杂度
  + slot 的 target 和 rule 可以共享上下文
  + 减少元数据冗余

缺点:
  - 采集与 RC 耦合，一个出问题可能影响另一个
  - 所有权协商更复杂（两套 owner 独立协商）
  - RC 槽位数受限于采集槽位数
  - 违反 P8（三条独立路径）原则的精神

适用场景: Mode B（简单部署，节点少）
```

#### 方案 C：节点绑定

```
┌──────────────────────────────────────────────────────────┐
│                    节点绑定方案                             │
│                                                          │
│  每个 Job Scheduler 节点同时运行 RC                        │
│  ┌──────────────────────────────────────────────┐        │
│  │ Node A                    Node B              │        │
│  │ ┌──────────┐ ┌────────┐ │ ┌──────────┐ ┌────────┐│   │
│  │ │ JS       │ │ RC     │ │ │ JS       │ │ RC     ││   │
│  │ │ (采集)    │ │ (规则)  │ │ │ (采集)    │ │ (规则)  ││   │
│  │ └──────────┘ └────────┘ │ └──────────┘ └────────┘│   │
│  │                          │                         │   │
│  │ RC-A 负责本节点存储       │ RC-B 负责本节点存储      │   │
│  └──────────────────────────────────────────────┘        │
│                                                          │
│  无需槽位协商:                                            │
│    每个节点的 RC 负责该节点上采集的数据                      │
│    RC 与 JS 同生共死                                      │
└──────────────────────────────────────────────────────────┘

优点:
  + 最简单，无需 RC 级别的所有权协商
  + 数据本地性好（RC 读本地存储）
  + 故障域清晰（节点级）

缺点:
  - RC 与 JS 强耦合，JS 故障则 RC 也丢失
  - 无法独立扩展 RC
  - 规则分布不均匀（取决于采集分布）
  - Mode C 集群存储时，数据本地性优势消失

适用场景: Mode B（单节点 VM，JS + RC 同机）
```

**决策:** 推荐方案 A（独立槽位池）作为默认方案，方案 C（节点绑定）作为 Mode B 小区的简化实现。方案 B（共享槽位池）不推荐，因违反 P8 原则。

### 6.2 Mode A 区的告警覆盖

```
问题: Mode A 区无本地存储 → 无本地 RC → 无本地规则告警

方案 A: 完全依赖中心 RC
  - 数据 remote-write 到中心后，中心 RC 评估规则
  - 延迟: 数据传输延迟 + 中心 RC 评估延迟
  - 优点: 简单，无额外组件
  - 缺点: 依赖中心，中心故障则告警失效

方案 B: 轻量级本地 RC（无存储）
  - RC 直接读取 Agent 最近一次采集结果（内存中）
  - 不做 PromQL 查询，只做简单阈值判断
  - 优点: 基本告警能力
  - 缺点: 功能受限，非标准 PromQL

方案 C: 接受告警盲区
  - Mode A 区本身定位为轻量级区，不要求本地告警
  - 依赖中心告警即可
  - 优点: 最简单
  - 缺点: 中心故障时有告警盲区

决策: 当前采用方案 A + C 组合。Mode A 区默认依赖中心 RC，
中心不可达时的告警盲区作为已知限制记录。方案 B 作为未来迭代方向。
```

### 6.3 RC 检测组独立性

```
问题: RC 节点的对等检测是否应该独立于 Job Scheduler 的检测组？

方案 A: 独立检测组（推荐）
  RC-A ←──HB──→ RC-B    (RC 检测组)
  JS-A  ←──HB──→ JS-B   (JS 检测组)

  + RC 和 JS 故障域独立
  + RC 接管不影响采集，采集接管不影响 RC
  + 可以有不同的超时参数（RC 可容忍更长延迟）
  - 需要维护两套心跳通道

方案 B: 共享检测组
  JS-A 也检测 RC-A 的状态
  + 减少心跳通道
  - 耦合度高
  - JS 故障可能导致 RC 被误判

决策: 采用方案 A，独立检测组。符合 P8 原则。
```

### 6.4 告警缓冲策略

```
问题: 控制面不可达时，RC 产生的告警如何处理？

缓冲策略:
  ┌────────────────────────────────────────────────┐
  │              告警缓冲队列                        │
  │                                                │
  │  容量上限: 10000 条                              │
  │  淘汰策略: FIFO（最旧的先淘汰）                   │
  │  持久化: 写入本地磁盘（防 RC 重启丢失）           │
  │  去重: dedup_key = hash(rule_id + labels)       │
  │                                                │
  │  控制面恢复后:                                   │
  │    1. 批量补发缓冲告警                           │
  │    2. 控制面侧做去重（可能有多个区同时补发）       │
  │    3. 补发完成后清空缓冲区                        │
  └────────────────────────────────────────────────┘
```

---

## 七、冲突与开放问题

### 7.1 已识别冲突

| 冲突编号 | 描述 | 影响范围 | 当前状态 |
|---------|------|---------|---------|
| MC-02 | RC 是否需要独立槽位池 | RC 架构 | 推荐独立，但 Mode B 可简化为节点绑定 |
| MC-03 | RC 与 JS 同节点时的资源竞争 | 性能 | 需要资源隔离机制 |
| MC-04 | Mode A 区告警覆盖缺口 | 功能完整性 | 已知限制，依赖中心 RC |

### 7.2 开放问题

| 问题编号 | 问题 | 候选方案 | 建议 |
|---------|------|---------|------|
| OQ-01 | RC 槽位数量如何确定？ | (a) 基于规则组数量 (b) 固定值 (c) 基于存储容量 | 建议 (a)，规则组数 / 每 RC 节点容量 |
| OQ-02 | RC 接管时如何重建 for 持续时间状态？ | (a) 从头计时 (b) 从存储中恢复 (c) 从 peer 获取 | 建议 (a)，简单安全，可能延迟告警 |
| OQ-03 | 规则表达式中引用跨区数据如何处理？ | (a) 不允许 (b) 通过 Zone Query Proxy 代理 | 建议 (a)，RC 仅使用本地数据 |
| OQ-04 | RC 评估频率与采集频率不匹配时？ | (a) RC 频率 ≤ 采集频率 (b) 独立配置 | 建议 (a)，RC 不能比采集更快 |
| OQ-05 | 告警缓冲溢出时的优先级策略？ | (a) FIFO (b) 按严重级别 (c) 按规则优先级 | 建议 (b)，CRITICAL 告警优先保留 |

### 7.3 风险项

| 风险编号 | 风险描述 | 概率 | 影响 | 缓解措施 |
|---------|---------|------|------|---------|
| R-01 | Mode A 区在中心不可达时无告警 | 中 | 高 | 明确文档说明限制，推动 Mode B 升级 |
| R-02 | RC 接管期间重复告警 | 高 | 低 | dedup_key 去重，控制面侧二次去重 |
| R-03 | 规则包过大导致分发延迟 | 低 | 中 | 增量 diff + 压缩传输 |
| R-04 | 本地存储故障导致 RC 全部失效 | 低 | 高 | 存储健康监控 + 自动降级告警 |

### 7.4 待决设计点

1. **RC 节点是否可以是 Job Scheduler 节点上的进程**: Mode B 推荐同节点，Mode C 推荐独立节点。需明确部署规范。
2. **规则热加载的原子性**: 规则更新是否需要全组原子替换，还是支持单条规则更新？建议全组原子替换。
3. **RC 评估结果缓存**: 是否需要缓存评估结果以减少存储查询？建议支持，缓存周期 = 评估间隔。
4. **告警静默规则的位置**: 静默规则在控制面定义还是在区 RC 本地执行？建议控制面定义，RC 本地执行过滤。
