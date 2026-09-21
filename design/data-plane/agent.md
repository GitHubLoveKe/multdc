# Agent 采集器

> 版本：v1.0 | 日期：2026-09-21
> 状态：设计中

---

## 一、概述

Agent 是采集层（Data Plane）中的多类型采集执行器。每个 Job Scheduler 节点上运行多种类型的 Agent，由 Job Scheduler 统一调度。Agent 的设计哲学是「简单执行」——接收采集指令、执行数据采集、将结果推送到本地 OTel Collector。

Agent 不参与 slot 归属协商，不知道 epoch fencing，不直接连接存储后端。这种刻意的「愚笨」设计使得 Agent 可以专注于采集质量，同时大幅降低分布式协调的复杂度。

### 核心定位

```
┌──────────────────────────────────────────────────────────────────┐
│ Node                                                              │
│                                                                    │
│  ┌──────────────────────┐                                         │
│  │ Job Scheduler        │                                         │
│  │  (调度决策)           │                                         │
│  └──────────┬───────────┘                                         │
│             │ HTTP/gRPC 采集指令                                    │
│             ▼                                                      │
│  ┌──────────────────────────────────────────────────────────┐     │
│  │ Agent 集群 (多类型共存)                                    │     │
│  │                                                            │     │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐               │     │
│  │  │ Scrape   │  │  SNMP    │  │  Probe   │               │     │
│  │  │ Agent    │  │  Agent   │  │  Agent   │  ...          │     │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘               │     │
│  │       │              │              │                      │     │
│  │       └──────────────┼──────────────┘                      │     │
│  │                      │ push 采集数据                        │     │
│  └──────────────────────┼──────────────────────────────────────┘     │
│                         ▼                                      │
│  ┌──────────────────────┐                                         │
│  │ OTel Collector       │                                         │
│  │  (数据管道)           │                                         │
│  └──────────────────────┘                                         │
└──────────────────────────────────────────────────────────────────┘
```

---

## 二、职责边界

**本文档负责**：
- Agent 类型定义与能力声明
- Agent 生命周期管理（注册、健康检查、任务分配、下线）
- 数据采集执行逻辑（各类型 Agent 的采集实现）
- Agent → OTel Collector 的数据推送协议
- Agent 的本地缓冲与背压处理
- Agent 的插件化扩展架构

**本文档不负责**：
- Agent 的调度决策（→ `data-plane/job-scheduler.md`）
- OTel Collector 的数据处理与导出（→ `data-plane/otel-collector.md`）
- Slot 归属协商与 peer 检测（→ `data-plane/job-scheduler.md`）
- 采集任务定义（TaskSpec）的生成（→ `control-plane/`）
- 凭据的实际获取与注入（→ `credential-service.md`）

---

## 三、功能清单

### 3.1 Agent 类型矩阵

| Agent 类型 | 采集目标 | 协议 | 返回格式 | 典型场景 |
|-----------|---------|------|---------|---------|
| Scrape Agent | HTTP/HTTPS 端点 | HTTP GET | Prometheus text/exposition | 标准 Prometheus 指标采集 |
| SNMP Agent | 网络设备、 legacy 系统 | SNMP v2c/v3 | 指标键值对 | 路由器、交换机、打印机 |
| Probe Agent | TCP/HTTP 端点 | TCP/HTTP | 拨测结果（延迟、状态） | 可用性探测、延迟测量 |
| Oracle Agent | Oracle 数据库 | Oracle JDBC/SQL | Oracle 特有指标 | 表空间、会话、SGA/PGA |
| MySQL Agent | MySQL 数据库 | MySQL protocol | MySQL 特有指标 | 连接数、查询、复制状态 |
| Windows Agent | Windows 主机 | WMI/WinRM | Windows 性能计数器 | CPU、内存、磁盘、服务 |
| Custom Agent | 可扩展 | 自定义 | 可配置 | 未来扩展的插件架构 |

### 3.2 Scrape Agent

