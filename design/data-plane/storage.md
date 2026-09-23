# 存储层

> 版本：v2.0 | 日期：2026-09-23
> 状态：设计中

---

## 一、概述

存储层是平台中负责时序数据持久化的独立基础设施层。存储层与采集层（Worker）完全解耦——Worker（Grafana Alloy）只负责数据采集并 remote-write 到存储，不绑定特定存储实例。存储作为独立的一等公民，拥有自己的生命周期管理。

所有存储统一采用 VictoriaMetrics 作为时序存储引擎，保证查询语言（PromQL）和写入协议（remote-write）的一致性。

### 架构总览

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Worker-Storage 分离架构                                                   │
│                                                                          │
│   DC 节点 (Worker 侧)                         存储侧                    │
│   ┌────────────────────────┐                  ┌─────────────────────┐   │
│   │  Alloy                 │                  │  Storage Instance    │   │
│   │  (采集 + remote_write) │───── direct ────▶│  (vmstorage)        │   │
│   │                        │    write         │                     │   │
│   │                        │                  │  + vmalert          │   │
│   │                        │                  │  + Alertmanager     │   │
│   └────────────────────────┘                  └──────────┬──────────┘   │
│                                                          │              │
│   Worker 安装时选择关联存储（可多选）                       │              │
│   必须指定一个 prime（默认）存储                            │              │
│                                                          │              │
│   查询侧                                               │              │
│   ┌────────────────────────┐                  ┌──────────┴──────────┐   │
│   │  DC 网关                │                  │  vmselect           │   │
│   │  (目标分发+配置+通信)    │───── query ────▶│  (fan-out 聚合)     │   │
│   │                        │                  │  挂载所有 vmstorage  │   │
│   └────────────────────────┘                  └─────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

### 核心设计原则

| 原则 | 说明 |
|------|------|
| Worker-Storage 分离 | Worker 只采集，Storage 只存储，两者独立管理 |
| 存储是一等公民 | 每个存储实例有独立的生命周期、配置和监控 |
| Prime 机制 | Worker 安装时选择关联存储（可多选），必须指定一个 prime |
| 存储 + 告警共部署 | 每个存储实例与 vmalert + Alertmanager 作为单元部署 |
| 无 DC Proxy | Alloy 直接 remote-write 到存储，无中间代理 |
| vmselect 聚合查询 | 控制面板通过 vmselect fan-out 到所有 vmstorage 进行查询聚合 |

---

## 二、职责边界

**本文档负责**：
- 存储层的独立架构设计
- Worker-Storage 绑定模型（含 Prime 机制）
- 存储 + vmalert + Alertmanager 共部署模型
- VictoriaMetrics 作为统一存储引擎的设计决策
- 数据写入路径（Worker → Storage）
- 数据保留策略
- 去重机制
- 容量规划指导

**本文档不负责**：
- Alloy 的采集与写入实现（→ `data-plane/alloy.md`）
- vmalert 规则评估的详细设计（→ `data-plane/rc-rulecheck.md`）
- DC 网关的管控功能（目标分发、配置分发、通信、健康检测）
- vmselect 查询聚合的详细设计（→ `control-plane/query-gateway.md`）
- DC 网关的目标分发（→ DC 网关 http_sd 接口，参见 DEC-027）

---

## 三、功能清单

### 3.1 功能总览

| 功能模块 | 功能项 | 优先级 | 说明 |
|---------|--------|--------|------|
| 存储实例管理 | 存储实例创建与配置 | P0 | 独立创建 vmstorage 实例 |
| 存储实例管理 | 存储实例生命周期 | P0 | 创建、扩缩容、退役 |
| Worker-Storage 绑定 | Worker 安装时选择存储 | P0 | 支持多选 |
| Worker-Storage 绑定 | Prime 存储指定 | P0 | 必须指定一个 prime |
| Worker-Storage 绑定 | 告警规则分发到 prime | P0 | prime 接收告警规则 |
| 写入路径 | Alloy remote-write 到 vmstorage | P0 | 直接写入，无中间代理 |
| 写入路径 | 多存储写入（多写） | P1 | Worker 关联多个存储时 |
| 共部署 | vmalert + Alertmanager 共部署 | P0 | 与存储实例作为单元 |
| 数据保留 | 保留策略配置 | P0 | 按存储实例配置 |
| 去重 | vmselect 端去重 | P0 | -dedup + -replicationFactor |
| 标签管理 | 写入标签注入规范 | P0 | zone_id, alloy_instance_id 等 |
| 容量规划 | 存储容量估算 | P1 | 基于关联 Worker 的 target 数 |

