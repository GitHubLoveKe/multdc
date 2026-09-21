# Zone Query Proxy 区查询代理

> 版本：v1.0 | 日期：2026-09-21
> 状态：设计中

---

## 一、概述

Zone Query Proxy 是采集层中的查询聚合组件，为网区内的本地时序数据提供统一的查询入口。它接收来自 Query Gateway（控制面）的查询请求，将请求路由到本区的存储后端（本地 VM 实例或 VM 集群），执行 fan-out、结果合并、去重后返回统一结果。

Zone Query Proxy 的部署与存储模式强相关：mode A 不部署（无本地数据），mode B 聚合本地 VM 实例数据，mode C 连接 VM 集群的 vmselect 组件。

### 核心定位

```
┌──────────────────────────────────────────────────────────────────┐
│ 全局查询流程                                                       │
│                                                                    │
│  ┌──────────────┐                                                 │
│  │ Query Gateway │  (控制面)                                       │
│  │ (查询路由)    │                                                 │
│  └──────┬───────┘                                                 │
│         │                                                          │
│    ┌────┼────────────────────────┐                                │
│    │    │                         │                                 │
│    ▼    ▼                         ▼                                 │
│  Zone A (Mode A)              Zone B (Mode B)                    │
│  ┌──────────┐                ┌──────────────────┐               │
│  │ 无 Query  │                │ Zone Query Proxy  │               │
│  │ Proxy     │                │                   │               │
│  │ (不部署)  │                │  ┌─────┐ ┌─────┐ │               │
│  │           │                │  │VM-1 │ │VM-2 │ │               │
│  └──────────┘                │  └─────┘ └─────┘ │               │
│                              └──────────────────┘               │
│                                                                    │
│  Zone C (Mode C)                                                   │
│  ┌──────────────────────────────────┐                             │
│  │ Zone Query Proxy                  │                             │
│  │         │                         │                             │
│  │         ▼                         │                             │
│  │  ┌─────────────┐                  │                             │
│  │  │  vmselect   │  (VM 集群组件)   │                             │
│  │  └─────────────┘                  │                             │
│  └──────────────────────────────────┘                             │
└──────────────────────────────────────────────────────────────────┘
```

---

## 二、职责边界

**本文档负责**：
- Zone Query Proxy 的查询聚合逻辑
- 按存储模式的部署策略
- Fan-out、结果合并、去重机制
- 与 Query Gateway 的查询路由集成
- 健康检查与可用性保障
- 查询缓存策略（可选）

**本文档不负责**：
- Query Gateway 的全局查询路由决策（→ `control-plane/`）
- 本地存储（VM/VM 集群）的部署与管理（→ `data-plane/storage.md`）
- RC 规则评估的查询（→ `data-plane/rc-rulecheck.md`，RC 直接查询存储）
- 跨区数据查询（→ `cross-plane/`）
- 数据写入路径（→ `data-plane/otel-collector.md`）

---

## 三、功能清单

### 3.1 功能总览

| 功能模块 | 功能项 | 优先级 | 说明 |
|---------|--------|--------|------|
| 查询代理 | PromQL 查询转发 | P0 | 接收查询请求，转发到本地存储 |
| 查询代理 | 查询结果合并 | P0 | 多存储实例的结果合并 |
| 查询代理 | 结果去重 | P0 | 去除重复时间序列 |
| 查询代理 | 查询超时控制 | P0 | 防止慢查询影响全局 |
| Fan-out | 多 VM 实例并行查询 | P0 (mode B) | 并发查询所有本地 VM |
| Fan-out | vmselect 连接管理 | P0 (mode C) | 连接 VM 集群 vmselect |
| 部署管理 | Mode A 不部署 | P0 | 无本地数据不需要代理 |
| 部署管理 | Mode B 聚合多 VM | P0 | 聚合区内所有 VM 实例 |
| 部署管理 | Mode C 连接 vmselect | P0 | 连接 VM 集群 |
| 健康检查 | 存储后端健康检测 | P0 | 检测本地存储可用性 |
| 健康检查 | 自身健康暴露 | P0 | 供 Query Gateway 探活 |
| 缓存 | 短期查询结果缓存 | P2 | 减少存储查询压力 |

