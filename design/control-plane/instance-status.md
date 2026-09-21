# 实例状态维护 (Instance Status Maintenance)

## 一、概述

实例状态维护模块负责持续追踪所有被监控实例的运行状态（正常/异常/降级/未知），为运维人员提供全局的实例健康视图。该模块通过周期性查询 TSDB（VictoriaMetrics）中的监控指标，将原始指标数据转化为业务可理解的状态信息。

在三层架构中，该模块运行于中心控制面，其数据源取决于各网区的存储模式：Mode A 网区查询中心 VM，Mode B/C 网区可通过 Zone Query Proxy 查询本地 VM。这种数据源差异是该模块设计的核心挑战之一。

```
  ┌────────────────────────────────────────────────────────────┐
  │                     中心控制面 (RDS)                        │
  │                                                            │
  │  ┌──────────────────────────────────────────────┐         │
  │  │            实例状态维护模块                    │         │
  │  │  ┌─────────┐ ┌──────────┐ ┌───────────────┐ │         │
  │  │  │ 状态拉取 │ │ 状态聚合  │ │ 中间件状态抽象 │ │         │
  │  │  └────┬────┘ └────┬─────┘ └──────┬────────┘ │         │
  │  └───────┼───────────┼──────────────┼──────────┘         │
  │          │           │              │                      │
  └──────────┼───────────┼──────────────┼──────────────────────┘
             │           │              │
     ┌───────┴───┐  ┌───┴────┐   ┌─────┴──────┐
     │ 中心 VM   │  │ 状态缓存│   │ 告警管理    │
     │ (Mode A)  │  │(Redis) │   │ 通知渠道    │
     └───────┬───┘  └────────┘   └────────────┘
             │
     ┌───────┴───────────────────────────┐
     │         Zone Query Proxy          │
     │    (Mode B/C 本地 VM 查询代理)     │
     └───────────────────────────────────┘
```

## 二、职责边界

### 本模块负责

| 职责 | 说明 |
|------|------|
| 实例运行状态维护 | 维护每个实例的可用性状态（up/down/degraded/unknown） |
| 周期性状态拉取 | 定时查询 TSDB 获取最新指标，计算实例状态 |
| 状态变更检测 | 检测状态变化并生成状态变更事件 |
| 状态聚合 | 从实例级聚合到网区级、服务级、全局级状态视图 |
| 中间件状态抽象 | 将原始指标翻译为业务语义状态（如 Oracle 表空间 > 90% → 警告） |

### 本模块不负责

| 不负责项 | 归属模块 |
|----------|----------|
| 实际的指标采集 | 数据层 (Agent + OTel Collector) |
| 告警规则评估 | RC (RuleCheck) 模块 |
| 告警事件处理 | 告警管理模块 (alert-management) |
| 时序数据存储 | 数据层 (VictoriaMetrics) |
| 实例管理状态（active/suspended 等） | 实例管理模块 (instance-management) |

## 三、功能清单

### 3.1 状态拉取引擎

| 功能 | 描述 |
|------|------|
| 周期查询调度 | 按配置的间隔周期性查询 TSDB 获取指标数据 |
| 多数据源路由 | 根据实例所属网区的存储模式，选择正确的查询目标 |
| PromQL 状态查询 | 执行预定义的状态判定 PromQL（如 `up{job="oracle"}`） |
| 查询批量优化 | 合并同一网区/同一类型的状态查询，减少查询次数 |
| 查询失败处理 | 查询超时或失败时的重试和降级策略 |

**数据源路由策略：**

```
实例所属网区存储模式
    │
    ├── Mode A ──▶ 直接查询中心 VM
    │               (数据仅存在于中心)
    │
    ├── Mode B ──▶ 优先查询 Zone Query Proxy (本地 VM，数据更新)
    │               降级: 查询中心 VM (remote-write 副本，有延迟)
    │
    └── Mode C ──▶ 查询 Zone Query Proxy (本地 VM 集群)
                    降级: 查询中心 VM (如有 remote-write)
```

### 3.2 状态模型

| 功能 | 描述 |
|------|------|
| 可用性状态 | up / down / degraded / unknown |
| 性能状态 | normal / warning / critical（基于性能指标阈值） |
| 容量状态 | sufficient / warning / critical（基于容量指标阈值） |
| 综合健康度 | 综合可用性 + 性能 + 容量的健康评分 |

**状态维度定义：**

