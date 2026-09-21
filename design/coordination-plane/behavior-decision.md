# 行为决策

## 一、概述

行为决策模块负责区内动态行为的管理，包括重平衡（Rebalancing）、驱逐（Eviction）、接管（Takeover）、隔离（Quarantine）和扩缩容建议。本模块是协调层的"行动执行者"——它消费组件健康模块的状态事件和冲突仲裁模块的裁决结果，转化为具体的调度动作。

核心设计哲学是"懒"（lazy）：迁移有成本，能不迁就不迁。通过三层抑制机制（滞后 + 冷却 + 渐进）避免不必要的震荡，确保系统稳定性优先于最优性。

### 1.1 核心定位

```
┌──────────────────────────────────────────────────────────────────────┐
│                        协调层 (Coordination Plane)                     │
│                                                                       │
│  ┌──────────────┐    ┌──────────────────────────────────────────┐    │
│  │ 组件健康       │───▶│           行为决策 (本模块)               │    │
│  │ (状态事件)     │    │                                          │    │
│  └──────────────┘    │  ┌──────────┐ ┌──────────┐ ┌──────────┐  │    │
│                      │  │ 重平衡    │ │ 驱逐      │ │ 接管      │  │    │
│  ┌──────────────┐    │  │Rebalance │ │ Eviction │ │ Takeover │  │    │
│  │ 冲突仲裁       │───▶│  └──────────┘ └──────────┘ └──────────┘  │    │
│  │ (裁决结果)     │    │                                          │    │
│  └──────────────┘    │  ┌──────────┐ ┌──────────┐               │    │
│                      │  │ 隔离      │ │ 扩缩容建议│               │    │
│  ┌──────────────┐    │  │Quarantine│ │ Scaling  │               │    │
│  │ 采集任务调度   │◀───│  └──────────┘ └──────────┘               │    │
│  │ (执行动作)     │    │                                          │    │
│  └──────────────┘    │  ┌──────────────────────────────────────┐  │    │
│                      │  │ 三层抑制: 滞后 + 冷却 + 渐进           │  │    │
│  ┌──────────────┐    │  └──────────────────────────────────────┘  │    │
│  │ 行为决策       │───▶│  → 控制面 (扩缩容建议)                    │    │
│  │ (输出建议)     │    └──────────────────────────────────────────┘    │
│  └──────────────┘                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.2 设计目标

| 目标编号 | 描述 | 优先级 |
|---------|------|--------|
| G-01 | 迁移有成本，能不迁就不迁（lazy 原则） | P0 |
| G-02 | 接管时宁缺勿滥，不产生双主 | P0 |
| G-03 | 优雅下线时零数据丢失（先建后拆） | P0 |
| G-04 | 重平衡不引起采集震荡（三层抑制） | P1 |
| G-05 | 强制驱逐在 ≤30s 内完成 slot 重新分配 | P1 |
| G-06 | 扩缩容建议基于持续负载，非瞬态峰值 | P1 |

### 1.3 行为类型总览

```
┌──────────────────────────────────────────────────────────────────────┐
│                        行为决策类型                                    │
├──────────────┬───────────────┬───────────────┬───────────────────────┤
│ 行为类型      │ 触发条件       │ 执行方式       │ 影响范围               │
├──────────────┼───────────────┼───────────────┼───────────────────────┤
│ 重平衡        │ 节点增减       │ 渐进迁移       │ 部分 slot 变更 owner   │
│ (Rebalance)  │ 负载不均       │ 三层抑制       │                       │
├──────────────┼───────────────┼───────────────┼───────────────────────┤
│ 驱逐          │ 节点下线       │ 优雅: 先 drain │ slot 从旧节点迁出      │
│ (Eviction)   │ 节点故障       │ 强制: 立即重分配│                       │
├──────────────┼───────────────┼───────────────┼───────────────────────┤
│ 接管          │ 节点故障       │ 多数派确认后   │ 故障节点的 slots 被    │
│ (Takeover)   │               │ 接管          │ 存活节点吸收           │
├──────────────┼───────────────┼───────────────┼───────────────────────┤
│ 隔离          │ 行为异常       │ 立即隔离       │ 节点 slots 重分配      │
│ (Quarantine) │ 安全顾虑       │ 需重新注册     │ 节点必须从头注册       │
├──────────────┼───────────────┼───────────────┼───────────────────────┤
│ 扩缩容建议    │ 持续高负载     │ 向控制面建议   │ 可能增加/减少节点      │
│ (Scaling)    │ 容量接近上限   │ 协调面不执行   │                       │
└──────────────┴───────────────┴───────────────┴───────────────────────┘
```

---

## 二、职责边界

### 2.1 本模块负责

| 职责 | 说明 |
|------|------|
| 重平衡决策 | 判断何时需要重平衡，生成迁移计划 |
| 三层抑制 | 执行滞后、冷却、渐进机制，防止迁移震荡 |
| 驱逐策略 | 决定驱逐顺序和方式（优雅/强制） |
| 接管协调 | 协调多数派确认，执行 slot 接管 |
| 隔离决策 | 判断是否需要隔离节点，执行隔离流程 |
| 扩缩容建议 | 基于负载趋势向控制面提出扩缩容建议 |
| 迁移执行监控 | 监控 slot 迁移的执行进度，处理迁移失败 |
| 行为审计 | 记录所有行为决策的完整日志 |

### 2.2 本模块不负责

| 不负责事项 | 归属 | 说明 |
|-----------|------|------|
| 节点健康检测 | 组件健康模块 | 本模块消费健康事件 |
| 冲突裁决 | 冲突仲裁模块 | 本模块执行裁决后的动作 |
| 实际 slot 迁移 | 采集任务调度模块 | 本模块生成计划，调度模块执行 |
| 节点增减 | 控制面 / 运维 | 本模块只提建议，不执行 |
| 数据迁移 | 采集层 Storage | slot 元数据迁移由调度模块处理 |

### 2.3 决策流程概览

```
触发事件 → 决策引擎 → 抑制检查 → 执行计划 → 监控确认
    │           │          │          │          │
    │           │          │          │          │
    ▼           ▼          ▼          ▼          ▼
 健康事件    是否需要     是否满足    生成迁移   迁移是否
 裁决结果    行动?       行动条件?   计划       成功?
 手动请求                                     