### 3.2 部署策略

#### 3.2.1 Mode A — 不部署

```
Mode A Zone:
  ┌─────────────────────────────────────────┐
  │  无本地 TSDB                              │
  │  无 Zone Query Proxy                      │
  │                                           │
  │  所有数据 → OTel Collector → 中心 VM      │
  │  所有查询 → Query Gateway → 中心 VM       │
  │                                           │
  │  Query Gateway 决策：                      │
  │    Mode A → 直接查询中心 VM，不经 Proxy    │
  └─────────────────────────────────────────┘
```

Mode A 不部署 Proxy 的原因：
- 没有本地存储，Proxy 无数据可查
- 所有数据已 remote-write 到中心 VM
- Query Gateway 直接查询中心 VM 即可

#### 3.2.2 Mode B — 聚合本地 VM

```
Mode B Zone:
  ┌─────────────────────────────────────────┐
  │                                           │
  │  Zone Query Proxy                         │
  │  ┌──────────────────────────────────┐    │
  │  │  Query Router                     │    │
  │  │  · 接收 PromQL 查询               │    │
  │  │  · Fan-out 到所有本地 VM          │    │
  │  │  · 合并 + 去重结果                │    │
  │  └──────────┬───────────────────────┘    │
  │             │                              │
  │      ┌──────┼──────┐                      │
  │      ▼      ▼      ▼                      │
  │   ┌────┐ ┌────┐ ┌────┐                   │
  │   │VM-1│ │VM-2│ │VM-3│  (本地 VM 实例)   │
  │   └────┘ └────┘ └────┘                   │
  │                                           │
  │  每个节点可能有一个 VM 实例                │
  │  Proxy 聚合所有实例的数据                  │
  └─────────────────────────────────────────┘
```

Mode B 部署说明：
- 每个节点可能运行一个本地 VM 实例
- Zone Query Proxy 需要 fan-out 到所有 VM 实例
- 结果合并时需要处理跨实例的去重

#### 3.2.3 Mode C — 连接 vmselect

```
Mode C Zone:
  ┌─────────────────────────────────────────┐
  │                                           │
  │  Zone Query Proxy                         │
  │  ┌──────────────────────────────────┐    │
  │  │  Query Router                     │    │
  │  │  · 接收 PromQL 查询               │    │
  │  │  · 转发到 vmselect               │    │
  │  │  · 返回结果                       │    │
  │  └──────────┬───────────────────────┘    │
  │             │                              │
  │             ▼                              │
  │  ┌──────────────────────────────────┐    │
  │  │  VM 集群                          │    │
  │  │  ┌──────────┐                    │    │
  │  │  │ vmselect │  (查询入口)        │    │
  │  │  └────┬─────┘                    │    │
  │  │       │                           │    │
  │  │  ┌────┴─────┐                    │    │
  │  │  ▼          ▼                     │    │
  │  │ storage-1  storage-2  ...         │    │
  │  └──────────────────────────────────┘    │
  │                                           │
  └─────────────────────────────────────────┘
```

Mode C 部署说明：
- VM 集群自带 vmselect 组件作为查询入口
- Zone Query Proxy 作为 vmselect 的前端代理
- Proxy 的价值在于提供统一的查询接口和额外的合并逻辑

### 3.3 查询处理流程

#### 3.3.1 查询接收

```
Query Gateway                         Zone Query Proxy
  │                                         │
  │  POST /api/v1/query                     │
  │  or POST /api/v1/query_range            │
  │  {                                      │
  │    query: "up{job='node'}",             │
  │    time: "2026-09-21T10:00:00Z",        │
  │    zone_id: "zone-b-01",                │
  │    timeout: "30s"                       │
  │  }                                      │
  │────────────────────────────────────────▶│
  │                                         │
```