### 3.2 Worker-Storage 绑定模型

#### 3.2.1 绑定关系

```
Worker-Storage 绑定:

  Worker (Alloy 实例)
    │
    ├── 关联存储 (可多选)
    │   ├── Storage-A [prime]  ← 默认存储，接收告警规则
    │   ├── Storage-B
    │   └── Storage-C
    │
    └── 写入行为:
        ├── remote-write → Storage-A (prime, 必写)
        ├── remote-write → Storage-B (非 prime, 多写)
        └── remote-write → Storage-C (非 prime, 多写)

  安装时配置:
    worker_install --storages=Storage-A,Storage-B,Storage-C \
                   --prime=Storage-A
```

#### 3.2.2 Prime 存储

| 特性 | 说明 |
|------|------|
| 定义 | Worker 关联的多个存储中的默认存储 |
| 数量 | 每个 Worker 有且仅有一个 prime |
| 职责 | 接收告警规则分发；作为 Worker 数据的主要存储 |
| 非 prime | 多写冗余、数据分流等用途视具体需求 |
| 变更 | prime 可重新指定（需重新分发告警规则） |

#### 3.2.3 绑定数据流

```
写入路径:

  Alloy (DC 节点)
    │
    │  remote-write (直接, 无 DC Proxy)
    │
    ├──▶ prime vmstorage (必写)
    ├──▶ storage-B (如果配置了多写)
    └──▶ storage-C (如果配置了多写)

  降级行为:
    · 某个 storage 不可达 → Alloy 本地缓冲，重试写入
    · 所有 storage 不可达 → Alloy 本地 WAL 保持，恢复后补写
    · Alloy 始终有本地 WAL 作为缓冲
```

### 3.3 存储 + 告警共部署

#### 3.3.1 部署单元

```
每个存储实例的部署单元:

  ┌──────────────────────────────────────────────────┐
  │  Storage Instance (部署单元)                       │
  │                                                    │
  │  ┌──────────────┐  ┌──────────┐  ┌─────────────┐ │
  │  │  vmstorage    │  │ vmalert  │  │Alertmanager │ │
  │  │  (数据存储)    │  │ (规则    │  │ (去重/分组/ │ │
  │  │              │  │  评估)   │  │  通知)      │ │
  │  └──────┬───────┘  └────┬─────┘  └──────┬──────┘ │
  │         │               │               │         │
  │         └───────────────┼───────────────┘         │
  │                         │                          │
  └─────────────────────────┼──────────────────────────┘
                            │
                            ▼
                    消息队列 → 平台
```

#### 3.3.2 告警链

```
完整告警链:

  Alloy → remote_write → vmstorage
                            ↓
                         vmselect (fan-out 聚合到所有 vmstorage)
                            ↓
                         vmalert (评估告警规则, 查询 vmselect)
                            ↓
                         Alertmanager (去重, 分组, 静默, 抑制)
                            ↓
                         消息队列 → 平台
```

vmalert 查询 vmselect 而非直接查询 vmstorage 的原因：
- vmselect fan-out 到所有 vmstorage，提供全局指标视图
- 告警规则可能需要跨存储的指标数据进行评估
- 统一查询入口，简化 vmalert 配置

### 3.4 VictoriaMetrics 存储引擎

#### 3.4.1 选型理由

| 评估维度 | VictoriaMetrics | Prometheus TSDB | InfluxDB | Thanos |
|---------|----------------|-----------------|----------|--------|
| PromQL 兼容 | 完全兼容 + VM 扩展 | 原生 | 不完全 | 完全兼容 |
| 远程写入 | 原生支持 | 不支持（需 Thanos） | 自有协议 | 原生支持 |
| 资源消耗 | 低（Go，优化内存） | 中 | 高 | 高（依赖多组件） |
| 长期存储 | 原生支持 | 有限 | 原生支持 | 依赖对象存储 |
| 集群模式 | VM Cluster | 无 | 企业版 | 原生 |
| 去重 | 原生支持 | 无 | 无 | 需配置 |
| 运维复杂度 | 低（单二进制） | 低 | 中 | 高 |

