# 通知渠道管理 (Notification Channel Management)

> 版本：v2.0 | 日期：2026-09-24
>
> **v2.0 变更摘要**：配合告警链路重构（`alert-management.md` v3.0，DEC-034 ~ DEC-037）。
>
> 1. **升级策略收敛到本模块的 `escalation_policy` 作为唯一权威**（DEC-034）。删除 `notification_group.escalation_config`（与 `escalation_policy` 重复且必然漂移）；`alert_route.escalation_s` 也已删除并改为指向本模块的外键。
> 2. **渠道强度由升级级别决定，不由 severity 直接决定**。同一套机制既能表达「critical 立刻电话」也能表达「warning 30 分钟没人理才打电话」。
> 3. **新增恢复通知（resolved）的发送策略**：渠道降级（不发短信/电话）+ 曾升级则通知全部历史接收者；模板增加 `{{.Duration}}` / `{{.EscalatedTo}}` / `{{.ClaimedBy}}` 变量。
> 4. **`rate_limit.dedup.window_seconds` 改名为「投递幂等窗口」**，与 `alert_route.repeat_notify_s`（人工重复提醒）显式区分——两者在 v1.x 中都叫「重复」，语义完全不同。
> 5. **接收 `notify_kind` 字段**（firing / repeat / escalation / resolved），用于分类限流、分类统计与恢复通知的历史接收者反查。
> 6. **闭环 MC-12（receiver 归属）与 MC-13（限流与风暴的协调）**；MC-14（跨时区静默期）因值班排班功能不做而给出新建议。
> 7. **值班排班功能不做**（v3.0 决策）。通知组为静态成员组，升级链仍可用，组成员需人工维护。

## 一、概述

通知渠道管理模块负责配置和管理各类告警通知的发送通道，以及将告警管理模块产生的"通知请求"转化为实际的消息投递。该模块与告警管理模块解耦——**告警管理负责"通知谁、什么时候通知"（路由匹配、重复通知、升级触发），通知渠道管理负责"怎么送达"**（渠道、模板、限流、故障切换）。

通过抽象统一的通知发送接口，该模块支持邮件、Webhook（钉钉/企微/Slack/飞书）、短信、PagerDuty 等多种通知方式，并提供模板渲染、限流、渠道健康监控、故障自动切换等能力。

> **本模块不感知 Alertmanager。** v3.0 后 AM 是零用户配置组件，路由树与 receiver 配置全部在平台侧（`alert-management.md` §3.6）。本模块只接收平台的通知请求，不与 AM 交互。

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
| 通知模板管理 | 管理各渠道的消息模板，支持变量替换（含 firing / resolved 两套） |
| 通知组管理 | 将渠道与人员组合为「通知组」，作为告警管理路由树的 receiver 目标 |
| 通知投递执行 | 按告警管理给出的通知组，展开为具体渠道与接收者并发送 |
| 通知限流 | 防止通知风暴，控制单位时间内的通知发送量；投递幂等 |
| 渠道健康监控 | 检测渠道发送失败，自动切换到备用渠道 |
| **升级策略定义（唯一权威）** | `escalation_policy` 表：多级升级链、每级的延迟/目标通知组/渠道强度 |
| 发送记录 | 记录所有通知的发送状态和历史，含 `notify_kind` 分类 |

### 本模块不负责

| 不负责项 | 归属模块 |
|----------|----------|
| 告警的产生、去重、收敛、抑制、屏蔽 | Flink 收敛引擎（见 `alert-management.md`） |
| 告警路由规则的定义与匹配 | 告警管理模块（`alert_route`） |
| **升级的触发时机判定** | 告警管理模块的 `notification_scheduler`——本模块只定义升级链，不判定何时升级 |
| 通知静默（免打扰） | 告警管理模块（`alert_notify_mute`）——被静默的通知请求根本不会到达本模块 |
| 告警认领与生命周期管理 | 告警管理模块 |

**升级的职责切分**（v2.0 明确）：本模块定义「升级链长什么样」（`escalation_policy.levels`：第 n 级延迟多久、发给哪个通知组、走哪些渠道），告警管理模块的调度器判定「什么时候该升到第 n 级」并发起调用。定义与触发分离，避免两处都持有计时逻辑。

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

### 3.3 通知投递执行

