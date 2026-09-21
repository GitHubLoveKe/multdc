# 通知渠道管理 (Notification Channel Management)

## 一、概述

通知渠道管理模块负责配置和管理各类告警通知的发送通道，以及将告警管理模块产生的"通知请求"转化为实际的消息投递。该模块与告警管理模块解耦——告警管理负责"产生什么通知"，通知渠道管理负责"怎么送达"。

通过抽象统一的通知发送接口，该模块支持邮件、Webhook（钉钉/企微/Slack/飞书）、短信、PagerDuty 等多种通知方式，并提供模板渲染、限流、渠道健康监控、故障自动切换等能力。

```
  ┌──────────────────────────────────────────────────────────────┐
  │                       中心控制面                              │
  │                                                              │
  │  ┌──────────────┐          ┌──────────────────────────┐     │
  │  │  告警管理模块  │──通知──▶│    通知渠道管理模块        │     │
  │  │  (产生通知请求)│  请求   │                          │     │
  │  └──────────────┘         │  ┌────────┐ ┌─────────┐ │     │
  │                           │  │ 模板渲染│ │ 限流控制 │ │     │
  │                           │  └───┬────┘ └────┬────┘ │     │
  │                           │      │           │       │     │
  │                           │  ┌───┴───────────┴───┐  │     │
  │                           │  │    渠道路由引擎    │  │     │
  │                           │  └───┬──┬──┬──┬──┬──┘  │     │
  │                           └──────┼──┼──┼──┼──┼─────┘     │
  └──────────────────────────────────┼──┼──┼──┼──┼────────────┘
                                     │  │  │  │  │
              ┌──────────┬──────────┤  │  │  │  ├──────────┐
              ▼          ▼          ▼  ▼  ▼  ▼          ▼
          ┌──────┐  ┌────────┐  ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──────┐
          │ Email │  │Webhook │  │钉钉│ │企微│ │短信│ │PD  │ │PagerD│
          └──────┘  └────────┘  └──┘ └──┘ └──┘ └──┘ └──────┘
```

## 二、职责边界

### 本模块负责

| 职责 | 说明 |
|------|------|
| 通知渠道配置 | 管理各类通知渠道的连接配置和认证信息 |
| 通知模板管理 | 管理各渠道的消息模板，支持变量替换 |
| 通知路由 | 将通知请求路由到正确的渠道（基于告警管理模块的路由策略） |
| 通知限流 | 防止通知风暴，控制单位时间内的通知发送量 |
| 渠道健康监控 | 检测渠道发送失败，自动切换到备用渠道 |
| 升级策略 | 未按时认领时自动升级通知 |
| 发送记录 | 记录所有通知的发送状态和历史 |

### 本模块不负责

| 不负责项 | 归属模块 |
|----------|----------|
| 告警的产生与聚合 | 告警管理模块 (alert-management) |
| 告警路由规则的定义 | 告警管理模块 (alert-management) |
| 告警认领与生命周期管理 | 告警管理模块 (alert-management) |

## 三、功能清单

### 3.1 通知渠道配置

| 功能 | 描述 |
|------|------|
| 渠道注册 | 注册新的通知渠道（邮件服务器、Webhook URL、短信网关等） |
| 渠道类型 | 支持 Email、Webhook（钉钉/企微/Slack/飞书）、SMS、PagerDuty |
| 渠道测试 | 发送测试消息验证渠道配置正确性 |
| 渠道启用/禁用 | 动态启用或禁用渠道 |
| 渠道分组 | 将多个渠道组合为"通知组"（如"DBA 值班组"包含邮件+钉钉+短信） |
| 备用渠道 | 为主渠道配置备用渠道，主渠道故障时自动切换 |

**支持的渠道类型及配置：**