Scrape Agent 是最核心的采集类型，实现标准 Prometheus HTTP scrape 语义。

```
Scrape Agent 执行流程：
    │
    ▼
1. 接收采集指令 (target endpoint + config)
    │
    ▼
2. 构造 HTTP GET 请求
   ├── URL: {scheme}://{endpoint}{metrics_path}
   ├── Headers: Accept, Authorization (if credential_ref)
   └── Timeout: scrape_timeout
    │
    ▼
3. 发送请求，接收响应
   ├── 200 OK → 解析响应体
   ├── 非 200 → 记录错误，返回失败
   └── 超时 → 记录超时，返回失败
    │
    ▼
4. 解析 Prometheus 格式响应
   ├── 解析 metric name、labels、value、timestamp
   ├── 注入外部标签 (zone_id, slot_id, agent_id)
   └── 过滤 (honor_labels 配置)
    │
    ▼
5. 构造 OTLP 数据格式
    │
    ▼
6. 推送到本地 OTel Collector
   ├── 成功 → 记录成功指标
   └── 失败 → 本地缓冲，退避重试
```

### 3.3 SNMP Agent

SNMP Agent 通过 SNMP 协议采集网络设备和 legacy 系统的指标。

```
SNMP Agent 执行流程：
    │
    ▼
1. 接收采集指令 (target + SNMP config)
   ├── host:port
   ├── SNMP version (v2c/v3)
   ├── community string / USM 配置 (credential_ref)
   └── OID 列表 (walk 或 get)
    │
    ▼
2. 执行 SNMP 操作
   ├── SNMP Walk: 遍历 OID 子树
   ├── SNMP Get: 获取指定 OID 值
   └── SNMP GetBulk: 批量获取 (v2c/v3)
    │
    ▼
3. 解析 SNMP 响应
   ├── OID → metric name 映射 (MIB 转换)
   ├── 值类型转换 (Counter32 → counter, Gauge32 → gauge)
   └── 索引提取 (ifIndex → interface label)
    │
    ▼
4. 构造指标数据 + 推送到 OTel Collector
```

### 3.4 Probe Agent

Probe Agent 执行轻量级的可用性探测和延迟测量。

```
Probe Agent 支持的探测类型：
    │
    ├── HTTP Probe
    │   ├── HTTP GET/HEAD/POST
    │   ├── 检查状态码、响应时间、TLS 证书有效期
    │   └── 可选：检查响应体内容匹配
    │
    ├── TCP Probe
    │   ├── TCP 连接建立测试
    │   ├── 测量连接建立延迟
    │   └── 可选：发送/接收自定义数据
    │
    ├── ICMP Probe
    │   ├── ICMP Echo Request/Reply
    │   ├── 测量 RTT (round-trip time)
    │   └── 计算丢包率
    │
    └── DNS Probe
        ├── DNS 查询测试
        ├── 测量解析延迟
        └── 验证解析结果
```

Probe Agent 输出指标：

```yaml
ProbeResult:
  probe_type: string                # http / tcp / icmp / dns
  target: string                    # 探测目标地址
  success: bool                     # 探测是否成功
  latency_ms: float                 # 延迟 (ms)
  status_code: uint32               # HTTP 状态码 (仅 HTTP probe)
  tls_cert_expiry_days: int32       # TLS 证书到期天数 (仅 HTTPS)
  dns_resolve_ms: float             # DNS 解析延迟 (仅 DNS probe)
  timestamp: timestamp              # 探测时间
```

### 3.5 数据库专用 Agent

#### 3.5.1 Oracle Agent

```
Oracle Agent 采集指标：
    │
    ├── 实例级指标
    │   ├── 活跃会话数 / 最大会话数
    │   ├── SGA/PGA 内存使用
    │   ├── 数据库状态 (OPEN/MOUNTED)
    │   └── 实例运行时间
    │
    ├── 性能指标
    │   ├── DB Time / CPU Time
    │   ├── 逻辑读 / 物理读
    │   ├── 解析次数 / 硬解析次数
    │   └── 等待事件统计
    │
    └── 表空间指标
        ├── 表空间使用率
        ├── 可用空间
        └── 自动扩展状态
```