```
┌─────────────────────────────────────────────────┐
│              实例综合健康模型                      │
│                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────┐ │
│  │  可用性      │  │  性能        │  │  容量    │ │
│  │             │  │             │  │         │ │
│  │ up          │  │ normal      │  │ ok      │ │
│  │ degraded    │  │ warning     │  │ warning │ │
│  │ down        │  │ critical    │  │ critical│ │
│  │ unknown     │  │             │  │         │ │
│  └──────┬──────┘  └──────┬──────┘  └────┬────┘ │
│         │                │              │       │
│         └────────────────┼──────────────┘       │
│                          ▼                      │
│                ┌──────────────────┐             │
│                │   综合健康度      │             │
│                │   healthy (100)  │             │
│                │   warning (60)   │             │
│                │   critical (30)  │             │
│                │   down (0)       │             │
│                └──────────────────┘             │
└─────────────────────────────────────────────────┘
```

### 3.3 状态变更检测与事件

| 功能 | 描述 |
|------|------|
| 状态变化检测 | 对比前后两次状态拉取结果，检测变化 |
| 抖动抑制 | 避免瞬时波动导致的状态频繁切换（需连续 N 次确认） |
| 变更事件生成 | 状态变化时生成结构化事件（包含旧状态、新状态、时间戳、原因） |
| 变更历史 | 记录每个实例的状态变更历史 |

**抖动抑制策略：**

```
状态判定规则:
  - up → down:  需连续 3 次查询结果为 down (避免瞬时网络抖动)
  - down → up:  需连续 2 次查询结果为 up (确保稳定恢复)
  - normal → warning: 需连续 2 次 (避免指标波动)
  - warning → critical: 立即切换 (严重问题不延迟)
```

### 3.4 状态聚合

| 功能 | 描述 |
|------|------|
| 网区级聚合 | 汇总某网区内所有实例的状态，计算网区健康度 |
| 服务级聚合 | 按服务（如"所有 Oracle 实例"）聚合状态 |
| 标签级聚合 | 按标签组合（如 env=production, team=dba）聚合状态 |
| 全局概览 | 全局实例健康概览（正常/异常/未知的比例） |
| 聚合下钻 | 从全局 → 网区 → 实例逐层下钻查看 |

### 3.5 中间件状态抽象

| 功能 | 描述 |
|------|------|
| 规则定义 | 为每种中间件类型定义状态抽象规则 |
| 指标映射 | 将原始指标映射为业务状态（如 `oracle_tablespace_usage > 0.9` → warning） |
| 规则管理 | 支持用户自定义状态抽象规则 |
| 规则模板 | 为常见中间件提供预置状态抽象规则模板 |

**Oracle 状态抽象规则示例：**

| 指标 | 正常 | 警告 | 严重 |
|------|------|------|------|
| 表空间使用率 | < 85% | 85%-95% | > 95% |
| 活跃会话数 | < 80% max | 80%-95% max | > 95% max |
| 等待事件 | 无异常排队 | 排队 > 10s | 排队 > 60s |
| ASM 磁盘组 | > 20% 空闲 | 10%-20% 空闲 | < 10% 空闲 |
| 归档日志 | 正常切换 | 切换延迟 > 5min | 切换失败 |

**MySQL 状态抽象规则示例：**

| 指标 | 正常 | 警告 | 严重 |
|------|------|------|------|
| 主从延迟 | < 1s | 1-10s | > 10s |
| 连接数使用率 | < 70% | 70%-90% | > 90% |
| InnoDB Buffer Pool 命中率 | > 99% | 95%-99% | < 95% |
| 慢查询速率 | < 1/min | 1-10/min | > 10/min |

## 四、核心数据模型

### 4.1 InstanceStatus（实例状态缓存）

```sql
CREATE TABLE instance_status (
    instance_id      VARCHAR(64)   PRIMARY KEY,       -- FK → instance
    availability     ENUM('up', 'down', 'degraded', 'unknown')
                     NOT NULL DEFAULT 'unknown',
    performance      ENUM('normal', 'warning', 'critical', 'unknown')
                     NOT NULL DEFAULT 'unknown',
    capacity         ENUM('sufficient', 'warning', 'critical', 'unknown')
                     NOT NULL DEFAULT 'unknown',
    health_score     INT,                             -- 0-100 综合健康分
    detail           JSON,                            -- 详细状态信息
    last_check_at    TIMESTAMP,                       -- 最近检查时间
    last_change_at   TIMESTAMP,                       -- 最近状态变更时间
    consecutive_count INT          DEFAULT 0,         -- 连续相同状态次数
    raw_metrics      JSON                             -- 最近一次拉取的原始指标快照
);
```

### 4.2 StatusChangeLog（状态变更日志）

```sql
CREATE TABLE status_change_log (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    instance_id      VARCHAR(64)   NOT NULL,
    dimension        VARCHAR(16)   NOT NULL,          -- availability/performance/capacity
    old_status       VARCHAR(16)   NOT NULL,
    new_status       VARCHAR(16)   NOT NULL,
    trigger_metric   VARCHAR(128),                    -- 触发变更的指标名
    trigger_value    VARCHAR(64),                     -- 触发变更的指标值
    changed_at       TIMESTAMP     NOT NULL,
    INDEX idx_change_instance (instance_id, changed_at)
);
```