#### 3.3.2 Mode B Fan-out 查询

```
Zone Query Proxy (Mode B):
    │
    ▼
1. 解析查询请求
   ├── 提取 PromQL 表达式
   ├── 提取时间范围
   └── 注入 zone_id 过滤条件
    │
    ▼
2. 获取本地 VM 实例列表
   [VM-1:8428, VM-2:8428, VM-3:8428]
    │
    ▼
3. Fan-out 并行查询
   ┌──────────────────────────────────────┐
   │                                       │
   │  ┌─────────┐  ┌─────────┐  ┌──────┐ │
   │  │ VM-1    │  │ VM-2    │  │ VM-3 │ │
   │  │ query() │  │ query() │  │query()│ │
   │  └────┬────┘  └────┬────┘  └──┬───┘ │
   │       │             │          │      │
   │       ▼             ▼          ▼      │
   │  result_1      result_2   result_3    │
   │                                       │
   └──────────────────────────────────────┘
    │
    ▼
4. 结果合并
   ├── 合并所有 result 的时间序列
   ├── 按 (metric_name, labels) 分组
   └── 同组内的数据点按时间戳排序
    │
    ▼
5. 去重
   ├── 同一时间戳的相同值 → 保留一条
   ├── 同一时间戳的不同值 → 取最新（或报错）
   └── 不同时间戳 → 合并到同一序列
    │
    ▼
6. 返回合并结果
```

#### 3.3.3 Mode C vmselect 查询

```
Zone Query Proxy (Mode C):
    │
    ▼
1. 解析查询请求
    │
    ▼
2. 转发到 vmselect
   ┌──────────────────────────────────────┐
   │                                       │
   │  GET /select/0/prometheus/            │
   │      api/v1/query                     │
   │      ?query=up{job='node'}            │
   │      &time=...                        │
   │──────────────────────────────────────▶│ vmselect
   │                                       │
   │  vmselect 内部 fan-out 到             │
   │  storage nodes 并合并                 │
   │                                       │
   │  Response ◀───────────────────────────│
   │                                       │
   └──────────────────────────────────────┘
    │
    ▼
3. 返回结果（vmselect 已完成合并）
```

Mode C 下 Proxy 的价值：
- 提供统一的查询接口（与 Mode B 一致）
- 添加 zone_id 过滤（防止跨区数据泄漏）
- 可选的查询缓存
- 查询审计日志

### 3.4 查询路由集成

#### 3.4.1 Query Gateway 路由决策

```
Query Gateway 查询路由逻辑：

  收到查询请求 (zone_id, promql)
      │
      ▼
  查询 zone 的存储模式
      │
      ├── Mode A:
      │   └── 直接查询中心 VM
      │       (数据在中心，无本地存储)
      │
      ├── Mode B:
      │   ├── 优先查询 Zone Query Proxy (本地数据，低延迟)
      │   ├── 如果 Proxy 不可用 → 回退到中心 VM
      │   │   (中心也有数据，但可能有复制延迟)
      │   └── 如果需要长期数据 → 查询中心 VM
      │       (本地只保留短期，如 7 天)
      │
      └── Mode C:
          └── 总是通过 Zone Query Proxy
              (数据主要在本地 VM 集群)
              (中心可能有副本，但本地是 primary)
```

#### 3.4.2 查询优先级

| 场景 | 查询目标 | 原因 |
|------|---------|------|
| Mode B，查询最近 1 小时 | Zone Query Proxy → 本地 VM | 本地数据最新，无复制延迟 |
| Mode B，查询最近 30 天 | 中心 VM | 本地只保留 7 天 |
| Mode B，Proxy 不可用 | 中心 VM（回退） | 数据也在中心，但可能有延迟 |
| Mode C，任意查询 | Zone Query Proxy → vmselect | 数据主要在本地集群 |
| Mode A，任意查询 | 中心 VM | 无本地数据 |

