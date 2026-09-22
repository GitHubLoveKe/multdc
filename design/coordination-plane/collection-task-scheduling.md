# 采集任务调度（协调层视角）

> 版本：v2.0 | 日期：2026-09-22
> 本文档描述协调层在采集任务调度中的职责。
> v2.0 核心变更：协调层定位为纯数据中继，不做调度决策。调度由 Scheduler 自治完成（Rendezvous Hashing + Gossip）。

---

## 一、概述

协调层在采集任务调度中的职责是**缓存控制面的实例数据，并为 Scheduler 提供高效的数据查询接口**。它不参与任何调度决策——"谁来采、在哪采、怎么采"完全由 Scheduler 自主决定。

这是"中心管理 ≠ 中心调度"（P1）原则的彻底体现：控制面定义"采什么"，协调层缓存"采什么"的数据副本，Scheduler 决定"谁来采"。

### 1.1 核心定位

```
┌─────────────────────────────────────────────────────────────────┐
│                      中心控制面 (Control Plane)                   │
│  实例注册表：定义 target、采集配置、凭据、启用/禁用                  │
│  "采什么" — WHAT                                                   │
└──────────────────────────┬──────────────────────────────────────┘
                           │ PullInstanceChanges（增量拉取）
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      协调层 (Coordination Plane)                  │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              采集任务调度 — 协调层视角 (本模块)              │   │
│  │                                                          │   │
│  │  · 缓存实例数据（Redis 物化视图）                          │   │
│  │  · 维护 root_hash（全局一致性指纹）                        │   │
│  │  · 提供增量查询接口（Scheduler 按需拉取）                   │   │
│  │  · 降级时冻结数据，不影响已有采集                           │   │
│  │                                                          │   │
│  │  注意：不做调度决策，不做槽位分配，不做所有权协商             │   │
│  └──────────────────────────┬───────────────────────────────┘   │
│                             │                                    │
└─────────────────────────────┼────────────────────────────────────┘
                              │ QueryInstanceData（Scheduler 查询）
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      采集层 (Data Plane)                          │
│  Job Scheduler × N  →  Agent × M  →  OTel Collector             │
│  Scheduler 自治：Rendezvous Hashing 分配 + Gossip 拓扑同步        │
│  "谁来采" — HOW（Scheduler 自主决定）                              │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 设计目标

| 目标编号 | 描述 | 优先级 |
|---------|------|--------|
| G-01 | 控制面不可达时，协调层缓存数据仍可供 Scheduler 查询（L1 降级） | P0 |
| G-02 | Scheduler 增量拉取延迟 ≤5s（控制面有变更时） | P1 |
| G-03 | root_hash 一致时，Scheduler 可跳过逐条比对（高效对账） | P1 |
| G-04 | 协调层故障时，Scheduler 使用本地缓存继续运行 | P0 |
| G-05 | 支持 1~50 个 Scheduler 节点同时查询 | P1 |

### 1.3 适用场景

- 标准多 zone 监控部署，协调层仅部署于核心网区
- 区内含 1~50 个 Job Scheduler 节点
- 每个 Scheduler 独立运行 Rendezvous Hashing，不依赖协调层分配
- 控制面不可达时，协调层冻结最后已知数据，Scheduler 使用本地缓存

---

## 二、职责边界

### 2.1 本模块负责

| 职责 | 说明 |
|------|------|
| 实例数据缓存 | 从控制面增量拉取实例数据，缓存到 Redis |
| root_hash 维护 | 维护全局一致性指纹，供 Scheduler 快速对账 |
| 增量查询接口 | Scheduler 按需查询变更的实例数据 |
| 快照版本管理 | 记录每次从控制面拉取的时间戳作为 snapshot_version |
| 降级冻结 | 控制面不可达时冻结数据，标记降级状态 |

### 2.2 本模块不负责

| 不负责事项 | 归属 | 说明 |
|-----------|------|------|
| 调度决策（实例→节点映射） | Scheduler | Rendezvous Hashing 在 Scheduler 本地执行 |
| 拓扑感知（节点上下线） | Scheduler | Gossip 协议在 Scheduler 间运行 |
| 健康检测 | Scheduler | 本地健康检测合并入 Scheduler（DEC-017） |
| 冲突仲裁 | Scheduler | Gossip 收敛后冲突自动消除 |
| 定义采集目标 | 控制面 | 控制面是"采什么"的唯一权威 |
| 实际执行采集 | Agent | Agent 是纯执行器 |
| 跨区通信 | Zone Agent | Zone Agent 负责 M2/M3 接口 |

### 2.3 与其他模块的协作关系

```
┌──────────────────┐    ┌──────────────────────┐    ┌──────────────────┐
│  控制面            │───▶│  协调层 (本模块)       │◀───│  Job Scheduler × N │
│  实例注册表        │    │  Redis 缓存           │    │  自治调度           │
│  (WHAT)           │    │  数据中继              │    │  (HOW)            │
└──────────────────┘    └──────────────────────┘    └──────────────────┘
                               │                          │
                               │    QueryInstanceData     │
                               │◀─────────────────────────│
                               │──────────────────────────▶│
                               │    SyncResponse          │
                               │                          │
                               │    (Scheduler 间无协调层   │
                               │     参与，Gossip 直连)     │
