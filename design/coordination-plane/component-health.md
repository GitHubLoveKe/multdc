# 组件健康

## 一、概述

组件健康模块负责监控和管理区内所有组件的运行状态，通过三源交叉验证（主动探测 + 自报告 + 对等报告）机制，准确判断组件健康状态，驱动节点状态机流转，并为采集任务调度、冲突仲裁、行为决策等模块提供可靠的健康事件。

本模块是协调层的基础支撑模块，其输出的节点状态是所有调度决策的前提。健康检测的准确性直接决定了故障接管的时效性和误判率。

### 1.1 核心定位

```
┌──────────────────────────────────────────────────────────────────────┐
│                        协调层 (Coordination Plane)                     │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                    组件健康 (本模块)                           │    │
│  │                                                              │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │    │
│  │  │ 主动探测      │  │ 自报告收集   │  │ 对等报告收集         │  │    │
│  │  │ (Coordinator │  │ (节点自报    │  │ (VRRP peer 报告)    │  │    │
│  │  │  → 节点)     │  │  状态/资源)  │  │                     │  │    │
│  │  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │    │
│  │         │                │                     │              │    │
│  │         └────────────────┼─────────────────────┘              │    │
│  │                          ▼                                    │    │
│  │              ┌─────────────────────┐                          │    │
│  │              │  三源交叉验证引擎     │                          │    │
│  │              └──────────┬──────────┘                          │    │
│  │                         ▼                                     │    │
│  │              ┌─────────────────────┐                          │    │
│  │              │  节点状态机管理       │                          │    │
│  │              └──────────┬──────────┘                          │    │
│  └─────────────────────────┼──────────────────────────────────────┘    │
│                            │                                          │
│          ┌─────────────────┼──────────────────────┐                  │
│          ▼                 ▼                      ▼                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐          │
│  │ 采集任务调度  │  │ 冲突仲裁      │  │ 行为决策          │          │
│  │ (节点状态事件)│  │ (fencing 依据)│  │ (驱逐/隔离触发)   │          │
│  └──────────────┘  └──────────────┘  └──────────────────┘          │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.2 设计目标

| 目标编号 | 描述 | 优先级 |
|---------|------|--------|
| G-01 | 节点故障检测延迟 ≤15s（3 次心跳超时） | P0 |
| G-02 | 误判率 < 1%（健康节点被错误标记为故障） | P0 |
| G-03 | 三源交叉验证，单一信息源不可靠不影响判断 | P0 |
| G-04 | 区分瞬态故障与持续退化 | P1 |
| G-05 | 健康数据 10s 周期上报至控制面观察矩阵 | P1 |
| G-06 | 支持 Agent、OTel Collector、RC 等全组件类型 | P1 |

### 1.3 监控范围

```
区内全组件监控覆盖:

┌─────────────────────────────────────────────────────────┐
│  Zone                                                    │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Job Scheduler │  │ Job Scheduler │  │ Job Scheduler │  │
│  │ Node A        │  │ Node B        │  │ Node C        │  │
│  │              │  │              │  │              │  │
│  │ ┌──────────┐ │  │ ┌──────────┐ │  │ ┌──────────┐ │  │
│  │ │Agent × N │ │  │ │Agent × N │ │  │ │Agent × N │ │  │
│  │ └──────────┘ │  │ └──────────┘ │  │ └──────────┘ │  │
│  │ ┌──────────┐ │  │ ┌──────────┐ │  │ ┌──────────┐ │  │
│  │ │OTel Coll.│ │  │ │OTel Coll.│ │  │ │OTel Coll.│ │  │
│  │ └──────────┘ │  │ └──────────┘ │  │ └──────────┘ │  │
│  │ ┌──────────┐ │  │ ┌──────────┐ │  │              │  │
│  │ │RC (B/C)  │ │  │ │RC (B/C)  │ │  │              │  │
│  │ └──────────┘ │  │ └──────────┘ │  │              │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │ Zone Coordinator (etcd 3-node / 双节点+RDS lease) │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐                    │
│  │ Zone Agent    │  │ Zone Query   │                    │
│  │ (跨区代理)    │  │ Proxy        │                    │
│  └──────────────┘  └──────────────┘                    │
└─────────────────────────────────────────────────────────┘
```

---

## 二、职责边界

### 2.1 本模块负责

| 职责 | 说明 |
|------|------|
| 主动探测 | Coordinator 周期性探测各 Job Scheduler 节点存活状态 |
| 自报告收集 | 收集各节点自报的健康状态、资源使用率、组件状态 |
| 对等报告收集 | 收集 Job Scheduler 间 VRRP 心跳中携带的 peer 状态信息 |
| 三源交叉验证 | 综合三个信息源判断节点真实状态 |
| 节点状态机管理 | 驱动节点在状态机中流转（REGISTER → HEALTHY → ... → FENCED） |
| Agent 健康追踪 | 通过 Job Scheduler 间接监控各节点上 Agent 的健康状态 |
| OTel Collector 健康 | 监控管道状态、输出连通性、缓冲区使用率 |
| RC 健康监控 | 监控规则评估延迟、查询成功率 |
| 健康数据聚合 | 生成区级别健康摘要，上报控制面观察矩阵 |
| 健康事件发布 | 向区内其他模块发布节点状态变更事件 |

### 2.2 本模块不负责

| 不负责事项 | 归属 | 说明 |
|-----------|------|------|
| 故障恢复动作（接管/驱逐） | 行为决策模块 | 本模块只检测、不行动 |
| 冲突裁决 | 冲突仲裁模块 | 本模块提供状态数据，仲裁模块做决策 |
| 节点注册/注销 | 控制面实例注册表 | 本模块管理区内运行时状态 |
| 实际探针部署 | 各节点自身 | 本模块消费探针数据 |
| 告警通知 | 控制面告警管理 | 本模块可触发内部事件，不直接告警 |

### 2.3 信息流向

```
                    ┌─────────────────────┐
                    │    控制面             │
                    │  (观察矩阵)          │
                    └──────────▲──────────┘
                               │ 10s 周期上报
                               │