**[决策 P7]**：VictoriaMetrics 作为所有时序存储的标准引擎。

#### 3.4.2 VM 单实例 vs 集群

| 特性 | VM 单实例 | VM 集群 |
|------|----------|---------|
| 部署 | 单二进制，极简 | 多组件，较复杂 |
| 数据量 | 适合 <1M 活跃序列 | 适合 >1M 活跃序列 |
| 写入吞吐 | 单节点上限 | 水平扩展 |
| 查询吞吐 | 单节点上限 | vmselect 水平扩展 |
| HA | 无（需外部 HA 方案） | 内置（多副本） |
| 资源需求 | 低 | 高 |

存储实例可根据规模需求选择单实例或集群部署。

### 3.5 数据写入路径

#### 3.5.1 标签注入规范

所有写入的数据都经过标签注入，确保数据可追溯、可去重：

```yaml
必注入标签:
  zone_id: string              # 网区 ID
  alloy_instance_id: string    # Alloy 实例标识
  node_id: string              # 节点 ID
  instance: string             # 采集目标实例（来自 Target 定义）
  job: string                  # 任务组名（来自 Target 定义）

系统标签:
  __replica__: string          # 副本标识（集群内部使用）
  __name__: string             # 指标名称

可选标签:
  __instance_type__: string    # 实例类型（oracle/mysql/linux/windows）
  __metrics_path__: string     # 指标路径
  __scheme__: string           # 协议（http/https）
```

注：相比旧模型，移除了 `collector_id` 和 `slot_id`（Alloy 统一替代了 OTel Collector 和 Scheduler 的 slot 分配机制），新增 `alloy_instance_id`。

#### 3.5.2 写入路径

```
Worker 写入路径:

  Alloy → [remote-write] → vmstorage (prime)
       → [remote-write] → vmstorage (非 prime, 如果配置了多写)

  协议:
    POST /api/v1/write (单实例)
    POST /insert/0/prometheus/api/v1/write (集群, 经 vminsert)

  特点:
    · 直接写入，无 DC Proxy
    · Alloy 本地 WAL 保证数据不丢失
    · 写入失败自动重试（指数退避）
```

### 3.6 数据去重

#### 3.6.1 去重场景

在 Worker-Storage 分离架构下，去重主要发生在以下场景：
- Worker 关联多个存储时（多写），同一数据存在于多个 vmstorage
- vmselect fan-out 查询所有 vmstorage 时，可能返回重复数据

#### 3.6.2 去重机制

```
VictoriaMetrics 去重:

  vmselect 配置:
    -dedup.minScrapeInterval=15s
    -replicationFactor=N (如果启用了副本)

  去重键:
    (zone_id, alloy_instance_id, __name__, labels_hash, timestamp)

  含义:
    · zone_id: 同一网区
    · alloy_instance_id: 同一 Alloy 实例
    · __name__: 同一指标名
    · labels_hash: 同一标签组合
    · timestamp: 同一时间点

  当两个数据点的去重键完全相同时，保留最后写入的。
```

### 3.7 数据保留策略

#### 3.7.1 保留策略

| 存储类型 | 默认保留 | 可配置 | 说明 |
|---------|---------|--------|------|
| 标准存储 | 30 天 | 是 | 按存储实例配置 |
| 长期存储 | 365 天 | 是 | 可选热/温/冷分层 |
| 归档存储 | 自定义 | 是 | 对象存储后端 |

#### 3.7.2 保留策略配置

```yaml
RetentionConfig:
  storage_id: string                    # 存储实例 ID
  retention_period: duration            # 保留时长
  # 默认: 30d
  max_disk_usage: uint64                # 最大磁盘使用量
  retention_type: enum                  # time_based | size_based | hybrid

  # 分层存储（可选）
  tiering:
    hot:
      period: duration                  # 热数据时长（默认 30d）
      storage_type: ssd                 # SSD
    warm:
      period: duration                  # 温数据时长（30d-180d）
      storage_type: hdd                 # HDD
    cold:
      period: duration                  # 冷数据时长（180d-365d）
      storage_type: object_storage      # 对象存储
```

