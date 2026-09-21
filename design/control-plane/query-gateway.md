# 统一查询入口 (Query Gateway)

## 一、概述

统一查询入口（Query Gateway）是中心控制面提供给用户和 Grafana 的统一数据查询接口。它屏蔽了底层多网区、多存储模式的复杂性，使查询方无需关心数据存储在哪个网区的哪个 VM 实例中，只需通过统一 API 即可查询全局任意实例的监控数据。

该模块是 P8 设计决策中"读路由"路径的核心实现——任务路由、读路由、RC 路由三条路径相互独立，Query Gateway 专注于读路由。它根据实例的网区归属和网区的存储模式，智能地将查询请求路由到正确的数据源（中心 VM 或 Zone Query Proxy），并在跨网区查询时负责结果合并。

```
  ┌──────────────────────────────────────────────────────────────┐
  │                      查询方                                  │
  │   Grafana    Web UI    API 用户    自定义 Dashboard          │
  └──────┬──────────┬──────────┬──────────┬─────────────────────┘
         │          │          │          │
         └──────────┴──────────┴──────────┘
                    │
                    ▼
  ┌──────────────────────────────────────────────────────────────┐
  │                   统一查询入口 (Query Gateway)                │
  │                                                              │
  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
  │  │ 查询解析  │  │ 路由决策  │  │ 结果合并  │  │ Grafana  │   │
  │  │ & 校验   │  │ & 分发   │  │ & 格式化  │  │ 数据源   │   │
  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  │ 管理     │   │
  │       │             │             │         └──────────┘   │
  └───────┼─────────────┼─────────────┼────────────────────────┘
          │             │             │
    ┌─────┴─────────────┴─────────────┴─────┐
    │           数据源路由                    │
    │                                       │
    │  ┌──────────┐  ┌──────────────────┐  │
    │  │ 中心 VM  │  │ Zone Query Proxy │  │
    │  │ (Mode A) │  │ (Mode B/C)      │  │
    │  └──────────┘  └────────┬─────────┘  │
    └─────────────────────────┼─────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        ┌──────────┐   ┌──────────┐   ┌──────────┐
        │ Zone-A   │   │ Zone-B   │   │ Zone-C   │
        │ VM(本地) │   │ VM(本地) │   │ VM 集群  │
        │ Mode A   │   │ Mode B   │   │ Mode C   │
        │ (无本地) │   │          │   │          │
        └──────────┘   └──────────┘   └──────────┘
```

## 二、职责边界

### 本模块负责

| 职责 | 说明 |
|------|------|
| 统一查询 API | 提供单一查询端点，兼容 Prometheus Query API |
| 查询路由 | 根据实例-to-网区映射和存储模式，决定查询目标数据源 |
| 跨网区查询 | 支持扇出到多个数据源并合并结果 |
| Grafana 数据源管理 | 管理 Grafana 数据源配置，支持自动注册 |
| 结果合并 | 合并来自多个数据源的查询结果 |
| 查询缓存 | 对热点查询提供缓存，降低后端压力 |

### 本模块不负责

| 不负责项 | 归属模块 |
|----------|----------|
| PromQL 的实际执行 | 后端 VM / Zone Query Proxy |
| 时序数据的存储 | 数据层 (VictoriaMetrics) |
| 查询定义的管理 | 指标维护模块 (metric-management) |
| 网区-to-实例映射的维护 | 网区管理 + 实例管理 |
| 网区内本地查询 | Zone Query Proxy |

## 三、功能清单

### 3.1 统一查询 API

| 功能 | 描述 |
|------|------|
| 即时查询 | 兼容 `/api/v1/query` (PromQL instant query) |
| 范围查询 | 兼容 `/api/v1/query_range` (PromQL range query) |
| 标签查询 | 兼容 `/api/v1/labels` 和 `/api/v1/label/{name}/values` |
| 序列查询 | 兼容 `/api/v1/series` |
| 元数据查询 | 兼容 `/api/v1/metadata` |
| 查询超时控制 | 全局和per-query 超时设置 |

**API 兼容性：**

```
Query Gateway 完整兼容 Prometheus HTTP API:

GET /api/v1/query?query=<promql>&time=<unix_time>&timeout=<duration>
GET /api/v1/query_range?query=<promql>&start=<time>&end=<time>&step=<duration>
GET /api/v1/labels?match[]=<selector>&start=<time>&end=<time>
GET /api/v1/label/<name>/values?match[]=<selector>
GET /api/v1/series?match[]=<selector>&start=<time>&end=<time>
GET /api/v1/metadata?limit=<number>&match[]=<selector>
```

