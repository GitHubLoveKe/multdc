# OTel Collector 数据管道

> 版本：v1.0 | 日期：2026-09-21
> 状态：设计中

---

## 一、概述

OTel Collector 是基于 OpenTelemetry Collector 构建的统一数据管道，部署在每个采集节点的本地。它接收来自各类 Agent 推送的采集数据，经过标签注入、格式化、批处理等加工后，根据网区存储模式路由到不同的输出目标——中心 VictoriaMetrics（所有模式）、本地 VM 实例（mode B/C）或本地 VM 集群（mode C）。

OTel Collector 不参与采集调度，不感知 slot 归属，不执行规则评估。它的职责纯粹而聚焦：**接收数据、加工数据、路由数据**。

### 核心定位

```
┌──────────────────────────────────────────────────────────────────┐
│ Node                                                              │
│                                                                    │
│  Agent 集群                                                        │
│  ┌────────┐ ┌────────┐ ┌────────┐                                │
│  │ Scrape │ │  SNMP  │ │ Probe  │  ...                           │
│  └───┬────┘ └───┬────┘ └───┬────┘                                │
│      │          │          │                                       │
│      └──────────┼──────────┘                                       │
│                 │ push (OTLP)                                       │
│                 ▼                                                   │
│  ┌──────────────────────────────────────────────────────────┐     │
│  │              OTel Collector (每节点一个)                    │     │
│  │                                                            │     │
│  │  ┌──────────┐   ┌──────────────┐   ┌──────────────┐     │     │
│  │  │ Receiver │──▶│  Processor   │──▶│  Exporter    │     │     │
│  │  │          │   │              │   │              │     │     │
│  │  │ · OTLP   │   │ · label 注入 │   │ · remote-write│    │     │
│  │  │ · Prom   │   │ · batch      │   │ · local VM   │     │     │
│  │  │ · (扩展) │   │ · filter     │   │ · VM cluster │     │     │
│  │  │          │   │ · transform  │   │ · (扩展)     │     │     │
│  │  └──────────┘   └──────────────┘   └──────────────┘     │     │
│  └──────────────────────────────────────────────────────────┘     │
│                 │                                                   │
│      ┌──────────┼──────────────┐                                   │
│      ▼          ▼              ▼                                   │
│  中心 VM    本地 VM       本地 VM 集群                               │
│  (所有模式)  (mode B/C)    (mode C)                                 │
└──────────────────────────────────────────────────────────────────┘
```

---

## 二、职责边界

**本文档负责**：
- OTel Collector 的 pipeline 架构设计（Receiver → Processor → Exporter）
- 各 pipeline 组件的配置与行为定义
- 按存储模式的输出路由策略
- 数据格式化与标签注入规则
- 写缓冲与重试机制（per-exporter）
- 背压处理与流量控制
- 配置管理与热更新
- 部署模型（per-node vs per-zone）

**本文档不负责**：
- Agent 的采集执行逻辑（→ `data-plane/agent.md`）
- 存储后端（VM）的部署与运维（→ `data-plane/storage.md`）
- RC 规则评估（→ `data-plane/rc-rulecheck.md`）
- 数据查询接口（→ `data-plane/zone-query-proxy.md`）
- 跨区数据传输（→ `cross-plane/`）

---

## 三、功能清单

### 3.1 功能总览