```

**关键变化（v2.0）：**
- 协调层不再与 Scheduler 进行"Manifest 分发"——Scheduler 主动拉取
- 协调层不再管理槽位——Rendezvous Hashing 无需槽位
- 协调层不再参与所有权协商——Gossip 收敛自动解决冲突
- 协调层不再管理 Agent 调度——Scheduler 本地决定

---

## 三、功能清单

### 3.1 控制面数据同步

| 功能项 | 描述 |
|--------|------|
| F-1.1 增量拉取 | 定期向控制面查询 `updatetime > last_sync_time` 的变更记录 |
| F-1.2 全量校验 | 定期（默认 60s）执行全量比对，修正增量同步可能的遗漏 |
| F-1.3 快照版本管理 | 每次成功拉取后更新 `snapshot_version`（时间戳格式） |
| F-1.4 root_hash 计算 | 每次数据变更后重新计算 root_hash = hash(all instance_id + updatetime pairs) |
| F-1.5 降级检测 | 控制面连续 N 次拉取失败，标记为降级状态，冻结数据 |
| F-1.6 恢复追赶 | 控制面恢复后，执行全量同步追上缺失的变更 |

### 3.2 Scheduler 查询服务

| 功能项 | 描述 |
|--------|------|
| F-2.1 增量查询 | Scheduler 提供 `last_updatetime`，协调层返回之后的变更 |
| F-2.2 全量查询 | Scheduler 请求所有实例数据（首次同步或恢复时使用） |
| F-2.3 root_hash 查询 | Scheduler 请求当前 root_hash，用于快速一致性判断 |
| F-2.4 单实例查询 | 按 instance_id 查询完整实例数据（含凭据） |
| F-2.5 降级标记 | 响应中标记当前是否处于降级状态 |

### 3.3 数据管理

| 功能项 | 描述 |
|--------|------|
| F-3.1 实例数据存储 | Redis Hash `instance:{id}` 存储每个实例的完整字段 |
| F-3.2 实例索引 | Redis Set `all_instances` 存储所有 instance_id |
| F-3.3 时间线索引 | Redis Sorted Set `instance_timeline` 按 updatetime 排序 |
| F-3.4 数据过期 | 控制面通知实例删除时，从缓存中移除 |
| F-3.5 数据隔离 | 不同 zone 的数据使用 Redis key 前缀隔离 |

---

## 四、核心数据模型

### 4.1 Redis 数据结构

```
# 实例数据 — 每个实例一个 Hash
HSET instance:{instance_id}
  instance_id     "inst-001"
  job_name        "mysql-prod"
  agent_type      "scrape"
  host            "10.0.1.5"
  port            "3306"
  scheme          "http"
  metrics_path    "/metrics"
  scrape_interval "15s"
  auth_type       "basic"
  username        "monitor"          # 凭据合并入实例记录（DEC-016）
  password        "encrypted:xxx"    # 加密存储
  enabled         "1"
  zone_id         "zone-core"
  updatetime      "1727000000"
  ...