### 3.5 健康与可用性

#### 3.5.1 健康检查

```
Zone Query Proxy 健康检查：

  GET /health
  Response:
  {
    "status": "healthy" | "degraded" | "unhealthy",
    "storage_backends": [
      {"endpoint": "vm-1:8428", "status": "up", "latency_ms": 5},
      {"endpoint": "vm-2:8428", "status": "up", "latency_ms": 8},
      {"endpoint": "vm-3:8428", "status": "down", "latency_ms": null}
    ],
    "version": "1.0.0"
  }

状态判定：
  · 所有后端 up → healthy
  · 部分后端 down → degraded (仍可服务，但数据可能不完整)
  · 所有后端 down → unhealthy (无法服务)
```

#### 3.5.2 可用性保障

```
Zone Query Proxy 可用性设计：

  · 无状态组件：不存储任何状态，可水平扩展
  · 多实例部署：可部署多个 Proxy 实例，前端 LB 负载均衡
  · 回退机制：Proxy 不可用时，Query Gateway 回退到中心 VM（Mode B）

  ┌─────────────┐
  │  LB / DNS   │
  └──────┬──────┘
         │
    ┌────┼────┐
    ▼    ▼    ▼
  ┌───┐┌───┐┌───┐
  │ P1││ P2││ P3│  (多个 Proxy 实例)
  └───┘└───┘└───┘
    │    │    │
    └────┼────┘
         │
    ┌────┼────┐
    ▼    ▼    ▼
  本地存储后端
```

---

## 四、核心数据模型

### 4.1 QueryRequest（查询请求）

```yaml
QueryRequest:
  request_id: string                    # 查询唯一标识
  zone_id: string                       # 目标网区
  query_type: enum                      # instant | range

  # PromQL 查询参数
  promql:
    expr: string                        # PromQL 表达式
    time: timestamp                     # 即时查询时间点
    start_time: timestamp               # 范围查询起始时间
    end_time: timestamp                 # 范围查询结束时间
    step: duration                      # 范围查询步长

  # 控制参数
  timeout: duration                     # 查询超时
  max_series: uint32                    # 最大返回序列数
  dedup: bool                           # 是否去重（默认 true）

  # 来源信息
  source:
    caller: string                      # 调用方标识
    query_gateway_id: string            # Query Gateway 实例
```

### 4.2 QueryResponse（查询响应）

```yaml
QueryResponse:
  request_id: string                    # 关联的查询请求
  status: enum                          # success | error | timeout | partial

  # 查询结果
  data:
    result_type: enum                   # vector | matrix | scalar | string
    result:                             # 时间序列结果
      - metric: map<string, string>     # 标签集合
        values:                         # 数据点
          - timestamp: timestamp
            value: float64

  # 统计信息
  stats:
    total_series: uint32                # 返回的序列总数
    total_samples: uint32               # 返回的数据点总数
    backend_responses:                  # 各后端响应情况
      - backend: string
        status: enum                    # success | error | timeout
        series_count: uint32
        latency_ms: float
    merge_duration_ms: float            # 合并耗时
    dedup_removed: uint32               # 去重移除的数据点数
    total_duration_ms: float            # 总查询耗时
```

### 4.3 ProxyConfig（Proxy 配置）

```yaml
ProxyConfig:
  zone_id: string                       # 所属网区
  storage_mode: enum                    # B | C (A 不部署 Proxy)
  listen_address: string                # 监听地址
  timeout: duration                     # 默认查询超时

  # Mode B: 本地 VM 实例列表
  local_vm_backends:
    - endpoint: string                  # VM 实例地址
      health_check_interval: duration   # 健康检查间隔
      weight: uint32                    # 权重（用于负载均衡）

  # Mode C: vmselect 地址
  vmselect_backend:
    endpoint: string                    # vmselect 地址
    health_check_interval: duration

  # 缓存配置（可选）
  cache:
    enabled: bool
    ttl: duration                       # 缓存 TTL
    max_size: uint32                    # 最大缓存条目数
```