| 功能模块 | 功能项 | 优先级 | 说明 |
|---------|--------|--------|------|
| Receiver | OTLP HTTP Receiver | P0 | 接收 Agent 推送的 OTLP 数据 |
| Receiver | OTLP gRPC Receiver | P1 | 高性能场景 |
| Receiver | Prometheus Receiver（兼容） | P2 | 向后兼容直接 scrape 场景 |
| Processor | 标签注入 (zone_id, collector_id, slot_id) | P0 | 所有数据自动注入 |
| Processor | Batch 批处理 | P0 | 减少下游写入次数 |
| Processor | Filter 过滤 | P1 | 按指标名/标签过滤 |
| Processor | Transform 转换 | P1 | 指标名重映射、标签变换 |
| Exporter | Remote-Write Exporter (→ 中心 VM) | P0 | 所有模式均启用 |
| Exporter | Local VM Exporter (→ 本地 VM) | P0 (mode B/C) | 本地存储写入 |
| Exporter | VM Cluster Exporter (→ vminsert) | P0 (mode C) | 集群写入 |
| 缓冲 | Per-exporter 写缓冲 | P0 | 下游故障时缓冲 |
| 缓冲 | 缓冲溢出策略 | P0 | 丢弃/阻塞/磁盘溢出 |
| 背压 | 下游慢时的背压传导 | P0 | 不阻塞独立 exporter |
| 配置 | 配置热更新（无重启） | P0 | 从 Zone Agent 获取配置 |
| 配置 | 配置版本追踪 | P1 | 确保配置一致性 |
| 可观测 | Collector 自身指标暴露 | P0 | /metrics 端点 |

### 3.2 Pipeline 架构详解

#### 3.2.1 Receiver 层

Receiver 负责接收 Agent 推送的数据，是数据管道的入口。

```
Agent 数据入口：

  Scrape Agent ──OTLP/HTTP──▶ ┌────────────────────┐
  SNMP Agent ──OTLP/HTTP──▶   │   OTLP Receiver     │
  Probe Agent ──OTLP/HTTP──▶  │   (port 4318)       │
  Oracle Agent ──OTLP/HTTP──▶ │                     │
  MySQL Agent ──OTLP/HTTP──▶  └──────────┬──────────┘
  Windows Agent ──OTLP/HTTP──▶            │
                                          ▼
                                   Pipeline 处理链
```

Receiver 配置：

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: "0.0.0.0:4318"          # OTLP HTTP 默认端口
        max_request_body_size: "10MB"     # 最大请求体
        include_metadata: true             # 保留 Agent 传入的 metadata
      grpc:
        endpoint: "0.0.0.0:4317"          # OTLP gRPC 默认端口
        max_recv_msg_size_mib: 16          # 最大消息大小

  # 可选：兼容直接 Prometheus scrape
  prometheus:
    config:
      scrape_configs: []                   # 由 Job Scheduler 动态填充
```

#### 3.2.2 Processor 层

Processor 对数据进行加工处理，按配置顺序依次执行。

```
数据流经 Processor 链：

  OTLP Receiver
      │
      ▼
  ┌─────────────────────────────────────────────────────┐
  │ Processor Chain                                      │
  │                                                       │
  │  1. Attributes Processor (标签注入)                   │
  │     ├── zone_id: 从配置注入                           │
  │     ├── collector_id: 本 Collector 唯一标识           │
  │     ├── node_id: 本节点标识                           │
  │     └── 保留 Agent 传入的 slot_id, agent_id          │
  │                                                       │
  │  2. Filter Processor (可选过滤)                       │
  │     ├── 按指标名过滤 (drop/include)                   │
  │     └── 按标签值过滤                                  │
  │                                                       │
  │  3. Transform Processor (可选转换)                    │
  │     ├── 指标名重映射                                  │
  │     ├── 标签重命名                                    │
  │     └── 值类型转换                                    │
  │                                                       │
  │  4. Batch Processor (批处理)                          │
  │     ├── 按时间窗口聚合 (默认 5s)                      │
  │     ├── 按数据量上限 (默认 1000 条)                   │
  │     └── 超时强制刷新                                  │
  │                                                       │
  └─────────────────────────────────────────────────────┘
      │
      ▼
  Exporter 路由层
```

Processor 配置示例：

```yaml
processors:
  # 标签注入
  attributes:
    actions:
      - key: zone_id
        value: "${ZONE_ID}"                # 从环境变量注入
        action: upsert
      - key: collector_id
        value: "${COLLECTOR_ID}"
        action: upsert
      - key: node_id
        value: "${NODE_ID}"
        action: upsert

  # 过滤
  filter:
    metrics:
      exclude:
        match_type: regexp
        metric_names:
          - "debug_.*"                     # 排除调试指标

  # 批处理
  batch:
    send_batch_size: 1000                  # 批次大小上限
    send_batch_max_size: 2000              # 硬上限
    timeout: 5s                            # 批次超时

  # 内存限制
  memory_limiter:
    check_interval: 1s
    limit_mib: 512                         # 内存使用上限
    spike_limit_mib: 128                   # 突发预留
