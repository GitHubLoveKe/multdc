# 统一查询入口 (Query Gateway)

> 版本：v2.0 | 日期：2026-09-23
> 状态：设计中

---

## 一、概述

统一查询入口（Query Gateway）是控制面板提供给用户和 Grafana 的统一数据查询接口。它屏蔽了底层多网区、多存储实例的复杂性，使查询方无需关心数据存储在哪个网区的哪个 vmstorage 实例中，只需通过统一 API 即可查询全局任意实例的监控数据。

该模块是 P8 设计决策中"读路由"路径的核心实现。Query Gateway 通过DC 网关 的 vmselect 组件进行查询聚合——vmselect fan-out 到所有关联的 vmstorage 实例，原生合并去重后返回结果。

```
┌──────────────────────────────────────────────────────────────────────┐
│                      查询方                                          │
│   Grafana    Web UI    API 用户    自定义 Dashboard                  │
└──────┬──────────┬──────────┬──────────┬─────────────────────────────┘
       │          │          │          │
       └──────────┴──────────┴──────────┘
                  │
                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│                   统一查询入口 (Query Gateway)                        │
│                                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ 查询解析  │  │ 路由决策  │  │ 结果合并  │  │ Grafana  │           │
│  │ & 校验   │  │ & 分发   │  │ & 格式化  │  │ 数据源   │           │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  │ 管理     │           │
│       │             │             │         └──────────┘           │
└───────┼─────────────┼─────────────┼────────────────────────────────┘
        │             │             │
        └─────────────┼─────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────────────────────────────┐
│  DC 网关 (目标分发+配置+通信+查询+健康)                              │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  vmselect                                                     │   │
│  │  (查询聚合引擎)                                               │   │
│  │                                                               │   │
│  │  挂载所有 vmstorage 后端:                                     │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │   │
│  │  │Storage-A │  │Storage-B │  │Storage-C │  │Storage-D │    │   │
│  │  │(Zone-1)  │  │(Zone-2)  │  │(Zone-3)  │  │(Zone-4)  │    │   │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │   │
│  │                                                               │   │
│  │  Fan-out → 所有 vmstorage → 合并 + 去重 → 返回               │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  其他 Proxy 职责:                                                    │
│  · 配置分发 (push config to Alloy, vmalert, AM)                     │
│  · 组件通信 (双向控制面 ↔ 分布式组件)                                │
│  · 健康探测 (智能组件状态检测)                                       │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 二、职责边界

### 本模块负责

| 职责 | 说明 |
|------|------|
| 统一查询 API | 提供单一查询端点，兼容 Prometheus Query API |
| 查询路由 | 根据查询条件决定查询目标存储实例 |
| 跨网区查询 | 支持扇出到多个存储实例并合并结果 |
| Grafana 数据源管理 | 管理 Grafana 数据源配置，支持自动注册 |
| 结果合并 | 合并来自多个存储实例的查询结果 |
| 查询缓存 | 对热点查询提供缓存，降低后端压力 |

### 本模块不负责

| 不负责项 | 归属模块 |
|----------|----------|
| PromQL 的实际执行 | vmselect / vmstorage |
| 时序数据的存储 | 存储层 (VictoriaMetrics) |
| vmselect fan-out 聚合 | DC 网关 (vmselect) |
| 查询定义的管理 | 指标维护模块 (metric-management) |
| 网区-to-实例映射的维护 | 网区管理 + 实例管理 |
| 配置分发与组件通信 | DC 网关 |

---

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
| 实例-to-存储解析 | 从 PromQL 中提取 instance 标签，解析关联的存储实例 |
| 单存储查询 | 查询目标明确属于单个存储时，直接路由 |
| 跨存储扇出 | 查询涉及多个存储时，通过 vmselect 扇出 |
| 降级路由 | vmselect 不可用时，直接查询特定 vmstorage |
| 路由缓存 | 缓存实例-to-存储映射，减少查询延迟 |

**读路由策略：**

```
┌─────────────────────────────────────────────────────────────────┐
│                    读路由决策树                                   │
│                                                                 │
│  查询请求                                                       │
│    │                                                            │
│    ├── 指定了 zone_id ──▶ 查询该网区关联的 prime 存储           │
│    │                                                            │
│    ├── 指定了 instance ──▶ 查询实例-to-存储绑定                 │
│    │   │                                                        │
│    │   ├── 找到唯一存储 ──▶ 路由到该存储                        │
│    │   ├── 找到多个存储 ──▶ 通过 vmselect fan-out               │
│    │   └── 未找到 ──▶ 全局 fan-out (所有 vmstorage)             │
│    │                                                            │
│    └── 未指定 zone/instance ──▶ vmselect 全局 fan-out           │
│                                                                 │
│  查询执行:                                                      │
│    Query Gateway → DC 网关 (vmselect)                    │
│                     → fan-out 到所有 vmstorage                  │
│                     → 合并 + 去重 → 返回                       │
└─────────────────────────────────────────────────────────────────┘
```

**路由策略说明：**

| 场景 | 查询路径 | 说明 |
|------|---------|------|
| 指定 zone_id | Query Gateway → vmselect → 该 zone 的 prime storage | 精确路由 |
| 跨 zone 查询 | Query Gateway → vmselect → fan-out 所有 storage | vmselect 原生合并 |
| 全局查询 | Query Gateway → vmselect → fan-out 所有 storage | 全量 fan-out |
| vmselect 不可用 | Query Gateway → 直接查询特定 vmstorage | 降级模式 |

### 3.3 vmselect 查询聚合

vmselect 是 VictoriaMetrics 集群模式的查询入口组件，天然支持 fan-out 聚合。DC 网关 内置 vmselect，挂载所有网区的 vmstorage 后端。

```
vmselect 聚合流程:

  Query Gateway
       │
       │  PromQL 查询
       ▼
  DC 网关 (vmselect)
       │
       │  Fan-out (并行)
       ├──▶ vmstorage-A (Zone-1)
       ├──▶ vmstorage-B (Zone-2)
       ├──▶ vmstorage-C (Zone-3)
       └──▶ vmstorage-D (Zone-4)
       │
       │  收集结果
       │◀── 结果 A
       │◀── 结果 B
       │◀── 结果 C
       │◀── 结果 D
       │
       │  合并 + 去重 (-dedup.minScrapeInterval)
       │
       ▼
  返回统一结果

  特点:
    · vmselect 原生支持 fan-out + 合并 + 去重
    · 无需额外开发查询聚合逻辑
    · 去重由 vmselect -dedup 参数控制
    · 当前数据规模（万级实例，~10+ zone）下全量 fan-out 开销可接受