```

---

## 三、功能清单

### 3.1 重平衡

| 功能项 | 描述 |
|--------|------|
| F-1.1 触发检测 | 检测重平衡触发条件（节点增减、负载不均、slot 数变更） |
| F-1.2 滞后检查 | 阈值必须持续超过 N 个周期才触发（防瞬态误触发） |
| F-1.3 冷却检查 | 距上次重平衡必须超过最小间隔（防频繁迁移） |
| F-1.4 渐进执行 | 每个重平衡周期最多迁移 N 个 slot（防大批量迁移） |
| F-1.5 迁移计划生成 | 计算最优迁移方案（最小迁移量达成目标分布） |
| F-1.6 迁移执行 | 协调源节点和目标节点完成 slot 转移 |
| F-1.7 迁移回滚 | 迁移失败时回滚到迁移前状态 |

### 3.2 驱逐

| 功能项 | 描述 |
|--------|------|
| F-2.1 优雅驱逐 | 节点进入 DRAINING 状态，slot 逐步迁移后 OFFLINE |
| F-2.2 强制驱逐 | 节点 EXPIRED/FENCED，slot 立即重新分配 |
| F-2.3 驱逐排序 | 优先迁移低优先级 slot，高优先级 slot 最后迁移 |
| F-2.4 驱逐进度监控 | 监控优雅驱逐的进度，超时则升级为强制驱逐 |
| F-2.5 驱逐完成确认 | 确认所有 slot 已迁移后，节点标记为 OFFLINE |

### 3.3 接管

| 功能项 | 描述 |
|--------|------|
| F-3.1 at-least-once 接管 | 允许短暂重叠（≤1 scrape interval），确保不丢数据 |
| F-3.2 多数派接管 | 仅接管被多数派确认死亡的节点的 slots |
| F-3.3 无双主保证 | 无法达成多数派共识时，slot 留空 |
| F-3.4 接管优先级 | 优先接管高优先级 slot（critical targets 优先） |
| F-3.5 接管状态同步 | 接管完成后，更新 Manifest 和 epoch_token |

### 3.4 隔离

| 功能项 | 描述 |
|--------|------|
| F-4.1 自动隔离 | 检测到反复 flapping 时自动触发 |
| F-4.2 手动隔离 | 管理员手动触发隔离 |
| F-4.3 隔离执行 | 立即重分配隔离节点的 slots |
| F-4.4 隔离解除 | 必须通过管理操作解除，节点从 REGISTER 重新开始 |

### 3.5 扩缩容建议

| 功能项 | 描述 |
|--------|------|
| F-5.1 扩容建议 | 持续高负载时建议增加节点 |
| F-5.2 缩容建议 | 持续低负载时建议减少节点 |
| F-5.3 建议上报 | 将建议上报至控制面（协调面不执行节点增减） |
| F-5.4 建议抑制 | 避免反复发送相同建议（冷却期） |

---

## 四、核心数据模型

### 4.1 RebalancePlan — 重平衡计划

```protobuf
// RebalancePlan 描述一次重平衡的完整计划
message RebalancePlan {
  // 计划 ID
  string plan_id = 1;
  
  // 区 ID
  string zone_id = 2;
  
  // 触发原因
  RebalanceTrigger trigger = 3;
  
  // 创建时间
  google.protobuf.Timestamp created_at = 4;
  
  // 迁移列表
  repeated SlotMigration migrations = 5;
  
  // 计划状态
  PlanStatus status = 6;
  
  // 三层抑制状态
  InhibitionState inhibition = 7;
  
  // 执行进度
  ExecutionProgress progress = 8;
  
  // 预计完成时间
  google.protobuf.Timestamp estimated_completion = 9;
}

enum RebalanceTrigger {
  REBALANCE_TRIGGER_UNSPECIFIED = 0;
  REBALANCE_TRIGGER_NODE_ADDED = 1;       // 新节点加入
  REBALANCE_TRIGGER_NODE_REMOVED = 2;     // 节点移除
  REBALANCE_TRIGGER_LOAD_IMBALANCE = 3;   // 负载不均
  REBALANCE_TRIGGER_SLOT_COUNT_CHANGED = 4; // slot 总数变更
  REBALANCE_TRIGGER_PARTITION_MERGED = 5; // 分区合并
  REBALANCE_TRIGGER_MANUAL = 6;           // 手动触发
}