┌──────────────┐    ┌──────────┴──────────┐    ┌──────────────┐
│  行为决策      │◀───│    组件健康 (本模块)  │───▶│  采集任务调度  │
│  (接收状态事件)│    │                     │    │ (接收状态事件) │
└──────────────┘    │  · 三源验证引擎       │    └──────────────┘
                    │  · 状态机管理         │
┌──────────────┐    │  · 健康数据聚合       │    ┌──────────────┐
│  冲突仲裁      │◀───│  · 事件发布          │───▶│  RC 任务调度   │
│  (接收状态数据)│    └─────────────────────┘    └──────────────┘
└──────────────┘
         ▲
         │
┌────────┴─────────────────────────────────────────────────┐
│                    数据源                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐   │
│  │ 主动探测  │  │ 自报告    │  │ 对等报告 (VRRP HB)   │   │
│  │ 15s 周期  │  │ 10s 周期  │  │ 3s 周期              │   │
│  └──────────┘  └──────────┘  └──────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

---

## 三、功能清单

### 3.1 主动探测

| 功能项 | 描述 |
|--------|------|
| F-1.1 节点心跳探测 | Coordinator 每 15s 向各 Job Scheduler 节点发送探测请求 |
| F-1.2 探测超时管理 | 超时阈值可配置（默认 5s），超时计为一次失败 |
| F-1.3 探测重试 | 单次探测失败后立即重试一次，避免网络抖动误判 |
| F-1.4 Coordinator 主探 | 仅 Coordinator primary 执行主动探测，backup 待命 |
| F-1.5 探测结果记录 | 记录每次探测的结果（成功/失败/超时）及延迟 |

### 3.2 自报告收集

| 功能项 | 描述 |
|--------|------|
| F-2.1 节点状态自报 | 节点每 10s 上报自身状态（运行中/降级/维护中） |
| F-2.2 资源使用率上报 | CPU、内存、磁盘、网络带宽使用率 |
| F-2.3 Agent 状态上报 | 本节点所有 Agent 实例的状态与负载 |
| F-2.4 OTel Collector 状态上报 | 管道状态、输出连通性、缓冲区水位 |
| F-2.5 RC 状态上报 | 规则评估延迟、查询成功率、存储连接状态（Mode B/C） |

### 3.3 对等报告收集

| 功能项 | 描述 |
|--------|------|
| F-3.1 VRRP 心跳解析 | 从 Job Scheduler 间 3s 心跳中提取 peer 状态信息 |
| F-3.2 peer 可达性矩阵 | 构建节点间两两可达性矩阵 |
| F-3.3 peer 报告可信度 | 基于报告者自身健康状态调整可信度权重 |
| F-3.4 网络分区检测 | 通过 peer 报告识别网络分区模式 |

### 3.4 三源交叉验证

| 功能项 | 描述 |
|--------|------|
| F-4.1 一致性判定 | 三源一致 → 高置信度判定 |
| F-4.2 分歧处理 | 任意两源与"健康"不一致 → 标记 SUSPECT |
| F-4.3 源权重 | 主动探测 > 自报告 > 对等报告（默认权重） |
| F-4.4 瞬态过滤 | 单次异常不立即触发状态变更，需持续 N 个周期 |
| F-4.5 退化分级 | 区分轻微退化（性能下降）与严重故障（不可用） |