```

#### 3.2.3 Exporter 层

Exporter 负责将处理后的数据写入目标存储。不同存储模式下，启用的 Exporter 组合不同。

```
Exporter 路由矩阵：

                    Mode A          Mode B          Mode C
                    (无本地存储)     (本地 VM)        (本地 VM 集群)
  ┌─────────────────────────────────────────────────────────────┐
  │ Remote-Write Exporter (→ 中心 VM)    │ ✅ 启用    │ ✅ 启用    │ ✅ 可选    │
  │ Local VM Exporter (→ 本地 VM)        │ ❌ 不启用  │ ✅ 启用    │ ❌ 不启用  │
  │ VM Cluster Exporter (→ vminsert)     │ ❌ 不启用  │ ❌ 不启用  │ ✅ 启用    │
  └─────────────────────────────────────────────────────────────┘
```

Exporter 配置：

```yaml
exporters:
  # 远程写入中心 VM (所有模式)
  prometheusremotewrite/center:
    endpoint: "${CENTER_VM_ENDPOINT}/api/v1/write"
    remote_write_queue:
      queue_size: 10000
      num_consumers: 5
    external_labels:
      zone_id: "${ZONE_ID}"
    retry_on_failure:
      enabled: true
      initial_interval: 1s
      max_interval: 30s
      max_elapsed_time: 300s

  # 本地 VM 单实例 (mode B)
  prometheusremotewrite/local_vm:
    endpoint: "http://localhost:8428/api/v1/write"
    remote_write_queue:
      queue_size: 5000
      num_consumers: 3
    retry_on_failure:
      enabled: true
      initial_interval: 500ms
      max_interval: 10s

  # 本地 VM 集群 vminsert (mode C)
  prometheusremotewrite/vm_cluster:
    endpoint: "http://vminsert:8480/insert/0/prometheus/api/v1/write"
    remote_write_queue:
      queue_size: 10000
      num_consumers: 8
    retry_on_failure:
      enabled: true
      initial_interval: 500ms
      max_interval: 10s
```

### 3.3 输出路由策略

#### 3.3.1 Mode A 路由

```
Agent → OTel Collector → Remote-Write Exporter → 中心 VM

特点：
  · 单路输出，最简单
  · 所有数据直接写入中心
  · 中心不可达时数据丢失（无本地缓冲）
  · 适用于边缘/低优先级网区
```

#### 3.3.2 Mode B 路由（双写）

```
Agent → OTel Collector ──┬── Remote-Write Exporter → 中心 VM
                         │
                         └── Local VM Exporter → 本地 VM (7 天保留)

特点：
  · 双路输出，独立运行
  · 本地 VM 提供短期查询能力
  · 中心 VM 提供长期存储
  · 两个 Exporter 独立缓冲、独立重试
  · 一个 Exporter 故障不影响另一个
```

#### 3.3.3 Mode C 路由

```
Agent → OTel Collector ──┬── VM Cluster Exporter → vminsert → VM 集群
                         │
                         └── Remote-Write Exporter → 中心 VM (可选)

特点：
  · 主输出到本地 VM 集群
  · 可选远程写入中心（用于跨区查询或灾备）
  · VM 集群提供 HA 本地存储
  · 关键网区推荐
