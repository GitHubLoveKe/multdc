# 告警管理 (Alert Management)

## 一、概述

告警管理模块是中心控制面的核心运维支撑模块，负责接收、聚合、去重、静默、路由来自所有网区 RC（RuleCheck）组件的告警事件，并提供告警确认、跟踪、分析等完整的告警生命周期管理能力。

该模块面临的核心挑战是**跨网区、跨存储模式的告警统一处理**——Mode B/C 网区有本地 RC 产生告警，Mode A 网区没有本地 RC，存在告警覆盖缺口。告警管理模块需要屏蔽这些差异，为运维人员提供一致的告警体验。

```
  ┌──────────────────────────────────────────────────────────────┐
  │                       中心控制面                              │
  │                                                              │
  │  ┌────────────────────────────────────────────────────┐     │
  │  │                 告警管理模块                        │     │
  │  │                                                    │     │
  │  │  ┌──────────┐ ┌──────────┐ ┌──────────┐          │     │
  │  │  │ 告警接收  │ │ 聚合去重  │ │ 静默管理  │          │     │
  │  │  └────┬─────┘ └────┬─────┘ └────┬─────┘          │     │
  │  │       │            │            │                  │     │
  │  │  ┌────┴─────┐ ┌────┴─────┐ ┌────┴─────┐          │     │
  │  │  │ 路由策略  │ │ 认领跟踪  │ │ 历史分析  │          │     │
  │  │  └──────────┘ └──────────┘ └──────────┘          │     │
  │  └────────────────────────────────────────────────────┘     │
  │                          │                                   │
  └──────────────────────────┼───────────────────────────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │ 通知渠道  │  │  Web UI  │  │ Grafana  │
        │ 管理模块  │  │  告警面板 │  │ 告警面板  │
        └──────────┘  └──────────┘  └──────────┘
```

## 二、职责边界

### 本模块负责

| 职责 | 说明 |
|------|------|
| 告警事件接收 | 接收来自各网区 RC 的告警事件 |
| 告警聚合与去重 | 合并重复告警、抑制告警风暴 |
| 告警静默 | 管理时间窗口和标签匹配的静默规则 |
| 告警路由 | 根据告警属性决定通知目标 |
| 告警认领与跟踪 | 运维人员认领、处理、关闭告警的工作流 |
| 告警历史与分析 | MTTR 统计、频率分析、误报率分析 |
| Mode A 告警覆盖 | 为无本地 RC 的 Mode A 网区提供告警能力 |

### 本模块不负责

| 不负责项 | 归属模块 |
|----------|----------|
| 告警规则的定义与管理 | 规则定义模块（控制面） |
| 告警规则的实时评估 | RC (RuleCheck) 模块（数据层） |
| 告警通知的实际发送 | 通知渠道管理模块 (notification-channel) |
| 告警规则到 RC 的分发 | 规则分发模块 |

## 三、功能清单

### 3.1 告警事件接收

| 功能 | 描述 |
|------|------|
| Webhook 接收 | 通过 HTTP Webhook 接收 RC 推送的告警事件 |
| 格式标准化 | 将不同来源的告警统一为标准告警格式 |
| 来源标记 | 记录告警来源（zone_id、RC 节点 ID） |
| 接收确认 | 向 RC 返回接收确认（ACK），支持重试 |
| 接收限流 | 防止单个网区的告警洪泛影响全局处理 |

**标准告警事件格式（兼容 AlertManager Webhook）：**

```json
{
  "alert_id": "uuid",
  "source": {
    "zone_id": "zone-east-1",
    "rc_node_id": "rc-01",
    "storage_mode": "B"
  },
  "status": "firing" | "resolved",
  "labels": {
    "alertname": "OracleTablespaceHigh",
    "severity": "warning",
    "instance": "ora-prod-01",
    "instance_type": "oracle",
    "zone": "zone-east-1"
  },
  "annotations": {
    "summary": "Oracle 表空间 USERS 使用率 92%",
    "description": "实例 ora-prod-01 的表空间 USERS 使用率已达 92%，超过警告阈值 85%",
    "runbook_url": "https://wiki.internal/runbook/tablespace-high"
  },
  "starts_at": "2025-01-15T10:30:00Z",
  "ends_at": null,
  "generator_url": "http://rc-01.zone-east-1:9093/graph?g0.expr=...",
  "fingerprint": "abc123def456"
}
```

