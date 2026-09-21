# 冲突仲裁

## 一、概述

冲突仲裁模块负责检测、诊断和解决区内各类冲突场景，确保在分布式环境下系统状态的一致性。核心原则是"宁缺勿滥"——当无法达成安全共识时，选择留空（hole）而非双主（dual-master），保障采集数据的正确性。

本模块与组件健康模块紧密协作：健康模块提供节点状态数据，仲裁模块基于这些数据做出冲突裁决。同时，仲裁模块的决策输出驱动行为决策模块的接管和重平衡动作。

### 1.1 核心定位

```
┌──────────────────────────────────────────────────────────────────────┐
│                        协调层 (Coordination Plane)                     │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                    冲突仲裁 (本模块)                           │    │
│  │                                                              │    │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐  │    │
│  │  │ 所有权冲突检测    │  │ 版本冲突解决     │  │ 分区处理     │  │    │
│  │  │ (Epoch Fencing)  │  │ (Manifest Ver.)  │  │ (Partition)  │  │    │
│  │  └────────┬────────┘  └────────┬────────┘  └──────┬──────┘  │    │
│  │           │                    │                   │          │    │
│  │           └────────────────────┼───────────────────┘          │    │
│  │                                ▼                              │    │
│  │                    ┌───────────────────────┐                  │    │
│  │                    │   裁决引擎              │                  │    │
│  │                    │   · Epoch 比较          │                  │    │
│  │                    │   · 多数派判定          │                  │    │
│  │                    │   · 2 节点特殊处理      │                  │    │
│  │                    │   · 偶数节点平局打破    │                  │    │
│  │                    └───────────┬───────────┘                  │    │
│  └────────────────────────────────┼──────────────────────────────┘    │
│                                   │                                   │
│          ┌────────────────────────┼──────────────────────┐           │
│          ▼                        ▼                      ▼           │
│  ┌──────────────┐        ┌──────────────┐       ┌──────────────┐   │
│  │ 采集任务调度  │        │ 行为决策      │       │ 组件健康      │   │
│  │ (执行 fencing)│        │ (执行驱逐)    │       │ (提供状态)    │   │
│  └──────────────┘        └──────────────┘       └──────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.2 设计目标

| 目标编号 | 描述 | 优先级 |
|---------|------|--------|
| G-01 | 杜绝双主（dual-master），宁可留空也不重复采集 | P0 |
| G-02 | 冲突检测延迟 ≤5s（从冲突发生到检测完成） | P0 |
| G-03 | 冲突解决后 ≤10s 内完成状态收敛 | P1 |
| G-04 | 2 节点区有明确的冲突解决路径 | P1 |
| G-05 | 网络分区场景下，少数派冻结、多数派继续 | P1 |
| G-06 | 所有冲突裁决可审计、可追溯 | P2 |

### 1.3 冲突类型总览

```
┌─────────────────────────────────────────────────────────────────┐
│                        冲突类型分类                               │
├───────────────────┬─────────────────────────────────────────────┤
│ 冲突类型           │ 描述                                        │
├───────────────────┼─────────────────────────────────────────────┤
│ 槽位所有权冲突     │ 两个节点声称拥有同一 slot（脑裂场景）          │
│ (Slot Ownership)  │ 严重度: CRITICAL                             │
├───────────────────┼─────────────────────────────────────────────┤
│ Manifest 版本冲突  │ 节点持有过时的 Manifest 版本                  │
│ (Manifest Version)│ 严重度: WARNING                              │
├───────────────────┼─────────────────────────────────────────────┤
│ 网络分区           │ 区内节点被网络分区分割                        │
│ (Partition)       │ 严重度: CRITICAL                             │
├───────────────────┼─────────────────────────────────────────────┤
│ Epoch 冲突        │ 不同节点持有不兼容的 epoch 值                  │
│ (Epoch Conflict)  │ 严重度: CRITICAL                             │
├───────────────────┼─────────────────────────────────────────────┤
│ 偶数节点平局       │ 投票出现 N:N 平局                            │
│ (Even-node Tie)   │ 严重度: WARNING                              │
└───────────────────┴─────────────────────────────────────────────┘
```

---

## 二、职责边界

### 2.1 本模块负责

| 职责 | 说明 |
|------|------|
| 冲突检测 | 通过心跳数据、所有权声明、版本校验发现冲突 |
| 冲突诊断 | 判断冲突类型、严重程度、影响范围 |
| 冲突裁决 | 基于 epoch fencing、多数派规则等做出裁决 |
| 2 节点特殊处理 | 为 2 节点区提供专门的冲突解决方案 |
| 偶数节点平局打破 | 为偶数节点区提供平局打破机制 |
| 分区处理策略 | 执行少数派冻结、多数派继续的分区策略 |
| 裁决审计 | 记录所有冲突裁决的完整日志 |
| 冲突恢复验证 | 确认冲突解决后系统状态已收敛 |

### 2.2 本模块不负责

| 不负责事项 | 归属 | 说明 |
|-----------|------|------|
| 执行 slot 迁移 | 行为决策模块 | 本模块做裁决，行为决策执行 |
| 节点健康检测 | 组件健康模块 | 本模块消费健康数据 |
| Epoch 令牌生成 | 采集任务调度模块 | 本模块验证 epoch 有效性 |
| 网络故障修复 | 运维/基础设施 | 本模块只处理网络分区的影响 |
| 控制面同步 | Zone Agent | 本模块在区内闭环处理 |

### 2.3 核心原则

```
原则 P-01: 宁缺勿滥 (Hole over Dual-Master)
═══════════════════════════════════════════════

  当无法达成安全共识时:
  
  ✓ 正确: 留下"空洞"（slot 暂时无主）
  ✗ 错误: 让两个节点同时采集同一目标

  原因:
  - 重复采集 → 重复数据 → 指标翻倍 → 告警误报
  - 空洞 → 短暂数据缺失 → 可能触发告警，但数据不会错误
  - 数据错误的代价 > 数据缺失的代价