```

#### 3.3.4 Exporter 独立性保证

```
关键设计：Exporter 之间完全独立

  Processor (batch)
      │
      ├──fan-out──▶ Exporter A (center)    独立队列、独立重试
      │                                      独立错误处理
      │
      ├──fan-out──▶ Exporter B (local VM)  独立队列、独立重试
      │                                      独立错误处理
      │
      └──fan-out──▶ Exporter C (cluster)   独立队列、独立重试
                                             独立错误处理

  如果一个 Exporter 的下游变慢：
    · 该 Exporter 的队列堆积
    · memory_limiter 触发背压
    · 其他 Exporter 不受影响（独立队列）
    · Agent 推送不受影响（Collector 仍接收）

  极端情况：所有 Exporter 都慢
    · memory_limiter 限制内存使用
    · 触发背压到 Receiver
    · Agent 收到 THROTTLED 响应
    · Agent 启动本地缓冲
```

### 3.4 写缓冲与重试

#### 3.4.1 缓冲架构

```
Exporter 内部缓冲模型：

  ┌────────────────────────────────────────────────┐
  │ Exporter                                        │
  │                                                  │
  │  ┌──────────┐   ┌──────────┐   ┌──────────┐   │
  │  │ Incoming  │──▶│  Queue   │──▶│ Consumer │──▶│ Target
  │  │ Buffer    │   │ (内存)   │   │ Pool     │   │
  │  └──────────┘   └──────────┘   └──────────┘   │
  │                                                  │
  │  Queue 参数：                                     │
  │    queue_size: 最大排队数据条数                    │
  │    num_consumers: 并发写入线程数                   │
  │                                                  │
  │  队列满时行为：                                    │
  │    · 阻塞新数据进入（backpressure）               │
  │    · 或丢弃最老数据（可配置）                      │
  └────────────────────────────────────────────────┘
```

#### 3.4.2 重试策略

| 参数 | 默认值 | 说明 |
|------|--------|------|
| initial_interval | 1s | 首次重试间隔 |
| max_interval | 30s | 最大重试间隔 |
| max_elapsed_time | 300s | 最大重试总时间 |
| multiplier | 2.0 | 退避倍数 |

重试行为：
- 仅对可重试错误重试（网络超时、5xx 错误）
- 不对 4xx 错误重试（数据格式错误，重试无意义）
- 超过最大重试时间后，数据被丢弃并记录告警指标

### 3.5 配置管理

#### 3.5.1 配置来源

OTel Collector 的配置由控制面统一管理，通过 Zone Agent 下发到每个节点：

```
Control Plane
    │
    │  生成 OTel 配置 (zone 级别)
    │  包含：receiver/processor/exporter 配置
    │
    ▼
Zone Agent
    │
    │  广播到区内所有节点
    │
    ▼
Job Scheduler (每个节点)
    │
    │  写入 OTel Collector 配置文件
    │  触发 Collector 热更新
    │
    ▼
OTel Collector
    │
    │  检测配置文件变更
    │  热加载新配置（不重启）
    │  保持正在处理的数据不丢失
```

#### 3.5.2 配置结构

```yaml
# OTel Collector 配置 (zone 级别，所有节点相同)
otel_collector_config:
  version: uint64                      # 配置版本号
  zone_id: string                      # 所属网区
  storage_mode: enum                   # A | B | C

  receivers:                           # Receiver 配置
    otlp:
      http_endpoint: string
      grpc_endpoint: string

  processors:                          # Processor 配置
    label_injection:
      zone_id: string
      external_labels: map<string, string>
    batch:
      send_batch_size: uint32
      timeout: duration
    filter:
      exclude_patterns: [string]

  exporters:                           # Exporter 配置 (按 storage_mode 裁剪)
    center_remote_write:
      endpoint: string
      queue_size: uint32
      retry: RetryConfig
    local_vm:                          # mode B only
      endpoint: string
      queue_size: uint32
      retry: RetryConfig
    vm_cluster:                        # mode C only
      endpoint: string
      queue_size: uint32
      retry: RetryConfig

  service:
    pipelines:
      metrics:
        receivers: [otlp]
        processors: [label_injection, filter, batch]
        exporters: [...]               # 根据 storage_mode 动态生成
```

#### 3.5.3 热更新机制

```
配置更新流程：
    │
    ▼
