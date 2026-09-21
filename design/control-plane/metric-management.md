# 指标维护 (Metric Management)

## 一、概述

指标维护模块是中心控制面的知识管理模块，负责管理监控平台中所有预定义和自定义的 PromQL 查询集、指标元数据、以及查询分类体系。该模块为运维人员和开发者提供"查什么"和"怎么查"的知识库，是连接底层采集能力与上层可视化/分析能力的桥梁。

该模块本身不执行查询——查询的实际执行由查询网关（query-gateway）负责，查询网关将 PromQL 路由到正确的数据源（中心 VM 或 Zone Query Proxy）并返回结果。

```
  ┌──────────────────────────────────────────────────────────────┐
  │                       中心控制面                              │
  │                                                              │
  │  ┌──────────────────────────────────────────────────┐       │
  │  │                 指标维护模块                      │       │
  │  │                                                  │       │
  │  │  ┌──────────┐ ┌──────────┐ ┌──────────────┐    │       │
  │  │  │ 公共查询集│ │ 自定义查询│ │ 指标元数据    │    │       │
  │  │  │ (PromQL) │ │ (用户定义)│ │ (指标描述)    │    │       │
  │  │  └────┬─────┘ └────┬─────┘ └──────┬───────┘    │       │
  │  │       │            │              │             │       │
  │  │  ┌────┴────────────┴──────────────┴──────┐     │       │
  │  │  │         查询分类与标签体系             │     │       │
  │  │  └───────────────────────────────────────┘     │       │
  │  └──────────────────────────────────────────────────┘       │
  │                          │                                   │
  └──────────────────────────┼───────────────────────────────────┘
                             │ 查询定义
                             ▼
  ┌──────────────────────────────────────────────────────────────┐
  │                    查询网关 (query-gateway)                   │
  │              执行 PromQL → 路由到数据源 → 返回结果             │
  └──────────────────────────────────────────────────────────────┘
```

## 二、职责边界

### 本模块负责

| 职责 | 说明 |
|------|------|
| 公共查询集管理 | 维护预定义的常用 PromQL 查询（CPU、内存、磁盘、网络、DB 特定） |
| 自定义查询管理 | 用户创建、保存、管理自己的 PromQL 查询 |
| 查询分类 | 按实例类型、场景、用途对查询进行分类 |
| 指标元数据 | 维护指标的名称、描述、单位、类型等元数据 |
| 查询共享 | 支持用户之间共享自定义查询 |
| 查询版本管理 | 公共查询集支持版本更新 |

### 本模块不负责

| 不负责项 | 归属模块 |
|----------|----------|
| PromQL 的实际执行 | 查询网关 (query-gateway) |
| 时序数据的存储 | 数据层 (VictoriaMetrics) |
| 采集指标的发现与注册 | 数据层 (Agent + OTel Collector) |
| 可视化面板的展示 | Grafana / Web UI |

## 三、功能清单

### 3.1 公共查询集

| 功能 | 描述 |
|------|------|
| 预置查询库 | 为每种实例类型提供预置查询集 |
| 查询版本管理 | 公共查询支持版本化，更新不影响已引用旧版本的场景 |
| 查询启用/禁用 | 可单独启用/禁用某条公共查询 |
| 查询参数化 | 公共查询支持参数化（如 `$instance`、`$duration`） |
| 查询收藏 | 用户可收藏常用查询 |

**预置查询集分类：**

**操作系统通用查询：**

| 查询名 | PromQL | 说明 |
|--------|--------|------|
| cpu_usage_percent | `100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)` | CPU 使用率 |
| memory_usage_percent | `(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100` | 内存使用率 |
| disk_usage_percent | `(1 - node_filesystem_avail_bytes / node_filesystem_size_bytes) * 100` | 磁盘使用率 |
| disk_io_read_bytes | `rate(node_disk_read_bytes_total[5m])` | 磁盘读速率 |
| disk_io_write_bytes | `rate(node_disk_written_bytes_total[5m])` | 磁盘写速率 |
| network_in_bytes | `rate(node_network_receive_bytes_total[5m])` | 网络入流量 |
| network_out_bytes | `rate(node_network_transmit_bytes_total[5m])` | 网络出流量 |
| load_average_1m | `node_load1` | 1 分钟负载 |
| filesystem_readonly | `node_filesystem_readonly` | 只读文件系统检测 |

**Oracle 特定查询：**