原则 P-02: 可审计性
═══════════════════════════════════════════════

  每次冲突裁决必须记录:
  - 冲突类型
  - 参与方
  - 裁决依据
  - 裁决结果
  - 恢复确认

原则 P-03: 最小干预
═══════════════════════════════════════════════

  冲突解决应尽量减少对正常运行的影响:
  - 只处理冲突涉及的 slot/节点
  - 不冲突的 slot 不受影响
  - 避免"全局重置"式的解决方案
```

---

## 三、功能清单

### 3.1 槽位所有权冲突

| 功能项 | 描述 |
|--------|------|
| F-1.1 冲突检测 | 从心跳数据中检测两个节点声称同一 slot 的情况 |
| F-1.2 Epoch 比较 | 比较冲突双方的 epoch_token，高者胜 |
| F-1.3 Node ID 比较 | epoch 相同时，node_id 字典序大者胜 |
| F-1.4 多数派验证 | 裁决需获得多数派节点确认 |
| F-1.5 败方 Fencing | 败方节点的该 slot 被 fencing，必须等待新 epoch |
| F-1.6 留空降级 | 无法达成多数派时，slot 留空（不分配） |

### 3.2 Manifest 版本冲突

| 功能项 | 描述 |
|--------|------|
| F-2.1 版本检测 | 从心跳中检测节点间 Manifest 版本差异 |
| F-2.2 版本裁决 | 高版本为权威，低版本必须同步 |
| F-2.3 强制同步 | 版本落后的节点被强制拉取最新 Manifest |
| F-2.4 版本回退拒绝 | 拒绝接受低于当前版本的 Manifest 更新 |

### 3.3 网络分区处理

| 功能项 | 描述 |
|--------|------|
| F-3.1 分区检测 | 通过 peer 可达性矩阵识别分区模式 |
| F-3.2 少数派冻结 | 少数派分区冻结所有变更操作 |
| F-3.3 多数派继续 | 多数派分区继续正常运行，可触发重平衡 |
| F-3.4 分区合并 | 分区恢复后，执行状态合并与冲突解决 |
| F-3.5 分区日志 | 记录分区起止时间、影响范围 |

### 3.4 2 节点区特殊处理

| 功能项 | 描述 |
|--------|------|
| F-4.1 方案选择 | 根据配置选择 witness / asymmetric / coordinator_assist |
| F-4.2 Witness 管理 | 管理轻量级 witness 节点的连接与状态 |
| F-4.3 非对称优先级 | 维护 primary/secondary 优先级配置 |
| F-4.4 Coordinator 辅助 | Coordinator 在 2 节点冲突时提供裁决 |

### 3.5 偶数节点平局打破

| 功能项 | 描述 |
|--------|------|
| F-5.1 平局检测 | 检测投票出现 N:N 平局的情况 |
| F-5.2 Coordinator 投票 | Coordinator 在平局时拥有决定性一票 |
| F-5.3 Epoch 优先 | 平局时 epoch 较高的方案胜出 |
| F-5.4 超时降级 | 平局持续超时则 slot 留空 |

### 3.6 裁决审计

| 功能项 | 描述 |
|--------|------|
| F-6.1 裁决日志 | 记录每次裁决的完整信息 |
| F-6.2 冲突历史 | 维护冲突历史记录 |
| F-6.3 审计查询 | 支持按时间、类型、节点查询冲突历史 |
| F-6.4 审计上报 | 定期将冲突摘要上报控制面 |

---

## 四、核心数据模型

### 4.1 ConflictEvent — 冲突事件

```protobuf
// ConflictEvent 描述一次检测到的冲突
message ConflictEvent {
  // 冲突 ID
  string conflict_id = 1;
  
  // 冲突类型
  ConflictType type = 2;
  
  // 严重度
  ConflictSeverity severity = 3;
  
  // 检测时间
  google.protobuf.Timestamp detected_at = 4;
  
  // 冲突参与方
  repeated ConflictParty parties = 5;
  
  // 冲突详情（按类型不同）
  oneof detail {
    SlotOwnershipConflict slot_conflict = 6;
    ManifestVersionConflict manifest_conflict = 7;
    NetworkPartitionConflict partition_conflict = 8;
    EvenNodeTieConflict tie_conflict = 9;
  }
  
  // 裁决结果
  ArbitrationResult resolution = 10;
  
  // 冲突状态
  ConflictStatus status = 11;
}