### 3.8 容量规划

#### 3.8.1 容量估算公式

```
存储容量估算:

  活跃序列数 (active_series) =
    Σ(关联 Worker 的 target_count × metrics_per_target)

  每日数据量 (daily_bytes) =
    active_series × samples_per_day × bytes_per_sample

  其中:
    samples_per_day = 86400 / scrape_interval (秒)
    bytes_per_sample ≈ 4 bytes (VM 压缩后)

  总存储容量 (total_storage) =
    daily_bytes × retention_days × replication_factor

示例:
  关联 Worker 总 target_count = 5000
  metrics_per_target = 100
  scrape_interval = 15s
  retention = 30d

  active_series = 5000 × 100 = 500,000
  samples_per_day = 86400 / 15 = 5,760
  daily_bytes = 500,000 × 5,760 × 4 bytes ≈ 11.5 GB
  total_storage = 11.5 GB × 30 = 345 GB
```

#### 3.8.2 推荐规格

| 场景 | 活跃序列数 | vmstorage 规格 | 存储 | 说明 |
|------|-----------|---------------|------|------|
| 小规模 | <100K | 4C8G | 100GB SSD | 单实例 |
| 中规模 | 100K-500K | 8C16G | 500GB SSD | 单实例或集群 |
| 大规模 | 500K-2M | 集群 6+ 进程 | 1TB+ SSD | 3 节点集群 |
| 超大规模 | >2M | 集群 9+ 进程 | 2TB+ NVMe | 3-5 节点集群 |

---

## 四、核心数据模型

### 4.1 StorageInstance（存储实例）

```yaml
StorageInstance:
  storage_id: string                    # 存储实例唯一标识
  zone_id: string                       # 所在网区
  vm_version: string                    # VictoriaMetrics 版本

  # 部署模式
  deploy_mode: enum                     # single | cluster
  single:                               # 单实例模式
    endpoint: string                    # vmstorage 地址
    resources:                          # 资源配置
      cpu: string
      memory: string
      disk: string
  cluster:                              # 集群模式
    vminsert:
      replicas: uint32
      endpoints: [string]
    storage:
      replicas: uint32
      replication_factor: uint32
      retention_period: duration
    vmselect:
      replicas: uint32
      endpoints: [string]

  # 告警共部署
  alerting:
    vmalert:
      enabled: bool                     # 是否部署 vmalert（默认 true）
      endpoint: string
    alertmanager:
      enabled: bool                     # 是否部署 Alertmanager（默认 true）
      endpoint: string

  # 状态
  status: enum                          # creating | running | degraded | retired
  is_prime_for: [string]                # 作为哪些 Worker 的 prime 存储
```

### 4.2 WorkerStorageBinding（Worker-存储绑定）

```yaml
WorkerStorageBinding:
  worker_id: string                     # Worker (Alloy 实例) ID
  zone_id: string                       # 所在网区

  # 关联存储列表
  storages:
    - storage_id: string                # 存储实例 ID
      is_prime: bool                    # 是否为 prime 存储
      write_enabled: bool               # 是否启用写入
      priority: uint32                  # 写入优先级

  # 写入配置
  write_config:
    remote_write_timeout: duration      # 写入超时
    max_retries: uint32                 # 最大重试次数
    retry_backoff: duration             # 重试退避
    wal_config:                         # WAL 配置
      segment_size: uint64
      max_segments: uint32
```

### 4.3 StorageCapacity（存储容量信息）

```yaml
StorageCapacity:
  storage_id: string                    # 存储实例 ID
  zone_id: string
  timestamp: timestamp

  # 规模指标
  active_series: uint64                 # 当前活跃序列数
  bound_workers: uint32                 # 关联的 Worker 数
  total_targets: uint32                 # 关联 Worker 的总 target 数
  metrics_per_target: float             # 平均每 target 指标数

  # 存储使用
  total_bytes: uint64                   # 总存储空间
  used_bytes: uint64                    # 已使用空间
  utilization: float                    # 使用率
  retention_days: uint32                # 当前保留天数
  daily_ingest_bytes: uint64            # 每日写入量
```