> **v2.0 变更**：本模块不再自行「路由」。路由树匹配在告警管理模块完成，本模块收到的是**已确定通知组**的通知请求，只负责展开与投递。

| 功能 | 描述 |
|------|------|
| 通知组展开 | 将 `notification_group` 展开为具体的渠道列表与接收者列表 |
| 多渠道并行发送 | 同一告警同时发送到多个渠道 |
| 渠道强度过滤 | 按请求携带的 `notify_level` / `escalation_level` 过滤渠道（如 resolved 通知不发短信电话，见 §3.7） |
| 投递幂等 | 同一 `notification_id` 重复到达时不重发（**这是幂等护栏，不是重复提醒策略**，见 §3.4） |
| 发送去重 | 同一告警在同一时间窗口内不重复发送到同一渠道 |

**通知请求契约（告警管理 → 本模块）：**

```json
{
  "notification_id": "ntf-uuid",
  "alert_id": "uuid",
  "event_id": "evt-uuid",
  "notify_kind": "firing | repeat | escalation | resolved",
  "notify_level": 2,
  "escalation_level": 0,
  "group_id": "dba-l1",
  "severity": "critical",
  "alert": { "labels": {}, "annotations": {}, "starts_at": "", "converged_count": 0 },
  "extra": {
    "duration": "2h13m",
    "escalated_to": "DBA 二线",
    "claimed_by": "operator-zhangsan"
  }
}
```

`notify_kind` 是 v2.0 新增的必填字段，用途有三：分类限流（resolved 可以宽松，escalation 必须严格保证送达）、分类统计、以及 §3.7 恢复通知的历史接收者反查。

### 3.4 通知限流

| 功能 | 描述 |
|------|------|
| 全局限流 | 限制系统整体通知发送速率（如 100 条/分钟） |
| 渠道限流 | 限制单个渠道的发送速率（如 SMS 10 条/分钟） |
| 目标限流 | 限制对同一接收者的发送频率（如同一人 5 条/小时） |
| 分类限流 | 按 `notify_kind` 差异化：`escalation` 不参与限流降级（升级必须送达），`repeat` 优先被限流丢弃 |
| 静默期 | 在指定时间段内抑制非关键通知（时区见 MC-14） |
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
  idempotency:                     # v2.0 改名（原 dedup）
    window_seconds: 300            # 投递幂等窗口：同一 notification_id 5 分钟内不重发
  by_kind:                         # v2.0 新增
    escalation:
      exempt: true                 # 升级通知不受限流降级，必须送达
    repeat:
      drop_on_throttle: true       # 重复提醒被限流时直接丢弃，不排队
```

**「投递幂等窗口」与「人工重复提醒」必须区分**（v2.0 改名原因）：

| 名称 | 位置 | 语义 | 值 |
|------|------|------|-----|
| 投递幂等窗口（原 `dedup.window_seconds`） | 本模块 | 防止同一通知请求因重试而重复投递 | 300s |
| 人工重复提醒 `repeat_notify_s` | 告警管理 `alert_route` | 未处理告警的周期性再提醒 | 14400s |
| AM `repeat_interval` | 存储域 AM | 下游状态续约心跳，**不触达人** | 4h |

三者语义完全不同。v1.x 中前两者都叫「重复」，是最容易配错的地方。三级分离的完整说明见 `alert-management.md` §3.6.3。

### 3.5 升级策略（唯一权威）

> **v2.0 变更**：升级配置此前散在三处（`alert_route.escalation_s`、`escalation_policy.levels`、`notification_group.escalation_config`），必然漂移。v2.0 收敛到 **`escalation_policy.levels` 唯一权威**，另两处已删除。

| 功能 | 描述 |
|------|------|
| 升级规则定义 | 定义告警未认领/未处理时的升级路径 |
| 多级升级 | 支持多级升级：一级 → 二级 → 三级 → ... |
| 渠道强度分级 | 每级独立配置渠道，**级别越高渠道越强**（钉钉 → 短信 → 电话） |
| 升级历史 | 记录每次升级的时间、原因、目标 |

**升级链示例：**

```
escalation_policy: "dba-critical"
  │
  ├── level 1 (delay=0):    通知组「DBA 一线」   渠道: 钉钉 + 邮件
  ├── level 2 (delay=5m):   通知组「DBA 二线」   渠道: 钉钉 + 短信
  ├── level 3 (delay=15m):  通知组「DBA 负责人」 渠道: 短信 + 电话
  └── level 4 (delay=30m):  通知组「运维总监」   渠道: 电话 + 短信