### 3.2 查询路由引擎

| 功能 | 描述 |
|------|------|
| 实例-to-网区解析 | 从 PromQL 中提取 instance 标签，解析所属网区 |
| 存储模式路由 | 根据网区存储模式决定查询目标 |
| 单网区查询 | 查询目标明确属于单个网区时，直接路由 |
| 跨网区扇出 | 查询涉及多个网区时，扇出到多个数据源 |
| 降级路由 | 首选数据源不可用时，自动降级到备用数据源 |
| 路由缓存 | 缓存实例-to-网区映射，减少查询延迟 |

**读路由策略（按存储模式）：**

```
┌─────────────────────────────────────────────────────────────────┐
│                    读路由决策树                                  │
│                                                                 │
│  查询请求                                                       │
│    │                                                            │
│    ├── 指定了 zone_id ──▶ 直接路由到该网区的数据源              │
│    │                                                            │
│    ├── 指定了 instance ──▶ 查询实例-to-网区映射                 │
│    │   │                                                        │
│    │   ├── 找到唯一网区 ──▶ 路由到该网区数据源                  │
│    │   ├── 找到多个网区 ──▶ 扇出到所有相关网区                  │
│    │   └── 未找到 ──▶ 全局广播 (所有数据源)                     │
│    │                                                            │
│    └── 未指定 zone/instance ──▶ 全局广播或查询默认数据源        │
│                                                                 │
│  数据源选择 (已知目标网区):                                     │
│    │                                                            │
│    ├── Mode A ──▶ 中心 VM (唯一数据副本)                       │
│    │                                                            │
│    ├── Mode B ──▶ 首选: Zone Query Proxy (本地 VM, 数据最新)   │
│    │              降级: 中心 VM (remote-write 副本, 有延迟)     │
│    │                                                            │
│    └── Mode C ──▶ 首选: Zone Query Proxy (本地 VM 集群)        │
│                   降级: 中心 VM (如有 remote-write)             │
└─────────────────────────────────────────────────────────────────┘
```

**路由策略详细配置：**

| 存储模式 | 首选数据源 | 降级数据源 | 数据新鲜度 |
|----------|-----------|-----------|-----------|
| Mode A | 中心 VM | 无（唯一副本） | 取决于 remote-write 延迟 |
| Mode B | Zone Query Proxy | 中心 VM | 本地: 实时; 中心: 有延迟 |
| Mode C | Zone Query Proxy | 中心 VM | 本地: 实时; 中心: 有延迟 |

### 3.3 跨网区混合查询

| 功能 | 描述 |
|------|------|
| 扇出执行 | 将查询并行发送到多个数据源 |
| 超时控制 | 设置扇出查询的全局超时 |
| 部分失败处理 | 部分数据源超时时，返回已获取的结果 + 标记不完整 |
| 结果合并 | 合并多个数据源返回的时间序列 |
| 去重处理 | 处理 Mode B 双写可能导致的数据重复 |

**跨网区查询流程：**

```
  查询: avg by(type) (cpu_usage{type="oracle"})
  涉及: Zone-A (Mode A), Zone-B (Mode B), Zone-C (Mode C)

  Query Gateway
       │
       ├── 解析查询 ──▶ 识别涉及 3 个网区的 Oracle 实例
       │
       ├── 扇出:
       │   ├── → 中心 VM: cpu_usage{zone="zone-a", type="oracle"}
       │   ├── → Zone-QP-B: cpu_usage{type="oracle"}
       │   └── → Zone-QP-C: cpu_usage{type="oracle"}
       │
       ├── 收集结果:
       │   ├── ← 中心 VM: {instance="ora-a1"} 85.2
       │   ├── ← Zone-QP-B: {instance="ora-b1"} 72.1, {instance="ora-b2"} 68.5
       │   └── ← Zone-QP-C: {instance="ora-c1"} 91.3
       │
       ├── 合并 & 去重:
       │   └── 4 条唯一序列 (无重复)
       │
       └── 返回: avg by(type) = (85.2 + 72.1 + 68.5 + 91.3) / 4 = 79.3
```

### 3.4 Grafana 数据源管理