# 实例索引 — 所有 instance_id 的集合
SADD all_instances "inst-001" "inst-002" ...

# 时间线索引 — 按 updatetime 排序，支持增量查询
ZADD instance_timeline 1727000000 "inst-001"
ZADD instance_timeline 1727000005 "inst-002"

# 全局一致性指纹
SET root_hash "sha256:a1b2c3d4..."
SET snapshot_version "1727000100"

# 降级状态
SET degradation_status "normal" | "degraded"
SET last_control_plane_sync "1727000100"
```

### 4.2 InstanceRecord — 实例记录（Protobuf）

```protobuf
// InstanceRecord 是协调层缓存的核心数据结构
// 四层属性模型（DEC-016 凭据合并入实例记录）
message InstanceRecord {
  // === 身份层（极少变更）===
  string instance_id = 1;         // 全局唯一实例标识
  string job_name = 2;            // 所属 Job 名称
  string agent_type = 3;          // 所需 Agent 类型: scrape / snmp / probe

  // === 连接层（可能变更）===
  string host = 4;                // 目标地址（IP 或域名）
  int32 port = 5;                 // 目标端口
  string scheme = 6;              // 协议: http / https

  // === 配置层（偶尔变更）===
  string metrics_path = 7;        // 指标路径，默认 "/metrics"
  string scrape_interval = 8;     // 采集间隔，如 "15s", "30s"
  string auth_type = 9;           // 认证类型: none / basic / bearer / tls

  // === 凭据层（独立生命周期，合并入实例记录）===
  string username = 10;           // 认证用户名（basic auth）
  string password = 11;           // 认证密码（加密存储）
  string bearer_token = 12;       // Bearer Token
  string tls_cert = 13;           // TLS 客户端证书

  // === 管理元数据 ===
  bool enabled = 14;              // 管理启用/禁用（协调层视角）
  string zone_id = 15;            // 所属网区
  int64 updatetime = 16;          // 最后更新时间戳（变更检测用）
  map<string, string> labels = 17; // 附加标签
}
```

### 4.3 SyncRequest / SyncResponse — 同步协议

```protobuf
// Scheduler → 协调层 的查询请求
message SyncRequest {
  string scheduler_id = 1;         // 请求方 Scheduler 标识
  string zone_id = 2;              // 查询的网区

  // 查询模式
  oneof query {
    IncrementalQuery incremental = 3;  // 增量查询
    FullQuery full = 4;                // 全量查询
    HashQuery hash = 5;                // 仅查询 root_hash
  }
}

message IncrementalQuery {
  int64 since_updatetime = 1;      // 返回该时间之后的变更
}

message FullQuery {
  // 无额外参数，返回所有实例数据
}

message HashQuery {
  // 无额外参数，返回 root_hash 和 snapshot_version
}

// 协调层 → Scheduler 的响应
message SyncResponse {
  bool is_degraded = 1;            // 是否处于降级状态
  int64 snapshot_version = 2;      // 当前快照版本
  string root_hash = 3;            // 全局一致性指纹

  // 实例数据列表（hash 查询时为空）
  repeated InstanceRecord instances = 4;

  // 变更类型标记（增量查询时有效）
  repeated ChangeType change_types = 5;  // 与 instances 一一对应

  enum ChangeType {
    CHANGE_TYPE_UNSPECIFIED = 0;
    CHANGE_TYPE_CREATE = 1;
    CHANGE_TYPE_UPDATE = 2;
    CHANGE_TYPE_DELETE = 3;
  }
}
```

### 4.4 数据模型关系图

```
Redis 数据结构:

  instance:{id}  (Hash × N)
    ├── 身份层: instance_id, job_name, agent_type
    ├── 连接层: host, port, scheme
    ├── 配置层: metrics_path, scrape_interval, auth_type
    ├── 凭据层: username, password, bearer_token, tls_cert
    └── 元数据: enabled, zone_id, updatetime, labels

  all_instances  (Set)
    └── 所有 instance_id 的集合

  instance_timeline  (Sorted Set)
    └── score = updatetime, member = instance_id
        用于增量查询: ZRANGEBYSCORE instance_timeline {since} +inf

  root_hash  (String)
    └── sha256(all instance_id + updatetime pairs)
        Scheduler 用于快速一致性判断

  snapshot_version  (String)
    └── 最后一次从控制面成功拉取的时间戳