enum ConflictType {
  CONFLICT_TYPE_UNSPECIFIED = 0;
  CONFLICT_TYPE_SLOT_OWNERSHIP = 1;
  CONFLICT_TYPE_MANIFEST_VERSION = 2;
  CONFLICT_TYPE_NETWORK_PARTITION = 3;
  CONFLICT_TYPE_EVEN_NODE_TIE = 4;
  CONFLICT_TYPE_EPOCH = 5;
}

enum ConflictSeverity {
  CONFLICT_SEVERITY_UNSPECIFIED = 0;
  CONFLICT_SEVERITY_INFO = 1;
  CONFLICT_SEVERITY_WARNING = 2;
  CONFLICT_SEVERITY_CRITICAL = 3;
}

enum ConflictStatus {
  CONFLICT_STATUS_UNSPECIFIED = 0;
  CONFLICT_STATUS_DETECTED = 1;     // 已检测到
  CONFLICT_STATUS_ARBITRATING = 2;  // 裁决中
  CONFLICT_STATUS_RESOLVED = 3;     // 已解决
  CONFLICT_STATUS_UNRESOLVED = 4;   // 无法解决（留空）
  CONFLICT_STATUS_MERGED = 5;       // 分区合并后解决
}
```

### 4.2 SlotOwnershipConflict — 槽位所有权冲突

```protobuf
message SlotOwnershipConflict {
  // 冲突涉及的 slot
  repeated uint32 contested_slots = 1;
  
  // 冲突双方声明
  OwnershipClaim claim_a = 2;
  OwnershipClaim claim_b = 3;
  
  // Epoch 比较结果
  EpochComparison epoch_comparison = 4;
  
  // 可用见证方（哪些节点可以作证）
  repeated string available_witnesses = 5;
  
  // 多数派是否可达
  bool majority_reachable = 6;
}

message OwnershipClaim {
  string node_id = 1;
  repeated uint32 claimed_slots = 2;
  string epoch_token = 3;
  uint64 claim_version = 4;
  google.protobuf.Timestamp claim_time = 5;
  
  // 声称的支持者
  repeated string endorsers = 6;
}

message EpochComparison {
  string higher_epoch_node = 1;
  bool epochs_equal = 2;
  uint32 epoch_a_zone = 3;
  uint32 epoch_a_slot = 4;
  uint32 epoch_b_zone = 5;
  uint32 epoch_b_slot = 6;
}
```

### 4.3 NetworkPartitionConflict — 网络分区冲突

```protobuf
message NetworkPartitionConflict {
  // 分区 ID
  string partition_id = 1;
  
  // 分区开始时间
  google.protobuf.Timestamp started_at = 2;
  
  // 分区模式
  repeated PartitionGroup groups = 3;
  
  // 本模块所在分区是多数派还是少数派
  PartitionSide local_side = 4;
  
  // 分区影响
  PartitionImpact impact = 5;
}

message PartitionGroup {
  repeated string node_ids = 1;
  bool is_majority = 2;
}

enum PartitionSide {
  PARTITION_SIDE_UNKNOWN = 0;
  PARTITION_SIDE_MAJORITY = 1;
  PARTITION_SIDE_MINORITY = 2;
  PARTITION_SIDE_EQUAL = 3;  // 无法判定（如 2 节点区）
}

message PartitionImpact {
  uint32 frozen_slots = 1;       // 被冻结的 slot 数
  uint32 affected_targets = 2;   // 受影响的 target 数
  bool rebalance_paused = 3;     // 重平衡是否暂停
  bool takeover_paused = 4;      // 接管是否暂停
}
```

### 4.4 ArbitrationResult — 裁决结果

```protobuf
message ArbitrationResult {
  // 裁决 ID
  string arbitration_id = 1;
  
  // 关联的冲突 ID
  string conflict_id = 2;
  
  // 裁决时间
  google.protobuf.Timestamp decided_at = 3;
  
  // 裁决类型
  ArbitrationType type = 4;
  
  // 胜方（如适用）
  string winner_node_id = 5;
  
  // 败方（如适用）
  repeated string loser_node_ids = 6;
  
  // 裁决依据
  string rationale = 7;
  
  // 需要执行的动作
  repeated ArbitrationAction actions = 8;
  
  // 裁决是否需要多数派确认
  bool requires_quorum = 9;
  
  // 确认方
  repeated string confirmed_by = 10;
}