| 功能 | 描述 |
|------|------|
| 数据源注册 | 自动/手动在 Grafana 中注册数据源 |
| 数据源更新 | 网区变更时自动更新 Grafana 数据源配置 |
| 数据源健康检查 | 定期检查 Grafana 数据源的连通性 |
| 推荐数据源策略 | 根据使用场景推荐最佳数据源配置方式 |

**Grafana 数据源策略（三阶段）：**

**Phase 1: 静态数据源**

```
  Grafana
    ├── VictoriaMetrics (中心) ──── 手动配置
    ├── Zone-A-QP ───────────────── 手动配置
    ├── Zone-B-QP ───────────────── 手动配置
    └── Zone-C-QP ───────────────── 手动配置

  特点: 简单直接，Grafana 需知道所有数据源
  缺点: 新增网区需手动配置
```

**Phase 2: 自动注册数据源**

```
  Query Gateway                    Grafana API
       │                              │
       │──网区上线事件──────────────▶│
       │──注册数据源────────────────▶│
       │   POST /api/datasources      │
       │   {                          │
       │     name: "Zone-D-QP",       │
       │     type: "prometheus",      │
       │     url: "http://qp-d:8080"  │
       │   }                          │
       │                              │
       │──网区下线事件──────────────▶│
       │──删除/禁用数据源───────────▶│

  特点: 自动化，新增网区自动注册
  缺点: Grafana 仍需管理多个数据源
```

**Phase 3: 网关代理模式**

```
  Grafana
    └── Query Gateway (唯一数据源)
           │
           ├── 自动路由到正确数据源
           └── 跨网区合并

  特点: Grafana 只需配置一个数据源
  优点: 最灵活，Grafana 无需感知网区拓扑
  缺点: Gateway 成为瓶颈和单点
```

### 3.5 结果合并与格式化

| 功能 | 描述 |
|------|------|
| 时间序列合并 | 合并多个数据源返回的不同时间序列 |
| 数据去重 | 基于 metric fingerprint 去除重复序列 |
| 时间对齐 | 处理不同数据源返回数据的时间戳微差异 |
| 格式兼容 | 确保返回格式与 Prometheus API 完全兼容 |
| 不完整标记 | 部分数据源失败时，在响应中标记结果不完整 |

**响应格式（部分失败）：**

```json
{
  "status": "success",
  "data": {
    "resultType": "vector",
    "result": [...],
    "warnings": [
      "partial_result: zone-east-1 query timed out, results may be incomplete"
    ],
    "sources": {
      "center_vm": { "status": "ok", "series_count": 5 },
      "zone-east-1-qp": { "status": "timeout", "series_count": 0 },
      "zone-west-1-qp": { "status": "ok", "series_count": 3 }
    }
  }
}
```

### 3.6 查询缓存

| 功能 | 描述 |
|------|------|
| 查询结果缓存 | 对相同查询在短时间内返回缓存结果 |
| 缓存策略 | 即时查询缓存 15s，范围查询不缓存 |
| 缓存失效 | 网区状态变更时清除相关缓存 |
| 缓存统计 | 统计缓存命中率和节省的后端负载 |

## 四、核心数据模型

### 4.1 QueryRoute（查询路由配置）

```sql
CREATE TABLE query_route (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    zone_id          VARCHAR(64)   NOT NULL,           -- 网区 ID
    storage_mode     ENUM('A', 'B', 'C')              -- 存储模式
                     NOT NULL,
    primary_source   VARCHAR(256)  NOT NULL,           -- 首选数据源 URL
    -- Mode A: "http://center-vm:8428"
    -- Mode B/C: "http://zone-qp-{zone_id}:8080"
    fallback_source  VARCHAR(256),                     -- 降级数据源 URL
    -- Mode B: "http://center-vm:8428"
    -- Mode C: "http://center-vm:8428" (如有 remote-write)
    source_type      ENUM('victoriametrics', 'prometheus')
                     NOT NULL DEFAULT 'victoriametrics',
    query_timeout_ms INT           DEFAULT 30000,      -- 查询超时
    priority         INT           DEFAULT 0,          -- 优先级
    enabled          BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMP     NOT NULL,
    updated_at       TIMESTAMP     NOT NULL,
    UNIQUE KEY uk_zone (zone_id)
);
```

### 4.2 GrafanaDatasource（Grafana 数据源注册）