enum PlanStatus {
  PLAN_STATUS_UNSPECIFIED = 0;
  PLAN_STATUS_PENDING = 1;       // 等待抑制条件满足
  PLAN_STATUS_INHIBITED = 2;     // 被抑制中
  PLAN_STATUS_EXECUTING = 3;     // 执行中
  PLAN_STATUS_COMPLETED = 4;     // 已完成
  PLAN_STATUS_CANCELLED = 5;     // 已取消
  PLAN_STATUS_FAILED = 6;        // 执行失败
}
```

### 4.2 SlotMigration — 槽位迁移

```protobuf
message SlotMigration {
  // 迁移 ID
  string migration_id = 1;
  
  // 被迁移的 slot
  uint32 slot_id = 2;
  
  // 源节点
  string from_node = 3;
  
  // 目标节点
  string to_node = 4;
  
  // 迁移状态
  MigrationStatus status = 5;
  
  // 迁移后的 epoch_token
  string new_epoch_token = 6;
  
  // 迁移开始时间
  google.protobuf.Timestamp started_at = 7;
  
  // 迁移完成时间
  google.protobuf.Timestamp completed_at = 8;
  
  // 迁移优先级
  MigrationPriority priority = 9;
  
  // 错误信息（失败时）
  string error_message = 10;
  
  // 迁移类型
  MigrationType type = 11;
}

enum MigrationStatus {
  MIGRATION_STATUS_UNSPECIFIED = 0;
  MIGRATION_STATUS_PENDING = 1;      // 等待执行
  MIGRATION_STATUS_TRANSFERRING = 2; // 传输中
  MIGRATION_STATUS_VERIFYING = 3;    // 验证中
  MIGRATION_STATUS_COMPLETED = 4;    // 已完成
  MIGRATION_STATUS_FAILED = 5;       // 失败
  MIGRATION_STATUS_ROLLED_BACK = 6;  // 已回滚
}

enum MigrationPriority {
  MIGRATION_PRIORITY_UNSPECIFIED = 0;
  MIGRATION_PRIORITY_LOW = 1;       // 低优先级（先迁移）
  MIGRATION_PRIORITY_NORMAL = 2;    // 普通优先级
  MIGRATION_PRIORITY_HIGH = 3;      // 高优先级（后迁移）
  MIGRATION_PRIORITY_CRITICAL = 4;  // 关键优先级（最后迁移）
}

enum MigrationType {
  MIGRATION_TYPE_UNSPECIFIED = 0;
  MIGRATION_TYPE_REBALANCE = 1;    // 重平衡迁移
  MIGRATION_TYPE_TAKEOVER = 2;     // 接管迁移
  MIGRATION_TYPE_DRAIN = 3;        // 排空迁移（优雅驱逐）
  MIGRATION_TYPE_EVICT = 4;        // 驱逐迁移（强制驱逐）
}
```

### 4.3 InhibitionState — 三层抑制状态

```protobuf
// 三层抑制机制的状态
message InhibitionState {
  // === 第一层: 滞后 (Hysteresis) ===
  // 阈值超过持续周期数
  uint32 threshold_exceeded_cycles = 1;
  // 触发所需的最小持续周期数
  uint32 hysteresis_threshold = 2;  // 默认: 3 个周期
  
  // === 第二层: 冷却 (Cooldown) ===
  // 上次重平衡完成时间
  google.protobuf.Timestamp last_rebalance_completed = 3;
  // 冷却期（两次重平衡之间的最小间隔）
  google.protobuf.Duration cooldown_period = 4;  // 默认: 5 分钟
  
  // === 第三层: 渐进 (Gradual) ===
  // 当前周期已迁移的 slot 数
  uint32 slots_migrated_this_cycle = 5;
  // 每个周期最大迁移 slot 数
  uint32 max_migrations_per_cycle = 6;  // 默认: 10
  
  // 综合判定: 是否允许执行
  bool execution_allowed = 7;
  // 不允许的原因
  string inhibition_reason = 8;
}
```

### 4.4 TakeoverPlan — 接管计划

```protobuf
message TakeoverPlan {
  string plan_id = 1;
  string zone_id = 2;
  
  // 被接管节点
  string failed_node_id = 3;
  
  // 故障确认方式
  FailureConfirmation confirmation = 4;
  
  // 待接管的 slots
  repeated TakeoverSlot slots = 5;
  
  // 接管策略
  TakeoverStrategy strategy = 6;
  
  // 计划状态
  PlanStatus status = 7;
  
  google.protobuf.Timestamp created_at = 8;
}

enum FailureConfirmation {
  FAILURE_CONFIRMATION_UNSPECIFIED = 0;
  FAILURE_CONFIRMATION_MAJORITY = 1;     // 多数派确认
  FAILURE_CONFIRMATION_COORDINATOR = 2;  // Coordinator 确认
  FAILURE_CONFIRMATION_TIMEOUT = 3;      // 超时确认
}

message TakeoverSlot {
  uint32 slot_id = 1;
  string new_owner = 2;
  string new_epoch_token = 3;
  TakeoverSlotStatus status = 4;
  
  // 是否允许短暂重叠采集
  bool allow_overlap = 5;
  
  // 重叠窗口（≤1 scrape interval）
  google.protobuf.Duration overlap_window = 6;
}

enum TakeoverSlotStatus {
  TAKEOVER_SLOT_UNSPECIFIED = 0;
  TAKEOVER_SLOT_PENDING = 1;
  TAKEOVER_SLOT_ASSIGNED = 2;
  TAKEOVER_SLOT_ACTIVE = 3;
  TAKEOVER_SLOT_FAILED = 4;
  TAKEOVER_SLOT_LEFT_HOLE = 5;  // 无法接管，留空
}