#### 3.5.2 MySQL Agent

```
MySQL Agent 采集指标：
    │
    ├── 连接指标
    │   ├── 当前连接数 / 最大连接数
    │   ├── 连接拒绝数
    │   └── 线程状态分布
    │
    ├── 查询指标
    │   ├── QPS (queries per second)
    │   ├── 慢查询数
    │   └── 查询类型分布 (SELECT/INSERT/UPDATE/DELETE)
    │
    ├── 复制指标
    │   ├── 主从延迟 (seconds behind master)
    │   ├── IO 线程状态
    │   └── SQL 线程状态
    │
    └── InnoDB 指标
        ├── Buffer Pool 使用率
        ├── 行锁等待
        └── 死锁检测
```

### 3.6 Windows Agent

```
Windows Agent 采集方式：
    │
    ├── WMI (Windows Management Instrumentation)
    │   ├── Win32_PerfFormattedData_* 类
    │   ├── 本地采集，无需额外配置
    │   └── 适用于 Windows Server 2012+
    │
    └── WinRM (Windows Remote Management)
        ├── 远程采集 Windows 主机
        ├── 需要凭据 (credential_ref)
        └── 适用于无法安装 exporter 的环境

Windows Agent 采集指标：
    ├── CPU 使用率 (User/System/Idle)
    ├── 内存使用 (Available/Committed)
    ├── 磁盘 IO (Read/Write bytes/sec)
    ├── 网络 IO (Bytes sent/received)
    ├── 服务状态 (Running/Stopped)
    └── 事件日志 (Error/Warning count)
```

### 3.7 Custom Agent 插件架构

```
Custom Agent 插件接口：

┌─────────────────────────────────────────────┐
│ Agent Plugin Interface                       │
│                                               │
│  ┌──────────────┐  ┌──────────────┐         │
│  │  Capability   │  │  Collection  │         │
│  │  Declaration  │  │  Execution   │         │
│  │              │  │              │         │
│  │  · agent_type│  │  · collect() │         │
│  │  · config    │  │  · health()  │         │
│  │    schema    │  │  · stop()    │         │
│  │  · version   │  │              │         │
│  └──────────────┘  └──────────────┘         │
│                                               │
│  ┌──────────────┐  ┌──────────────┐         │
│  │  Data Output  │  │  Lifecycle   │         │
│  │              │  │              │         │
│  │  · format()  │  │  · init()    │         │
│  │  · push()    │  │  · start()   │         │
│  │              │  │  · shutdown()│         │
│  └──────────────┘  └──────────────┘         │
└─────────────────────────────────────────────┘

插件加载方式：
  · 动态链接库 (.so / .dll)
  · 独立进程 (subprocess)
  · WebAssembly (WASM) — 未来探索
```

### 3.8 Agent 生命周期

#### 3.8.1 注册

Agent 启动时向本地 Job Scheduler 注册，声明自身能力：

```
Agent                                  Job Scheduler
  │                                         │
  │  AgentRegistration                      │
  │  { agent_type, capacity,                │
  │    supported_protocols, version }       │
  │────────────────────────────────────────▶│
  │                                         │  校验 Agent 类型
  │                                         │  记录到 Agent 表
  │  AgentRegistrationResponse              │  分配初始 target (如果有)
  │  { agent_id, status: WARMING }          │
  │◀────────────────────────────────────────│
  │                                         │
```

#### 3.8.2 健康监控

Job Scheduler 周期性（默认 5s）检查 Agent 健康状态：

```
Job Scheduler                          Agent
  │                                       │
  │  HealthCheck(agent_id)                │
  │──────────────────────────────────────▶│
  │                                       │  检查内部状态
  │  HealthResponse                       │  ├── 进程存活
  │  { state, current_targets,            │  ├── 内存使用
  │    consecutive_errors, load }         │  └── 最近采集结果
  │◀──────────────────────────────────────│
  │                                       │
```