```sql
CREATE TABLE grafana_datasource (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    datasource_uid   VARCHAR(64)   NOT NULL UNIQUE,    -- Grafana 数据源 UID
    name             VARCHAR(128)  NOT NULL,           -- 数据源名称
    zone_id          VARCHAR(64),                      -- 关联网区 (空=中心)
    datasource_type  ENUM('zone_qp', 'center_vm', 'gateway')
                     NOT NULL,
    url              VARCHAR(256)  NOT NULL,           -- 数据源 URL
    grafana_config   JSON,                             -- Grafana 数据源配置
    health_status    ENUM('healthy', 'unhealthy', 'unknown')
                     NOT NULL DEFAULT 'unknown',
    last_health_check TIMESTAMP,
    auto_managed     BOOLEAN       NOT NULL DEFAULT FALSE,  -- 是否自动管理
    created_at       TIMESTAMP     NOT NULL,
    updated_at       TIMESTAMP     NOT NULL
);
```

### 4.3 QueryCache（查询缓存）

```sql
CREATE TABLE query_cache (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    cache_key        VARCHAR(256)  NOT NULL UNIQUE,     -- 查询哈希
    query            TEXT          NOT NULL,             -- 原始 PromQL
    result           MEDIUMTEXT    NOT NULL,             -- 缓存结果 (JSON)
    result_type      VARCHAR(16)   NOT NULL,             -- vector/matrix
    expires_at       TIMESTAMP     NOT NULL,             -- 过期时间
    hit_count        INT           DEFAULT 0,            -- 命中次数
    created_at       TIMESTAMP     NOT NULL,
    INDEX idx_expires (expires_at)
);
```

### 4.4 InstanceZoneMapping（实例-网区映射缓存）

```sql
-- 该表为查询网关专用的映射缓存，主数据在实例管理模块
CREATE TABLE instance_zone_mapping_cache (
    instance_id      VARCHAR(64)   PRIMARY KEY,
    zone_id          VARCHAR(64)   NOT NULL,
    storage_mode     ENUM('A', 'B', 'C') NOT NULL,
    instance_labels  JSON,                            -- 常用标签缓存
    synced_at        TIMESTAMP     NOT NULL            -- 最近同步时间
);
```

## 五、接口与交互

### 5.1 上游依赖

| 来源 | 交互内容 | 协议 |
|------|----------|------|
| 用户 / Grafana | 查询请求 | Prometheus HTTP API |
| 实例管理模块 | 实例-to-网区映射 | 内部 API |
| 网区管理模块 | 网区列表、存储模式 | 内部 API |

### 5.2 下游提供

| 消费方 | 提供内容 | 协议 |
|--------|----------|------|
| 中心 VM | 查询请求 (Mode A) | Prometheus Query API |
| Zone Query Proxy | 查询请求 (Mode B/C) | Prometheus Query API |
| Grafana | 数据源配置管理 | Grafana HTTP API |

### 5.3 对外 API

```
# 统一查询 API (兼容 Prometheus)
GET    /api/v1/query                              # 即时查询
GET    /api/v1/query_range                        # 范围查询
GET    /api/v1/labels                             # 标签查询
GET    /api/v1/label/{name}/values                # 标签值查询
GET    /api/v1/series                             # 序列查询
GET    /api/v1/metadata                           # 元数据查询

# 扩展查询参数 (非标准，Query Gateway 特有)
# ?zone_id=zone-east-1         限定查询网区
# ?prefer_local=true           优先查询本地数据源
# ?timeout=30s                 查询超时
# ?cache=true                  是否使用缓存

# Grafana 数据源管理
GET    /api/v1/grafana-datasources                # 查询数据源列表
POST   /api/v1/grafana-datasources/sync           # 触发数据源同步
GET    /api/v1/grafana-datasources/health         # 数据源健康状态

# 路由配置
GET    /api/v1/query-routes                       # 查询路由配置
PUT    /api/v1/query-routes/{zone_id}             # 更新路由配置

# 运维
GET    /api/v1/query-gateway/stats                # 查询统计 (QPS/延迟/缓存命中率)
GET    /api/v1/query-gateway/health               # 网关健康检查
POST   /api/v1/query-gateway/cache/clear          # 清除缓存
```

### 5.4 查询路由完整流程