enum TakeoverStrategy {
  TAKEOVER_STRATEGY_UNSPECIFIED = 0;
  TAKEOVER_STRATEGY_AT_LEAST_ONCE = 1;  // 允许短暂重叠
  TAKEOVER_STRATEGY_EXACTLY_ONCE = 2;   // 严格不重叠（需等待确认）
  TAKEOVER_STRATEGY_MAJORITY_BASED = 3; // 多数派确认后接管
}
```

### 4.5 EvictionPlan — 驱逐计划

```protobuf
message EvictionPlan {
  string plan_id = 1;
  string zone_id = 2;
  
  // 被驱逐节点
  string target_node_id = 3;
  
  // 驱逐类型
  EvictionType type = 4;
  
  // 驱逐的 slot 列表（按优先级排序）
  repeated SlotMigration eviction_migrations = 5;
  
  // 优雅驱逐超时
  google.protobuf.Duration graceful_timeout = 6;  // 默认: 5 分钟
  
  // 计划状态
  PlanStatus status = 7;
  
  google.protobuf.Timestamp created_at = 8;
}

enum EvictionType {
  EVICTION_TYPE_UNSPECIFIED = 0;
  EVICTION_TYPE_GRACEFUL = 1;  // 优雅: drain → migrate → offline
  EVICTION_TYPE_FORCED = 2;    // 强制: 立即重新分配
}
```

### 4.6 ScalingRecommendation — 扩缩容建议

```protobuf
message ScalingRecommendation {
  string recommendation_id = 1;
  string zone_id = 2;
  
  // 建议类型
  ScalingDirection direction = 3;
  
  // 建议的节点数变更
  int32 node_count_delta = 4;  // 正数=扩容, 负数=缩容
  
  // 建议原因
  repeated string reasons = 5;
  
  // 支持数据
  ScalingEvidence evidence = 6;
  
  // 建议时间
  google.protobuf.Timestamp created_at = 7;
  
  // 建议状态
  RecommendationStatus status = 8;
}

enum ScalingDirection {
  SCALING_DIRECTION_UNSPECIFIED = 0;
  SCALING_DIRECTION_SCALE_UP = 1;
  SCALING_DIRECTION_SCALE_DOWN = 2;
  SCALING_DIRECTION_NO_CHANGE = 3;
}

message ScalingEvidence {
  // 平均 CPU 使用率（过去 15 分钟）
  float avg_cpu_usage = 1;
  // 峰值 CPU 使用率
  float peak_cpu_usage = 2;
  // 平均每节点 slot 数
  float avg_slots_per_node = 3;
  // 平均每节点 target 数
  float avg_targets_per_node = 4;
  // slot 容量利用率
  float slot_utilization = 5;
  // 采样周期数
  uint32 sample_cycles = 6;
}

enum RecommendationStatus {
  RECOMMENDATION_STATUS_UNSPECIFIED = 0;
  RECOMMENDATION_STATUS_PROPOSED = 1;    // 已提出
  RECOMMENDATION_STATUS_SUBMITTED = 2;   // 已提交至控制面
  RECOMMENDATION_STATUS_ACCEPTED = 3;    // 控制面已接受
  RECOMMENDATION_STATUS_REJECTED = 4;    // 控制面已拒绝
  RECOMMENDATION_STATUS_SUPPRESSED = 5;  // 被抑制（冷却期）
}
```

### 4.7 数据模型关系图

```
行为决策数据流:

触发事件 (健康/裁决/手动)
  │
  ▼
┌─────────────────────────────────────────────────────────────┐
│  决策引擎                                                    │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │RebalancePlan│  │TakeoverPlan │  │EvictionPlan │        │
│  │             │  │             │  │             │        │
│  │ migrations  │  │ slots[]     │  │ migrations  │        │
│  │ inhibition  │  │ strategy    │  │ type        │        │
│  │ progress    │  │ confirmation│  │ timeout     │        │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘        │
│         │                │                │                │
│         └────────────────┼────────────────┘                │
│                          ▼                                  │
│              ┌───────────────────────┐                      │
│              │ SlotMigration (执行)   │                      │
│              │ from → to, status     │                      │
│              └───────────────────────┘                      │
│                                                             │
│  ┌────────────────────────┐                                 │
│  │ScalingRecommendation   │ ← 独立输出至控制面              │
│  └────────────────────────┘                                 │
└─────────────────────────────────────────────────────────────┘
```

---

## 五、接口与交互

### 5.1 内部接口

#### 5.1.1 重平衡触发接口

```
接口: TriggerRebalance
方向: 组件健康 / 手动操作 → 行为决策
触发: 节点状态变更 / 负载不均检测 / 手动请求

请求 (RebalanceRequest):
  trigger: RebalanceTrigger
  details: {
    // 节点增减触发
    added_node_id: string
    removed_node_id: string
    
    // 负载不均触发
    current_distribution: {string: uint32}  // node_id → slot_count
    ideal_distribution: {string: uint32}
    imbalance_ratio: float  // 偏差比例
  }