| 渠道类型 | 关键配置项 | 说明 |
|----------|-----------|------|
| Email | SMTP host/port/user/password, from, TLS | 标准 SMTP 邮件 |
| 钉钉 Webhook | Webhook URL, Secret, @手机号列表 | 钉钉群机器人 |
| 企微 Webhook | Webhook URL | 企业微信群机器人 |
| 飞书 Webhook | Webhook URL, Secret | 飞书群机器人 |
| Slack Webhook | Webhook URL, Channel | Slack Incoming Webhook |
| SMS | 网关 URL, API Key, 签名, 模板 ID | 短信通知 |
| PagerDuty | Routing Key, Service ID | PagerDuty Events API |
| 自定义 Webhook | URL, Method, Headers, Body Template | 通用 HTTP 回调 |

### 3.2 通知模板管理

| 功能 | 描述 |
|------|------|
| 模板定义 | 为每种渠道类型定义消息模板 |
| 变量替换 | 支持告警标签、注释、实例信息等变量的动态替换 |
| 模板继承 | 支持基础模板 + 渠道特定模板的继承关系 |
| 模板预览 | 给定告警样本，预览渲染后的消息内容 |
| 默认模板 | 为每种渠道类型提供预置默认模板 |

**模板变量列表：**

| 变量 | 说明 | 示例 |
|------|------|------|
| `{{.AlertName}}` | 告警规则名称 | OracleTablespaceHigh |
| `{{.Severity}}` | 严重级别 | warning |
| `{{.Status}}` | 告警状态 | firing / resolved |
| `{{.Instance}}` | 实例名称 | ora-prod-01 |
| `{{.InstanceType}}` | 实例类型 | oracle |
| `{{.Zone}}` | 网区名称 | zone-east-1 |
| `{{.Summary}}` | 告警摘要 | Oracle 表空间使用率 92% |
| `{{.Description}}` | 告警详细描述 | ... |
| `{{.MetricValue}}` | 触发指标值 | 92.5 |
| `{{.StartTime}}` | 告警开始时间 | 2025-01-15 10:30:00 |
| `{{.RunbookURL}}` | 运维手册链接 | https://wiki... |
| `{{.AlertURL}}` | 告警详情链接 | https://monitor... |

**模板示例（钉钉 Markdown）：**

```markdown
### 🔔 {{if eq .Status "firing"}}告警触发{{else}}告警恢复{{end}}

**规则:** {{.AlertName}}
**级别:** {{.Severity}}
**实例:** {{.Instance}} ({{.InstanceType}})
**网区:** {{.Zone}}

**详情:** {{.Summary}}

{{if eq .Status "firing"}}
**指标值:** {{.MetricValue}}
**开始时间:** {{.StartTime}}
{{else}}
**恢复时间:** {{.EndTime}}
{{end}}

{{if .RunbookURL}}[运维手册]({{.RunbookURL}}){{end}} | [查看详情]({{.AlertURL}})
```

### 3.3 通知路由引擎

| 功能 | 描述 |
|------|------|
| 路由规则匹配 | 根据告警管理模块的路由策略，确定通知目标渠道 |
| 通知组展开 | 将通知组展开为具体的渠道列表 |
| 多渠道并行发送 | 同一告警同时发送到多个渠道 |
| 发送去重 | 同一告警在同一时间窗口内不重复发送到同一渠道 |
| 路由优先级 | 支持路由规则的优先级排序 |

### 3.4 通知限流

| 功能 | 描述 |
|------|------|
| 全局限流 | 限制系统整体通知发送速率（如 100 条/分钟） |
| 渠道限流 | 限制单个渠道的发送速率（如 SMS 10 条/分钟） |
| 目标限流 | 限制对同一接收者的发送频率（如同一人 5 条/小时） |
| 静默期 | 在指定时间段内抑制非关键通知 |
| 限流统计 | 展示被限流的通知数量和分布 |

**限流策略配置：**

```yaml
rate_limit:
  global:
    max_per_minute: 100
    max_per_hour: 2000
  channel:
    sms:
      max_per_minute: 10
      max_per_hour: 100
    email:
      max_per_minute: 50
  target:
    max_per_person_per_hour: 5
    max_per_group_per_hour: 30
  dedup:
    window_seconds: 300          # 同一告警 5 分钟内不重复发送
```

### 3.5 升级策略