```
  Grafana/User
       │
       │ GET /api/v1/query?query=up{instance="ora-01"}
       ▼
  ┌─────────────────────────────────────────────────────┐
  │  Query Gateway                                      │
  │                                                     │
  │  [1] 解析 PromQL                                    │
  │      └── 提取 label selectors: instance="ora-01"   │
  │                                                     │
  │  [2] 实例-to-网区解析                               │
  │      └── ora-01 → zone_id: zone-east-1             │
  │          storage_mode: B                            │
  │                                                     │
  │  [3] 路由决策                                       │
  │      └── Mode B → 首选: Zone-QP-zone-east-1       │
  │                  降级: 中心 VM                      │
  │                                                     │
  │  [4] 执行查询                                       │
  │      └── → Zone-QP-zone-east-1:8080               │
  │          GET /api/v1/query?query=up{instance="ora-01"}│
  │                                                     │
  │  [5] 结果处理                                       │
  │      └── ← 200 OK { result: [{metric:..., value:1}] }│
  │                                                     │
  │  [6] 返回结果                                       │
  │      └── 原样返回 Prometheus 格式                   │
  └─────────────────────────────────────────────────────┘
       │
       ▼
  Grafana/User 收到结果
```

### 5.5 跨网区查询流程

```
  Grafana/User
       │
       │ GET /api/v1/query?query=avg by(zone)(up{})&zone_id=*
       ▼
  ┌─────────────────────────────────────────────────────┐
  │  Query Gateway                                      │
  │                                                     │
  │  [1] 解析: 未限定具体网区, 需查询所有网区            │
  │                                                     │
  │  [2] 获取所有活跃网区:                              │
  │      zone-a (Mode A), zone-b (Mode B), zone-c (Mode C)│
  │                                                     │
  │  [3] 路由决策:                                      │
  │      zone-a → 中心 VM                              │
  │      zone-b → Zone-QP-B                            │
  │      zone-c → Zone-QP-C                            │
  │                                                     │
  │  [4] 并行扇出:                                      │
  │      ┌──→ 中心 VM: up{zone="zone-a"}              │
  │      ├──→ Zone-QP-B: up{}                          │
  │      └──→ Zone-QP-C: up{}                          │
  │                                                     │
  │  [5] 收集结果 (超时 30s):                           │
  │      ← 中心 VM: {zone="zone-a"} 结果               │
  │      ← Zone-QP-B: {zone="zone-b"} 结果             │
  │      ← Zone-QP-C: 超时!                             │
  │                                                     │
  │  [6] 合并 & 标记:                                   │
  │      合并 zone-a + zone-b 结果                     │
  │      警告: zone-c 查询超时                          │
  │                                                     │
  │  [7] 返回 (部分结果 + 警告)                         │
  └─────────────────────────────────────────────────────┘
```

## 六、设计决策与替代方案

### 6.1 Grafana 集成策略 [待确认]

**方案 A: 网关代理模式（Gateway as Single Entry）[建议 Phase 3]**

```
Grafana → Query Gateway → 路由到数据源
```

| 优点 | 缺点 |
|------|------|
| Grafana 只需一个数据源 | Gateway 成为单点和瓶颈 |
| 完全屏蔽网区拓扑 | Gateway 故障影响所有查询 |
| 最灵活，支持跨网区查询 | 需要 Gateway 高可用部署 |
| 统一查询入口 | 所有查询流量经过 Gateway |

**方案 B: 多数据源模式（One DS per Zone）**

```
Grafana → VictoriaMetrics-Center (中心数据)
       → Zone-A-QP (Zone A 数据)
       → Zone-B-QP (Zone B 数据)
       → Zone-C-QP (Zone C 数据)
```

| 优点 | 缺点 |
|------|------|
| 简单直接 | Grafana 需管理多个数据源 |
| 无单点 | 跨网区查询需 Grafana Mixin 插件 |
| 各数据源独立可用 | 新增网区需手动配置 |
| 流量不经过中心 | Dashboard 需指定数据源 |

**方案 C: 数据源 + Dashboard 变量（中间方案）[建议 Phase 1/2]**

```
Grafana 配置:
  - 多个数据源 (自动注册)
  - Dashboard 使用变量 $datasource
  - 用户通过下拉框选择查询哪个网区

  ┌─────────────────────────────────────┐
  │ Dashboard: Oracle 监控              │
  │ 网区: [zone-east-1 ▼]              │  ← Grafana 变量选择器
  │ 实例: [ora-01 ▼]                   │
  │                                     │
  │ [CPU 使用率] [表空间] [会话数]      │
  └─────────────────────────────────────┘
```

| 优点 | 缺点 |
|------|------|
| 兼顾灵活性和简单性 | 一次只能查一个网区 |
| 数据源自动注册 | 跨网区视图需多个 Panel |
| 用户可选择性查询 | Dashboard 设计稍复杂 |