健康判定规则：

| 条件 | 判定 | 动作 |
|------|------|------|
| 连续 3 次 HealthCheck 无响应 | ERROR | 暂停分配新 target |
| 连续 5 次 HealthCheck 无响应 | OFFLINE | 触发 target 重分配 |
| consecutive_errors > 10 | QUARANTINED | 隔离，等待恢复 |
| 内存使用 > 80% capacity | DEGRADED | 减少 target 分配 |
| 恢复正常 | HEALTHY | 恢复 target 分配 |

#### 3.8.3 任务分配

Job Scheduler 向 Agent 发送采集指令：

```
Job Scheduler                          Agent
  │                                       │
  │  CollectionInstruction                │
  │  { target, interval, timeout,         │
  │    credential_ref, labels }           │
  │──────────────────────────────────────▶│
  │                                       │  启动采集循环
  │                                       │  每 interval 执行一次采集
  │                                       │  数据推送到 OTel Collector
  │  CollectionReport (per scrape)        │
  │◀──────────────────────────────────────│
  │  { success, duration, error }         │
  │                                       │
```

#### 3.8.4 优雅下线

```
Job Scheduler                          Agent
  │                                       │
  │  RevokeAllTasks(agent_id, reason)     │
  │──────────────────────────────────────▶│
  │                                       │  停止所有采集循环
  │                                       │  等待进行中的采集完成
  │                                       │  刷新本地缓冲到 OTel Collector
  │  ShutdownComplete(agent_id)           │
  │◀──────────────────────────────────────│
  │                                       │
  │  (Agent 进程退出)                      │
```

---

## 四、核心数据模型

### 4.1 AgentDescriptor（Agent 描述符）

```yaml
AgentDescriptor:
  agent_id: string                    # Agent 唯一标识 (格式: {node_id}-{type}-{seq})
  agent_type: string                  # scrape | snmp | probe | oracle | mysql | windows | custom
  node_id: string                     # 所在节点 ID
  state: enum                         # REGISTER | WARMING | HEALTHY | ERROR | OFFLINE | QUARANTINED
  capacity: uint32                    # 最大可承载 target 数
  current_load: uint32               # 当前承载 target 数
  supported_protocols: [string]       # 支持的协议列表
  version: string                     # Agent 版本号
  registered_at: timestamp            # 注册时间
  last_health_check: timestamp        # 最后健康检查时间
  consecutive_errors: uint32          # 连续错误次数
  config:                             # Agent 特有配置
    scrape:
      max_response_size: uint64       # 最大响应体大小
      decompression: bool             # 是否支持 gzip 解压
    snmp:
      max_repetitions: uint32         # SNMP bulk walk 最大重复次数
      timeout: duration               # SNMP 操作超时
    probe:
      default_timeout: duration       # 默认探测超时
      max_redirects: uint32           # HTTP 最大重定向次数
```

### 4.2 CollectionTask（采集任务）

```yaml
CollectionTask:
  task_id: string                     # 任务唯一标识
  slot_id: uint32                     # 所属 slot
  epoch_token: string                 # 当前 epoch
  target:                             # 采集目标
    instance_id: string               # 实例台账 ID
    endpoint: string                  # 采集地址 (host:port)
    metrics_path: string              # 指标路径
    scheme: string                    # http | https
    agent_type_required: string       # 所需 Agent 类型
  scrape_interval: duration           # 采集间隔
  scrape_timeout: duration            # 采集超时
  credential_ref: string              # 凭据引用
  labels:                             # 附加标签
    zone_id: string
    slot_id: string
    agent_id: string
    node_id: string
    __instance_type__: string
    job: string
  output:                             # 数据输出配置
    collector_endpoint: string        # OTel Collector 地址
    protocol: string                  # otlp_http | otlp_grpc | prometheus_rw
  state: enum                         # PENDING | RUNNING | PAUSED | CANCELLED
  assigned_at: timestamp              # 分配时间
  last_scrape_at: timestamp           # 最后采集时间
  last_scrape_result: enum            # SUCCESS | FAILED | TIMEOUT
```