enum ArbitrationType {
  ARBITRATION_TYPE_UNSPECIFIED = 0;
  ARBITRATION_TYPE_EPOCH_WIN = 1;       // Epoch 高者胜
  ARBITRATION_TYPE_NODEID_WIN = 2;      // Node ID 大者胜
  ARBITRATION_TYPE_LEAVE_HOLE = 3;      // 留空（无法裁决）
  ARBITRATION_TYPE_FORCE_SYNC = 4;      // 强制同步
  ARBITRATION_TYPE_FREEZE = 5;          // 冻结（少数派）
  ARBITRATION_TYPE_COORDINATOR_BREAK = 6; // Coordinator 打破平局
}

message ArbitrationAction {
  ActionType type = 1;
  string target_node = 2;
  repeated uint32 affected_slots = 3;
  string detail = 4;
  
  // 执行截止时间
  google.protobuf.Timestamp deadline = 5;
}

enum ActionType {
  ACTION_TYPE_UNSPECIFIED = 0;
  ACTION_TYPE_FENCE_SLOT = 1;       // Fencing 指定 slot
  ACTION_TYPE_RELEASE_SLOT = 2;     // 释放 slot（变为 unassigned）
  ACTION_TYPE_FORCE_RESYNC = 3;     // 强制节点重新同步
  ACTION_TYPE_FREEZE_NODE = 4;      // 冻结节点操作
  ACTION_TYPE_UNFREEZE_NODE = 5;    // 解冻节点
  ACTION_TYPE_TRIGGER_TAKEOVER = 6; // 触发接管
}
```

### 4.5 TwoNodeConfig — 2 节点区配置

```protobuf
message TwoNodeConfig {
  // 2 节点冲突解决方案
  TwoNodeScheme scheme = 1;
  
  // Witness 方案配置
  WitnessConfig witness_config = 2;
  
  // Asymmetric 方案配置
  AsymmetricConfig asymmetric_config = 3;
  
  // Coordinator assist 方案配置
  CoordinatorAssistConfig coordinator_assist_config = 4;
}

enum TwoNodeScheme {
  TWO_NODE_SCHEME_UNSPECIFIED = 0;
  TWO_NODE_SCHEME_WITNESS = 1;           // Witness 节点
  TWO_NODE_SCHEME_ASYMMETRIC = 2;        // 非对称优先级
  TWO_NODE_SCHEME_COORDINATOR_ASSIST = 3; // Coordinator 辅助
  TWO_NODE_SCHEME_MANUAL = 4;            // 手动干预
}

message WitnessConfig {
  string witness_node_id = 1;
  string witness_address = 2;
  google.protobuf.Duration heartbeat_interval = 3;  // 默认 5s
  google.protobuf.Duration witness_timeout = 4;      // 默认 15s
}

message AsymmetricConfig {
  string primary_node_id = 1;
  string secondary_node_id = 2;
  // 冲突时 primary 始终胜出
  // 但 primary 故障时 secondary 可完全接管
}

message CoordinatorAssistConfig {
  // Coordinator 在冲突时充当仲裁者
  // 仅在 Coordinator 可达时有效
  // Coordinator 不可达则退化为 MANUAL
  google.protobuf.Duration decision_timeout = 1;  // 等待 Coordinator 裁决的超时
}
```

### 4.6 数据模型关系图

```
ConflictEvent (N, 历史冲突)
  ├── ConflictParty (2+, 参与方)
  ├── SlotOwnershipConflict / ManifestVersionConflict / ...
  │     ├── OwnershipClaim (2, 双方声明)
  │     └── EpochComparison
  └── ArbitrationResult (1, 裁决)
        ├── ArbitrationAction (M, 执行动作)
        └── confirmed_by (K, 确认方)

冲突生命周期:
  DETECTED → ARBITRATING → RESOLVED / UNRESOLVED
                              │
                              └── 分区合并后: MERGED
```

---

## 五、接口与交互

### 5.1 内部接口

#### 5.1.1 冲突检测接口

```
接口: DetectConflict
方向: 采集任务调度 / 组件健康 → 冲突仲裁
触发: 心跳数据中发现所有权声明冲突 / 版本不一致 / 分区模式

请求 (ConflictDetectionInput):
  source: string                    // 检测来源 ("heartbeat" | "health_check" | "manual")
  detector_node_id: string          // 检测到冲突的节点
  conflict_type: ConflictType
  evidence: ConflictEvidence        // 冲突证据

处理流程:
  1. 接收冲突证据
  2. 验证证据有效性（时间戳、签名等）
  3. 创建 ConflictEvent
  4. 根据类型进入对应裁决流程
  5. 发布冲突检测事件