```

---

## 五、接口与交互

### 5.1 控制面 → 协调层

#### 5.1.1 PullInstanceChanges（增量拉取）

```
接口: PullInstanceChanges
方向: 协调层 → 控制面（主动拉取）
周期: 10s（正常）/ 30s（降级模式）
协议: gRPC (M2 接口)

请求:
  PullRequest {
    zone_id: string
    since_updatetime: int64    // 上次同步的时间戳
  }

响应:
  PullResponse {
    repeated InstanceRecord changes    // 变更的实例列表
    int64 latest_updatetime            // 最新的 updatetime
    bool has_more                      // 是否还有更多（分页）
  }

处理流程:
  1. 协调层定时向控制面发送 PullRequest
  2. 控制面返回 updatetime > since_updatetime 的所有变更
  3. 协调层更新 Redis 中的实例数据
  4. 重新计算 root_hash
  5. 更新 snapshot_version
  6. 若 has_more = true，继续拉取直到追平
```

#### 5.1.2 FullReconcile（全量校验）

```
接口: FullReconcile
方向: 协调层 → 控制面
周期: 60s
协议: gRPC

处理流程:
  1. 协调层从控制面拉取所有实例数据
  2. 与本地 Redis 数据逐条比对
  3. 修正差异（新增、更新、删除）
  4. 重新计算 root_hash
  5. 记录校验日志
```

### 5.2 Scheduler → 协调层

#### 5.2.1 QueryInstanceData（实例数据查询）

```
接口: QueryInstanceData
方向: Scheduler → 协调层
协议: gRPC
触发: Scheduler 启动 / 定期同步 / root_hash 不一致时

请求: SyncRequest (见 4.3)
响应: SyncResponse (见 4.3)

典型使用模式:
  1. Scheduler 先请求 root_hash（HashQuery）
  2. 与本地 root_hash 比较
  3. 相同 → 跳过，无需拉取
  4. 不同 → 发送增量查询（IncrementalQuery）
  5. 若增量查询结果仍不一致 → 发送全量查询（FullQuery）
```

### 5.3 交互时序图

#### 5.3.1 正常增量同步

```
控制面              协调层 (Redis)           Scheduler A         Scheduler B
  │                    │                       │                    │
  │                    │                       │                    │
  │◀─PullInstanceChanges─│                    │                    │
  │  (since=1000)      │                       │                    │
  │──changes(3 items)─▶│                       │                    │
  │                    │──更新 Redis──────       │                    │
  │                    │  HSET instance:{id}    │                    │
  │                    │  root_hash = "abc"     │                    │
  │                    │  snapshot_version=1010 │                    │
  │                    │                       │                    │
  │                    │◀────QueryInstanceData──│                    │
  │                    │      (HashQuery)       │                    │
  │                    │──root_hash="abc"──────▶│                    │
  │                    │                       │                    │
  │                    │  [hash 不同，需要拉取]  │                    │
  │                    │                       │                    │
  │                    │◀────QueryInstanceData──│                    │
  │                    │  (IncrementalQuery     │                    │
  │                    │   since=1000)          │                    │
  │                    │──3 changes────────────▶│                    │
  │                    │                       │                    │
  │                    │                       │  [本地更新]          │
  │                    │                       │  [Rendezvous Hash] │
  │                    │                       │  [重新计算分配]      │
  │                    │                       │                    │
  │                    │◀─────────────────────────────QueryInstanceData──│
  │                    │      (HashQuery)       │                    │
  │                    │──root_hash="abc"──────────────────────────────│
  │                    │                       │                    │