```

**关键设计：电话/短信的触发条件由升级级别决定，不由 severity 直接决定。**

| 想要的行为 | 配置方式 |
|------------|----------|
| critical 立刻电话 | level 1 配成 `delay=0, channels=[phone, sms]` |
| warning 30 分钟没人理才打电话 | level 1 `delay=0, channels=[dingtalk]`；level 3 `delay=30m, channels=[phone]` |

这样「问题多严重」（severity，规则静态属性）与「叫人叫多响」（notify_level，升级链动态属性）解耦，无需为每种组合写特殊逻辑。

**升级的终止条件**（闭环 `alert-management.md` MC-11）：

| 条件 | 说明 |
|------|------|
| `escalation_level >= max(levels)` | 升到链顶即停，不循环 |
| `lifecycle_status IN ('resolved','closed')` | 告警已恢复或已关闭 |
| 通知静默生效中 | 升级计时**暂停**（不是终止）：记 `remaining`，置 `next_escalation_at = NULL`；静默解除时 `next_escalation_at = now() + remaining` |

第三条尤其重要：否则「静默 2 小时，一解除就立刻升到总监」。计时逻辑由告警管理的 `notification_scheduler` 执行，本模块只提供链定义。

**升级触发的调用契约**（告警管理 → 本模块）：

```
POST /api/internal/notification/escalate
{
  "alert_id": "uuid",
  "policy_id": "dba-critical",
  "from_level": 1,
  "to_level": 2,
  "reason": "unclaimed_timeout",
  "triggered_at": "2026-09-24T10:35:00Z"
}
```

本模块据 `to_level` 查 `escalation_policy.levels[2]` 得到目标通知组与渠道，然后走 §3.3 的投递流程，`notify_kind='escalation'`。

### 3.6 渠道健康监控

| 功能 | 描述 |
|------|------|
| 发送成功率监控 | 统计各渠道的发送成功率 |
| 失败检测 | 检测渠道发送失败（超时、认证失败、服务端错误等） |
| 自动切换 | 主渠道故障时自动切换到备用渠道 |
| 渠道恢复检测 | 检测故障渠道恢复，自动切回 |
| 健康告警 | 渠道故障时通知管理员 |

**渠道健康告警必须走带外路径**（v2.0 新增）。渠道自身故障时，用该渠道发「渠道故障」通知显然无效。健康告警需走 §3.8 的硬编码最小通知路径。

### 3.7 恢复通知（resolved）发送策略

> **v2.0 新增**。告警恢复是否通知、通知谁、走什么渠道，由告警管理模块的 `notify_on_resolve` 开关决定；本模块负责按以下策略执行。

| 决定 | 取值 | 理由 |
|------|------|------|
| 路由 | 沿用原告警的通知组 | 保证恢复通知到达同一批人 |
| **渠道强度** | **降级**：resolved 只发钉钉/企微/邮件，**不发短信/电话**，即使原 severity=critical | 问题已解决，不需要叫人 |
| **接收者范围** | 若 `escalation_level > 0`，发给**该 alert_id 历史上所有被通知过的人**，不只是当前级别 | 总监被叫醒了，应该告诉他问题好了 |

第三条的实现：反查 `notification_record`（`WHERE alert_id = ? AND status = 'sent'`），取 `target` 去重集合作为接收者。已有 `idx_alert` 索引，成本可控。这也是 `notify_kind` 字段需要落库的原因之一。

**resolved 专用模板变量**（在 §3.2 通用变量之外新增）：

| 变量 | 说明 | 示例 |
|------|------|------|
| `{{.Duration}}` | 告警持续时长 | 2h13m |
| `{{.EscalatedTo}}` | 曾升级到的最高级别与目标 | DBA 二线 |
| `{{.ClaimedBy}}` | 认领人（未认领则为空） | operator-zhangsan |
| `{{.ResolvedReason}}` | 恢复原因（Phase 2，见 `alert-management.md` §3.11.4） | condition_cleared / data_missing |
| `{{.ConvergedCount}}` | 该收敛组累计归并的事件数 | 47 |

`{{.ResolvedReason}}` 为 `data_missing` 时，模板应显式提示「**本次恢复由数据缺失触发，可能为伪恢复**」，避免运维误判问题已解决。这是伪恢复治理在通知层的落点。

**resolved 模板示例（钉钉 Markdown）：**

```markdown
### ✅ 告警恢复