**建议的分阶段策略：**

```
Phase 1: 方案 B (静态多数据源)
  └── 手动配置，快速上线
  └── 适用于网区数量少 (< 5) 的场景

Phase 2: 方案 C (自动注册 + 变量)
  └── 数据源自动注册
  └── Dashboard 变量选择网区
  └── 适用于网区数量中等 (5-20) 的场景

Phase 3: 方案 A (网关代理)
  └── Grafana 仅配置 Gateway 为数据源
  └── Gateway 负责所有路由
  └── 适用于网区数量多 (> 20) 或需要跨网区查询
```

### 6.2 查询网关的部署模式 [待确认]

**方案 A: 独立服务**

| 优点 | 缺点 |
|------|------|
| 独立扩缩容 | 增加部署复杂度 |
| 故障隔离 | 需要独立的健康检查 |
| 资源隔离 | |

**方案 B: 与控制面其他模块合并部署**

| 优点 | 缺点 |
|------|------|
| 部署简单 | 资源竞争 |
| 共享基础设施 | 故障不隔离 |

**建议：** Phase 1 合并部署，Phase 2 根据负载情况决定是否独立。

### 6.3 跨网区查询的一致性保证 [待确认]

**问题：** 跨网区查询时，不同数据源的数据可能有时间偏差（时钟不同步、remote-write 延迟等）。

**策略：**
- 时间戳对齐：以查询时间戳为基准，各数据源返回最近的数据点
- 标记数据新鲜度：在响应中包含各数据源的最新数据时间戳
- 不强制一致性：接受各数据源的"最新可用"数据，不等待所有数据源同步

### 6.4 查询网关的高可用 [建议]

**建议：** 无状态设计，支持多实例部署 + 负载均衡。

**理由：**
- Query Gateway 不维护查询状态（除缓存外）
- 缓存可使用 Redis 共享
- 多实例部署避免单点

## 七、冲突与开放问题

### MC-05: Grafana 数据源自动维护复杂度 [待确认]

**冲突描述：** Phase 2 需要 Query Gateway 通过 Grafana API 自动管理数据源。这引入以下问题：
- Grafana API 变更可能影响自动注册
- 自动注册的数据源与手动配置的数据源可能冲突
- 数据源名称/标签的命名规范需要统一

**待决策：**
- 自动注册的数据源是否使用特殊前缀（如 `mgmt-`）以区分手动配置？
- 是否需要数据源配置的"锁定"机制（防止手动修改自动注册的数据源）？

### MC-06: 跨网区混合查询的性能和一致性 [待确认]

**冲突描述：** 跨网区查询涉及多个数据源的并行查询，面临：
- 性能：最慢的数据源决定整体延迟
- 一致性：不同数据源的数据可能有时间偏差
- 部分失败：一个数据源失败是否应导致整个查询失败？

**待决策：**
- 跨网区查询的超时策略（全局超时 vs 单数据源超时）？
- 部分失败时的用户体验（返回部分结果 + 警告 vs 报错）？
- 是否需要"最终一致"模式（先返回已有结果，后台继续查询慢数据源）？

### MC-22: Query Gateway 与 Zone Query Proxy 的职责边界 [待确认]

**冲突描述：** Query Gateway 和 Zone Query Proxy 都涉及查询路由，需要明确边界：
- Query Gateway：全局路由（跨网区，选择查哪个数据源）
- Zone Query Proxy：网区内路由（选择查本地 VM 的哪个副本/分片）

**建议：** Query Gateway 负责"查哪个网区的数据源"，Zone Query Proxy 负责"网区内如何查询"。

### MC-23: 查询网关的认证与授权 [待确认]

**冲突描述：** 查询网关是否需要独立的认证授权？还是复用控制面的统一认证？

**待决策：**
- 是否需要按网区控制查询权限（某些用户只能查某些网区）？
- Grafana 的认证是否透传到 Query Gateway？
- API 调用的认证方式（API Key / OAuth / mTLS）？

### MC-24: 查询缓存的一致性 [待确认]

**冲突描述：** 查询缓存可能导致用户看到陈旧数据。缓存策略需要平衡性能和新鲜度。

**待决策：**
- 即时查询（instant query）的缓存 TTL 应该多长？
- 范围查询（range query）是否应该缓存？
- 缓存是否需要按用户/角色隔离？