1. Zone Agent 推送新配置文件 (version N+1)
    │
    ▼
2. Job Scheduler 写入配置文件
    │
    ▼
3. 发送 SIGHUP 或调用 /-/reload API
    │
    ▼
4. OTel Collector 加载新配置
   ├── 对比新旧配置 diff
   ├── 新增 Exporter → 初始化并加入 pipeline
   ├── 删除 Exporter → 排空队列后移除
   ├── 修改 Processor → 原子替换
   └── 修改 Receiver → 平滑切换（不丢弃进行中的请求）
    │
    ▼
5. 返回 reload 结果 (success/error)
```

---

## 四、核心数据模型

### 4.1 CollectorConfig（Collector 配置）

```yaml
CollectorConfig:
  config_version: uint64              # 配置版本号
  zone_id: string                     # 所属网区
  collector_id: string                # 本 Collector 唯一标识
  node_id: string                     # 所在节点
  storage_mode: enum                  # A | B | C
  updated_at: timestamp               # 配置更新时间

  pipeline:                           # Pipeline 配置
    receivers: ReceiverConfig[]
    processors: ProcessorConfig[]
    exporters: ExporterConfig[]
    service: ServiceConfig            # Pipeline 组装配置
```

### 4.2 ExporterState（Exporter 运行状态）

```yaml
ExporterState:
  exporter_id: string                 # Exporter 标识
  exporter_type: string               # remote_write | local_vm | vm_cluster
  target_endpoint: string             # 目标地址
  state: enum                         # ACTIVE | DEGRADED | DOWN | RECOVERING

  # 队列状态
  queue:
    current_size: uint32              # 当前队列大小
    max_size: uint32                  # 队列上限
    utilization: float                # 使用率 (0.0 ~ 1.0)

  # 写入统计
  stats:
    total_writes: uint64              # 总写入次数
    success_writes: uint64            # 成功写入次数
    failed_writes: uint64             # 失败写入次数
    avg_latency_ms: float             # 平均写入延迟
    last_success_at: timestamp        # 最后成功时间
    last_error: string                # 最后错误信息

  # 重试状态
  retry:
    in_retry: bool                    # 是否正在重试
    retry_count: uint32               # 当前重试次数
    next_retry_at: timestamp          # 下次重试时间
```

### 4.3 PipelineMetrics（Pipeline 指标）

```yaml
PipelineMetrics:
  collector_id: string
  timestamp: timestamp

  # 接收统计
  receiver:
    total_received: uint64            # 总接收数据条数
    receive_rate: float               # 接收速率 (条/秒)
    active_connections: uint32        # 活跃连接数

  # 处理统计
  processor:
    total_processed: uint64           # 总处理数据条数
    total_filtered: uint64            # 被过滤的数据条数
    batch_count: uint64               # 批次数
    avg_batch_size: float             # 平均批次大小

  # 导出统计 (per exporter)
  exporters:
    - exporter_id: string
      total_exported: uint64          # 总导出数据条数
      export_rate: float              # 导出速率
      queue_utilization: float        # 队列使用率
      error_rate: float               # 错误率

  # 资源使用
  resources:
    memory_usage_mib: float           # 内存使用 (MiB)
    cpu_usage: float                  # CPU 使用率
    goroutines: uint32                # Go 协程数 (如适用)
```

### 4.4 DataEnvelope（数据信封）

```yaml
DataEnvelope:
  # Agent 注入的元数据
  metadata:
    agent_id: string                  # 来源 Agent
    agent_type: string                # Agent 类型
    slot_id: uint32                   # 所属 slot
    epoch_token: string               # 当前 epoch
    scrape_timestamp: timestamp       # 采集时间

  # Collector 注入的标签
  labels:
    zone_id: string                   # 网区 ID
    collector_id: string              # Collector ID
    node_id: string                   # 节点 ID

  # 指标数据
  metrics:                            # OTLP MetricsData
    resource_metrics: [...]