**规则:** {{.AlertName}}
**级别:** {{.Severity}}
**实例:** {{.Instance}} ({{.InstanceType}})
**网区:** {{.Zone}}

**持续时长:** {{.Duration}}
**处理人:** {{if .ClaimedBy}}{{.ClaimedBy}}{{else}}未认领{{end}}
{{if .EscalatedTo}}**曾升级至:** {{.EscalatedTo}}{{end}}
{{if eq .ResolvedReason "data_missing"}}
> ⚠️ **本次恢复由数据缺失触发，可能为伪恢复，请确认采集链路**
{{end}}

[查看详情]({{.AlertURL}})
```

### 3.8 硬编码最小通知路径（带外）

> **v2.0 新增**，配合 `alert-management.md` §3.10.1 与 DEC-033 修订。

告警链路自身的中断（Flink 挂掉、vmalert 挂掉导致全量伪恢复、Kafka 不可达、渠道全部故障）必须有一条**不经该链路**的通知路径，否则「链路断了」这件事本身没人知道。

| 约束 | 说明 |
|------|------|
| 代码写死，不可配置 | 接收人、渠道、文案全部硬编码。理由：故障的可能正是配置系统或路由策略本身 |
| 不经路由策略 | 不查 `alert_route`、不查 `escalation_policy`、不做限流 |
| 不经 Flink / Kafka | 直接由带外心跳监控进程调用渠道 SDK |
| 至少两种异构渠道 | 建议短信 + 电话（不同运营商/不同网关），避免单一渠道故障即失效 |
| 定期演练 | 该路径平时不走流量，必须定期主动触发验证，否则等同于不存在 |

触发该路径的事件：带外心跳超时（任一链路组件）、渠道健康全部 unhealthy、`alert_resolved_by_reason_total{reason="data_missing"}` 占比突增。

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

> **v2.0 变更**：删除 `escalation_config` 字段。升级配置收敛到 `escalation_policy` 唯一权威（§3.5），组内嵌配置必然与之漂移。

```sql
CREATE TABLE notification_group (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    group_id         VARCHAR(64)   NOT NULL UNIQUE,
    name             VARCHAR(128)  NOT NULL,
    description      TEXT,
    channels         JSON          NOT NULL,          -- 渠道 ID 列表
    members          JSON          NOT NULL,          -- 静态成员列表 [{user_id, name, contact}]
    created_at       TIMESTAMP     NOT NULL,
    updated_at       TIMESTAMP     NOT NULL
);
```

**`group_id` 是告警管理路由树的 receiver 目标**：`alert_route.receiver_id → notification_group.group_id`。这闭环了 MC-12——**告警管理定义「发给哪个组」，本模块定义「组里有什么、怎么发」**。

**值班排班不做**（v2.0 决策）。`members` 是静态列表，需人工维护。这不影响升级机制的正确性，但意味着「谁在值班」没有系统化表达。若将来引入排班，只需在成员解析处加一层（`resolve_members(group_id, at) -> [user]`），路由与升级链不动——因此现在不做不构成技术债锁定。

### 4.3 NotificationTemplate（通知模板）

```sql
CREATE TABLE notification_template (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    template_id      VARCHAR(64)   NOT NULL UNIQUE,
    name             VARCHAR(128)  NOT NULL,
    channel_type     VARCHAR(32)   NOT NULL,          -- 适用渠道类型
    notify_kind      ENUM('firing', 'repeat', 'escalation', 'resolved')
                     NOT NULL DEFAULT 'firing',       -- v2.0：模板按通知类型区分
    subject_template TEXT,                             -- 标题模板 (邮件用)
    body_template    TEXT          NOT NULL,           -- 正文模板
    variables        JSON,                             -- 模板使用的变量列表
    is_default       BOOLEAN       NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMP     NOT NULL,
    updated_at       TIMESTAMP     NOT NULL,
    INDEX idx_kind_channel (notify_kind, channel_type)
);
```

`notify_kind` 使 firing 与 resolved 可以用完全不同的模板（resolved 需要 `{{.Duration}}`、`{{.ResolvedReason}}` 等变量，且文案语气不同）。

### 4.4 NotificationRecord（通知发送记录）

```sql
CREATE TABLE notification_record (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    notification_id  VARCHAR(64)   NOT NULL UNIQUE,
    alert_id         VARCHAR(64)   NOT NULL,           -- 关联告警 ID
    event_id         VARCHAR(64),                      -- v2.0：关联 Flink 事件 ID
    notify_kind      ENUM('firing', 'repeat', 'escalation', 'resolved')
                     NOT NULL,                         -- v2.0 新增
    escalation_level INT           NOT NULL DEFAULT 0, -- v2.0：本次通知对应的升级级别
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
    INDEX idx_alert (alert_id),                        -- resolved 历史接收者反查（§3.7）
    INDEX idx_channel_status (channel_id, status),
    INDEX idx_created (created_at),
    INDEX idx_alert_kind (alert_id, notify_kind)
);
```

`notify_kind` 的三个用途：分类限流统计、恢复通知的历史接收者反查（§3.7）、以及「重复通知 vs 升级通知」的运营分析。

### 4.5 EscalationPolicy（升级策略 — 唯一权威）

```sql
CREATE TABLE escalation_policy (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    policy_id        VARCHAR(64)   NOT NULL UNIQUE,
    name             VARCHAR(128)  NOT NULL,
    levels           JSON          NOT NULL,          -- 升级级别定义
    -- levels 格式:
    -- [
    --   { "level": 1, "delay_minutes": 0,  "target_group_id": "dba-l1",
    --     "channels": ["dingtalk", "email"] },
    --   { "level": 2, "delay_minutes": 5,  "target_group_id": "dba-l2",
    --     "channels": ["dingtalk", "sms"] },
    --   { "level": 3, "delay_minutes": 15, "target_group_id": "dba-lead",
    --     "channels": ["sms", "phone"] },
    --   { "level": 4, "delay_minutes": 30, "target_group_id": "ops-director",
    --     "channels": ["phone", "sms"] }
    -- ]
    -- 语义：delay_minutes 为「距上一级的间隔」，level 1 的 delay 即首次通知延迟
    match_labels     JSON,                           -- 匹配的告警标签
    enabled          BOOLEAN       NOT NULL DEFAULT TRUE,
    version          BIGINT        NOT NULL,           -- v2.0：平台内存缓存按版本刷新
    created_at       TIMESTAMP     NOT NULL,
    updated_at       TIMESTAMP     NOT NULL
);
```

**`levels[].channels` 是渠道强度的唯一决定因素**（§3.5）。电话/短信不由 severity 直接触发，而由升级到的级别触发——critical 若要立即电话，把它的 level 1 配成 `delay=0, channels=[phone, sms]` 即可。

**发布期校验**：`levels` 非空且 `level` 连续递增；`delay_minutes` 单调不减；每级的 `target_group_id` 必须存在于 `notification_group`；`channels` 中的渠道必须已注册且启用。校验不通过拒绝发布——升级链配错的后果是「该打电话时没打」，属于静默失败。

## 五、接口与交互

### 5.1 上游依赖

| 来源 | 交互内容 | 协议 |
|------|----------|------|
| 告警管理模块 | 通知请求（告警内容 + 通知组 + `notify_kind` + `notify_level`），见 §3.3 契约 | 内部 API / 消息队列 |
| 告警管理模块 `notification_scheduler` | 升级触发请求（`from_level` / `to_level` / `reason`） | 内部 API |
| 带外心跳监控 | 链路中断告警，走 §3.8 硬编码最小通知路径 | 直接调用渠道 SDK |
| 运维人员 | 渠道配置、模板管理、升级链定义 | REST API |

### 5.2 下游提供

| 消费方 | 提供内容 | 协议 |
|--------|----------|------|
| 外部通知服务 | 实际通知消息（邮件/钉钉/短信/电话等） | SMTP / HTTP Webhook / SMS API / 语音 API |
| 告警管理模块 | 通知发送状态反馈（用于 `notify_count` 与升级判定） | 内部 API |
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

# 升级策略（唯一权威，DEC-034）
GET    /api/v1/escalation-policies                # 查询升级策略
POST   /api/v1/escalation-policies                # 创建升级策略（含发布期校验，§4.5）
PUT    /api/v1/escalation-policies/{policy_id}    # 更新升级策略（版本 +1）
DELETE /api/v1/escalation-policies/{policy_id}    # 删除（被 alert_route 引用时拒绝）
POST   /api/v1/escalation-policies/{policy_id}/dry-run  # 给定告警样本，预演完整升级链

# 发送记录
GET    /api/v1/notification-records               # 查询发送记录（支持按 notify_kind 过滤）
GET    /api/v1/notification-records/stats         # 发送统计（按 kind / channel / 成功率）

# 内部接口 (告警管理调用)
POST   /api/internal/notification/send            # 发送通知请求（契约见 §3.3）
POST   /api/internal/notification/escalate        # 触发升级（契约见 §3.5）
GET    /api/internal/notification/recipients      # 反查某 alert_id 的历史接收者（§3.7 resolved 用）

# 带外路径（§3.8，代码写死，此处仅暴露状态查询，不接受配置写入）
GET    /api/v1/out-of-band/status                 # 查询带外通知路径的最近演练时间与结果
POST   /api/v1/out-of-band/drill                  # 主动触发演练（需管理员权限，会真实发送）
```