| 查询名 | PromQL | 说明 |
|--------|--------|------|
| oracle_tablespace_usage | `oracle_tablespace_bytes / oracle_tablespace_max_bytes * 100` | 表空间使用率 |
| oracle_active_sessions | `oracle_sessions{status="ACTIVE"}` | 活跃会话数 |
| oracle_sga_usage | `oracle_sga_current_bytes` | SGA 内存使用 |
| oracle_pga usage | `oracle_pga_aggregate_bytes` | PGA 内存使用 |
| oracle_wait_events | `rate(oracledb_wait_time_total[5m])` | 等待事件时间 |
| oracle_asm_diskgroup | `oracle_asm_diskgroup_free_bytes / oracle_asm_diskgroup_total_bytes * 100` | ASM 磁盘组使用率 |
| oracle_archive_log_switch | `rate(oracledb_archive_log_switches_total[1h])` | 归档日志切换频率 |

**MySQL 特定查询：**

| 查询名 | PromQL | 说明 |
|--------|--------|------|
| mysql_connections_usage | `mysql_global_status_threads_connected / mysql_global_variables_max_connections * 100` | 连接数使用率 |
| mysql_replication_lag | `mysql_slave_seconds_behind_master` | 主从延迟 |
| mysql_buffer_pool_hit | `1 - rate(mysql_global_status_innodb_buffer_pool_reads_total[5m]) / rate(mysql_global_status_innodb_buffer_pool_read_requests_total[5m])` | Buffer Pool 命中率 |
| mysql_slow_queries_rate | `rate(mysql_global_status_slow_queries_total[5m])` | 慢查询速率 |
| mysql_qps | `rate(mysql_global_status_queries_total[5m])` | QPS |

### 3.2 用户自定义查询

| 功能 | 描述 |
|------|------|
| 创建查询 | 用户创建自定义 PromQL 查询，指定名称、描述、分类 |
| 查询验证 | 创建时进行语法检查和安全性检查 |
| 查询编辑 | 修改已有自定义查询 |
| 查询删除 | 删除不再需要的自定义查询 |
| 查询测试 | 执行查询并预览结果 |

**查询验证规则：**

```
语法检查:
  ├── PromQL 语法是否合法
  ├── 函数名是否正确
  └── 括号是否匹配

安全检查:
  ├── 是否包含 __name__ 正则全匹配 (可能返回海量数据)
  ├── 时间范围是否合理 (禁止 > 30d 的 range vector)
  ├── 是否使用了被禁用的函数 (如 label_replace 的某些用法)
  └── 预估返回数据量是否超过阈值
```

### 3.3 查询分类体系

| 功能 | 描述 |
|------|------|
| 按实例类型分类 | Oracle 查询、MySQL 查询、Linux 查询、Windows 查询等 |
| 按场景分类 | 容量规划、性能分析、故障排查、日常巡检 |
| 按层级分类 | 基础设施（CPU/内存/磁盘）、中间件（DB/消息队列）、应用 |
| 自定义分类 | 用户创建自定义分类标签 |
| 分类浏览 | 按分类树浏览查询集 |

**分类体系结构：**

```
查询分类
├── 基础设施
│   ├── CPU ─── 使用率 / 负载 / 上下文切换 / 中断
│   ├── 内存 ─── 使用率 / 可用量 / Swap / Cache
│   ├── 磁盘 ─── 使用率 / IO / 延迟 / inode
│   └── 网络 ─── 流量 / 丢包 / 错误 / 连接数
├── 数据库
│   ├── Oracle ─── 表空间 / 会话 / SGA / PGA / 等待事件 / ASM
│   ├── MySQL ─── 连接 / 复制 / Buffer Pool / 慢查询 / QPS
│   └── PostgreSQL ─── 连接 / 复制 / 锁 / 缓存命中
├── 中间件
│   ├── Redis ─── 内存 / 命中率 / 连接 / 键数量
│   └── Kafka ─── 消费延迟 / 分区 / Broker 状态
├── 场景
│   ├── 日常巡检 ─── 核心指标一览
│   ├── 性能分析 ─── 详细性能指标
│   └── 故障排查 ─── 诊断类指标
└── 自定义分类
```

### 3.4 指标元数据

| 功能 | 描述 |
|------|------|
| 指标注册 | 注册指标的名称、描述、类型、单位 |
| 指标搜索 | 按名称/描述/标签搜索指标 |
| 指标关联 | 关联指标与实例类型（哪些指标适用于哪些实例类型） |
| 指标来源 | 记录指标来源于哪个 Exporter / Agent |
| 自动发现 | （未来）从 TSDB 自动发现新指标并注册元数据 |

**指标元数据模型：**

```json
{
  "metric_name": "oracle_tablespace_bytes",
  "description": "Oracle 表空间已使用字节数",
  "type": "gauge",
  "unit": "bytes",
  "instance_types": ["oracle"],
  "source": "oracledb_exporter",
  "labels": [
    { "name": "tablespace_name", "description": "表空间名称" },
    { "name": "instance", "description": "实例标识" }
  ],
  "common_thresholds": {
    "warning": "> 85% of max",
    "critical": "> 95% of max"
  }
}
```