```

---

## 五、接口与交互

### 5.1 Agent → OTel Collector

```
Agent                                   OTel Collector
  │                                          │
  │  POST /v1/metrics (OTLP HTTP)           │
  │  Content-Type: application/x-protobuf    │
  │  { resource_metrics: [...] }             │
  │─────────────────────────────────────────▶│
  │                                          │  Receiver 接收
  │                                          │  Processor 处理
  │                                          │  Exporter 路由
  │  200 OK                                  │
  │◀─────────────────────────────────────────│
  │                                          │
  │  或                                       │
  │                                          │
  │  429 Too Many Requests                   │  背压信号
  │  Retry-After: 5                          │
  │◀─────────────────────────────────────────│
  │                                          │
  │  或                                       │
  │                                          │
  │  503 Service Unavailable                 │  Collector 过载
  │◀─────────────────────────────────────────│
```

| 接口 | 方向 | 协议 | 说明 |
|------|------|------|------|
| PushMetrics | Agent → Collector | OTLP/HTTP POST | 指标数据推送 |
| HealthCheck | Agent → Collector | HTTP GET /health | Collector 健康检查 |
| Ready | Agent → Collector | HTTP GET /ready | Collector 就绪检查 |

### 5.2 OTel Collector → 中心 VM

```
OTel Collector                          中心 VictoriaMetrics
  │                                          │
  │  POST /api/v1/write (Remote Write)       │
  │  Content-Type: application/x-protobuf    │
  │  X-Prometheus-Remote-Write-Version: 1.0  │
  │  { timeseries: [...] }                   │
  │─────────────────────────────────────────▶│
  │                                          │  写入 VM
  │  200 OK                                  │
  │◀─────────────────────────────────────────│
  │                                          │
```

### 5.3 OTel Collector → 本地 VM (Mode B)

```
OTel Collector                          本地 VictoriaMetrics
  │                                          │
  │  POST /api/v1/write                      │
  │  (同 Remote Write 协议)                   │
  │─────────────────────────────────────────▶│
  │                                          │  写入本地 VM
  │  200 OK                                  │  (短期保留, 如 7 天)
  │◀─────────────────────────────────────────│
  │                                          │
```

### 5.4 OTel Collector → VM 集群 (Mode C)

```
OTel Collector                          VM 集群 (vminsert)
  │                                          │
  │  POST /insert/{accountID}/prometheus/    │
  │       api/v1/write                       │
  │─────────────────────────────────────────▶│
  │                                          │  vminsert 分发到
  │  200 OK                                  │  storage nodes
  │◀─────────────────────────────────────────│
  │                                          │
```

### 5.5 配置管理接口

```
Zone Agent                              OTel Collector
  │                                          │
  │  PushConfig(config, version)             │
  │─────────────────────────────────────────▶│
  │                                          │  热加载配置
  │  ConfigAck(version, status)              │
  │◀─────────────────────────────────────────│
  │                                          │
  │  GetConfigVersion()                      │
  │─────────────────────────────────────────▶│
  │                                          │
  │  ConfigVersion(version)                  │
  │◀─────────────────────────────────────────│
  │                                          │
```

### 5.6 可观测性接口

```
OTel Collector 暴露指标：

  GET /metrics                              # Prometheus 格式自身指标
  GET /health                               # 健康检查
  GET /ready                                # 就绪检查
  GET /debug/pipeline                       # Pipeline 拓扑（调试用）
  GET /debug/exporters                      # Exporter 状态（调试用）