处理流程:
  1. 接收触发请求
  2. 三层抑制检查:
     a. 滞后检查: 阈值是否持续超过 N 个周期?
        → 否: 记录但不触发, 等待下一周期
        → 是: 进入下一步
     b. 冷却检查: 距上次重平衡是否超过冷却期?
        → 否: 进入 INHIBITED 状态, 等待冷却
        → 是: 进入下一步
     c. 渐进检查: 当前周期已迁移数 < 上限?
        → 否: 分批执行, 当前批次最多 N 个
        → 是: 继续
  3. 生成迁移计划
  4. 提交至采集任务调度执行
  5. 监控执行进度
```

#### 5.1.2 迁移执行接口

```
接口: ExecuteMigration
方向: 行为决策 → 采集任务调度
触发: 重平衡/驱逐/接管计划中的迁移步骤

请求 (MigrationExecution):
  migration_id: string
  slot_id: uint32
  from_node: string
  to_node: string
  new_epoch_token: string
  migration_type: MigrationType
  
  // 重叠控制
  allow_overlap: bool
  overlap_window: Duration

执行流程:
  1. 通知目标节点准备接收 slot
  2. 目标节点确认准备就绪
  3. 更新 epoch_token（新 owner 的 token）
  4. 通知源节点释放 slot
  5. 源节点确认释放
  6. 目标节点正式接管
  7. 更新 Manifest

  重叠模式 (allow_overlap = true):
    1~4 同上
    5'. 源节点短暂继续采集（≤1 scrape interval）
    6'. 目标节点同时开始采集
    7'. 源节点停止，目标节点独占
    → 保证 at-least-once 语义
```

#### 5.1.3 接管协调接口

```
接口: CoordinateTakeover
方向: 行为决策内部
触发: 节点被标记为 EXPIRED

请求 (TakeoverCoordination):
  failed_node_id: string
  failed_slots: [uint32]
  
  // 存活节点列表
  alive_nodes: [string]
  
  // 多数派阈值
  quorum_size: uint32

流程:
  1. 确认故障: 多数派存活节点确认 failed_node 不可达
     → 无法达成多数派 → slots 留空 (LEAVE_HOLE)
  2. 计算分配方案:
     a. 将 failed_slots 均分至 alive_nodes
     b. 考虑各节点当前负载
     c. 生成 TakeoverPlan
  3. 执行迁移:
     a. 为每个 slot 生成新 epoch_token
     b. 逐个执行迁移（受渐进限制）
     c. 允许短暂重叠（at-least-once）
  4. 完成确认:
     a. 所有 slot 迁移完成
     b. 更新 Manifest
     c. 通知组件健康模块更新节点状态
```

#### 5.1.4 驱逐执行接口

```
接口: ExecuteEviction
方向: 行为决策 → 采集任务调度 / 组件健康
触发: 节点需要下线

优雅驱逐流程:
  1. 通知目标节点进入 DRAINING 状态
  2. 目标节点停止接受新 slot
  3. 按优先级排序现有 slots:
     LOW priority → 先迁移
     NORMAL → 次之
     HIGH → 再次
     CRITICAL → 最后
  4. 逐个迁移 slots 至其他节点
  5. 监控迁移进度
  6. 所有 slots 迁移完成 → 节点标记为 OFFLINE
  7. 超时处理: 优雅超时 → 升级为强制驱逐

强制驱逐流程:
  1. 节点已 EXPIRED 或 FENCED
  2. 立即将所有 slots 标记为 unassigned
  3. 触发接管流程
  4. 不等待节点确认
```

#### 5.1.5 扩缩容建议接口

```
接口: SubmitScalingRecommendation
方向: 行为决策 → 控制面 (通过 Zone Agent)
触发: 负载趋势分析结果

请求 (ScalingRecommendation):
  (见 4.6 数据模型)

触发条件:
  扩容:
    - 平均 CPU > 80% 持续 15 分钟
    - 平均 slot 利用率 > 85% 持续 15 分钟
    - 节点数已达 slot 容量上限
  
  缩容:
    - 平均 CPU < 30% 持续 30 分钟
    - 平均 slot 利用率 < 20% 持续 30 分钟
    - 节点数 > 最低需求 + 1

抑制规则:
  - 同类建议冷却期: 30 分钟
  - 被拒绝后冷却期: 1 小时
  - 每次最多建议 ±2 个节点
```

### 5.2 交互时序图

#### 5.2.1 重平衡完整流程

```
组件健康       行为决策          采集任务调度      JS Node A       JS Node B
  │               │                  │               │               │
  │  [Node C 加入] │                  │               │               │
  │               │                  │               │               │
  │──NodeAdded───▶│                  │               │               │
  │               │                  │               │               │
  │               │  [滞后检查]       │               │               │
  │               │  阈值超过? ✓      │               │               │
  │               │  持续 3 周期? ✓   │               │               │
  │               │                  │               │               │
  │               │  [冷却检查]       │               │               │
  │               │  距上次 > 5min? ✓ │               │               │
  │               │                  │               │               │
  │               │  [生成迁移计划]   │               │               │
  │               │  A: 33 → 22      │               │               │
  │               │  B: 33 → 22      │               │               │
  │               │  C: 0  → 22      │               │               │
  │               │  迁移 22 slots    │               │               │
  │               │                  │               │               │
  │               │  [渐进检查]       │               │               │
  │               │  本批最多 10 slots│               │               │
  │               │                  │               │               │
  │               │──Migrate(10)───▶│               │               │
  │               │                  │──迁移 slot 0──▶│               │
  │               │                  │               │──释放 slot 0──│
  │               │                  │               │  (短暂重叠)    │
  │               │                  │               │◀─确认────────│
  │               │                  │──迁移 slot 1──▶│               │
  │               │                  │  ...          │               │
  │               │                  │──迁移 slot 9──▶│               │
  │               │                  │               │               │
  │               │◀─BatchDone──────│               │               │
  │               │  (10/22 完成)    │               │               │
  │               │                  │               │               │
  │               │  [下一周期继续]   │               │               │
  │               │──Migrate(10)───▶│               │               │
  │               │  ...            │               │               │
  │               │                  │               │               │
  │               │──Migrate(2)────▶│               │               │
  │               │◀─AllDone────────│               │               │
  │               │  (22/22 完成)    │               │               │
  │               │                  │               │               │
  │               │  [更新 Manifest] │               │               │
  │               │  A:22 B:22 C:22  │               │               │