### 4.3 ScrapeResult（采集结果）

```yaml
ScrapeResult:
  task_id: string                     # 关联的采集任务
  timestamp: timestamp                # 采集时间
  duration_ms: float                  # 采集耗时 (ms)
  success: bool                       # 是否成功
  error: string                       # 错误信息 (失败时)

  # 采集数据 (成功时)
  metrics:                            # 指标数据
    - metric_name: string
      metric_type: enum               # gauge | counter | histogram | summary
      labels: map<string, string>
      value: float64
      timestamp: timestamp

  # 统计信息
  stats:
    response_size_bytes: uint64       # 响应体大小
    metrics_count: uint32             # 采集到的指标数量
    parse_duration_ms: float          # 解析耗时
    push_duration_ms: float           # 推送到 Collector 的耗时
```

### 4.4 AgentBuffer（Agent 本地缓冲）

```yaml
AgentBuffer:
  agent_id: string                    # 所属 Agent
  max_size_bytes: uint64              # 最大缓冲大小 (默认 64MB)
  current_size_bytes: uint64          # 当前缓冲大小
  buffered_items: uint32              # 缓冲的数据条目数
  max_items: uint32                   # 最大缓冲条目数
  oldest_item: timestamp              # 最老缓冲数据的时间戳
  overflow_policy: enum               # DROP_OLDEST | REJECT_NEW | PAUSE

  # 背压状态
  backpressure:
    active: bool                      # 是否处于背压状态
    reason: string                    # 背压原因 (collector_slow | network_error | disk_full)
    started_at: timestamp             # 背压开始时间
    drain_rate: float                 # 缓冲消耗速率 (items/sec)
```

---

## 五、接口与交互

### 5.1 Agent → OTel Collector 数据推送

Agent 采集到数据后，推送到本节点的 OTel Collector：

```
Agent                                  OTel Collector
  │                                         │
  │  PushMetrics (OTLP HTTP/gRPC)           │
  │  { resource_metrics: [...],             │
  │    resource_labels: {                   │
  │      zone_id, agent_id, slot_id,        │
  │      node_id, instance_id               │
  │    }                                    │
  │  }                                      │
  │────────────────────────────────────────▶│
  │                                         │  处理数据
  │  PushResponse                           │  (label 注入, batch, export)
  │  { status: OK | THROTTLED | ERROR }     │
  │◀────────────────────────────────────────│
  │                                         │
```

推送协议选型：

| 协议 | 格式 | 优点 | 缺点 | 推荐度 |
|------|------|------|------|--------|
| OTLP/HTTP | OTLP JSON/Protobuf over HTTP | 标准；生态兼容；可调试 | 性能中等 | **推荐** |
| OTLP/gRPC | OTLP Protobuf over gRPC | 高性能；流式；类型安全 | 调试较难 | 推荐（高性能场景） |
| Prometheus Remote-Write | Prometheus RW 协议 | 与 Prometheus 生态完全兼容 | 仅支持 Prometheus 格式 | 兼容模式 |
| 自定义二进制 | 自定义格式 | 最高性能 | 无生态兼容；维护成本高 | 不推荐 |

### 5.2 背压与缓冲机制

```
正常流程：
  Agent ──采集──▶ 数据 ──push──▶ OTel Collector ──OK──▶ 完成

Collector 慢（背压）：
  Agent ──采集──▶ 数据 ──push──▶ OTel Collector ──THROTTLED──▶ 缓冲
                                                              │
                                                              ▼
                                                         本地缓冲区
                                                         (内存 + 可选磁盘)
                                                              │
                                                         退避重试
                                                         (指数退避, 最大 30s)
                                                              │
                                                         缓冲满？
                                                         ├── 否 → 继续缓冲
                                                         └── 是 → 触发溢出策略
                                                              ├── DROP_OLDEST (丢弃最老数据)
                                                              └── PAUSE (暂停采集)
```