### 5.4 通知发送流程

```
  告警管理模块 (notification_scheduler)
       │
       │ 通知请求 (alert + group_id + notify_kind + notify_level)
       ▼
  ┌────────────────┐
  │  通知组展开     │  group_id → 渠道列表 + 接收者列表
  │                │  resolved 且曾升级 → 反查历史接收者 (§3.7)
  └───────┬────────┘
          ▼
  ┌────────────────┐
  │  渠道强度过滤   │  resolved → 剔除 sms/phone
  │                │  escalation → 保留全部渠道
  └───────┬────────┘
          ▼
  ┌────────────────┐
  │  限流检查       │
  │  - 全局限流     │── 超限 ──▶ notify_kind=escalation: 强制放行
  │  - 渠道限流     │            notify_kind=repeat:    直接丢弃
  │  - 目标限流     │            其它:                  记为 throttled, 延迟发送
  └───────┬────────┘
          │ 通过
          ▼
  ┌────────────────┐
  │  投递幂等检查   │── 重复 notification_id ──▶ 跳过
  │  (300s 窗口)    │
  └───────┬────────┘
          │ 新通知
          ▼
  ┌────────────────┐
  │  模板渲染       │
  │  - 按 notify_kind + channel_type 选模板
  │  - 变量替换（resolved 用 Duration/ResolvedReason 等）
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
  │  - 更新发送记录（含 notify_kind / escalation_level）
  │  - 反馈告警管理（更新 notify_count / last_notify_at）
  └────────────────┘
```