### 3.5 查询共享

| 功能 | 描述 |
|------|------|
| 个人查询 | 仅创建者可见的私有查询 |
| 团队查询 | 团队内共享的查询 |
| 公共查询 | 全平台可见的查询（需审核） |
| 查询导入/导出 | 支持查询集的批量导入导出（JSON/YAML） |
| 查询评分 | 用户可对共享查询评分和评论 |

## 四、核心数据模型

### 4.1 MetricQuery（指标查询）

```sql
CREATE TABLE metric_query (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    query_id         VARCHAR(64)   NOT NULL UNIQUE,
    name             VARCHAR(128)  NOT NULL,           -- 查询名称
    description      TEXT,                              -- 查询描述
    promql           TEXT          NOT NULL,            -- PromQL 表达式
    query_type       ENUM('builtin', 'custom')         -- 内置 / 自定义
                     NOT NULL DEFAULT 'custom',
    instance_type    VARCHAR(32),                      -- 适用实例类型 (可空=通用)
    category         VARCHAR(64),                      -- 分类
    tags             JSON,                              -- 标签
    parameters       JSON,                              -- 参数化定义
    -- parameters 格式:
    -- [
    --   { "name": "instance", "type": "label_selector", "required": true },
    --   { "name": "duration", "type": "duration", "default": "5m" }
    -- ]
    visibility       ENUM('private', 'team', 'public')
                     NOT NULL DEFAULT 'private',
    owner_id         VARCHAR(64),                      -- 创建者
    team_id          VARCHAR(64),                      -- 所属团队
    version          INT           DEFAULT 1,          -- 版本号 (builtin 用)
    is_validated     BOOLEAN       DEFAULT FALSE,      -- 是否通过验证
    validation_error TEXT,                              -- 验证错误信息
    enabled          BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMP     NOT NULL,
    updated_at       TIMESTAMP     NOT NULL,
    INDEX idx_type_category (instance_type, category),
    INDEX idx_visibility (visibility)
);
```

### 4.2 MetricMetadata（指标元数据）

```sql
CREATE TABLE metric_metadata (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    metric_name      VARCHAR(256)  NOT NULL,
    description      TEXT,
    metric_type      ENUM('counter', 'gauge', 'histogram', 'summary', 'unknown')
                     NOT NULL DEFAULT 'unknown',
    unit             VARCHAR(32),                      -- 单位: bytes, percent, seconds, ...
    instance_types   JSON,                              -- 适用实例类型列表
    source_exporter  VARCHAR(64),                      -- 来源 Exporter
    labels           JSON,                              -- 标签定义
    thresholds       JSON,                              -- 常见阈值
    is_auto_discovered BOOLEAN     DEFAULT FALSE,
    created_at       TIMESTAMP     NOT NULL,
    updated_at       TIMESTAMP     NOT NULL,
    UNIQUE KEY uk_metric_name (metric_name)
);
```

### 4.3 QueryCategory（查询分类）

```sql
CREATE TABLE query_category (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    category_id      VARCHAR(64)   NOT NULL UNIQUE,
    name             VARCHAR(128)  NOT NULL,
    parent_id        VARCHAR(64),                     -- 父分类 (树形结构)
    sort_order       INT           DEFAULT 0,
    is_builtin       BOOLEAN       NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMP     NOT NULL
);
```

### 4.4 QueryFavorite（查询收藏）

```sql
CREATE TABLE query_favorite (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    user_id          VARCHAR(64)   NOT NULL,
    query_id         VARCHAR(64)   NOT NULL,
    created_at       TIMESTAMP     NOT NULL,
    UNIQUE KEY uk_user_query (user_id, query_id)
);
```

## 五、接口与交互

### 5.1 上游依赖

| 来源 | 交互内容 | 协议 |
|------|----------|------|
| 运维人员 | 创建/编辑自定义查询、管理元数据 | REST API |
| TSDB (未来) | 自动发现指标元数据 | Prometheus API |

### 5.2 下游提供

| 消费方 | 提供内容 | 协议 |
|--------|----------|------|
| 查询网关 | 查询定义（PromQL + 参数） | 内部 API |
| Web UI | 查询浏览器、指标目录 | REST API |
| Grafana | （未来）查询集同步到 Grafana | Grafana API |

### 5.3 对外 API