| 功能 | 描述 |
|------|------|
| 升级规则定义 | 定义告警未认领时的升级路径 |
| 多级升级 | 支持多级升级：一级 → 二级 → 三级 |
| 升级触发 | 超过指定时间未认领自动触发升级 |
| 升级通知 | 升级时通知更高级别的人员 |
| 升级历史 | 记录每次升级的时间、原因、目标 |

**升级策略示例：**

```
告警: severity=critical, team=dba
  │
  ├── 0-5 分钟: 通知 DBA 一线 on-call (钉钉 + 邮件)
  │
  ├── 5-15 分钟: 升级 → DBA 二线 on-call (钉钉 + 短信)
  │
  ├── 15-30 分钟: 升级 → DBA 负责人 (短信 + 电话)
  │
  └── > 30 分钟: 升级 → 运维总监 (电话 + 短信)
```

### 3.6 渠道健康监控

| 功能 | 描述 |
|------|------|
| 发送成功率监控 | 统计各渠道的发送成功率 |
| 失败检测 | 检测渠道发送失败（超时、认证失败、服务端错误等） |
| 自动切换 | 主渠道故障时自动切换到备用渠道 |
| 渠道恢复检测 | 检测故障渠道恢复，自动切回 |
| 健康告警 | 渠道故障时通知管理员 |

## 四、核心数据模型

### 4.1 NotificationChannel（通知渠道）

```sql
CREATE TABLE notification_channel (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    channel_id       VARCHAR(64)   NOT NULL UNIQUE,
    name             VARCHAR(128)  NOT NULL,
    channel_type     ENUM('email', 'dingtalk', 'wecom', 'feishu',
                         'slack', 'sms', 'pagerduty', 'webhook')
                     NOT NULL,
    config           JSON          NOT NULL,          -- 渠道配置 (加密存储敏感字段)
    config_encrypted BOOLEAN       NOT NULL DEFAULT FALSE,
    enabled          BOOLEAN       NOT NULL DEFAULT TRUE,
    health_status    ENUM('healthy', 'degraded', 'unhealthy', 'unknown')
                     NOT NULL DEFAULT 'unknown',
    last_health_check TIMESTAMP,
    backup_channel_id VARCHAR(64),                   -- 备用渠道 ID
    description      TEXT,
    created_at       TIMESTAMP     NOT NULL,
    updated_at       TIMESTAMP     NOT NULL
);
```

### 4.2 NotificationGroup（通知组）

```sql
CREATE TABLE notification_group (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    group_id         VARCHAR(64)   NOT NULL UNIQUE,
    name             VARCHAR(128)  NOT NULL,
    description      TEXT,
    channels         JSON          NOT NULL,          -- 渠道 ID 列表
    escalation_config JSON,                          -- 升级配置
    created_at       TIMESTAMP     NOT NULL,
    updated_at       TIMESTAMP     NOT NULL
);
```

### 4.3 NotificationTemplate（通知模板）

```sql
CREATE TABLE notification_template (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    template_id      VARCHAR(64)   NOT NULL UNIQUE,
    name             VARCHAR(128)  NOT NULL,
    channel_type     VARCHAR(32)   NOT NULL,          -- 适用渠道类型
    subject_template TEXT,                             -- 标题模板 (邮件用)
    body_template    TEXT          NOT NULL,           -- 正文模板
    variables        JSON,                             -- 模板使用的变量列表
    is_default       BOOLEAN       NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMP     NOT NULL,
    updated_at       TIMESTAMP     NOT NULL
);
```

### 4.4 NotificationRecord（通知发送记录）

```sql
CREATE TABLE notification_record (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    notification_id  VARCHAR(64)   NOT NULL UNIQUE,
    alert_id         VARCHAR(64)   NOT NULL,           -- 关联告警 ID
    channel_id       VARCHAR(64)   NOT NULL,
    channel_type     VARCHAR(32)   NOT NULL,
    target           VARCHAR(256)  NOT NULL,           -- 接收目标 (邮箱/手机号/Webhook URL)
    status           ENUM('pending', 'sending', 'sent', 'failed', 'throttled')
                     NOT NULL,
    retry_count      INT           DEFAULT 0,
    error_message    TEXT,
    sent_at          TIMESTAMP,
    delivered_at     TIMESTAMP,                        -- 送达确认时间 (部分渠道支持)
    created_at       TIMESTAMP     NOT NULL,
    INDEX idx_alert (alert_id),
    INDEX idx_channel_status (channel_id, status),
    INDEX idx_created (created_at)
);
```