冲突证据类型:
  SlotOwnershipEvidence:
    - 两个节点的心跳中声称同一 slot
    - 携带各自的 epoch_token
  ManifestVersionEvidence:
    - 节点报告的 manifest_version 落后于最新已知版本
  PartitionEvidence:
    - peer 可达性矩阵显示不连通分组
```

#### 5.1.2 裁决执行接口

```
接口: ExecuteArbitration
方向: 冲突仲裁 → 采集任务调度 / 行为决策
触发: 裁决完成

请求 (ArbitrationExecution):
  arbitration_id: string
  actions: [ArbitrationAction]
  
  // 执行确认回调
  on_complete: callback

执行方:
  - 采集任务调度: 执行 FENCE_SLOT / RELEASE_SLOT
  - 行为决策: 执行 TRIGGER_TAKEOVER
  - 组件健康: 执行 FREEZE_NODE

确认流程:
  1. 执行方完成动作后返回确认
  2. 冲突仲裁模块收集所有确认
  3. 所有动作确认 → 冲突标记为 RESOLVED
  4. 部分动作超时 → 记录并升级处理
```

#### 5.1.3 2 节点冲突裁决接口

```
接口: ArbitrateTwoNodeConflict
方向: 冲突仲裁内部
触发: 2 节点区发生所有权冲突

裁决流程 (按 scheme 不同):

  Witness 方案:
    1. 向 witness 节点请求裁决
    2. Witness 选择它认为存活的节点
    3. 2 + witness = 3 票，多数派可达成
    4. 若 witness 不可达 → 退化为 MANUAL

  Asymmetric 方案:
    1. 检查 primary 节点是否在冲突方中
    2. Primary 在冲突中 → primary 胜
    3. Primary 不在冲突中（已故障）→ secondary 胜
    4. 无需外部仲裁

  Coordinator Assist 方案:
    1. 向 Coordinator 提交冲突信息
    2. Coordinator 基于健康数据做出裁决
    3. 若 Coordinator 不可达 → 退化为 MANUAL
    4. 裁决结果通过 epoch_token 更新生效
```

### 5.2 交互时序图

#### 5.2.1 槽位所有权冲突解决流程

```
JS Node A        冲突仲裁         JS Node B        JS Node C
  │                 │                │                │
  │  [心跳中发现:   │                │                │
  │   A 和 B 都声称 │                │                │
  │   slot 5]      │                │                │
  │                 │                │                │
  │──ConflictDetect▶│                │                │
  │  "A claims      │                │                │
  │   slot 5,       │                │                │
  │   epoch 3-42"   │                │                │
  │                 │                │                │
  │                 │──查询 B 的声明──▶│                │
  │                 │  "B claims      │                │
  │                 │   slot 5,       │                │
  │                 │   epoch 3-41"   │                │
  │                 │                │                │
  │                 │  [Epoch 比较]   │                │
  │                 │  A: 3-42        │                │
  │                 │  B: 3-41        │                │
  │                 │  42 > 41 → A 胜 │                │
  │                 │                │                │
  │                 │  [多数派确认]    │                │
  │                 │──验证请求──────▶│                │
  │                 │                │──确认: A 胜────│
  │                 │──验证请求──────────────────────▶│
  │                 │                                │──确认: A 胜──│
  │                 │                                │              │
  │                 │  [多数派确认: A+C = 2/3]       │              │
  │                 │                                │              │
  │◀─Arbitrate──────│                                │              │
  │  "A 胜, epoch   │                                │              │
  │   3-42 有效"     │                                │              │
  │                 │──Arbitrate────────────────────▶│              │
  │                 │  "B 败, slot 5                  │              │
  │                 │   必须释放, 需重新注册"          │              │
  │                 │                                │              │
  │  [A 正常持有 slot 5]           │                │              │
  │                                │  [B 释放 slot 5]│              │
  │                                │  [B 标记 FENCED]│              │
```

#### 5.2.2 网络分区处理流程

```
JS Node A (多数派)    冲突仲裁          JS Node D (少数派)
  │                    │                  │
  │  [网络分区发生]     │                  │
  │  A,B,C 可达        │                  │
  │  D 不可达          │                  │
  │                    │                  │
  │──PartitionDetect──▶│                  │
  │  "D 不可达"        │                  │
  │                    │                  │
  │──PartitionDetect──▶│                  │
  │  "D 不可达"        │                  │
  │                    │                  │
  │                    │  [分区判定]       │
  │                    │  多数派: {A,B,C}  │
  │                    │  少数派: {D}      │
  │                    │                  │
  │                    │  [多数派策略]      │
  │◀─Continue─────────│                  │
  │  "继续运行,        │                  │
  │   D 的 slots 可接管"│                  │
  │                    │                  │
  │  [A,B,C 协商接管 D 的 slots]          │
  │  [正常重平衡]       │                  │
  │                    │                  │
  │════════════════════════════════════════│
  │             [网络恢复]                 │
  │                    │                  │
  │                    │◀─Reconnect───────│
  │                    │  "D 恢复"         │
  │                    │                  │
  │                    │  [分区合并]        │
  │                    │  1. D 上报最后已知状态
  │                    │  2. 检测合并冲突   │
  │                    │  3. D 的旧声明被覆盖
  │                    │  4. D 同步最新 Manifest
  │                    │  5. 触发重平衡      │
  │                    │                  │
  │                    │──Resync──────────▶│
  │                    │  "同步最新状态"    │