**注意「限流检查」与「投递幂等」的顺序**：幂等必须在限流之后。若幂等在前，被限流丢弃的通知不会留下 `notification_id` 记录，重试时会被当作新通知，幂等失效。

## 六、设计决策与替代方案

### 6.1 通知路由：规则驱动 vs 简单映射 [已确认 — 规则驱动，平台侧执行]

**决策：采用规则驱动（路由树），但由告警管理模块存储与匹配，本模块只执行投递。**

v1.x 曾建议「Phase 1 简单映射（severity → channel），Phase 2 引入路由树」。v2.0 直接采用路由树，理由是：

| 原因 | 说明 |
|------|------|
| Alertmanager 已退出路由 | AM 零配置化后（DEC-037），路由能力必须在平台侧重建，没有「先用简单方案过渡」的退路 |
| 升级链需要多级 receiver | `escalation_policy.levels[n].target_group_id` 要求路由能表达团队维度，纯 severity 映射做不到 |
| 简单映射的实际成本不低 | 一旦需要「critical 且 team=dba 发给 DBA 组」，简单映射就要打补丁，补丁叠几次比直接实现路由树更复杂 |

**方案对比（保留 v1.x 记录）：**

| 方案 | 优点 | 缺点 |
|------|------|------|
| **A：规则驱动路由树（选定）** | 灵活；支持多级路由与 `continue`；能表达团队维度 | 配置复杂度高；调试路由匹配较困难（需 `alert-management.md` §3.6.2 路由测试 + §3.6.7 策略回放工具补偿） |
| B：简单映射（severity → channel） | 配置简单直观 | 无法支持团队级别路由，升级链无法落地 |