```

#### 5.2.2 优雅驱逐流程

```
管理员        行为决策          采集任务调度      JS Node A (待下线)   JS Node B
  │              │                  │               │               │
  │──Drain(A)──▶│                  │               │               │
  │              │                  │               │               │
  │              │──SetDraining────────────────────▶│               │
  │              │                  │               │  [停止接受新 slot]
  │              │                  │               │               │
  │              │  [按优先级排序 A 的 slots]        │               │
  │              │  LOW:    slot 5, 8, 12           │               │
  │              │  NORMAL: slot 1, 3, 7            │               │
  │              │  HIGH:   slot 0, 4               │               │
  │              │  CRIT:   slot 2                  │               │
  │              │                  │               │               │
  │              │──Migrate(slot 5)▶│──迁移─────────▶│               │
  │              │──Migrate(slot 8)▶│               │──释放────────│
  │              │──Migrate(slot 12)▶│              │               │
  │              │  [LOW 完成]       │               │               │
  │              │                  │               │               │
  │              │──Migrate(slot 1)▶│──迁移─────────▶│               │
  │              │  ...            │               │               │
  │              │  [NORMAL 完成]   │               │               │
  │              │                  │               │               │
  │              │──Migrate(slot 0)▶│               │               │
  │              │──Migrate(slot 4)▶│               │               │
  │              │  [HIGH 完成]     │               │               │
  │              │                  │               │               │
  │              │──Migrate(slot 2)▶│               │               │
  │              │  [CRITICAL 完成] │               │               │
  │              │                  │               │               │
  │              │  [所有 slots 迁移完毕]            │               │
  │              │──SetOffline─────────────────────▶│               │
  │              │                  │               │  [节点下线]    │
  │              │                  │               │               │
  │◀─Done────────│                  │               │               │
```

#### 5.2.3 接管流程（多数派确认）

```
组件健康       行为决策          JS Node A       JS Node B       JS Node C
  │               │                │               │               │
  │  [Node D EXPIRED]              │               │               │
  │               │                │               │               │
  │──NodeExpired─▶│                │               │               │
  │               │                │               │               │
  │               │  [多数派确认]   │               │               │
  │               │──Confirm?─────▶│               │               │
  │               │                │──"D 不可达"──▶│               │
  │               │──Confirm?────────────────────────────────────▶│
  │               │                                │──"D 不可达"──│
  │               │                                │               │
  │               │  [3/3 确认 D 故障: 多数派达成]  │               │
  │               │                │               │               │
  │               │  [计算接管方案] │               │               │
  │               │  D 的 slots: [10,11,12,13]    │               │
  │               │  A 接管: 10, 11               │               │
  │               │  B 接管: 12                    │               │
  │               │  C 接管: 13                    │               │
  │               │                │               │               │
  │               │──Takeover─────▶│               │               │
  │               │  "接管 10,11"  │               │               │
  │               │──Takeover────────────────────▶│               │
  │               │  "接管 12"     │               │               │
  │               │──Takeover────────────────────────────────────▶│
  │               │  "接管 13"     │               │               │
  │               │                │               │               │
  │               │  [at-least-once: 短暂重叠]     │               │
  │               │  [更新 epoch_token]            │               │
  │               │                │               │               │
  │               │◀─AllTaken──────│◀──────────────│◀──────────────│
  │               │  [接管完成]     │               │               │
```

---

## 六、设计决策与替代方案

### 6.1 重平衡策略

#### 当前方案：局部调整（Local Adjustment）

```
原则: 只移动需要移动的，不重新计算全部

算法:
  1. 计算目标分布: target_per_node = total_slots / node_count
  2. 识别"过多"节点（slot_count > target + threshold）
  3. 识别"过少"节点（slot_count < target - threshold）
  4. 从"过多"节点选择 slots 迁移至"过少"节点
  5. 选择迁移的 slots 时优先选择低优先级 slots

示例:
  当前: A=40, B=30, C=30 (total=100)
  目标: A=34, B=33, C=33
  迁移: A→B: 3 slots, A→C: 3 slots (共 6 次迁移)

  不需要移动的: B 和 C 的现有 slots 不变
```

**优点:**
- 迁移量最小化
- 对系统扰动最小
- 可预测性强

**缺点:**
- 可能不是全局最优
- 多次局部调整可能累积出次优分布

#### 替代方案：全局优化（Global Optimization）

```
每次重平衡重新计算所有 slot 的最优分配:
  1. 收集所有 slot 和节点的信息
  2. 使用优化算法（如最小化方差）计算全局最优分配
  3. 计算当前分配与最优分配的 diff
  4. 仅迁移 diff 中的 slots