背压处理规则：

| Collector 响应 | Agent 行为 | 说明 |
|---------------|-----------|------|
| OK | 正常推送 | 无特殊处理 |
| THROTTLED (429) | 降低推送频率，数据缓冲 | 尊重 Collector 的限流信号 |
| ERROR (5xx) | 数据缓冲，指数退避重试 | 最大重试 10 次，间隔 1s → 30s |
| 无响应（超时） | 数据缓冲，标记 Collector 不可达 | 连续 3 次超时进入背压状态 |
| 缓冲满 | 根据策略：丢弃或暂停 | 防止 Agent OOM |

### 5.3 Agent 内部接口汇总

| 接口 | 方向 | 协议 | 说明 |
|------|------|------|------|
| RegisterAgent | Agent → JS | HTTP/gRPC | Agent 注册到 Job Scheduler |
| HealthCheck | JS → Agent | HTTP | Job Scheduler 健康检查 |
| AssignTask | JS → Agent | HTTP/gRPC | 分配采集任务 |
| RevokeTask | JS → Agent | HTTP/gRPC | 撤销采集任务 |
| CollectionReport | Agent → JS | HTTP/gRPC | 采集结果上报（元数据，非数据本身） |
| PushMetrics | Agent → OTel | OTLP HTTP/gRPC | 采集数据推送到 OTel Collector |
| GetCredential | Agent → CredService | HTTP | 获取采集凭据（通过凭据引用） |

### 5.4 Agent 与外部组件交互全景

```
                    ┌─────────────────────────────────────┐
                    │         Job Scheduler                 │
                    │  (注册/健康检查/任务分配/撤销)          │
                    └──────────────┬──────────────────────┘
                                   │
                    ┌──────────────┼──────────────────────┐
                    │              │                        │
                    │   ┌──────────▼──────────┐           │
                    │   │       Agent          │           │
                    │   │                      │           │
                    │   │  1. 接收采集指令      │           │
                    │   │  2. 获取凭据 ───────────────────▶│ Credential Service
                    │   │  3. 执行采集 ───────────────────▶│ Target (HTTP/SNMP/DB)
                    │   │  4. 格式化数据        │           │
                    │   │  5. 推送数据 ───────────────────▶│ OTel Collector
                    │   │  6. 上报结果 ───────────────────▶│ Job Scheduler
                    │   │                      │           │
                    │   └──────────────────────┘           │
                    │                                      │
                    └──────────────────────────────────────┘
```

---

## 六、设计决策与替代方案

### DEC-AGENT-01：Agent 部署模型

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：单进程多类型（当前） | 一个 Agent 进程支持多种采集类型 | 资源占用少；部署简单 | 单点故障影响所有类型；类型间资源竞争 |
| B：每类型独立进程 | 每种 Agent 类型一个独立进程 | 隔离性好；独立升级 | 资源占用多；进程管理复杂 |
| C：混合模式 | 核心类型（Scrape）独立进程，其他类型合并 | 平衡隔离与资源 | 部署配置复杂 |

**[建议]**：阶段 1 用方案 A（单进程多类型），降低部署复杂度。阶段 2 评估方案 C（混合模式），当特定类型 Agent 需要独立扩缩容时。

### DEC-AGENT-02：Agent → Collector 协议选型

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：OTLP/HTTP（当前推荐） | 使用 OTLP 标准协议 over HTTP | 标准；生态兼容；可调试 | 性能中等 |
| B：OTLP/gRPC | 使用 OTLP over gRPC streaming | 高性能；低延迟 | 调试较难；需要 gRPC 支持 |
| C：Prometheus Remote-Write | 使用 Prometheus RW 协议 | 与 Prometheus 生态完全兼容 | 仅 Prometheus 格式；非标准数据管道 |
| D：自定义二进制 | 自定义高效二进制协议 | 最高性能 | 无生态兼容；维护成本高 |