### 4.4 DeduplicationConfig（去重配置）

```yaml
DeduplicationConfig:
  storage_id: string                    # 存储实例 ID
  enabled: bool                         # 是否启用去重
  min_scrape_interval: duration         # 最小抓取间隔（去重窗口）
  dedup_key_fields: [string]            # 去重键字段
  # 默认: [zone_id, alloy_instance_id, __name__, labels_hash, timestamp]
  replication_factor: uint32            # 副本因子（集群模式）
  conflict_resolution: enum             # 冲突解决策略
  # LAST_WRITE: 保留最后写入的
```

---

## 五、接口与交互

### 5.1 Alloy → vmstorage (Remote Write)

```
Alloy                                   vmstorage / vminsert
  │                                          │
  │  POST /api/v1/write                      │
  │  Content-Type: application/x-protobuf    │
  │  Content-Encoding: snappy                │
  │  X-Prometheus-Remote-Write-Version: 1.0  │
  │                                          │
  │  WriteRequest {                          │
  │    timeseries: [                         │
  │      {                                   │
  │        labels: [                         │
  │          {name: "__name__", value: "up"},│
  │          {name: "zone_id", value: "z1"}, │
  │          {name: "alloy_instance_id",     │
  │           value: "alloy-node-01"},       │
  │          {name: "instance", value: "..."},│
  │          ...                             │
  │        ],                                │
  │        samples: [                        │
  │          {value: 1.0, timestamp: ...}    │
  │        ]                                 │
  │      }                                   │
  │    ]                                     │
  │  }                                       │
  │─────────────────────────────────────────▶│
  │                                          │
  │  200 OK                                  │
  │◀─────────────────────────────────────────│
  │                                          │
  │  集群模式时:                               │
  │  POST /insert/0/prometheus/api/v1/write  │
  │  → vminsert 分发到 storage 节点           │
```

### 5.2 vmselect → vmstorage (查询 Fan-out)

```
vmselect                                vmstorage 实例
  │                                          │
  │  GET /api/v1/query                       │
  │  ?query=up{zone_id="z1"}                 │
  │  &time=2026-09-23T10:00:00Z              │
  │─────────────────────────────────────────▶│ storage-1
  │─────────────────────────────────────────▶│ storage-2
  │─────────────────────────────────────────▶│ storage-3
  │                                          │
  │  Response (from each)                    │
  │◀─────────────────────────────────────────│
  │◀─────────────────────────────────────────│
  │◀─────────────────────────────────────────│
  │                                          │
  │  vmselect 内部:                           │
  │  1. 并行 fan-out 到所有 storage           │
  │  2. 收集结果                              │
  │  3. 合并 + 去重                           │
  │  4. 返回统一结果                           │
```

### 5.3 vmalert → vmselect (规则评估查询)

```
vmalert                                 vmselect
  │                                          │
  │  GET /api/v1/query                       │
  │  ?query=rate(http_requests_total[5m])    │
  │  &time=...                               │
  │─────────────────────────────────────────▶│
  │                                          │
  │  vmselect fan-out 到所有 vmstorage       │
  │  合并返回                                 │
  │                                          │
  │  Response                                │
  │◀─────────────────────────────────────────│
  │                                          │
  │  vmalert 内部:                            │
  │  1. 评估告警规则                           │
  │  2. 触发告警 → Alertmanager               │
```

---

## 六、设计决策与替代方案

### DEC-STOR-01：统一存储引擎选型

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：VictoriaMetrics（当前） | 所有存储统一使用 VM | 一致性好；运维简单；资源效率高 | 绑定单一供应商 |
| B：Prometheus TSDB | 使用原生 Prometheus 存储 | 生态原生 | 无集群模式；长期存储弱；无去重 |
| C：混合（VM + Prometheus） | 按场景选择不同引擎 | 灵活性 | 运维复杂度大幅增加 |
| D：Thanos | 基于 Thanos 的长期存储 | 功能丰富 | 依赖对象存储；运维复杂 |

**[决策 P7]**：方案 A。VictoriaMetrics 在资源效率、集群支持、去重能力方面全面优于替代方案。单一供应商的风险通过 VM 的 PromQL 兼容性缓解（迁移成本低）。