评估:
  + 总是达到全局最优
  + 长期来看迁移总量可能更少
  - 单次计算量大
  - 可能产生"无意义"迁移（slot 只是换了个节点，但实际效果相同）
  - 实现复杂度高
```

**决策:** 当前采用局部调整。对于 1~50 节点规模，局部调整已足够好。全局优化作为未来迭代方向。

### 6.2 三层抑制参数

```
三层抑制是重平衡稳定性的关键:

┌──────────────────────────────────────────────────────────────────────┐
│                        三层抑制机制                                    │
│                                                                      │
│  第一层: 滞后 (Hysteresis)                                           │
│  ┌────────────────────────────────────────────────────────────┐      │
│  │  阈值必须持续超过 N 个周期才触发                              │      │
│  │  默认: hysteresis_threshold = 3 cycles                     │      │
│  │  周期 = 10s (健康上报周期)                                  │      │
│  │  → 负载不均必须持续 ≥30s 才触发重平衡                       │      │
│  │                                                            │      │
│  │  目的: 过滤瞬态负载波动                                     │      │
│  └────────────────────────────────────────────────────────────┘      │
│                                                                      │
│  第二层: 冷却 (Cooldown)                                             │
│  ┌────────────────────────────────────────────────────────────┐      │
│  │  两次重平衡之间的最小间隔                                    │      │
│  │  默认: cooldown_period = 5 minutes                         │      │
│  │                                                            │      │
│  │  目的: 防止连续重平衡导致系统震荡                            │      │
│  └────────────────────────────────────────────────────────────┘      │
│                                                                      │
│  第三层: 渐进 (Gradual)                                              │
│  ┌────────────────────────────────────────────────────────────┐      │
│  │  每个重平衡周期最多迁移 N 个 slots                           │      │
│  │  默认: max_migrations_per_cycle = 10                       │      │
│  │                                                            │      │
│  │  目的: 限制单次重平衡的影响范围                              │      │
│  │  效果: 100 slots 的重平衡需要 10 个周期完成                  │      │
│  └────────────────────────────────────────────────────────────┘      │
│                                                                      │
│  时序示例 (需要迁移 22 slots):                                        │
│  ─────────────────────────                                           │
│  t=0s:    检测到不均 (滞后开始计数)                                   │
│  t=30s:   滞后满足 (3 周期), 冷却检查通过                            │
│  t=30s:   批次 1: 迁移 10 slots                                     │
│  t=40s:   批次 2: 迁移 10 slots                                     │
│  t=50s:   批次 3: 迁移 2 slots → 完成                               │
│  t=50s:   冷却期开始 (5 分钟内不再重平衡)                             │
└──────────────────────────────────────────────────────────────────────┘
```

### 6.3 驱逐优先级排序

#### 当前方案：手动优先级 + 默认 LRU

```
Slot 优先级来源:
  1. 显式优先级: TaskSpec 中定义的 priority 标签
     CRITICAL > HIGH > NORMAL > LOW
  2. 默认优先级: 无显式定义时，按最近健康时间排序
     最近健康的 slot 优先级更高（最后被迁移）

驱逐顺序:
  LOW → NORMAL → HIGH → CRITICAL
  
  同优先级内:
    按 target 数量排序（target 少的先迁移，减少中断影响）
```

#### 替代方案：容量感知排序

```
考虑 slot 的"迁移成本":
  cost = target_count × scrape_frequency × data_volume

优先迁移成本低的 slot（快速完成迁移）

评估:
  + 减少迁移总时间
  - 需要估算 data_volume，不精确
  - 增加了复杂度
```

**决策:** 当前采用手动优先级 + 默认 LRU。简单直观，运维可预测。

### 6.4 接管语义

#### 当前方案：at-least-once + 多数派确认

```
┌──────────────────────────────────────────────────────────────────────┐
│                        接管语义                                       │
│                                                                      │
│  at-least-once:                                                      │
│  ┌────────────────────────────────────────────────────────────┐      │
│  │  接管期间允许短暂重叠（≤1 scrape interval）                  │      │
│  │                                                            │      │
│  │  时间线:                                                    │      │
│  │  ─────────────────────────────────                         │      │
│  │  旧主: ████████████████████░░░░                            │      │
│  │  新主:                   ░░░░████████████████████           │      │
│  │                          ↑  ↑                              │      │
│  │                          重叠窗口 (≤1 interval)            │      │
│  │                                                            │      │
│  │  优点: 不丢数据点                                           │      │
│  │  代价: 可能产生重复数据点（可接受）                          │      │
│  └────────────────────────────────────────────────────────────┘      │
│                                                                      │
│  多数派确认:                                                         │
│  ┌────────────────────────────────────────────────────────────┐      │
│  │  只有多数派节点确认目标节点故障后，才执行接管                 │      │
│  │                                                            │      │
│  │  3 节点区: 需要 2 个存活节点确认                             │      │
│  │  5 节点区: 需要 3 个存活节点确认                             │      │
│  │  2 节点区: 依赖 2 节点特殊方案（见冲突仲裁）                 │      │
│  │                                                            │      │
│  │  无法达成多数派 → slot 留空（宁缺勿滥）                     │      │
│  └────────────────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────────────┘
```

#### 替代方案：exactly-once 接管

```
严格不重叠:
  1. 等待旧主完全停止
  2. 确认旧主 slot 状态为"已释放"
  3. 新主才开始采集