```

#### 5.2.3 2 节点区 Witness 方案

```
JS Node A (Primary)    Witness          JS Node B (Secondary)
  │                     │                  │
  │◀──Heartbeat(3s)───▶│◀──Heartbeat──▶  │
  │                     │                  │
  │  [B 心跳超时]        │                  │
  │                     │                  │
  │──Claim─────────────▶│                  │
  │  "我接管 B 的 slots" │                  │
  │                     │                  │
  │                     │──验证 B 状态      │
  │                     │  [B 确实不可达]   │
  │                     │                  │
  │◀─Endorse────────────│                  │
  │  "Witness 确认,     │                  │
  │   多数派达成:        │                  │
  │   A + Witness = 2/3"│                  │
  │                     │                  │
  │  [A 合法接管 B 的 slots]               │
  │                     │                  │
  │════════════════════════════════════════│
  │             [B 恢复]                   │
  │                     │                  │
  │◀──Heartbeat─────────│◀──Heartbeat─────│
  │                     │                  │
  │  [重新协商 slot 分配]│                  │
  │  [部分 slots 归还 B] │                  │
```

---

## 六、设计决策与替代方案

### 6.1 所有权冲突裁决规则

#### 当前方案：Epoch 优先 + Node ID 决胜

```
裁决优先级:
  1. zone_epoch 高者胜
  2. zone_epoch 相同 → slot_version 高者胜
  3. slot_version 相同 → node_id 字典序大者胜

示例:
  Node A: epoch_token = "3-42"  (zone_epoch=3, slot_version=42)
  Node B: epoch_token = "3-41"  (zone_epoch=3, slot_version=41)
  
  比较: zone_epoch 相同(3=3) → slot_version: 42 > 41 → A 胜

  Node A: epoch_token = "3-42"
  Node C: epoch_token = "4-1"   (zone_epoch=4, slot_version=1)
  
  比较: zone_epoch: 4 > 3 → C 胜（即使 slot_version 更小）

安全保证:
  - zone_epoch 递增保证: 新分配总是产生更高的 epoch
  - 旧主恢复: 携带旧 epoch，必然输给新主
  - 确定性: 相同输入总是产生相同输出（无随机性）
```

**优点:**
- 确定性强，易于调试和验证
- 不需要额外的随机源
- 与 epoch fencing 机制天然配合

**缺点:**
- Node ID 决胜可能导致"热点"（高 ID 节点总是赢）
- 不考慮节点当前负载

#### 替代方案：负载感知裁决

```
在 epoch 和版本相同时，考虑节点负载:
  - 当前拥有 slot 数更少的节点胜
  - 或 CPU/内存使用率更低的节点胜

评估:
  + 更均衡的负载分布
  - 增加裁决复杂度
  - 负载信息可能不准确（尤其在分区场景）
  - 不确定性增加，调试困难