### 3.2 告警聚合与去重

| 功能 | 描述 |
|------|------|
| 指纹去重 | 基于告警 fingerprint 进行精确去重 |
| 语义去重 | 同一规则在不同采集器上触发的告警合并 |
| 风暴抑制 | 短时间内大量同类告警聚合为单条摘要 |
| 关联聚合 | 基于实例/网区/服务维度聚合相关告警 |
| 分组通知 | 将相关告警分组后一次性通知 |

**去重策略：**

```
告警去重层次:

Layer 1: 精确去重 (fingerprint)
  └── 同一 fingerprint 的告警视为同一告警
      仅更新状态和时间戳

Layer 2: 语义去重 (alertname + instance)
  └── 不同 fingerprint 但 alertname + instance 相同
      → 可能是不同采集器对同一目标的重复告警
      → 保留最早的一条，标记其他为 duplicate

Layer 3: 风暴抑制 (alertname + 时间窗口)
  └── 同一 alertname 在 60s 内触发 > 10 次
      → 聚合为告警风暴事件
      → 通知: "告警风暴: {alertname} 在 60s 内触发 N 次"

Layer 4: 关联聚合 (zone_id / service)
  └── 同一网区/服务在短时间内的多条不同告警
      → 聚合为事件组
      → 便于运维人员整体处理
```

### 3.3 告警静默

| 功能 | 描述 |
|------|------|
| 时间窗口静默 | 指定时间段内静默所有/特定告警（如维护窗口） |
| 标签匹配静默 | 基于标签匹配规则静默告警（如 silence zone=zone-east-1） |
| 静默创建 | 手动创建或 API 创建静默规则 |
| 静默预览 | 创建前预览该静默规则会匹配哪些当前活跃告警 |
| 静默历史 | 记录所有静默规则的创建、修改、过期历史 |

**静默规则数据模型：**

```json
{
  "silence_id": "uuid",
  "matchers": [
    { "name": "zone", "value": "zone-east-1", "is_regex": false },
    { "name": "severity", "value": "warning|info", "is_regex": true }
  ],
  "starts_at": "2025-01-15T22:00:00Z",
  "ends_at": "2025-01-16T06:00:00Z",
  "created_by": "operator-zhangsan",
  "comment": "数据库维护窗口",
  "status": "active"
}
```

### 3.4 告警路由策略

| 功能 | 描述 |
|------|------|
| 路由规则定义 | 基于告警标签的路由树（类似 AlertManager routing tree） |
| 多级路由 | 支持多级路由：severity → team → channel |
| 路由测试 | 给定告警标签，测试匹配哪条路由 |
| 默认路由 | 未匹配任何规则的告警走默认路由 |

**路由树示例：**

```
root route:
  ├── severity=critical ──▶ PagerDuty + 短信 + 电话
  │   └── team=dba ──▶ DBA on-call
  │   └── team=network ──▶ Network on-call
  ├── severity=warning ──▶ 钉钉/企微群 + 邮件
  │   └── zone=edge-* ──▶ 边缘运维组
  ├── severity=info ──▶ 邮件
  └── default ──▶ 邮件 (default-team)
```

### 3.5 告警认领与跟踪

| 功能 | 描述 |
|------|------|
| 告警列表 | 展示当前活跃告警列表（支持过滤/排序/分组） |
| 告警认领 | 运维人员认领告警，标记"我正在处理" |
| 认领超时 | 告警超过 N 分钟未被认领，自动升级 |
| 处理记录 | 认领后可添加处理记录/备注 |
| 状态流转 | unclaimed → claimed → resolving → resolved → closed |
| 告警合并视图 | 将相关告警合并展示，避免重复处理 |

**告警生命周期状态机：**

```
  ┌───────────┐
  │  firing   │  ← RC 报告告警触发
  └─────┬─────┘
        │
        ▼
  ┌───────────┐
  │ unclaimed │  ← 等待认领
  └─────┬─────┘
        │ 运维人员认领
        ▼
  ┌───────────┐     超时未处理
  │  claimed  │ ──────────────▶ 升级通知
  └─────┬─────┘
        │ 开始处理
        ▼
  ┌───────────┐
  │ resolving │  ← 处理中
  └─────┬─────┘
        │ RC 报告告警恢复 / 手动关闭
        ▼
  ┌───────────┐
  │ resolved  │
  └─────┬─────┘
        │ 确认关闭
        ▼
  ┌───────────┐
  │  closed   │
  └───────────┘
```