评估:
  + 不产生重复数据
  - 等待期间数据缺失
  - 需要可靠的"旧主已停止"确认（在故障场景难以保证）
  - 实现复杂度高
```

**决策:** 采用 at-least-once。短暂重叠的代价（重复数据点）远低于数据缺失的代价。下游 VictoriaMetrics 可自动处理重复时间戳。

### 6.5 扩缩容建议阈值

```
扩容触发条件:
  ┌──────────────────────────────────────────────────────────────┐
  │  指标              阈值          持续时长    权重             │
  ├──────────────────────────────────────────────────────────────┤
  │  平均 CPU 使用率   > 80%         15 分钟    0.3              │
  │  峰值 CPU 使用率   > 95%         5 分钟     0.2              │
  │  Slot 利用率       > 85%         15 分钟    0.3              │
  │  Agent 队列深度    > 阈值        10 分钟    0.2              │
  ├──────────────────────────────────────────────────────────────┤
  │  综合评分 > 0.7 → 触发扩容建议                               │
  └──────────────────────────────────────────────────────────────┘

缩容触发条件:
  ┌──────────────────────────────────────────────────────────────┐
  │  指标              阈值          持续时长    权重             │
  ├──────────────────────────────────────────────────────────────┤
  │  平均 CPU 使用率   < 30%         30 分钟    0.3              │
  │  Slot 利用率       < 20%         30 分钟    0.3              │
  │  节点冗余度        > 50%         30 分钟    0.2              │
  │  Agent 队列深度    ≈ 0           30 分钟    0.2              │
  ├──────────────────────────────────────────────────────────────┤
  │  综合评分 > 0.7 → 触发缩容建议                               │
  │  约束: 缩容后节点数 ≥ 2（保持基本 HA）                       │
  └──────────────────────────────────────────────────────────────┘
```

---

## 七、冲突与开放问题

### 7.1 已识别冲突

| 冲突编号 | 描述 | 影响范围 | 当前状态 |
|---------|------|---------|---------|
| CB-01 | 三层抑制参数需要调优 | 重平衡效率 | 默认参数基于经验值，需实测验证 |
| CB-02 | 优雅驱逐超时后的升级策略 | 运维体验 | 超时升级强制驱逐可能影响正在进行的采集 |
| CB-03 | 扩缩容建议与控制面策略可能冲突 | 自动化程度 | 控制面可能拒绝建议，需处理拒绝后的行为 |
| CB-04 | 重平衡期间如果再次触发接管 | 并发行为 | 需定义优先级：接管 > 重平衡 |

### 7.2 开放问题

| 问题编号 | 问题 | 候选方案 | 建议 |
|---------|------|---------|------|
| OQ-01 | 重平衡期间能否被新的重平衡触发打断？ | (a) 可以打断 (b) 排队等待 (c) 合并 | 建议 (c)，合并为新的重平衡计划 |
| OQ-02 | 迁移失败后是否自动重试？ | (a) 不重试 (b) 重试 3 次 (c) 指数退避重试 | 建议 (c)，最多 3 次，间隔递增 |
| OQ-03 | 扩缩容建议是否应该考虑成本（如云资源费用）？ | (a) 不考虑 (b) 作为参考 (c) 硬约束 | 建议 (a)，成本由控制面评估 |
| OQ-04 | 接管时 slot 的 Agent 状态如何传递？ | (a) 新节点重新发现 Agent (b) 从 Manifest 继承 | 建议 (b)，减少发现延迟 |
| OQ-05 | 隔离后的节点数据（本地缓存）如何处理？ | (a) 丢弃 (b) 迁移到新 owner (c) 保留待恢复 | 建议 (a)，简化处理 |

### 7.3 风险项

| 风险编号 | 风险描述 | 概率 | 影响 | 缓解措施 |
|---------|---------|------|------|---------|
| R-01 | 重平衡风暴（大量 slot 同时迁移） | 中 | 高 | 三层抑制 + 渐进执行 |
| R-02 | 接管期间数据重复导致告警误报 | 高 | 低 | 重叠窗口 ≤1 interval，VM 去重 |
| R-03 | 优雅驱逐超时导致强制驱逐 | 中 | 中 | 合理设置超时 + 提前告警 |
| R-04 | 扩缩容建议过于激进 | 低 | 中 | 滞后 + 冷却抑制 |
| R-05 | 并发行为冲突（重平衡 + 接管同时发生） | 低 | 高 | 行为优先级队列：接管 > 驱逐 > 重平衡 |

### 7.4 待决设计点

1. **重平衡计划的持久化**: 重平衡计划是否需要持久化到 Coordinator 存储？如果行为决策模块重启，是否需要恢复未完成的重平衡计划？建议持久化。
2. **迁移的原子性**: 单个 slot 迁移是否原子操作？当前设计是：目标节点先准备 → 源节点释放 → 目标节点接管。如果中间失败，需要回滚。
3. **缩容的最低节点数**: 缩容时是否应该保持最低节点数？建议 ≥2（保持基本 HA），但 Small 区（1 节点）除外。
4. **行为优先级**: 当多种行为同时触发时的优先级。建议：接管 > 驱逐 > 隔离 > 重平衡 > 扩缩容建议。
5. **迁移期间的降级**: 如果迁移过程中区进入降级状态（如 L1），是否暂停迁移？建议：L1 冻结新的迁移计划，已开始的迁移继续完成。