### 3.5 节点状态机管理

| 功能项 | 描述 |
|--------|------|
| F-5.1 状态流转 | 驱动节点在状态机中按规则流转 |
| F-5.2 状态持久化 | 节点状态持久化到 Coordinator 存储（etcd / RDS） |
| F-5.3 状态事件发布 | 状态变更时发布事件，供其他模块消费 |
| F-5.4 FENCED 管理 | FENCED 节点必须通过完整重新注册才能恢复 |
| F-5.5 状态审计日志 | 记录所有状态变更的完整审计日志 |

### 3.6 健康数据聚合与上报

| 功能项 | 描述 |
|--------|------|
| F-6.1 区健康摘要 | 聚合区内所有组件状态，生成区级别健康摘要 |
| F-6.2 控制面上报 | 每 10s 将健康摘要上报至控制面观察矩阵 |
| F-6.3 趋势分析 | 跟踪健康指标趋势（如内存使用率持续上升） |
| F-6.4 预测告警 | 基于趋势预测潜在故障（如磁盘将在 N 小时后满） |

---

## 四、核心数据模型

### 4.1 NodeHealthState — 节点健康状态

```protobuf
// NodeHealthState 描述一个节点的完整健康视图
message NodeHealthState {
  // 节点 ID
  string node_id = 1;
  
  // 当前状态机状态
  NodeState state = 2;
  
  // 三源健康数据
  HealthSource active_probe = 3;     // 主动探测结果
  HealthSource self_report = 4;      // 自报告结果
  HealthSource peer_report = 5;      // 对等报告汇总
  
  // 综合健康评分 (0.0 ~ 1.0)
  // 1.0 = 完全健康, 0.0 = 完全不可用
  float health_score = 6;
  
  // 状态进入时间（当前状态已持续多久）
  google.protobuf.Timestamp state_entered_at = 7;
  
  // 最后状态变更原因
  string last_transition_reason = 8;
  
  // 连续异常计数（用于瞬态过滤）
  uint32 consecutive_failure_count = 9;
  
  // 连续健康计数（用于恢复判定）
  uint32 consecutive_health_count = 10;
}

enum NodeState {
  NODE_STATE_UNSPECIFIED = 0;
  NODE_STATE_REGISTER = 1;      // 刚注册，尚未验证
  NODE_STATE_WARMING = 2;       // 预热中，通过初始检查
  NODE_STATE_HEALTHY = 3;       // 健康，正常运行
  NODE_STATE_SUSPECT = 4;       // 疑似故障，需进一步确认
  NODE_STATE_EXPIRED = 5;       // 已过期，确认故障
  NODE_STATE_FENCED = 6;        // 已隔离，不可参与任何协商
  NODE_STATE_DRAINING = 7;      // 排空中，准备下线
  NODE_STATE_OFFLINE = 8;       // 已下线
  NODE_STATE_QUARANTINED = 9;   // 被隔离（异常行为）
}
```

### 4.2 HealthSource — 健康信息源

```protobuf
message HealthSource {
  // 信息来源类型
  SourceType source_type = 1;
  
  // 最后一次成功获取数据的时间
  google.protobuf.Timestamp last_seen = 2;
  
  // 报告的状态
  ReportedStatus reported_status = 3;
  
  // 数据新鲜度（当前时间 - last_seen）
  google.protobuf.Duration staleness = 4;
  
  // 可信度权重 (0.0 ~ 1.0)
  float confidence = 5;
  
  // 详细信息
  HealthDetail detail = 6;
}

enum SourceType {
  SOURCE_TYPE_UNSPECIFIED = 0;
  SOURCE_TYPE_ACTIVE_PROBE = 1;
  SOURCE_TYPE_SELF_REPORT = 2;
  SOURCE_TYPE_PEER_REPORT = 3;
}

enum ReportedStatus {
  REPORTED_STATUS_UNKNOWN = 0;
  REPORTED_STATUS_HEALTHY = 1;
  REPORTED_STATUS_DEGRADED = 2;
  REPORTED_STATUS_UNREACHABLE = 3;
  REPORTED_STATUS_NO_DATA = 4;    // 超时未收到任何数据
}

message HealthDetail {
  // 响应延迟（主动探测的 RTT）
  google.protobuf.Duration response_latency = 1;
  
  // 资源使用率
  ResourceUsage resource_usage = 2;
  
  // 组件状态摘要
  repeated ComponentHealth components = 3;
}

message ResourceUsage {
  float cpu_usage = 1;          // 0.0 ~ 1.0
  float memory_usage = 2;       // 0.0 ~ 1.0
  float disk_usage = 3;         // 0.0 ~ 1.0
  float network_bandwidth = 4;  // 0.0 ~ 1.0
  uint32 goroutine_count = 5;   // Go runtime goroutine 数
  uint32 fd_count = 6;          // 文件描述符数
}
```