```

**智能路由（未来优化）：**

vmselect 当前不支持智能路由（按 zone 标签选择性查询后端），总是 fan-out 到所有后端。在当前数据规模下这是可接受的。如果未来数据规模增长到 fan-out 成为瓶颈，可以考虑：
- 部署多个 vmselect 实例，每个挂载部分 vmstorage
- 在 Query Gateway 层做预过滤，只向相关 vmselect 发送查询
- 评估 VictoriaMetrics vmselect 的智能路由支持进展

### 3.4 跨网区混合查询

| 功能 | 描述 |
|------|------|
| 扇出执行 | vmselect 将查询并行发送到所有 vmstorage |
| 超时控制 | 设置扇出查询的全局超时 |
| 部分失败处理 | 部分 vmstorage 超时时，返回已获取的结果 + 标记不完整 |
| 结果合并 | vmselect 原生合并多个 vmstorage 返回的时间序列 |
| 去重处理 | vmselect -dedup 自动处理多写导致的数据重复 |

**跨网区查询流程：**

```
  查询: avg by(type) (cpu_usage{type="oracle"})
  涉及: Zone-A (Storage-A), Zone-B (Storage-B), Zone-C (Storage-C)

  Query Gateway
       │
       ├── 解析查询 ──▶ 识别涉及 Oracle 实例
       │
       ├── 路由到 vmselect (通过DC 网关)
       │
       ├── vmselect fan-out:
       │   ├── → Storage-A: cpu_usage{type="oracle"}
       │   ├── → Storage-B: cpu_usage{type="oracle"}
       │   └── → Storage-C: cpu_usage{type="oracle"}
       │
       ├── vmselect 收集结果:
       │   ├── ← Storage-A: {instance="ora-a1"} 85.2
       │   ├── ← Storage-B: {instance="ora-b1"} 72.1, {instance="ora-b2"} 68.5
       │   └── ← Storage-C: {instance="ora-c1"} 91.3
       │
       ├── vmselect 合并 & 去重:
       │   └── 4 条唯一序列
       │
       └── 返回: avg by(type) = (85.2 + 72.1 + 68.5 + 91.3) / 4 = 79.3
```

### 3.5 Grafana 数据源管理

| 功能 | 描述 |
|------|------|
| 数据源注册 | 自动/手动在 Grafana 中注册数据源 |
| 数据源更新 | 存储实例变更时自动更新 Grafana 数据源配置 |
| 数据源健康检查 | 定期检查 Grafana 数据源的连通性 |
| 推荐数据源策略 | 根据使用场景推荐最佳数据源配置方式 |

**Grafana 数据源策略（分阶段）：**

**Phase 1: 网关代理模式（推荐）**

```
  Grafana
    └── Query Gateway (唯一数据源)
           │
           ├── DC 网关 (vmselect)
           │     └── fan-out 到所有 vmstorage
           └── 自动跨区合并

  特点: Grafana 只需配置一个数据源
  优点: 最灵活，Grafana 无需感知存储拓扑
  缺点: Gateway 成为瓶颈和单点