### 3.6 告警历史与分析

| 功能 | 描述 |
|------|------|
| 告警历史查询 | 按时间范围、标签、状态查询历史告警 |
| MTTR 统计 | 计算平均修复时间（从 firing 到 resolved） |
| 告警频率分析 | 统计各规则/网区/实例的告警频率 |
| 误报率分析 | 统计告警触发后快速关闭（< 5min）的比例 |
| Top-N 告警 | 展示最频繁的告警规则/实例 |
| 告警趋势 | 告警数量的时间趋势图 |

### 3.7 Mode A 告警覆盖方案

Mode A 网区没有本地 RC，需要特殊处理：

| 方案 | 描述 | 适用场景 |
|------|------|----------|
| 中心虚拟 RC | 在中心部署 RC 实例，专门评估 Mode A 网区的规则 | 需要规则告警的 Mode A 网区 |
| 中心 VM 规则评估 | 利用中心 VM 的 recording rules / alerting rules | 中心 VM 支持告警规则时 |
| Grafana 阈值告警 | 通过 Grafana 的告警功能对 Mode A 数据设置阈值告警 | 简单阈值场景 |

**推荐方案：中心虚拟 RC**

```
  Mode A 网区数据流:
  Agent → OTel Collector → remote-write → 中心 VM
                                                │
                                                ▼
  ┌──────────────────────────────────────────────────┐
  │  中心虚拟 RC (Virtual RC)                         │
  │  ┌──────────────────────────────────────────┐   │
  │  │ 规则集: 仅包含 Mode A 网区的告警规则       │   │
  │  │ 数据源: 中心 VM (Mode A 数据)             │   │
  │  │ 输出: 告警事件 → 告警管理模块              │   │
  │  └──────────────────────────────────────────┘   │
  └──────────────────────────────────────────────────┘
```

## 四、核心数据模型

### 4.1 AlertEvent（告警事件）

```sql
CREATE TABLE alert_event (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    alert_id         VARCHAR(64)   NOT NULL UNIQUE,    -- 全局告警 ID
    fingerprint      VARCHAR(64)   NOT NULL,           -- 告警指纹 (去重键)
    source_zone_id   VARCHAR(64)   NOT NULL,           -- 来源网区
    source_rc_node   VARCHAR(64),                      -- 来源 RC 节点
    status           ENUM('firing', 'resolved')        NOT NULL,
    lifecycle_status ENUM('unclaimed', 'claimed', 'resolving',
                         'resolved', 'closed')
                     NOT NULL DEFAULT 'unclaimed',
    alertname        VARCHAR(128)  NOT NULL,
    severity         ENUM('critical', 'warning', 'info') NOT NULL,
    labels           JSON          NOT NULL,           -- 告警标签
    annotations      JSON,                             -- 告警注释
    starts_at        TIMESTAMP     NOT NULL,
    ends_at          TIMESTAMP,
    claimed_by       VARCHAR(64),
    claimed_at       TIMESTAMP,
    resolved_at      TIMESTAMP,
    closed_by        VARCHAR(64),
    closed_at        TIMESTAMP,
    dedup_count      INT           DEFAULT 1,          -- 去重计数
    group_id         VARCHAR(64),                      -- 关联告警组 ID
    created_at       TIMESTAMP     NOT NULL,
    updated_at       TIMESTAMP     NOT NULL,
    INDEX idx_fingerprint (fingerprint),
    INDEX idx_zone_status (source_zone_id, status),
    INDEX idx_lifecycle (lifecycle_status),
    INDEX idx_starts (starts_at)
);
```

### 4.2 AlertRoute（告警路由规则）

```sql
CREATE TABLE alert_route (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    route_name       VARCHAR(128)  NOT NULL,
    matchers         JSON          NOT NULL,           -- 标签匹配规则
    receiver_id      BIGINT        NOT NULL,           -- 通知接收器 ID
    group_wait_s     INT           DEFAULT 30,         -- 分组等待时间
    group_interval_s INT           DEFAULT 300,        -- 分组发送间隔
    repeat_interval_s INT          DEFAULT 14400,      -- 重复发送间隔
    continue         BOOLEAN       DEFAULT FALSE,      -- 是否继续匹配下级路由
    parent_id        BIGINT,                           -- 父路由 (树形结构)
    enabled          BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMP     NOT NULL,
    updated_at       TIMESTAMP     NOT NULL
);
```