```

**决策:** 采用 epoch + node_id 确定性裁决。负载感知留给重平衡模块处理。

### 6.2 2 节点区冲突解决方案

#### 方案 A：Witness 节点

```
┌──────────────────────────────────────────────────────────┐
│                  Witness 节点方案                          │
│                                                          │
│  ┌──────────┐       ┌──────────┐       ┌──────────┐     │
│  │ JS Node A │       │ Witness  │       │ JS Node B │     │
│  │ (Primary) │       │ (轻量级)  │       │(Secondary)│     │
│  │           │       │          │       │           │     │
│  │ 完整功能   │       │ 仅投票    │       │ 完整功能   │     │
│  │ 运行 slots │       │ 不运行    │       │ 运行 slots │     │
│  │           │       │ slots    │       │           │     │
│  └─────┬─────┘       └────┬─────┘       └─────┬─────┘     │
│        │                  │                    │          │
│        └──────────────────┼────────────────────┘          │
│                           │                               │
│  冲突时: A + Witness = 2/3 → 多数派达成                    │
│  Witness 要求: 独立主机，稳定网络，极低资源需求              │
│                                                          │
│  优点:                                                    │
│    + 标准 quorum，与 ≥3 节点方案一致                       │
│    + Witness 故障不影响正常运行（退化为手动）               │
│    + 自动接管能力完整                                      │
│                                                          │
│  缺点:                                                    │
│    - 需要额外一台主机（成本）                              │
│    - Witness 与两节点的网络连通性需保证                     │
│    - Witness 自身也需要健康监控                            │
└──────────────────────────────────────────────────────────┘
```

#### 方案 B：非对称优先级

```
┌──────────────────────────────────────────────────────────┐
│                  非对称优先级方案                           │
│                                                          │
│  Node A = Primary (优先级 1)                              │
│  Node B = Secondary (优先级 2)                            │
│                                                          │
│  冲突规则:                                                │
│    - A 和 B 都声称 → A 胜（Primary 优先）                 │
│    - A 故障，B 声称 → B 胜（唯一存活者）                  │
│    - A 和 B 互相不可达 → 各自独立运行                     │
│      * A 继续运行自己的 slots                             │
│      * B 继续运行自己的 slots                             │
│      * A 的 slots 不被接管（无法确认 A 是否存活）          │
│                                                          │
│  优点:                                                    │
│    + 无需额外节点                                         │
│    + 实现简单                                             │
│    + 无外部依赖                                           │
│                                                          │
│  缺点:                                                    │
│    - 网络分区时（A,B 互相不可达）→ 无法接管               │
│    - 50% 场景下需要手动干预                               │
│    - Primary 故障时 Secondary 完全接管，但 Primary 恢复   │
│      后可能产生冲突                                       │
└──────────────────────────────────────────────────────────┘
```

#### 方案 C：Coordinator 辅助

```
┌──────────────────────────────────────────────────────────┐
│                  Coordinator 辅助方案                      │
│                                                          │
│  冲突时:                                                  │
│    1. A 和 B 都将冲突提交给 Coordinator                   │
│    2. Coordinator 基于健康数据做裁决                       │
│    3. 裁决结果返回给 A 和 B                               │
│                                                          │
│  Coordinator 不可达时:                                     │
│    - 退化为方案 B（非对称优先级）                          │
│    - 或退化为手动干预                                      │
│                                                          │
│  优点:                                                    │
│    + Coordinator 有更全面的健康视图                        │
│    + 裁决质量高于简单优先级                               │
│    + 无需额外 Witness 节点                                │
│                                                          │
│  缺点:                                                    │
│    - 依赖 Coordinator 可达性                              │
│    - L2 降级时（Coordinator primary 宕机）裁决能力下降    │
│    - L3 降级时完全丧失自动裁决                            │
│    - 增加 Coordinator 负载                                │
└──────────────────────────────────────────────────────────┘
```

#### 方案 D：接受 50% 自动恢复

```
不做自动冲突解决:
  - 2 节点区故障时，需要手动干预
  - 适用于对可用性要求不高的场景

优点: 最简单，无额外复杂度
缺点: 50% 故障场景需人工介入，恢复时间长
```

**决策:** 推荐方案 A（Witness）作为 Critical 区的默认方案，方案 B（非对称优先级）作为 Normal 区的默认方案，方案 C（Coordinator 辅助）作为可选增强。方案 D 仅用于 Small 区（单节点不存在 2 节点冲突）。

### 6.3 偶数节点平局打破

```
问题: N=2k 节点时，投票可能出现 k:k 平局

方案 A: Coordinator 拥有决定性一票
  - 平局时 Coordinator 投票打破平衡
  - 优点: 简单直接
  - 缺点: 依赖 Coordinator

方案 B: Epoch 优先
  - 平局时，epoch 较高的方案胜出
  - 优点: 不依赖外部
  - 缺点: 可能总是同一方赢

方案 C: 超时留空
  - 平局持续超过阈值 → slot 留空
  - 优点: 最安全（宁缺勿滥）
  - 缺点: 可能长期留空

决策: 组合使用:
  1. 首先尝试 Coordinator 打破平局（方案 A）
  2. Coordinator 不可达 → 使用 Epoch 优先（方案 B）
  3. 若 Epoch 也相同 → 超时留空（方案 C）
```

### 6.4 分区合并策略

```
问题: 网络分区恢复后，如何合并两个分区各自产生的状态变更？

策略: 高版本覆盖低版本

  分区期间:
    多数派分区: 可能进行了 slot 重分配、接管等操作
    少数派分区: 冻结，保持最后已知状态

  合并流程:
    1. 少数派节点恢复连接
    2. 多数派向其推送最新 Manifest 和所有权映射
    3. 少数派节点放弃分区期间的所有状态变更
    4. 若少数派节点在分区前拥有 slots:
       a. 若 slots 已被重新分配 → 节点需重新注册
       b. 若 slots 未被重新分配 → 恢复原有 slots
    5. 触发一轮重平衡，优化合并后的 slot 分布

  关键保证:
    - 多数派的状态始终优先
    - 少数派不会引入"回退"变更
    - 合并后的状态与"从未分区"等价（在多数派视角）