**「与 AlertManager 生态兼容」不再作为优点**：AM 已不持有路由配置，兼容性没有实际价值。路由树语法沿用 AM 风格仅仅是为了降低运维人员的学习成本。

### 6.2 通知发送的同步 vs 异步 [已确认]

**决策：** 通知发送采用异步模式（消息队列）。

**理由：**
- 外部渠道（邮件/短信/Webhook/电话）的延迟不可控
- 异步发送避免阻塞告警处理主流程
- 便于重试和限流控制
- 消息队列提供持久化，避免通知丢失

**v2.0 补充**：`escalation` 类通知即使异步也必须保证送达（§3.4 `by_kind.escalation.exempt: true`），限流降级时优先丢弃 `repeat` 类。

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

### 6.5 升级配置的唯一权威（DEC-034）[已确认]

**决策：升级链只在 `escalation_policy.levels` 定义。**

v1.x 有三处升级配置，必然漂移：

| 原位置 | 字段 | v2.0 处置 |
|--------|------|-----------|
| `alert_route.escalation_s`（告警管理） | 单个秒数阈值 | **删除**，改为 `escalation_policy_id` 外键 |
| `escalation_policy.levels`（本模块） | 完整多级链 | **保留为唯一权威** |
| `notification_group.escalation_config`（本模块） | 组内嵌升级配置 | **删除** |

三处并存的后果是「改了路由的阈值但升级链没改」，表现为升级时机与预期不符且极难排查——两处配置都「看起来是对的」。

### 6.6 值班排班不做（v2.0 决策）[已确认]

**决策：不实现 on-call 排班轮转，`notification_group.members` 为静态列表。**

评估过的选项：

| 选项 | 说明 | 未选原因 |
|------|------|----------|
| A：外部 SaaS（PagerDuty / OpsGenie） | 排班、换班、电话升级、移动端 ack 全都有 | **需出网**，多网区隔离环境不可用（与 AI 算子「不得出网」同类约束） |
| B：Grafana OnCall 私有化 | Grafana 已在栈内 | Grafana 已将 OnCall 重心转向 Cloud/IRM，**OSS 版维护状态不确定**，不宜作为关键路径依赖 |
| B'：OneUptime 等其它开源 | 排班 + 事件管理 | 引入一个全新平台，与「复用已有组件」原则冲突 |
| **C：自建最小值班表** | 周期轮转 + 临时换班，约 1~2 周工作量 | 可行但当前不需要 |
| **D：静态通知组（选定）** | 无排班概念 | **最简，当前团队规模下够用** |
| E：从已有排班系统只读同步 | 复用现有排班 | 依赖外部系统有 API，前提未确认 |

**选 D 不构成技术债锁定**：把成员解析抽象为 `resolve_members(group_id, at) -> [user]`，D 是它的默认实现。将来要换成 C/B/E 只改这一个解析器，路由与升级链完全不动。

**代价（已知并接受）**：「谁在值班」没有系统化表达，组成员需人工维护；跨时区静默期失去载体（见 MC-14）。

### 6.7 硬编码最小通知路径（DEC-033 修订）[已确认]

**决策：链路自身的中断告警走一条代码写死、不可配置、不经路由策略、不经 Flink/Kafka 的通知路径。**

理由：故障的可能正是路由策略本身，或 Flink 本身。用可能已损坏的系统去报告「系统损坏」，等于没有报告。详见 §3.8。

**该路径平时不走流量，必须定期主动触发演练**，否则等同于不存在——这是它最大的风险，比实现本身更难保证。

## 七、冲突与开放问题

> **编号说明**：本模块的 MC-12 ~ MC-15 与 `alert-management.md` 的同号条目**含义完全不同**（项目内 MC 编号按文件命名空间，MC-01/03/04 亦在多个文件重复，属既有惯例）。跨文档引用时写作 `NC-MC-12` / `AM-MC-12` 以示区分。