### 4.3 AlertSilence（告警静默）

```sql
CREATE TABLE alert_silence (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    silence_id       VARCHAR(64)   NOT NULL UNIQUE,
    matchers         JSON          NOT NULL,           -- 匹配规则
    starts_at        TIMESTAMP     NOT NULL,
    ends_at          TIMESTAMP     NOT NULL,
    created_by       VARCHAR(64)   NOT NULL,
    comment          TEXT,
    status           ENUM('pending', 'active', 'expired', 'revoked')
                     NOT NULL DEFAULT 'pending',
    created_at       TIMESTAMP     NOT NULL,
    updated_at       TIMESTAMP     NOT NULL,
    INDEX idx_status_time (status, starts_at, ends_at)
);
```

### 4.4 AlertAnalytics（告警分析统计）

```sql
CREATE TABLE alert_analytics (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    alertname        VARCHAR(128)  NOT NULL,
    zone_id          VARCHAR(64),
    instance_id      VARCHAR(64),
    period_start     TIMESTAMP     NOT NULL,           -- 统计周期起始
    period_end       TIMESTAMP     NOT NULL,           -- 统计周期结束
    total_fires      INT           NOT NULL,           -- 总触发次数
    false_positives  INT           DEFAULT 0,          -- 误报次数
    avg_resolve_time_s INT,                            -- 平均解决时间(秒)
    max_resolve_time_s INT,                            -- 最大解决时间(秒)
    INDEX idx_period (period_start, period_end)
);
```

## 五、接口与交互

### 5.1 上游依赖

| 来源 | 交互内容 | 协议 |
|------|----------|------|
| RC (RuleCheck) | 告警事件 Webhook 推送 | HTTP Webhook |
| 中心虚拟 RC | Mode A 网区的告警事件 | HTTP Webhook |
| 实例状态维护 | 实例状态变更事件（可选告警源） | 内部事件 |
| 运维人员 | 告警认领/关闭/静默操作 | REST API |

### 5.2 下游提供

| 消费方 | 提供内容 | 协议 |
|--------|----------|------|
| 通知渠道管理 | 通知请求（告警内容 + 路由目标） | 内部 API / 消息队列 |
| Web UI | 告警列表、详情、历史、分析 | REST API |
| Grafana | 告警面板数据 | REST API |

### 5.3 对外 API

```
# 告警事件
GET    /api/v1/alerts                         # 查询活跃告警列表
GET    /api/v1/alerts/{alert_id}              # 查询告警详情
POST   /api/v1/alerts/{alert_id}/claim        # 认领告警
POST   /api/v1/alerts/{alert_id}/resolve      # 标记解决
POST   /api/v1/alerts/{alert_id}/close        # 关闭告警
POST   /api/v1/alerts/{alert_id}/note         # 添加处理备注

# 告警历史
GET    /api/v1/alerts/history                  # 查询历史告警
GET    /api/v1/alerts/analytics                # 告警分析统计
GET    /api/v1/alerts/analytics/mttr           # MTTR 统计
GET    /api/v1/alerts/analytics/topn           # Top-N 告警

# 静默管理
GET    /api/v1/silences                        # 查询静默列表
POST   /api/v1/silences                        # 创建静默
GET    /api/v1/silences/{silence_id}           # 查询静默详情
PUT    /api/v1/silences/{silence_id}           # 更新静默
DELETE /api/v1/silences/{silence_id}           # 删除(撤销)静默
POST   /api/v1/silences/preview                # 预览静默匹配

# 路由管理
GET    /api/v1/alert-routes                    # 查询路由树
POST   /api/v1/alert-routes                    # 创建路由
PUT    /api/v1/alert-routes/{route_id}         # 更新路由
DELETE /api/v1/alert-routes/{route_id}         # 删除路由
POST   /api/v1/alert-routes/test               # 测试路由匹配

# Webhook 接收 (RC 调用)
POST   /api/v1/webhook/alerts                  # 接收告警事件
```

### 5.4 告警处理完整流程