```

**Phase 2: 多数据源模式（备选）**

```
  Grafana
    ├── Query Gateway (全局查询)
    ├── Storage-A (Zone-A 直查)
    ├── Storage-B (Zone-B 直查)
    └── Storage-C (Zone-C 直查)

  特点: 各存储可直查，也可通过 Gateway 全局查
  优点: 灵活性高，Gateway 故障时仍可查单区
  缺点: Grafana 需管理多个数据源
```

### 3.6 结果合并与格式化

| 功能 | 描述 |
|------|------|
| 时间序列合并 | vmselect 原生合并多个 vmstorage 返回的不同时间序列 |
| 数据去重 | vmselect -dedup 基于去重键自动去除重复序列 |
| 时间对齐 | 处理不同 vmstorage 返回数据的时间戳微差异 |
| 格式兼容 | 确保返回格式与 Prometheus API 完全兼容 |
| 不完整标记 | 部分 vmstorage 失败时，在响应中标记结果不完整 |

**响应格式（部分失败）：**

```json
{
  "status": "success",
  "data": {
    "resultType": "vector",
    "result": [...],
    "warnings": [
      "partial_result: storage-zone-east-1 query timed out, results may be incomplete"
    ],
    "sources": {
      "storage-a": { "status": "ok", "series_count": 5 },
      "storage-b": { "status": "timeout", "series_count": 0 },
      "storage-c": { "status": "ok", "series_count": 3 }
    }
  }
}
```

### 3.7 查询缓存

| 功能 | 描述 |
|------|------|
| 查询结果缓存 | 对相同查询在短时间内返回缓存结果 |
| 缓存策略 | 即时查询缓存 15s，范围查询不缓存 |
| 缓存失效 | 存储实例状态变更时清除相关缓存 |
| 缓存统计 | 统计缓存命中率和节省的后端负载 |

---

## 四、核心数据模型

### 4.1 QueryRoute（查询路由配置）

```sql
CREATE TABLE query_route (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    zone_id          VARCHAR(64)   NOT NULL,           -- 网区 ID
    storage_id       VARCHAR(64)   NOT NULL,           -- 关联存储实例 ID
    is_prime         BOOLEAN       NOT NULL DEFAULT FALSE,  -- 是否为 prime 存储
    vmselect_url     VARCHAR(256)  NOT NULL,           -- vmselect 地址 (DC 网关)
    storage_url      VARCHAR(256)  NOT NULL,           -- vmstorage 直连地址 (降级用)
    query_timeout_ms INT           DEFAULT 30000,      -- 查询超时
    priority         INT           DEFAULT 0,          -- 优先级
    enabled          BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMP     NOT NULL,
    updated_at       TIMESTAMP     NOT NULL,
    UNIQUE KEY uk_zone_storage (zone_id, storage_id)
);
```

### 4.2 GrafanaDatasource（Grafana 数据源注册）

```sql
CREATE TABLE grafana_datasource (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    datasource_uid   VARCHAR(64)   NOT NULL UNIQUE,    -- Grafana 数据源 UID
    name             VARCHAR(128)  NOT NULL,           -- 数据源名称
    zone_id          VARCHAR(64),                      -- 关联网区 (空=全局)
    datasource_type  ENUM('gateway', 'storage_direct')
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

### 4.4 InstanceStorageMapping（实例-存储映射缓存）

```sql
-- 该表为查询网关专用的映射缓存，主数据在 Worker-Storage 绑定模块
CREATE TABLE instance_storage_mapping_cache (
    instance_id      VARCHAR(64)   PRIMARY KEY,
    zone_id          VARCHAR(64)   NOT NULL,
    prime_storage_id VARCHAR(64)   NOT NULL,            -- prime 存储 ID
    all_storage_ids  JSON,                              -- 所有关联存储 ID
    instance_labels  JSON,                              -- 常用标签缓存
    synced_at        TIMESTAMP     NOT NULL             -- 最近同步时间
);
```

---

## 五、接口与交互

### 5.1 上游依赖

| 来源 | 交互内容 | 协议 |
|------|----------|------|
| 用户 / Grafana | 查询请求 | Prometheus HTTP API |
| 实例管理模块 | 实例-to-网区映射 | 内部 API |
| Worker-Storage 绑定 | 存储绑定关系 | 内部 API |

### 5.2 下游提供

| 消费方 | 提供内容 | 协议 |
|--------|----------|------|
| DC 网关 (vmselect) | 查询请求 (主要路径) | Prometheus Query API |
| vmstorage (直连降级) | 查询请求 (降级路径) | Prometheus Query API |
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
# ?storage_id=storage-a        限定查询存储
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
  │  [2] 实例-to-存储解析                               │
  │      └── ora-01 → zone_id: zone-east-1             │
  │          prime_storage: storage-b                    │
  │                                                     │
  │  [3] 路由决策                                       │
  │      └── 通过DC 网关 (vmselect) 查询         │
  │                                                     │
  │  [4] 执行查询                                       │
  │      └── → DC 网关:8080                      │
  │          GET /api/v1/query?query=up{instance="ora-01"}│
  │                                                     │
  │  [5] vmselect fan-out                              │
  │      └── 并行查询所有 vmstorage                     │
  │          合并 + 去重                                │
  │                                                     │
  │  [6] 返回结果                                       │
  │      └── 原样返回 Prometheus 格式                   │
  └─────────────────────────────────────────────────────┘
       │
       ▼
  Grafana/User 收到结果
```

---

## 六、设计决策与替代方案

### 6.1 查询聚合方式

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：vmselect fan-out（当前） | DC 网关 的 vmselect 挂载所有 vmstorage，原生 fan-out | 零开发；VM 原生能力；去重内置 | 全量 fan-out 开销随规模增长 |
| B：自研聚合层 | Query Gateway 自行实现 fan-out + 合并 | 可定制智能路由 | 重复造轮子；维护负担 |
| C：智能路由 | 按 zone 标签选择性查询后端 | 性能好 | vmselect 原生不支持；需额外开发 |

**[决策 2026-09-23]**：方案 A。当前数据规模（万级实例，~10+ zone）下全量 fan-out 开销可接受。智能路由作为未来优化方向。

### 6.2 Grafana 集成策略

**推荐方案：网关代理模式**

```
Grafana → Query Gateway → DC 网关 (vmselect) → fan-out 到所有 vmstorage
```

| 优点 | 缺点 |
|------|------|
| Grafana 只需一个数据源 | Gateway 成为单点和瓶颈 |
| 完全屏蔽存储拓扑 | Gateway 故障影响所有查询 |
| 最灵活，支持跨区查询 | 需要 Gateway 高可用部署 |
| 统一查询入口 | 所有查询流量经过 Gateway |

**建议：** 阶段 1 即采用网关代理模式。vmselect 的原生 fan-out 能力使得 Query Gateway 可以非常轻量地实现。

### 6.3 查询网关的高可用

**建议：** 无状态设计，支持多实例部署 + 负载均衡。

**理由：**
- Query Gateway 不维护查询状态（除缓存外）
- 缓存可使用共享缓存
- 多实例部署避免单点

---

## 七、冲突与开放问题

| ID | 问题 | 影响 | 状态 |
|----|------|------|------|
| QG-01 | vmselect 全局 fan-out 的性能上限 | 数据规模增长后 fan-out 可能成为瓶颈 | 待观察 |
| QG-02 | 查询网关的认证与授权 | 是否需要按网区控制查询权限 | 待确认 |
| QG-03 | 查询缓存的一致性 | 缓存 TTL 与数据新鲜度的平衡 | 待确认 |
| QG-04 | Grafana 数据源自动维护复杂度 | 自动注册与手动配置的冲突处理 | 待确认 |
| QG-05 | 跨区查询的部分失败处理策略 | 返回部分结果 + 警告 vs 报错 | 待确认 |
| QG-06 | vmselect 智能路由的可行性评估 | 未来是否需要按 zone 选择性查询 | 待评估 |
| QG-07 | Zone Query Proxy 废弃后的迁移路径 | 旧部署中 Zone Query Proxy 的处理 | 已废弃（2026-09-23） |

---

## 八、废弃内容

> 以下内容在 v2.0（2026-09-23）中废弃，保留索引以供追溯。

| 废弃项 | 原内容 | 替代方案 |
|--------|--------|----------|
| Mode A/B/C 路由 | 按存储模式选择不同数据源 | 统一通过 vmselect fan-out |
| Zone Query Proxy 路由 | 查询路由到 Zone Query Proxy | DC 网关 (vmselect) |
| 中心 VM 直查 | Mode A 直接查询中心 VM | 所有存储实例平级管理 |
| 降级到中心 VM | Mode B/C 降级到中心 VM | 降级到 vmstorage 直连 |