### 4.5 EscalationPolicy（升级策略）

```sql
CREATE TABLE escalation_policy (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    policy_id        VARCHAR(64)   NOT NULL UNIQUE,
    name             VARCHAR(128)  NOT NULL,
    levels           JSON          NOT NULL,          -- 升级级别定义
    -- levels 格式:
    -- [
    --   { "level": 1, "delay_minutes": 5, "target_group_id": "dba-l1",
    --     "channels": ["dingtalk", "email"] },
    --   { "level": 2, "delay_minutes": 15, "target_group_id": "dba-l2",
    --     "channels": ["sms", "dingtalk"] },
    --   { "level": 3, "delay_minutes": 30, "target_group_id": "ops-director",
    --     "channels": ["phone", "sms"] }
    -- ]
    match_labels     JSON,                           -- 匹配的告警标签
    enabled          BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMP     NOT NULL,
    updated_at       TIMESTAMP     NOT NULL
);
```

## 五、接口与交互

### 5.1 上游依赖

| 来源 | 交互内容 | 协议 |
|------|----------|------|
| 告警管理模块 | 通知请求（告警内容 + 目标渠道/通知组） | 内部 API / 消息队列 |
| 告警管理模块 | 升级触发请求 | 内部 API |
| 运维人员 | 渠道配置、模板管理 | REST API |

### 5.2 下游提供

| 消费方 | 提供内容 | 协议 |
|--------|----------|------|
| 外部通知服务 | 实际通知消息（邮件/钉钉/短信等） | SMTP / HTTP Webhook / SMS API |
| 告警管理模块 | 通知发送状态反馈 | 内部 API |
| Web UI | 通知发送历史、渠道健康状态 | REST API |

### 5.3 对外 API

```
# 渠道管理
GET    /api/v1/notification-channels              # 查询渠道列表
POST   /api/v1/notification-channels              # 创建渠道
GET    /api/v1/notification-channels/{channel_id} # 查询渠道详情
PUT    /api/v1/notification-channels/{channel_id} # 更新渠道
DELETE /api/v1/notification-channels/{channel_id} # 删除渠道
POST   /api/v1/notification-channels/{channel_id}/test  # 发送测试消息
GET    /api/v1/notification-channels/{channel_id}/health # 查询渠道健康状态

# 通知组管理
GET    /api/v1/notification-groups                # 查询通知组列表
POST   /api/v1/notification-groups                # 创建通知组
PUT    /api/v1/notification-groups/{group_id}     # 更新通知组
DELETE /api/v1/notification-groups/{group_id}     # 删除通知组

# 模板管理
GET    /api/v1/notification-templates             # 查询模板列表
POST   /api/v1/notification-templates             # 创建模板
PUT    /api/v1/notification-templates/{template_id} # 更新模板
DELETE /api/v1/notification-templates/{template_id} # 删除模板
POST   /api/v1/notification-templates/preview     # 预览模板渲染

# 升级策略
GET    /api/v1/escalation-policies                # 查询升级策略
POST   /api/v1/escalation-policies                # 创建升级策略
PUT    /api/v1/escalation-policies/{policy_id}    # 更新升级策略

# 发送记录
GET    /api/v1/notification-records               # 查询发送记录
GET    /api/v1/notification-records/stats         # 发送统计

# 内部接口 (告警管理调用)
POST   /api/internal/notification/send            # 发送通知请求
POST   /api/internal/notification/escalate        # 触发升级
```

### 5.4 通知发送流程