```

---

## 六、设计决策与替代方案

### DEC-OTEL-01：Collector 部署粒度

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：Per-node（当前推荐） | 每个节点一个 Collector | 简单；无额外网络跳数；无额外单点 | 节点数多时 Collector 实例多 |
| B：Per-zone 集群 | 每个区部署一个 Collector 集群 | 集中管理；资源利用率高 | 额外网络跳数；Collector 成为单点/瓶颈 |
| C：混合模式 | 小区 per-node，大区 per-zone | 灵活 | 两种部署模式增加运维复杂度 |

**[建议]**：方案 A（Per-node）。Agent 与 Collector 在同一节点，推送延迟最低，无网络依赖。Collector 故障只影响本节点，不影响其他节点。VM 的轻量特性使得 per-node 部署的资源开销可接受。

### DEC-OTEL-02：输出路由策略

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：静态路由（当前） | 根据 storage_mode 在配置时确定 Exporter 组合 | 简单；可预测 | 不够灵活 |
| B：动态路由 | 运行时根据下游健康状态动态调整路由 | 自适应；高可用 | 实现复杂；可能导致数据重复或丢失 |
| C：条件路由 | 基于标签/指标名条件路由到不同 Exporter | 精细控制 | 配置复杂 |

**[建议]**：方案 A（静态路由）。storage_mode 是网区级别的稳定属性，不需要运行时动态调整。方案 B 的自适应路由虽然吸引人，但引入了数据一致性的复杂度（双写时如何去重）。

### DEC-OTEL-03：缓冲策略

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：内存缓冲（当前推荐） | 数据在内存中排队 | 快速；低延迟 | 进程崩溃时数据丢失 |
| B：磁盘缓冲 | 数据写入本地磁盘排队 | 持久化；崩溃安全 | 延迟高；磁盘 IO 瓶颈 |
| C：混合缓冲 | 内存 + 磁盘溢出 | 平衡速度与持久性 | 实现复杂 |

**[建议]**：阶段 1 用方案 A（内存缓冲）。监控数据允许少量丢失（下个采集周期会覆盖）。阶段 2 评估方案 C（混合缓冲），当网络不稳定导致数据丢失率过高时。

### DEC-OTEL-04：配置管理方式

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：控制面推送（当前） | 控制面生成配置，通过 Zone Agent 下发 | 集中管理；一致性保证 | 依赖跨区通道 |
| B：本地配置文件 | 每个节点手动配置 | 离线可用 | 配置漂移风险；运维成本高 |
| C：etcd 存储 | 配置存储在 etcd，Collector 主动拉取 | 实时性好；版本管理 | 引入 etcd 依赖 |

**[建议]**：方案 A。与 Zone Manifest 的下发机制一致，复用现有通道。降级时（L1），Collector 使用最后已知配置继续运行。

### DEC-OTEL-05：双写一致性

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：独立双写（当前） | 两个 Exporter 独立写入，不保证完全一致 | 简单；互不影响 | 中心和本地的数据可能有时间差 |
| B：事务双写 | 两个 Exporter 同时成功或同时失败 | 强一致 | 性能差；一个慢则都慢 |
| C：主写+异步复制 | 先写本地，异步复制到中心 | 本地优先；不影响采集 | 复制延迟；可能丢数据 |

**[建议]**：方案 A（独立双写）。监控数据的「一致性」要求远低于业务数据。中心和本地的数据时间差是可接受的，查询时通过 Query Gateway 处理。

---

## 七、冲突与开放问题

| ID | 问题 | 影响 | 状态 |
|----|------|------|------|
| C14 | Collector 部署粒度未最终确认（per-node vs per-zone） | 影响架构复杂度和资源使用 | 待确认 |
| C13 | 输出路由策略：静态 vs 动态 | 影响故障自适应能力 | 待确认 |
| OT-01 | Mode B 双写时中心与本地的数据去重策略 | 影响查询准确性 | 待确认 |
| OT-02 | Collector 内存限制的配置策略：固定值 vs 按节点资源比例 | 影响不同规格节点的适应性 | 待确认 |
| OT-03 | 大规模指标（>100K 条/秒/节点）时 Collector 的性能表现 | 影响大区的可行性 | 待压测 |
| OT-04 | OTel Collector 版本升级策略：与 OTLP 协议版本的兼容性管理 | 影响升级路径 | 待确认 |
| OT-05 | 磁盘缓冲的必要性评估：网络不稳定区的数据丢失容忍度 | 影响数据完整性 | 待确认 |
| OT-06 | Collector 自身指标的采集方式：自暴露 vs 外部采集 | 影响可观测性 | 待确认 |