### 4.3 ComponentHealth — 组件健康

```protobuf
message ComponentHealth {
  // 组件类型
  ComponentType component_type = 1;
  
  // 组件实例 ID
  string instance_id = 2;
  
  // 组件状态
  ComponentState state = 3;
  
  // 组件特定指标
  oneof metrics {
    AgentMetrics agent_metrics = 4;
    OTelCollectorMetrics otel_metrics = 5;
    RCMetrics rc_metrics = 6;
    JobSchedulerMetrics js_metrics = 7;
  }
  
  // 最后更新时间
  google.protobuf.Timestamp updated_at = 8;
}

enum ComponentType {
  COMPONENT_TYPE_UNSPECIFIED = 0;
  COMPONENT_TYPE_JOB_SCHEDULER = 1;
  COMPONENT_TYPE_AGENT = 2;
  COMPONENT_TYPE_OTEL_COLLECTOR = 3;
  COMPONENT_TYPE_RC = 4;
  COMPONENT_TYPE_ZONE_AGENT = 5;
  COMPONENT_TYPE_QUERY_PROXY = 6;
}

enum ComponentState {
  COMPONENT_STATE_UNSPECIFIED = 0;
  COMPONENT_STATE_RUNNING = 1;
  COMPONENT_STATE_DEGRADED = 2;
  COMPONENT_STATE_ERROR = 3;
  COMPONENT_STATE_STOPPED = 4;
}
```

### 4.4 组件特定指标

```protobuf
message AgentMetrics {
  uint32 active_targets = 1;       // 当前采集目标数
  uint32 failed_scrapes = 2;       // 最近一个周期的失败采集数
  float scrape_success_rate = 3;   // 采集成功率
  google.protobuf.Duration avg_scrape_duration = 4;
  uint32 oom_kills = 5;            // OOM 被杀次数
}

message OTelCollectorMetrics {
  uint32 pipeline_count = 1;        // 活跃管道数
  uint32 received_samples = 2;      // 最近周期接收的样本数
  uint32 exported_samples = 3;      // 最近周期导出的样本数
  uint32 dropped_samples = 4;       // 最近周期丢弃的样本数
  float buffer_usage = 5;           // 缓冲区使用率 (0.0 ~ 1.0)
  bool remote_write_connected = 6;  // 远程写入是否连通
  bool local_storage_connected = 7; // 本地存储是否连通
  google.protobuf.Duration export_latency = 8;
}

message RCMetrics {
  uint32 active_rule_groups = 1;     // 活跃规则组数
  google.protobuf.Duration eval_latency = 2;   // 规则评估延迟
  float eval_success_rate = 3;       // 评估成功率
  uint32 pending_alerts = 4;         // 待发送告警数
  bool storage_connected = 5;        // 存储连接状态
  google.protobuf.Duration query_latency = 6;  // 存储查询延迟
}

message JobSchedulerMetrics {
  uint32 owned_slots = 1;           // 拥有的槽位数
  uint32 active_agents = 2;         // 活跃 Agent 数
  uint32 peer_count = 3;            // 可见的 peer 数
  google.protobuf.Duration last_peer_hb = 4;  // 距上次 peer 心跳的时间
  uint32 manifest_version = 5;      // 当前 Manifest 版本
}
```

### 4.5 ZoneHealthSummary — 区健康摘要