```
# 公共查询集
GET    /api/v1/metric-queries/builtin              # 查询预置查询列表
GET    /api/v1/metric-queries/builtin/{query_id}   # 查询单个预置查询

# 自定义查询
GET    /api/v1/metric-queries                       # 查询列表 (支持过滤/搜索)
POST   /api/v1/metric-queries                       # 创建查询
GET    /api/v1/metric-queries/{query_id}            # 查询详情
PUT    /api/v1/metric-queries/{query_id}            # 更新查询
DELETE /api/v1/metric-queries/{query_id}            # 删除查询
POST   /api/v1/metric-queries/{query_id}/validate   # 验证查询
POST   /api/v1/metric-queries/{query_id}/test       # 测试执行查询

# 查询执行 (代理到查询网关)
POST   /api/v1/metric-queries/execute               # 执行查询
  Body: { "promql": "...", "time": "...", "zone_id": "..." }

# 指标元数据
GET    /api/v1/metrics                              # 查询指标列表
GET    /api/v1/metrics/{metric_name}                # 查询指标详情
POST   /api/v1/metrics                              # 注册指标元数据
PUT    /api/v1/metrics/{metric_name}                # 更新指标元数据
GET    /api/v1/metrics/search?q=...                 # 搜索指标

# 分类
GET    /api/v1/metric-categories                    # 查询分类树
POST   /api/v1/metric-categories                    # 创建分类

# 收藏
POST   /api/v1/metric-queries/{query_id}/favorite   # 收藏查询
DELETE /api/v1/metric-queries/{query_id}/favorite   # 取消收藏
GET    /api/v1/metric-queries/favorites             # 我的收藏

# 导入导出
POST   /api/v1/metric-queries/import                # 批量导入
GET    /api/v1/metric-queries/export                # 批量导出
```

## 六、设计决策与替代方案

### 6.1 指标元数据来源：手动 vs 自动发现 [待确认]

**方案 A: 手动维护**

由平台管理员手动注册指标元数据。

| 优点 | 缺点 |
|------|------|
| 元数据质量可控 | 维护工作量大 |
| 描述可以很详细 | 新指标无法自动覆盖 |

**方案 B: TSDB 自动发现**

从 VictoriaMetrics 的 `/api/v1/label/__name__/values` 接口自动发现指标。

| 优点 | 缺点 |
|------|------|
| 自动覆盖所有指标 | 缺少业务语义描述 |
| 新指标自动纳入 | 可能引入大量无用指标 |

**方案 C: 混合方案 [建议]**

自动发现指标列表 + 手动补充描述和元数据。

- 定期从 TSDB 同步指标名称列表
- 未注册元数据的指标标记为"未编目"
- 管理员逐步补充关键指标的元数据

### 6.2 查询参数化方案 [建议]

**建议：** 使用 Grafana 风格的变量语法（`$variable` 或 `${variable}`）。

**理由：**
- 与 Grafana 变量语法兼容
- 用户熟悉度高
- 便于查询在 Grafana 中直接使用

### 6.3 公共查询集的更新策略 [建议]

**建议：** 公共查询集采用版本化管理，更新时创建新版本，旧版本保留。

**策略：**
- 每个公共查询有 `version` 字段
- 更新时 version + 1，旧版本保留（可标记为 deprecated）
- 引用公共查询的场景可选择锁定版本或跟随最新版
- 提供版本变更日志

### 6.4 自定义查询的安全检查 [已确认]

**决策：** 自定义查询在保存前必须通过安全检查，拒绝潜在的危险查询。

**检查项：**
- range vector 不超过 30 天
- 禁止无过滤的全量查询（如 `{__name__=~".*"}`）
- 限制子查询步长最小值
- 限制查询复杂度（嵌套深度、函数数量）

## 七、冲突与开放问题

### MC-16: 指标元数据与 Agent 采集配置的同步 [待确认]

**冲突描述：** Agent 采集的指标由 Exporter 决定，指标元数据需要与 Exporter 版本保持同步。当 Exporter 升级引入新指标或变更指标名时，指标元数据如何同步更新？

### MC-17: 自定义查询的跨网区执行 [待确认]

**冲突描述：** 用户创建的自定义查询可能需要跨多个网区执行（如"查看所有 Oracle 实例的表空间使用率"）。查询网关需要知道如何将查询拆分到多个数据源。

**待决策：** 自定义查询是否需要指定目标网区范围？还是由查询网关自动路由？

### MC-18: 公共查询集与 Grafana Dashboard 的关系 [待确认]

**冲突描述：** 公共查询集中的查询是否应自动同步为 Grafana Dashboard 面板？还是两者独立维护？

### MC-19: 指标元数据的规模管理 [待确认]

**冲突描述：** 大型环境中可能有数千个不同的指标名称，指标元数据的管理和搜索需要高效。是否需要引入搜索引擎（如 Elasticsearch）来支持全文搜索？