```

---

## 七、冲突与开放问题

### 7.1 已识别冲突

| 冲突编号 | 描述 | 影响范围 | 当前状态 |
|---------|------|---------|---------|
| CA-01 | 2 节点区各方案的自动恢复率不同 | Normal 区可用性 | 需量化各方案的恢复率 |
| CA-02 | L3 + 2 节点区 = 极有限的冲突解决能力 | 极端降级场景 | 需明确降级行为文档 |
| CA-03 | Witness 节点本身也可能故障 | Witness 方案 | 需设计 Witness 故障回退策略 |
| CA-04 | Coordinator 辅助方案在 L2/L3 降级时退化 | Coordinator 依赖 | 需多级回退策略 |

### 7.2 开放问题

| 问题编号 | 问题 | 候选方案 | 建议 |
|---------|------|---------|------|
| OQ-01 | Witness 节点是否可以是其他区的节点？ | (a) 必须独立主机 (b) 可以是其他区的轻量进程 | 建议 (b)，降低部署成本 |
| OQ-02 | 冲突裁决日志保留多久？ | (a) 7 天 (b) 30 天 (c) 永久 | 建议 (b)，30 天足够审计 |
| OQ-03 | 多次连续冲突（同一 slot 反复冲突）如何处理？ | (a) 每次独立裁决 (b) 升级处理 (c) 自动 fencing 冲突节点 | 建议 (b)+(c)，3 次以上自动 quarantine |
| OQ-04 | 分区合并时，少数派正在执行的采集数据如何处理？ | (a) 丢弃 (b) 保留并标记 (c) 合并到主流 | 建议 (b)，标记为"分区期间数据" |
| OQ-05 | 是否需要支持跨区冲突仲裁？ | (a) 不支持 (b) 控制面统一仲裁 | 建议 (a)，区内部闭环 |

### 7.3 风险项

| 风险编号 | 风险描述 | 概率 | 影响 | 缓解措施 |
|---------|---------|------|------|---------|
| R-01 | 脑裂导致数据重复 | 低 | 高 | Epoch fencing + 宁缺勿滥原则 |
| R-02 | 2 节点区 Witness 与主节点同时故障 | 极低 | 高 | 退化为手动，告警通知运维 |
| R-03 | 分区合并时状态不一致 | 低 | 中 | 版本强制覆盖 + 全量校验 |
| R-04 | 裁决逻辑 bug 导致错误 fencing | 低 | 高 | 裁决审计日志 + 控制面复核 |

### 7.4 待决设计点

1. **冲突裁决的幂等性**: 同一冲突被多次提交裁决时，是否保证结果一致？当前设计保证（确定性规则），但需实现层面验证。
2. **Fencing 的自动解除**: 被 fencing 的 slot 是否可以在一定时间后自动解除 fencing？当前设计需要节点重新注册，但可能需要自动恢复路径。
3. **冲突告警阈值**: 连续多少次冲突后应触发告警？建议 3 次/小时，但需根据实际运行数据调整。
4. **偶数节点区的扩展路径**: 当区从偶数节点扩展到奇数节点时，平局打破机制如何平滑过渡？建议自动检测节点数变化并切换策略。

### 7.5 各方案自动恢复率对比

```
┌──────────────────────────────────────────────────────────────────────┐
│              2 节点区各方案故障场景自动恢复率对比                        │
├──────────────────┬───────────┬───────────┬───────────┬──────────────┤
│ 故障场景          │ Witness   │ Asymmetric│ Coord.Asst│ Manual       │
├──────────────────┼───────────┼───────────┼───────────┼──────────────┤
│ 1 节点故障        │ 100%      │ 100%*     │ 100%**    │ 0%           │
│ (Secondary)      │           │(Pri胜)    │(Coord裁决) │              │
├──────────────────┼───────────┼───────────┼───────────┼──────────────┤
│ 1 节点故障        │ 100%      │ 50%***    │ 50%****   │ 0%           │
│ (Primary)        │           │(Sec无法确 │(Coord裁决  │              │
│                  │           │ 认Pri故障) │ 或退化为  │              │
│                  │           │           │ Asymmetric)│              │
├──────────────────┼───────────┼───────────┼───────────┼──────────────┤
│ 网络分区          │ 100%      │ 0%        │ 50%       │ 0%           │
│ (A,B互不可达)    │(Witness判)│(无法确认) │(Coord裁决) │              │
├──────────────────┼───────────┼───────────┼───────────┼──────────────┤
│ Witness/Coord故障│ N/A       │ N/A       │ 退化为    │ N/A          │
│ + 1节点故障      │           │           │ Asymmetric│              │
├──────────────────┼───────────┼───────────┼───────────┼──────────────┤
│ 综合自动恢复率    │ ~100%     │ ~75%      │ ~75%      │ 0%           │
└──────────────────┴───────────┴───────────┴───────────┴──────────────┘

*  Asymmetric: Primary 总是赢，所以 Primary 故障时 Secondary 可接管
   但 Secondary 故障时 Primary 无法确认是 Sec 故障还是网络分区
** Coord.Asst: Coordinator 可达时可裁决，不可达时退化为 Asymmetric
*** 仅当故障方是 Primary 时可自动恢复
**** Coordinator 可达时可自动恢复
```