**[建议]**：方案 A（OTLP/HTTP）。OTel Collector 原生支持 OTLP，Agent 使用 OTLP 推送是最自然的选择。高性能场景可升级到方案 B。

### DEC-AGENT-03：Agent 数据推送模式

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：即时推送（当前） | 每次采集后立即推送到 Collector | 数据实时性好；简单 | 推送频率高时 Collector 压力大 |
| B：批量推送 | 缓存 N 次采集结果后批量推送 | 减少推送次数；Collector 友好 | 数据延迟增加；缓冲管理复杂 |
| C：Collector 拉取 | Agent 缓存数据，Collector 主动拉取 | Collector 控制节奏 | 架构反转；Agent 需要暴露接口 |

**[建议]**：方案 A（即时推送）。采集间隔通常 15-60s，推送频率可控。OTel Collector 的 batch processor 已在 Collector 侧实现了批量处理，无需在 Agent 侧重复实现。

### DEC-AGENT-04：凭据获取方式

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：Agent 直接获取（当前） | Agent 通过 credential_ref 向凭据服务获取 | 简单；端到端加密 | Agent 需要凭据服务访问权限 |
| B：Scheduler 注入 | Job Scheduler 获取凭据后注入采集指令 | Agent 不接触凭据服务 | Scheduler 成为凭据暴露点 |
| C：本地凭据缓存 | 节点上部署凭据代理，Agent 从本地获取 | 减少网络调用；离线可用 | 本地凭据安全面 |

**[建议]**：方案 A。Agent 通过 credential_ref 向独立凭据服务获取凭据，凭据不经过 Job Scheduler 中转，减少暴露面。方案 C 作为降级优化。

### DEC-AGENT-05：插件架构选型

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：进程内插件 | 动态链接库 (.so/.dll) 加载 | 高性能；共享内存 | 语言绑定；崩溃影响主进程 |
| B：子进程插件 | 独立进程通过 stdin/stdout 通信 | 隔离性好；语言无关 | IPC 开销；进程管理复杂 |
| C：WASM 插件 | WebAssembly 沙箱执行 | 安全沙箱；跨平台 | 性能开销；WASM 生态不成熟 |

**[建议]**：阶段 1 暂不实现插件架构，内置所有 Agent 类型。阶段 2 评估方案 B（子进程插件），当需要支持第三方扩展时。

---

## 七、冲突与开放问题

| ID | 问题 | 影响 | 状态 |
|----|------|------|------|
| C11 | Scheduler → Agent 调度协议未最终定义（HTTP vs gRPC） | 影响 Agent 接口实现和性能 | 待确认 |
| C12 | Agent → Collector 协议和格式未最终确认（OTLP vs RW vs 自定义） | 影响数据管道兼容性和性能 | 待确认 |
| C3 | 异构 Agent 部署与均分策略的冲突：不同节点可能有不同的 Agent 类型组合 | 影响 slot 分配和 target 调度 | 待确认 |
| AG-01 | Agent 单进程多类型时的资源隔离：某类型 Agent 内存泄漏影响其他类型 | 影响节点稳定性 | 待确认 |
| AG-02 | Agent 本地缓冲的持久化策略：纯内存 vs 内存+磁盘 | 影响 Collector 故障时的数据丢失风险 | 待确认 |
| AG-03 | 数据库专用 Agent（Oracle/MySQL）的连接池管理：长连接 vs 短连接 | 影响数据库负载和采集延迟 | 待确认 |
| AG-04 | SNMP Agent 的 MIB 库管理：内置 vs 动态加载 | 影响设备兼容性和部署大小 | 待确认 |
| AG-05 | Agent 版本升级策略：滚动升级 vs 全量升级 | 影响升级期间的采集连续性 | 待确认 |
| AG-06 | Custom Agent 的安全沙箱：如何防止恶意插件影响节点 | 影响平台安全性 | 待设计 |