```
  告警管理模块
       │
       │ 通知请求 (alert + route_target)
       ▼
  ┌────────────────┐
  │  限流检查       │
  │  - 全局限流     │
  │  - 渠道限流     │── 超限 ──▶ 记录为 throttled, 延迟发送
  │  - 目标限流     │
  └───────┬────────┘
          │ 通过
          ▼
  ┌────────────────┐
  │  去重检查       │── 重复 ──▶ 跳过
  │  (5min 窗口)   │
  └───────┬────────┘
          │ 新通知
          ▼
  ┌────────────────┐
  │  模板渲染       │
  │  - 选择模板     │
  │  - 变量替换     │
  └───────┬────────┘
          │
          ▼
  ┌────────────────┐
  │  渠道发送       │
  │  - 主渠道尝试   │
  │  - 失败→备用    │
  │  - 重试机制     │
  └───────┬────────┘
          │
          ▼
  ┌────────────────┐
  │  记录结果       │
  │  - 更新发送记录 │
  │  - 反馈告警管理 │
  └────────────────┘
```

## 六、设计决策与替代方案

### 6.1 通知路由：规则驱动 vs 简单映射 [建议]

**方案 A: 规则驱动（类 AlertManager routing tree）[建议]**

告警管理模块定义完整的路由树，通知渠道模块按路由树匹配执行。

| 优点 | 缺点 |
|------|------|
| 灵活度高，支持复杂路由 | 配置复杂度较高 |
| 与 AlertManager 生态兼容 | 学习成本较高 |
| 支持多级路由和 continue | 调试路由匹配较困难 |

**方案 B: 简单映射（severity → channel）**

基于告警 severity 直接映射到通知渠道。

| 优点 | 缺点 |
|------|------|
| 配置简单直观 | 无法支持团队级别路由 |
| 易于理解和维护 | 无法满足复杂组织需求 |

**建议：** Phase 1 采用方案 B（简单映射），Phase 2 引入方案 A（规则驱动）。

### 6.2 通知发送的同步 vs 异步 [已确认]

**决策：** 通知发送采用异步模式（消息队列）。

**理由：**
- 外部渠道（邮件/短信/Webhook）的延迟不可控
- 异步发送避免阻塞告警处理主流程
- 便于重试和限流控制
- 消息队列提供持久化，避免通知丢失

### 6.3 渠道配置的敏感信息存储 [已确认]

**决策：** 渠道配置中的敏感信息（密码、API Key、Secret）使用 AES-256 加密存储，密钥由凭据服务统一管理。

**理由：**
- 通知渠道配置存储在 RDS 中，需要保护敏感信息
- 复用凭据服务的密钥管理能力，避免重复建设

### 6.4 通知模板引擎选择 [建议]

**建议：** 使用 Go text/template 语法（与 Prometheus 生态一致）。

**替代方案：**
- Jinja2 模板：功能更丰富，但引入 Python 依赖
- Mustache：逻辑less，但功能有限
- 自定义 DSL：灵活但维护成本高

## 七、冲突与开放问题

### MC-12: 通知渠道与告警路由的职责划分 [待确认]

**冲突描述：** 告警管理模块定义了告警路由规则（哪些告警发给谁），通知渠道模块定义了渠道配置（怎么发）。两者的边界需要明确：
- 路由规则中的"接收器"（receiver）是在告警管理模块定义还是在通知渠道模块定义？
- 接收器到渠道的映射在哪里配置？

**建议：** 告警管理定义"路由到哪个 receiver"，通知渠道管理定义"receiver 包含哪些渠道"。

### MC-13: 通知限流与告警风暴的协调 [待确认]

**冲突描述：** 告警管理模块有告警风暴抑制，通知渠道模块有限流。两者可能产生不一致：
- 告警管理认为"已聚合"的告警，在通知渠道层面可能仍然很多
- 限流导致的通知延迟是否会影响升级策略的计时？

### MC-14: 跨时区通知的静默期 [待确认]

**冲突描述：** 不同网区可能跨时区，静默期（如夜间不通知）需要按接收者所在时区还是按网区时区？

### MC-15: 通知渠道的容灾 [待确认]

**冲突描述：** 当中心控制面整体不可用时，告警通知如何发送？是否需要独立的告警通知通道（如直接由 RC 发送到 PagerDuty）？