### 4.4 BackendHealth（后端健康状态）

```yaml
BackendHealth:
  endpoint: string                      # 后端地址
  status: enum                          # UP | DOWN | DEGRADED
  last_check: timestamp                 # 最后检查时间
  latency_ms: float                     # 响应延迟
  consecutive_failures: uint32          # 连续失败次数
  error_message: string                 # 错误信息
```

---

## 五、接口与交互

### 5.1 Query Gateway → Zone Query Proxy

```
Query Gateway                           Zone Query Proxy
  │                                          │
  │  POST /api/v1/query                      │
  │  { query: "up", time: "...",             │
  │    zone_id: "zone-b-01" }                │
  │─────────────────────────────────────────▶│
  │                                          │  解析查询
  │                                          │  Fan-out 到本地存储
  │                                          │  合并 + 去重
  │  200 OK                                  │
  │  { status: "success",                    │
  │    data: { result: [...] } }             │
  │◀─────────────────────────────────────────│
  │                                          │
  │  POST /api/v1/query_range                │
  │  { query: "rate(http_requests[5m])",     │
  │    start: "...", end: "...", step: 15s } │
  │─────────────────────────────────────────▶│
  │                                          │
  │  200 OK                                  │
  │◀─────────────────────────────────────────│
```

| 接口 | 方向 | 协议 | 说明 |
|------|------|------|------|
| Instant Query | QG → ZQP | HTTP (Prometheus API) | 即时查询 |
| Range Query | QG → ZQP | HTTP (Prometheus API) | 范围查询 |
| Labels Query | QG → ZQP | HTTP (Prometheus API) | 查询标签名 |
| Label Values | QG → ZQP | HTTP (Prometheus API) | 查询标签值 |
| Series Query | QG → ZQP | HTTP (Prometheus API) | 查询序列列表 |

### 5.2 Zone Query Proxy → 本地存储

```
Zone Query Proxy (Mode B)               本地 VM 实例
  │                                          │
  │  GET /api/v1/query                       │
  │  ?query=up{zone_id="zone-b-01"}          │
  │  &time=2026-09-21T10:00:00Z              │
  │─────────────────────────────────────────▶│ VM-1
  │─────────────────────────────────────────▶│ VM-2
  │─────────────────────────────────────────▶│ VM-3
  │                                          │
  │  Response (from each)                    │
  │◀─────────────────────────────────────────│
  │◀─────────────────────────────────────────│
  │◀─────────────────────────────────────────│
  │                                          │

Zone Query Proxy (Mode C)               vmselect
  │                                          │
  │  GET /select/0/prometheus/api/v1/query   │
  │  ?query=up{zone_id="zone-c-01"}          │
  │─────────────────────────────────────────▶│
  │                                          │  vmselect 内部
  │  Response                                │  fan-out 到
  │◀─────────────────────────────────────────│  storage nodes
```

### 5.3 健康检查接口

```
Zone Query Proxy 暴露的健康检查：

  GET /health
  Response 200:
  {
    "status": "healthy",
    "storage_mode": "B",
    "backends": [
      {"endpoint": "vm-1:8428", "status": "up", "latency_ms": 5},
      {"endpoint": "vm-2:8428", "status": "up", "latency_ms": 8}
    ],
    "uptime": "72h",
    "version": "1.0.0"
  }

  GET /ready
  Response 200: { "ready": true }
  Response 503: { "ready": false, "reason": "no backends available" }
```

### 5.4 可观测性接口

```
Zone Query Proxy 暴露的指标：

  GET /metrics                          # Prometheus 格式自身指标

  指标包括：
  · zone_query_proxy_queries_total      # 总查询次数
  · zone_query_proxy_query_duration     # 查询延迟分布
  · zone_query_proxy_backend_errors     # 后端错误次数
  · zone_query_proxy_series_returned    # 返回的序列数
  · zone_query_proxy_cache_hits         # 缓存命中次数
  · zone_query_proxy_cache_misses       # 缓存未命中次数
  · zone_query_proxy_active_queries     # 当前活跃查询数
```