### 4.3 StatusAbstractionRule（状态抽象规则）

```sql
CREATE TABLE status_abstraction_rule (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    instance_type    VARCHAR(32)   NOT NULL,          -- 适用实例类型
    rule_name        VARCHAR(128)  NOT NULL,
    metric_name      VARCHAR(128)  NOT NULL,          -- 原始指标名
    dimension        VARCHAR(16)   NOT NULL,          -- 映射到的状态维度
    warning_expr     VARCHAR(256),                    -- 警告阈值表达式
    critical_expr    VARCHAR(256),                    -- 严重阈值表达式
    is_builtin       BOOLEAN       NOT NULL DEFAULT FALSE,
    enabled          BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMP     NOT NULL,
    updated_at       TIMESTAMP     NOT NULL
);
```

### 4.4 StatusCheckConfig（状态检查配置）

```sql
CREATE TABLE status_check_config (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    instance_type    VARCHAR(32)   NOT NULL,
    check_interval_s INT           NOT NULL DEFAULT 30,  -- 检查间隔(秒)
    up_down_confirm  INT           NOT NULL DEFAULT 3,   -- up→down 确认次数
    down_up_confirm  INT           NOT NULL DEFAULT 2,   -- down→up 确认次数
    query_timeout_ms INT           NOT NULL DEFAULT 5000, -- 查询超时
    status_queries   JSON          NOT NULL,             -- PromQL 查询列表
    enabled          BOOLEAN       NOT NULL DEFAULT TRUE
);
```

## 五、接口与交互

### 5.1 上游依赖

| 来源 | 交互内容 | 协议 |
|------|----------|------|
| 实例管理模块 | 实例列表、网区归属、实例类型 | 内部 API |
| 网区管理模块 | 网区存储模式（决定查询路由） | 内部 API |
| 中心 VM | Mode A 网区的指标数据 | Prometheus Query API |
| Zone Query Proxy | Mode B/C 网区的指标数据 | Prometheus Query API |

### 5.2 下游提供

| 消费方 | 提供内容 | 协议 |
|--------|----------|------|
| 告警管理模块 | 状态变更事件（可选，作为告警源之一） | 事件推送 |
| Web UI | 实例状态概览、聚合视图、状态历史 | REST API |
| 通知渠道 | 状态变更通知（严重状态变化时） | 事件推送 |

### 5.3 对外 API

```
# 状态查询
GET    /api/v1/status/overview                    # 全局状态概览
GET    /api/v1/status/instances                   # 实例状态列表 (支持过滤/分页)
GET    /api/v1/status/instances/{instance_id}     # 单个实例状态详情
GET    /api/v1/status/zones/{zone_id}             # 网区级状态聚合
GET    /api/v1/status/aggregate                   # 按标签/类型聚合查询

# 状态历史
GET    /api/v1/status/instances/{instance_id}/history   # 实例状态变更历史
GET    /api/v1/status/zones/{zone_id}/history           # 网区状态变更历史

# 状态抽象规则管理
GET    /api/v1/status/rules                       # 查询规则列表
POST   /api/v1/status/rules                       # 创建规则
PUT    /api/v1/status/rules/{rule_id}             # 更新规则
DELETE /api/v1/status/rules/{rule_id}             # 删除规则

# 配置
GET    /api/v1/status/config                      # 查询检查配置
PUT    /api/v1/status/config                      # 更新检查配置
```

### 5.4 内部查询流程

```
  ┌──────────────┐
  │  定时调度器   │  每 N 秒触发
  └──────┬───────┘
         │
         ▼
  ┌──────────────┐     ┌──────────────┐
  │ 获取实例列表  │────▶│ 按网区/存储模式 │
  │ (from RDS)   │     │ 分组          │
  └──────────────┘     └──────┬───────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
       ┌──────────┐   ┌──────────┐   ┌──────────────┐
       │ 中心 VM  │   │ Zone QP  │   │ Zone QP      │
       │ (Mode A) │   │ (Mode B) │   │ (Mode C)     │
       └────┬─────┘   └────┬─────┘   └──────┬───────┘
            │              │                │
            └──────────────┼────────────────┘
                           ▼
                  ┌─────────────────┐
                  │  合并查询结果    │
                  │  状态判定       │
                  │  抖动抑制       │
                  │  更新状态缓存    │
                  └────────┬────────┘
                           │
                           ▼
                  ┌─────────────────┐
                  │  检测状态变更    │
                  │  生成变更事件    │
                  │  触发聚合更新    │
                  └─────────────────┘
```