```

#### 5.3.2 控制面不可达 — 降级模式

```
控制面              协调层 (Redis)           Scheduler A
  │                    │                       │
  │  [网络中断]         │                       │
  │                    │                       │
  │◀─PullInstanceChanges─│ (超时)               │
  │  ... 重试失败 ...    │                       │
  │                    │                       │
  │                    │──标记降级状态           │
  │                    │  degradation_status     │
  │                    │  = "degraded"          │
  │                    │                       │
  │                    │◀────QueryInstanceData──│
  │                    │──root_hash="abc"──────▶│
  │                    │  is_degraded=true      │
  │                    │                       │
  │                    │  [Scheduler 知道数据    │
  │                    │   可能不是最新，但继续   │
  │                    │   使用缓存数据运行]     │
  │                    │                       │
  │                    │  [数据冻结，不再变更]    │
  │                    │  [Scheduler 本地缓存    │
  │                    │   仍可独立运行]         │
```

---

## 六、设计决策与替代方案

### 6.1 协调层定位

#### 当前方案：纯数据中继

协调层仅缓存控制面数据，为 Scheduler 提供查询接口。不做任何调度决策。

**优点：**
- 协调层故障不影响调度——Scheduler 使用本地缓存
- 实现简单——无需复杂的分布式状态管理
- 符合 P1 原则——管理在中心，调度在区内

**缺点：**
- 无法做全局最优调度——协调层不参与分配决策
- Scheduler 需要自行维护一致性——通过 Gossip 实现

#### 替代方案：智能协调（v1.0 方案，已废弃）

协调层生成 Zone Manifest、管理槽位、执行 VRRP 所有权协商、Epoch Fencing。

**废弃原因：**
- 协调层成为调度瓶颈和单点故障
- 槽位模型复杂度高（DEC-014 废弃）
- VRRP 在 2 节点场景有问题
- 与 Scheduler 自治原则冲突

### 6.2 缓存策略

#### 当前方案：Redis 物化视图

使用 Redis 作为控制面数据的缓存层，支持增量查询和 root_hash 快速比对。

**优点：**
- root_hash 比对使得一致时零开销
- Redis 查询性能优异，支持 50+ Scheduler 并发查询
- 增量查询减少网络传输

**缺点：**
- 引入 Redis 依赖
- 缓存与控制面可能短暂不一致

#### 替代方案：直连控制面

Scheduler 直接从控制面拉取数据，无需协调层缓存。

**评估：**
- 减少一层缓存，但增加控制面负载
- 跨区网络不稳定时，Scheduler 无法获取数据
- 协调层缓存提供了降级缓冲

### 6.3 root_hash 设计

```
root_hash 计算方式:

  1. 收集所有 (instance_id, updatetime) 对
  2. 按 instance_id 字典序排序
  3. 拼接为 "instance_id:updatetime\n" 格式
  4. 计算 SHA-256

  用途:
    - Scheduler 定期比对 root_hash
    - 相同 → 无需拉取（快速路径）
    - 不同 → 增量拉取变更

  更新频率:
    - 每次从控制面成功拉取后重新计算
    - 约每 10s 一次（正常同步周期）
```

---

## 七、开放问题

| 问题编号 | 问题 | 候选方案 | 当前倾向 |
|---------|------|---------|---------|
| OQ-01 | Redis 集群 vs 单实例？ | (a) 单实例 (b) Redis Cluster (c) Redis Sentinel | 阶段 1 单实例，阶段 3 评估集群 |
| OQ-02 | 大规模实例（10 万+）下 root_hash 计算性能？ | (a) 每次全量计算 (b) 增量更新 hash (c) 分片 hash | 建议 (b) 增量更新 |
| OQ-03 | 多 zone 数据隔离策略？ | (a) Redis key 前缀 (b) 独立 Redis 实例 (c) Redis DB 隔离 | 建议 (a)，key 前缀 `zone:{id}:` |