```
  RC(各网区)          告警管理模块              通知渠道模块          运维人员
      │                    │                      │                   │
      │──告警Webhook──────▶│                      │                   │
      │                    │──去重/聚合──▶         │                   │
      │                    │──静默检查──▶          │                   │
      │                    │  (匹配则跳过)         │                   │
      │                    │──路由匹配──▶          │                   │
      │◀──ACK─────────────│──通知请求────────────▶│                   │
      │                    │                      │──发送通知─────────▶│
      │                    │                      │                   │
      │                    │                      │      ◀──认领──────│
      │                    │◀──认领确认───────────────────────────────│
      │                    │                      │                   │
      │──resolved─────────▶│                      │                   │
      │                    │──更新状态──▶          │                   │
      │                    │──关闭通知───────────▶│                   │
      │                    │                      │                   │
```

## 六、设计决策与替代方案

### 6.1 Mode A 告警覆盖方案 [待确认]

**方案 A: 中心虚拟 RC [建议]**

在中心部署专门的 RC 实例，配置为仅评估 Mode A 网区的告警规则，数据源为中心 VM。

| 优点 | 缺点 |
|------|------|
| 统一的告警处理流程 | 增加中心组件复杂度 |
| 告警格式与 B/C 一致 | 中心 VM 数据可能有 remote-write 延迟 |
| 复用现有 RC 组件 | 需要维护"哪些规则发给虚拟 RC"的逻辑 |

**方案 B: 接受 Mode A 无规则告警**

Mode A 网区仅依赖 Grafana 阈值告警，不部署 RC。

| 优点 | 缺点 |
|------|------|
| 实现简单 | Mode A 告警能力弱于 B/C |
| 无额外组件 | 告警体验不一致 |

**方案 C: 中心 RC 统一评估**

中心部署 RC 评估所有网区的规则（不仅 Mode A）。

| 优点 | 缺点 |
|------|------|
| 全局统一评估 | 与本地 RC 功能重叠 |
| 可作为本地 RC 的备份 | 中心 RC 负载可能很大 |

**建议：** 方案 A（中心虚拟 RC）作为 Phase 1 方案，Mode A 网区的重要规则由中心虚拟 RC 评估。

### 6.2 告警去重跨存储模式的处理 [待确认]

**冲突描述：** Mode B 网区双写（本地 VM + 中心 VM），如果 RC 配置不当，可能对同一指标产生两条告警。

**处理策略：**
- 去重基于 fingerprint（alertname + 关键标签的组合哈希）
- 同一 fingerprint 的告警，无论来自哪个 RC 节点，均视为同一告警
- 记录 `dedup_count`，便于后续分析

### 6.3 告警格式兼容性 [已确认]

**决策：** 告警事件格式兼容 Prometheus AlertManager Webhook 格式。

**理由：**
- AlertManager Webhook 格式已是事实标准
- 便于对接现有告警系统和工具
- RC 组件基于 Prometheus 生态，原生支持该格式

### 6.4 告警认领工作流 [建议]

**建议：** 采用可选认领模式，非强制。

**理由：**
- 部分告警（info 级别）无需认领
- 强制认领增加运维负担
- 可通过配置决定是否要求认领（按 severity 或 route）

## 七、冲突与开放问题

### MC-04: Mode A 告警覆盖缺口 [待确认]

**冲突描述：** Mode A 网区无本地 RC，存在规则告警的覆盖缺口。虚拟 RC 方案需要明确：
- 哪些规则需要由虚拟 RC 评估？
- 虚拟 RC 的评估频率如何设定？
- 虚拟 RC 与本地 RC 的告警是否会重复？

### MC-09: 告警去重与 Zone 迁移 [待确认]

**冲突描述：** 当实例从一个网区迁移到另一个网区时，迁移过程中可能同时被新旧网区的 RC 评估，导致重复告警。去重机制需要处理这种场景。

**待决策：** 迁移期间的告警去重策略——以 fingerprint 为准还是以 instance_id 为准？

### MC-10: 告警风暴的处理策略 [待确认]

**冲突描述：** 当核心组件故障时，可能同时触发大量关联告警（如交换机故障导致其下所有实例不可达）。

**待决策：**
- 是否需要自动根因分析（RCA）？
- 告警风暴时是否应抑制子告警、仅通知根因告警？
- 还是简单聚合、通知总数？

### MC-11: 告警升级策略 [待确认]

**冲突描述：** 告警认领超时后的升级路径需要明确：
- 升级到谁？（上级/其他团队/on-call）
- 升级几次后停止？
- 电话通知的触发条件？