```protobuf
message ZoneHealthSummary {
  string zone_id = 1;
  google.protobuf.Timestamp generated_at = 2;
  
  // 区整体健康级别
  ZoneHealthLevel overall_health = 3;
  
  // 节点健康列表
  repeated NodeHealthState nodes = 4;
  
  // 聚合统计
  HealthStats stats = 5;
  
  // 降级状态
  DegradationLevel degradation_level = 6;
  string degradation_reason = 7;
  
  // 活跃告警
  repeated HealthAlert active_alerts = 8;
}

enum ZoneHealthLevel {
  ZONE_HEALTH_UNSPECIFIED = 0;
  ZONE_HEALTH_FULL = 1;         // 所有组件正常
  ZONE_HEALTH_DEGRADED = 2;     // 部分组件退化
  ZONE_HEALTH_CRITICAL = 3;     // 关键组件故障
  ZONE_HEALTH_FAILING = 4;      // 区功能严重受损
}

message HealthStats {
  uint32 total_nodes = 1;
  uint32 healthy_nodes = 2;
  uint32 suspect_nodes = 3;
  uint32 expired_nodes = 4;
  uint32 fenced_nodes = 5;
  uint32 total_agents = 6;
  uint32 active_agents = 7;
  uint32 total_slots = 8;
  uint32 assigned_slots = 9;
  float avg_health_score = 10;
}

enum DegradationLevel {
  DEGRADATION_L0 = 0;  // 全部可用
  DEGRADATION_L1 = 1;  // 中心不可达
  DEGRADATION_L2 = 2;  // Coordinator primary 宕机
  DEGRADATION_L3 = 3;  // 所有 Coordinator 丢失
}

message HealthAlert {
  string alert_id = 1;
  string severity = 2;       // "critical" | "warning" | "info"
  string component = 3;      // 受影响组件
  string description = 4;
  google.protobuf.Timestamp fired_at = 5;
}
```

### 4.6 状态转换规则

```protobuf
// 状态转换规则定义
message StateTransition {
  NodeState from = 1;
  NodeState to = 2;
  
  // 触发条件
  TransitionCondition condition = 3;
  
  // 最小停留时间（在该状态至少停留多久才能转换）
  google.protobuf.Duration min_stay = 4;
  
  // 是否需要确认（需要多数派确认的转换）
  bool requires_quorum = 5;
}

// 关键转换规则:
//
// REGISTER → WARMING:
//   条件: 首次主动探测成功
//   停留: 0s
//
// WARMING → HEALTHY:
//   条件: 连续 3 次主动探测成功 + 自报告正常
//   停留: 30s (可配置)
//
// HEALTHY → SUSPECT:
//   条件: 任意两源报告异常
//   停留: 0s (立即转换)
//
// SUSPECT → HEALTHY:
//   条件: 连续 3 次三源一致
//   停留: 0s
//
// SUSPECT → EXPIRED:
//   条件: 连续 3 次（默认）主动探测无响应
//   停留: 0s
//
// EXPIRED → FENCED:
//   条件: 自动（EXPIRED 状态持续超过 fence_delay）
//   停留: fence_delay (默认 60s)
//
// HEALTHY → DRAINING:
//   条件: 管理操作（graceful shutdown）
//   停留: 0s
//
// DRAINING → OFFLINE:
//   条件: 所有 slot 已迁移完成
//   停留: 0s
//
// HEALTHY → QUARANTINED:
//   条件: 管理操作 或 自动检测（反复 flapping）
//   停留: 0s
```

### 4.7 数据模型关系图

```
ZoneHealthSummary (1 per zone, 10s 更新)
  ├── NodeHealthState (N, per node)
  │     ├── HealthSource: active_probe
  │     ├── HealthSource: self_report
  │     ├── HealthSource: peer_report
  │     └── ComponentHealth (M, per component)
  │           ├── AgentMetrics
  │           ├── OTelCollectorMetrics
  │           ├── RCMetrics
  │           └── JobSchedulerMetrics
  ├── HealthStats (聚合统计)
  └── HealthAlert (K, 活跃告警)

状态机:
  REGISTER → WARMING → HEALTHY ←→ SUSPECT → EXPIRED → FENCED
                         │
                         ├──→ DRAINING → OFFLINE
                         └──→ QUARANTINED
```

---

## 五、接口与交互

### 5.1 内部接口

#### 5.1.1 主动探测接口（Coordinator → Job Scheduler）

```
接口: ActiveProbe
方向: Coordinator → Job Scheduler 节点
周期: 15s
协议: gRPC

请求 (ProbeRequest):
  probe_id: string
  timestamp: Timestamp
  timeout: Duration (默认 5s)
  expected_manifest_version: uint64  // 用于检测节点是否落后

响应 (ProbeResponse):
  node_id: string
  timestamp: Timestamp
  status: "healthy" | "degraded"
  resource_usage: ResourceUsage
  component_summary: ComponentHealthSummary
  manifest_version: uint64
  response_latency: Duration

超时处理:
  - 首次超时: 立即重试一次
  - 重试仍超时: 记录为一次探测失败
  - 连续 3 次探测失败: 触发 SUSPECT 评估
```

#### 5.1.2 自报告接口（Job Scheduler → Coordinator）