### DEC-STOR-02：Worker-Storage 分离

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：分离（当前） | Worker 与 Storage 独立管理 | 独立扩缩；生命周期解耦；简化 DC 节点 | 需要额外的绑定管理 |
| B：绑定（旧模式） | 每个区固定存储模式（Mode A/B/C） | 简单 | 灵活性差；升级困难；DC 节点复杂 |

**[决策 2026-09-23]**：方案 A。存储独立后，DC 节点只需 Alloy 一个进程，极大简化。Worker 通过 remote-write 直接写存储，无需 DC Proxy。目标发现由 DC 网关通过 http_sd 提供。存储可独立扩缩、独立运维。

### DEC-STOR-03：Prime 存储机制

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：Prime 机制（当前） | 多选中指定一个 prime | 告警规则有明确分发目标；简单 | 需要管理 prime 指定 |
| B：所有存储均等 | 无 prime 概念，所有存储同等对待 | 简单 | 告警规则分发目标不明确 |
| C：自动选择 | 系统自动选择负载最低的作为 prime | 自动化 | 增加复杂度；告警规则分发不稳定 |

**[决策 2026-09-23]**：方案 A。Prime 机制简单明确，告警规则分发到 prime 存储，职责清晰。

### DEC-STOR-04：存储 + 告警共部署

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：共部署（当前） | vmstorage + vmalert + AM 作为单元 | 部署简单；告警与数据同区 | 资源耦合 |
| B：独立部署 | vmalert 独立于存储部署 | 灵活 | 增加部署复杂度；查询路径更长 |

**[决策 2026-09-23]**：方案 A。vmalert 查询 vmselect（fan-out 到所有 vmstorage），共部署简化了部署和运维。Alertmanager 与 vmalert 同部署减少通知路径延迟。

### DEC-STOR-05：DC Proxy 移除

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：无 DC Proxy（当前） | Alloy 直接 remote-write 到存储 | DC 节点极简；减少故障点 | 需要网络直达 |
| B：保留 DC Proxy | 保留中间代理层 | 可做流量控制 | DC 节点复杂；额外故障点 |

**[决策 2026-09-23]**：方案 A。DC Proxy 在 Worker-Storage 分离后不再必要。Alloy 自带 WAL 和重试机制，可安全地直接写入存储。DC 节点进程数从 5+ 减少到 1（仅 Alloy）。

---

## 七、冲突与开放问题

| ID | 问题 | 影响 | 状态 |
|----|------|------|------|
| STOR-01 | 多写场景下的带宽成本评估 | Worker 关联多个存储时的网络开销 | 待评估 |
| STOR-02 | Prime 存储故障时的告警规则切换策略 | 告警规则是否需要自动迁移到新的 prime | 待确认 |
| STOR-03 | 存储加密需求：静态加密 vs 传输加密 | 影响安全合规 | 待确认 |
| STOR-04 | VM 版本升级策略：滚动升级 vs 蓝绿部署 | 影响升级期间的数据可用性 | 待确认 |
| STOR-05 | Worker 关联存储数量上限 | 过多关联会导致写入放大 | 待确认 |
| STOR-06 | 存储实例间的负载均衡策略 | 多个存储实例如何均匀分配 Worker | 待确认 |
| STOR-07 | vmselect 全局 fan-out 的性能上限 | 当前规模可接受，未来可能需要智能路由 | 待观察 |

---

## 八、废弃内容

> 以下内容在 v2.0（2026-09-23）中废弃，保留索引以供追溯。

| 废弃项 | 原内容 | 替代方案 |
|--------|--------|----------|
| Mode A/B/C 存储模式 | 三种存储模式分类 | Worker-Storage 分离模型，存储作为独立层 |
| 中心 VM 概念 | 中心/本地二级存储 | 存储实例平级管理，无中心/本地之分 |
| Zone Query Proxy | 区内查询代理 | vmselect fan-out 聚合（通过 DC 网关） |
| collector_id / slot_id 标签 | OTel Collector 和 Slot 标识 | alloy_instance_id 替代 |
| Mode B 双写 | 本地 + 中心双写 | Worker 多存储写入（prime + 非 prime） |