## 六、设计决策与替代方案

### 6.1 数据源选择 [待确认]

这是本模块最核心的设计决策，有三种可选方案：

**方案 A: 直接查询 TSDB**

```
状态模块 ──PromQL──▶ VM / Zone QP ──▶ 原始指标
```

| 优点 | 缺点 |
|------|------|
| 实现简单，无需额外组件 | 高频查询对 TSDB 产生负载 |
| 数据实时性好 | 查询量 = 实例数 × 状态维度，可能很大 |
| 复用现有查询基础设施 | TSDB 故障直接影响状态判定 |

**方案 B: TSDB → 缓存层 → 状态模块读缓存**

```
状态模块 ──▶ Redis/DB 缓存 ◀── 定期刷新自 TSDB
```

| 优点 | 缺点 |
|------|------|
| 降低 TSDB 查询压力 | 增加数据陈旧度（缓存 TTL） |
| 状态模块查询速度快 | 引入额外组件（Redis） |
| TSDB 短暂故障不影响 | 缓存一致性需要维护 |

**方案 C: RC 推送状态事件**

```
RC (RuleCheck) ──状态事件──▶ 状态模块
```

| 优点 | 缺点 |
|------|------|
| 实时性最好 | 仅适用于 Mode B/C（有 RC 的网区） |
| 不增加 TSDB 查询负载 | Mode A 网区无法覆盖 |
| 利用 RC 已有的规则评估能力 | 依赖 RC 的可用性 |

**建议：** 混合方案——以方案 A 为基础，辅以方案 B 的缓存优化。对于 Mode B/C 网区，可额外接收 RC 事件作为补充信号。

### 6.2 拉取间隔 [建议]

**建议：** 默认 30 秒，可按实例类型和重要性配置。

| 实例类型/重要性 | 建议间隔 |
|----------------|----------|
| 核心数据库 (Oracle RAC) | 10-15 秒 |
| 一般数据库 (MySQL/PG) | 30 秒 |
| 操作系统 (Linux/Windows) | 30-60 秒 |
| 网络设备 | 60 秒 |
| 非关键实例 | 120 秒 |

**理由：** 过于频繁（< 10s）会对 TSDB 产生过大压力；过于稀疏（> 2min）会导致状态感知延迟。

### 6.3 状态模型复杂度 [建议]

**建议：** Phase 1 使用简单的 up/down/degraded 模型，Phase 2 引入多维度状态。

**Phase 1：**
- 仅关注可用性（up/down/degraded/unknown）
- 基于 `up` 指标 + 基本阈值判定

**Phase 2：**
- 引入性能、容量维度
- 引入中间件状态抽象规则
- 引入综合健康评分

### 6.4 状态缓存位置 [待确认]

**决策（待确认）：** 状态数据存储在何处？

| 选项 | 说明 |
|------|------|
| RDS 表 | 持久化好，但写入频率高 |
| Redis | 读写快，适合高频更新，但需考虑持久化 |
| 内存 + 定期持久化 | 最快，但进程重启丢失 |

**建议：** Redis 作为运行时缓存 + RDS 作为持久化存储（变更日志和定期快照）。

## 七、冲突与开放问题

### MC-03: 状态维护的数据源选择 [待确认]

**冲突描述：** 方案 A/B/C 各有优劣，且不同网区存储模式导致数据源路径不同。需要统一抽象查询接口，屏蔽底层数据源差异。

**待决策：** 是否采用混合方案？如果是，各方案的优先级和降级顺序如何？

### MC-06: Mode A 网区的状态数据延迟 [待确认]

**冲突描述：** Mode A 网区无本地 TSDB，数据通过 OTel Collector remote-write 到中心 VM。如果 remote-write 延迟或中断，中心 VM 中该网区的数据会陈旧，导致状态判定不准确。

**待决策：**
- 是否需要在状态判定中考虑数据新鲜度（staleness）？
- 数据超过多久未更新应标记为 `unknown`？

### MC-07: 状态模块与 RC 的职责边界 [待确认]

**冲突描述：** RC 也做规则评估和状态判定（如 `up == 0` 触发告警），状态模块也做类似判定。两者是否有重叠？

**建议边界：**
- RC：实时规则评估 → 触发告警事件
- 状态模块：周期性状态快照 → 提供全局视图
- 两者独立运行，可互相补充信号

### MC-08: 大规模实例的性能考量 [待确认]

**冲突描述：** 当实例数量达到数千甚至上万时，每 30 秒全量查询 TSDB 可能产生巨大压力。

**待决策：**
- 是否需要分批查询（如每批 100 个实例）？
- 是否需要优先级调度（核心实例优先查询）？
- 是否需要增量更新（仅查询状态可能变化的实例）？