```
接口: SelfReport
方向: Job Scheduler → Coordinator
周期: 10s
协议: gRPC

请求 (SelfReportMessage):
  node_id: string
  timestamp: Timestamp
  node_status: "running" | "degraded" | "maintenance"
  resource_usage: ResourceUsage
  components: [ComponentHealth]
  
  // 节点自评估
  self_assessment: {
    overall_status: "healthy" | "degraded" | "critical"
    issues: [string]           // 已知问题列表
    capacity_available: float  // 剩余容量比例
  }

处理:
  - Coordinator 接收并更新该节点的 self_report 源
  - 若 self_report 超时（连续 3 个周期未收到）:
    → 标记 self_report 源为 NO_DATA
  - 若 self_report 中 node_status = "maintenance":
    → 不计入异常（预期行为）
```

#### 5.1.3 对等报告接口（从 VRRP 心跳提取）

```
接口: PeerReport (从心跳消息中提取)
方向: Job Scheduler ↔ Job Scheduler (已有心跳通道)
周期: 3s (随心跳)

从心跳消息中提取的 peer 信息:
  peer_id: string               // 被报告的节点 ID
  reporter_id: string           // 报告者节点 ID
  peer_status: "alive" | "degraded" | "unreachable"
  peer_owned_slots: [uint32]    // peer 声称拥有的 slots
  peer_epoch_tokens: {uint32: string}
  
处理:
  - 每个节点收集来自所有 peer 的报告
  - 汇总后上报给 Coordinator
  - Coordinator 综合所有 peer 报告形成 peer_report 源
```

#### 5.1.4 状态事件发布接口

```
接口: OnNodeStateChanged
方向: 组件健康 → 其他模块（发布-订阅）
触发: 节点状态机发生任何转换

事件 (NodeStateChangeEvent):
  node_id: string
  from_state: NodeState
  to_state: NodeState
  timestamp: Timestamp
  reason: string
  health_score: float
  
  // 建议动作（供消费方参考）
  suggested_actions: [string]
  // 如: "trigger_takeover", "pause_rebalance", "initiate_fence"

订阅方:
  - 采集任务调度: 接收节点 EXPIRED/FENCED 事件，触发接管
  - 行为决策: 接收节点状态变更，触发驱逐/隔离
  - 冲突仲裁: 接收状态数据，用于冲突裁决
```

### 5.2 外部接口

#### 5.2.1 控制面健康上报接口

```
接口: ReportZoneHealth
方向: 组件健康 → 控制面观察矩阵
周期: 10s
协议: 跨区 gRPC (M3 接口)

请求: ZoneHealthSummary (见 4.5 节)

降级行为:
  - L1（控制面不可达）: 停止上报，区内缓存最近 100 条摘要
  - 控制面恢复后补发缓存摘要
  - 补发不影响区内正常功能
```

### 5.3 交互时序图

#### 5.3.1 三源交叉验证流程

```
Coordinator         JS Node A          JS Node B          JS Node C
  │                    │                  │                  │
  │──Probe(15s)──────▶│                  │                  │
  │◀──ProbeResp───────│                  │                  │
  │  (latency=2ms,    │                  │                  │
  │   status=healthy) │                  │                  │
  │                    │                  │                  │
  │◀──SelfReport(10s)─│                  │                  │
  │  (status=running, │                  │                  │
  │   cpu=45%)        │                  │                  │
  │                    │                  │                  │
  │◀──PeerReport──────│──────────────────│──────────────────│
  │  (B reports A:    │                  │                  │
  │   alive, C reports│                  │                  │
  │   A: alive)       │                  │                  │
  │                    │                  │                  │
  │  [三源验证 Node A] │                  │                  │
  │  active_probe: ✓   │                  │                  │
  │  self_report:  ✓   │                  │                  │
  │  peer_report:  ✓   │                  │                  │
  │  → HEALTHY (置信度高)                  │                  │
  │                    │                  │                  │
  │  [假设 Node B 主动探测超时]             │                  │
  │──Probe(15s)───────│─────────────────▶│                  │
  │  [超时 5s]         │                  │                  │
  │──Probe(retry)─────│─────────────────▶│                  │
  │  [超时 5s]         │                  │                  │
  │                    │                  │                  │
  │  active_probe: ✗ (连续 2 次超时)       │                  │
  │  self_report:  ? (最近一次 = 30s 前)   │                  │
  │  peer_report:  ✗ (A,C 均报 B 不可达)  │                  │
  │                    │                  │                  │
  │  → B: SUSPECT     │                  │                  │
  │  → 发布状态变更事件 │                  │                  │
```

#### 5.3.2 节点状态完整生命周期