### ~~NC-MC-12: 通知渠道与告警路由的职责划分~~ [v2.0 已闭环]

**原冲突**：路由规则中的「接收器」（receiver）在哪个模块定义？接收器到渠道的映射在哪里配置？

**v2.0 裁决**：

```
alert_route.receiver_id  ──指向──▶  notification_group.group_id
                                    （如「DBA 一线值班组」）
                                          │
                                          ├─ channels: 钉钉群 + 邮件列表 + 短信网关
                                          └─ members:  静态成员列表（值班排班不做，§6.6）
```

**告警管理定义「发给哪个组」，本模块定义「组里有什么、怎么发」。** 与本模块 v1.x 的建议一致，现已落为契约（§3.3 通知请求携带 `group_id`）。

### ~~NC-MC-13: 通知限流与告警风暴的协调~~ [v2.0 已闭环]

**原冲突**：告警管理有风暴抑制，本模块有限流，两者可能不一致；限流导致的延迟是否影响升级计时。

**v2.0 裁决**：

| 原问题 | 答案 |
|--------|------|
| 「已聚合」的告警在通知层是否仍然很多 | 不会。Flink 收敛削减的是**事件量**，平台 `notify_buffer_s`(30s) 合并的是**消息条数**，两者作用在不同层面且都需要（`alert-management.md` §3.6.2）。到达本模块的请求已是双重削减后的量 |
| 限流延迟是否影响升级计时 | **不影响**。升级计时由告警管理的 `notification_scheduler` 基于 `alert_event.next_escalation_at` 推进，与本模块的发送结果解耦。发送失败只影响 `notification_record.status`，不回写升级计时 |
| 限流是否会吞掉升级通知 | **不会**。`by_kind.escalation.exempt: true`（§3.4）——升级通知强制放行，限流降级时优先丢弃 `repeat` 类 |

**残留**：若 `escalation` 强制放行导致渠道被打爆，需靠渠道级熔断（`health_status=unhealthy` 时切备用渠道）兜底，而非限流。这是有意的取舍：**宁可打爆渠道，不可吞掉升级**。

### NC-MC-14: 跨时区通知的静默期 [待确认 — v2.0 重新打开]

**冲突描述**：不同网区可能跨时区，静默期（如夜间不通知）需要按接收者所在时区还是按网区时区？

**v2.0 变化**：原计划挂在值班表的 `timezone` 字段上，但**值班排班功能已决定不做**（§6.6），载体消失，问题重新打开。

**建议**：采用**全局统一时区**（部署级配置，默认 `Asia/Shanghai`）。

| 理由 | 说明 |
|------|------|
| 最简单 | 一个部署级配置项，无表、无解析逻辑 |
| 大概率不跨时区 | 多网区通常在同一国家 |
| 语义更正确 | 夜间静默的本质是「人在睡觉」，不是「机房在睡觉」。按运维团队所在时区比按网区时区更符合意图 |

若将来确需精确到人，时区应挂在**用户资料**上，而不是新建表或挂在网区上。

### NC-MC-15: 通知渠道的容灾 [已确认 — 走带外路径]

**原冲突**：当中心控制面整体不可用时，告警通知如何发送？是否需要独立的告警通知通道（如直接由 RC 发送到 PagerDuty）？

**v2.0 裁决**：**不由 RC/vmalert 直连外部通知服务**，改为 §3.8 的硬编码最小通知路径。

否决「RC 直发」的理由：

| 理由 | 说明 |
|------|------|
| 违背 AM 零配置化 | RC 直发意味着 vmalert/AM 侧要重新持有 receiver 配置与路由，DEC-037 的收益全部丢失 |
| 网区侧出网受限 | 多网区隔离环境，各区直连外部通知网关需要额外的防火墙放行，与 DEC-021「简化防火墙规则」方向相反 |
| 无法收敛 | RC 直发绕过 Flink，风暴时各区独立直发会产生通知洪水——正是 DEC-033 否决降级旁路的同一理由 |

**采用的方案**：带外心跳监控进程（独立于告警链路部署）检测到链路中断时，直接调用渠道 SDK 通知平台管理员。它只报告「链路断了」这一件事，不承载业务告警，因此不需要路由、收敛、模板——复杂度极低，可靠性极高。详见 §3.8 与 `alert-management.md` §3.10.1。