---

## 六、设计决策与替代方案

### DEC-ZQP-01：Proxy 实现方式

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：独立服务（当前推荐） | 独立的 Proxy 进程 | 职责清晰；独立扩缩；独立升级 | 额外进程管理 |
| B：嵌入 Zone Agent | Proxy 功能嵌入 Zone Agent | 减少进程数 | Zone Agent 职责过重；资源竞争 |
| C：嵌入 OTel Collector | Proxy 功能嵌入 OTel Collector | 复用连接 | OTel Collector 职责扩展；写入与查询路径混合 |

**[建议]**：方案 A（独立服务）。查询路径与写入路径分离（P8），Proxy 作为独立组件更清晰。Zone Agent 应专注于跨区通信，OTel Collector 应专注于数据管道。

### DEC-ZQP-02：查询协议

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：PromQL 透传（当前） | 直接透传 PromQL 到存储后端 | 完全兼容；无需额外学习 | 无法在 Proxy 层做查询优化 |
| B：自定义查询 API | Proxy 定义自己的查询接口 | 可跨存储引擎 | 需要适配层；学习成本 |
| C：PromQL + 扩展 | PromQL 透传 + Proxy 层扩展 | 兼容 + 增强 | 扩展部分非标准 |

**[建议]**：方案 A（PromQL 透传）。VictoriaMetrics 完全兼容 PromQL，透传是最简单的实现。Proxy 层不需要理解查询语义，只需做 fan-out 和结果合并。

### DEC-ZQP-03：查询缓存策略

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：无缓存（当前推荐） | 每次查询直接到存储 | 数据始终最新；实现简单 | 存储查询压力大 |
| B：短期 TTL 缓存 | 缓存最近查询结果（如 10s TTL） | 减少存储压力 | 数据可能不是最新 |
| C：智能缓存 | 根据查询类型和数据新鲜度动态缓存 | 最优 | 实现复杂 |

**[建议]**：阶段 1 用方案 A（无缓存）。VictoriaMetrics 的查询性能足够好，短期查询不需要缓存。阶段 2 当查询频率很高时评估方案 B。

### DEC-ZQP-04：Mode B 回退策略

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：回退到中心 VM（当前） | Proxy 不可用时查询中心 VM | 高可用；数据可达 | 可能有复制延迟 |
| B：返回错误 | Proxy 不可用时直接返回错误 | 简单；不隐藏问题 | 可用性降低 |
| C：部分结果 | 返回可用后端的结果，标记为 partial | 平衡 | 客户端需要处理 partial |

**[建议]**：方案 A + 方案 C 结合。Proxy 部分后端不可用时返回 partial 结果并标记；Proxy 完全不可用时回退到中心 VM。

---

## 七、冲突与开放问题

| ID | 问题 | 影响 | 状态 |
|----|------|------|------|
| ZQP-01 | Mode B 回退到中心 VM 时的数据一致性（复制延迟） | 查询结果可能不是最新 | 待确认 |
| ZQP-02 | Mode B 多 VM 实例间的数据分布策略 | 影响 fan-out 查询的效率 | 待确认 |
| ZQP-03 | Proxy 实例数量的规划：每区一个 vs 每区多个 | 影响可用性和资源使用 | 待确认 |
| ZQP-04 | 大查询（返回 >100K 序列）时的内存管理 | 可能导致 Proxy OOM | 待确认 |
| ZQP-05 | Proxy 是否需要认证与鉴权 | 影响安全性 | 待确认 |
| ZQP-06 | Mode C 下 Proxy 的附加价值评估：vmselect 已提供查询能力 | Proxy 可能成为不必要的中间层 | 待评估 |
| ZQP-07 | 跨区查询的支持：是否需要 Proxy 间的联邦查询 | 影响全局查询架构 | 待确认（当前不在范围内） |