```
时间轴 →

t0: REGISTER
    │  节点首次注册到区
    │
t1: WARMING (首次主动探测成功)
    │  开始预热，执行初始检查
    │  (至少停留 30s)
    │
t2: HEALTHY (连续 3 次探测成功 + 自报告正常)
    │  正常运行
    │  参与 slot 分配和 peer 检测
    │
    │  ═══════════════════════════════════════════
    │  场景 A: 瞬态故障后恢复
    │  
t3: SUSPECT (2/3 源报告异常)
    │  进入观察期
    │  
t3+ε: HEALTHY (连续 3 次三源一致)
    │  恢复正常
    │
    │  ═══════════════════════════════════════════
    │  场景 B: 持续故障
    │
t3: SUSPECT
    │  
t3+9s: EXPIRED (连续 3 次主动探测无响应)
    │  确认故障
    │  触发 slot 接管流程
    │
t3+69s: FENCED (EXPIRED 持续 60s)
    │  完全隔离
    │  不可参与任何协商
    │
    │  ═══════════════════════════════════════════
    │  场景 C: 优雅下线
    │
t3: DRAINING (管理操作)
    │  slot 逐步迁移
    │  
t4: OFFLINE (所有 slot 迁移完成)
    │  节点下线
```

---

## 六、设计决策与替代方案

### 6.1 三源验证策略

#### 当前方案：2/3 多数判定

```
判定规则:
  ┌──────────────────────────────────────────────────────────────┐
  │  主动探测    自报告      对等报告    → 判定结果                 │
  ├──────────────────────────────────────────────────────────────┤
  │  HEALTHY     HEALTHY    HEALTHY    → HEALTHY (高置信度)       │
  │  HEALTHY     HEALTHY    UNREACHABLE→ HEALTHY (中置信度)       │
  │  HEALTHY     UNREACHABLE UNREACHABLE→ SUSPECT (2/3 异常)     │
  │  UNREACHABLE UNREACHABLE UNREACHABLE→ SUSPECT (全异常)       │
  │  HEALTHY     DEGRADED   HEALTHY    → DEGRADED (性能问题)     │
  │  NO_DATA     HEALTHY    HEALTHY    → 需区分:                 │
  │                                       探测故障 vs 节点故障    │
  └──────────────────────────────────────────────────────────────┘

核心规则:
  1. 任意两源与"健康"不一致 → SUSPECT
  2. 所有三源一致 → 高置信度
  3. 源数据过期（>3 个周期未更新）→ 视为 NO_DATA
  4. NO_DATA 不计入异常（但降低整体置信度）
```

**优点:**
- 单一信息源故障不会导致误判
- 容忍一个信息源的暂时不可用
- 逻辑清晰，易于调试

**缺点:**
- 2 节点区中，peer_report 只有 1 个来源
- 网络分区时 peer_report 可能系统性偏差

#### 替代方案：加权评分

```
health_score = w1 × probe_score + w2 × self_score + w3 × peer_score

默认权重:
  w1 = 0.5 (主动探测)
  w2 = 0.3 (自报告)
  w3 = 0.2 (对等报告)

判定阈值:
  score ≥ 0.7 → HEALTHY
  0.3 ≤ score < 0.7 → DEGRADED
  score < 0.3 → SUSPECT

评估:
  + 更细粒度的健康判定
  + 可动态调整权重
  - 阈值调优困难
  - 不如 2/3 规则直观
```

**决策:** 当前采用 2/3 多数判定，简单可靠。加权评分作为未来迭代方向，在积累足够运行数据后引入。

### 6.2 主动探测周期

#### 当前方案：15s

```
15s 主动探测 + 3s VRRP 心跳 + 10s 自报告

时序:
  0s   3s   6s   9s   12s  15s  18s  21s  24s  27s  30s
  │    │    │    │    │    │    │    │    │    │    │
  ├────VRRP──┤────VRRP──┤────VRRP──┤────VRRP──┤
  │              │              │              │
  ├──────Self──────────┤──────Self──────────┤
  │                   │                   │
  ├──────────Probe─────────────┤──────────Probe──────┤

故障检测时间:
  - VRRP 检测: 3 × 3s = 9s (最快)
  - 主动探测: 3 × 15s = 45s (最慢，含重试)
  - 综合: 通常 9~15s 内可检测故障
```

**优点:**
- 主动探测频率低，减少 Coordinator 负载
- VRRP 心跳提供快速检测补充
- 网络开销可控

#### 替代方案：自适应周期

```
正常状态: 30s 探测周期
发现异常后: 缩短至 5s 探测周期
确认恢复后: 逐步回到 30s

评估:
  + 正常时减少开销
  + 异常时加快检测
  - 实现复杂
  - 周期变化增加调试难度
```

**决策:** 固定 15s 周期，简单可预测。VRRP 3s 心跳已提供足够的快速检测能力。

### 6.3 瞬态故障过滤

```
问题: 如何区分网络抖动导致的瞬态异常和真实故障？

当前方案: 连续 N 次确认

  SUSPECT 触发条件:
    - 连续 2 次主动探测失败（含重试），或
    - 主动探测失败 + 自报告异常，或
    - 主动探测失败 + peer 报告异常

  EXPIRED 触发条件:
    - 连续 3 次主动探测完全无响应（含重试）

  恢复条件:
    - SUSPECT → HEALTHY: 连续 3 次三源一致
    - EXPIRED 不可直接恢复，必须经过 FENCED → 重新注册

参数可调:
  suspect_threshold: 2 (连续异常次数)
  expired_threshold: 3 (连续无响应次数)
  recovery_threshold: 3 (连续正常次数)
```

### 6.4 QUARANTINED 状态设计

```
问题: 如何处理"行为异常但未宕机"的节点？

触发条件:
  1. 反复 flapping: HEALTHY ↔ SUSPECT 在 1 小时内 ≥ 5 次
  2. 数据损坏: 节点上报的数据被检测到不一致
  3. 安全顾虑: 凭证泄露、未授权访问尝试

QUARANTINED 效果:
  - 节点 slot 立即重新分配（等同 EXPIRED）
  - 节点心跳仍被接收，但不参与任何协商
  - 必须通过管理操作手动解除
  - 解除后从 REGISTER 状态重新开始

与 FENCED 的区别:
  FENCED: 自动触发（故障超时），自动恢复（重新注册）
  QUARANTINED: 可能手动触发，必须手动解除
```

---

## 七、冲突与开放问题

### 7.1 已识别冲突

| 冲突编号 | 描述 | 影响范围 | 当前状态 |
|---------|------|---------|---------|
| CH-01 | 2 节点区 peer_report 只有 1 个来源 | Normal 规模区 | 需依赖主动探测和自报告补偿 |
| CH-02 | Coordinator 自身健康由谁监控？ | 协调层自身 | 需设计自监控机制 |
| CH-03 | 主动探测与 VRRP 心跳可能给出矛盾结论 | 判定准确性 | 需明确优先级规则 |

### 7.2 开放问题

| 问题编号 | 问题 | 候选方案 | 建议 |
|---------|------|---------|------|
| OQ-01 | QUARANTINED 状态的自动触发阈值如何设定？ | (a) 固定值 (b) 可配置 (c) 基于历史数据自适应 | 建议 (b)，默认 1h 内 5 次 flapping |
| OQ-02 | 健康数据是否需要持久化到时序数据库？ | (a) 仅内存 (b) 内存 + 本地磁盘 (c) 写入 TSDB | 建议 (b)，保留最近 24h 数据 |
| OQ-03 | 资源使用率的告警阈值是否因区而异？ | (a) 全局统一 (b) 按区配置 (c) 按节点配置 | 建议 (b)，区级别可配置 |
| OQ-04 | 节点自报告是否可以"撒谎"（误报自身状态）？ | (a) 信任自报告 (b) 自报告仅作参考 (c) 签名验证 | 建议 (b)，自报告权重最低 |
| OQ-05 | 如何避免"告警风暴"（大量节点同时异常）？ | (a) 告警聚合 (b) 告警抑制 (c) 优先级排序 | 建议 (a)+(c) |

### 7.3 风险项

| 风险编号 | 风险描述 | 概率 | 影响 | 缓解措施 |
|---------|---------|------|------|---------|
| R-01 | Coordinator 与节点同时网络分区 | 低 | 高 | 三源验证降低误判；分区场景由冲突仲裁处理 |
| R-02 | 时钟偏移导致心跳超时误判 | 中 | 中 | 使用逻辑时钟 + 物理时钟混合判定 |
| R-03 | 健康数据量过大导致 Coordinator 过载 | 低 | 中 | 聚合上报，非逐指标上报 |
| R-04 | 状态机卡死（如长期停在 SUSPECT） | 低 | 中 | 设置状态超时，超时自动推进 |

### 7.4 待决设计点

1. **Coordinator 自监控**: Coordinator 的健康由谁检测？候选方案：(a) Coordinator 节点上的 Agent 检测 (b) 控制面主动探测 (c) 互监控（etcd 集群内部健康检测）。
2. **健康数据保留策略**: 区内健康数据保留多久？建议 24h，但需确认存储开销。
3. **预测性健康**: 是否引入趋势预测（如内存泄漏检测）？当前仅做阈值告警，预测功能作为未来迭代。
4. **健康数据的加密**: 健康数据中可能包含敏感信息（如内部 IP），是否需要加密传输？当前假设区内通信可信。
