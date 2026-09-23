# 规则检测 (Rule Check)

> 版本：v2.0 | 日期：2026-09-23
> 状态：设计中

---

## 一、概述

规则检测模块负责周期性评估告警规则、生成告警事件。采用 VictoriaMetrics 生态的开源组件 **vmalert** 作为规则评估引擎，部署在存储侧（与 vmstorage + Alertmanager 共部署），通过查询 vmselect 获取全局指标视图进行规则评估。

### 架构演进说明

> **v1.0 → v2.0 重大变更（2026-09-23）：**
>
> 旧架构中，RC（RuleCheck）部署在 DC 侧，通过 VRRP peer 组和 slot 协商机制分配规则组，查询本地存储。
>
> 新架构中，vmalert 作为独立组件部署在存储侧，与 vmstorage + Alertmanager 共部署。规则评估不再需要 DC 侧的 peer 组/slot 协商——vmalert 查询 vmselect（fan-out 到所有 vmstorage），拥有全局指标视图。告警规则由控制面板分发到 prime 存储的 vmalert。

### 核心定位

```
┌──────────────────────────────────────────────────────────────────────┐
│ 存储侧部署                                                           │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Storage Instance (部署单元)                                   │   │
│  │                                                               │   │
│  │  ┌──────────────┐  ┌──────────┐  ┌─────────────┐            │   │
│  │  │  vmstorage    │  │ vmalert  │  │Alertmanager │            │   │
│  │  │  (数据存储)    │  │ (规则    │  │ (去重/分组/ │            │   │
│  │  │              │  │  评估)   │  │  通知)      │            │   │
│  │  └──────┬───────┘  └────┬─────┘  └──────┬──────┘            │   │
│  │         │               │               │                    │   │
│  │         └───────────────┼───────────────┘                    │   │
│  └─────────────────────────┼────────────────────────────────────┘   │
│                            │                                         │
│                            ▼                                         │
│                    消息队列 → 平台                                     │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│ 完整告警链                                                            │
│                                                                      │
│  Alloy ──remote_write──▶ vmstorage                                   │
│                             │                                        │
│                             ▼                                        │
│                          vmselect (fan-out 聚合到所有 vmstorage)      │
│                             │                                        │
│                             ▼                                        │
│                          vmalert (评估告警规则, 查询 vmselect)        │
│                             │                                        │
│                             ▼                                        │
│                          Alertmanager (去重, 分组, 静默, 抑制)        │
│                             │                                        │
│                             ▼                                        │
│                          消息队列 → 平台                              │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 二、职责边界

**本文档负责**：
- vmalert 规则评估引擎的核心逻辑
- vmalert 的存储侧部署模型（与 vmstorage + AM 共部署）
- 告警规则的分发机制（控制面板 → prime 存储的 vmalert）
- 规则热加载与更新
- 告警生成与转发（vmalert → Alertmanager → MQ → Platform）
- vmalert 的查询路径（查询 vmselect）

**本文档不负责**：
- RuleSpec 的定义与管理（→ `control-plane/`）
- 规则包的分发协议（→ `cross-plane/zone-manifest-protocol.md`）
- Alertmanager 的告警去重、分组、静默、抑制（→ `control-plane/` 告警管理模块）
- vmalert 组件本身的实现与维护（→ VictoriaMetrics 社区）
- 存储层的部署与管理（→ `data-plane/storage.md`）
- Alloy 的采集与写入（→ `data-plane/alloy.md`）

---

## 三、功能清单

### 3.1 功能总览

| 功能模块 | 功能项 | 优先级 | 说明 |
|---------|--------|--------|------|
| 规则评估 | vmalert 规则评估 | P0 | vmalert 原生 PromQL 求值与规则状态机管理 |
| 规则评估 | 评估间隔调度 | P0 | vmalert 按 evaluation_interval 周期执行 |
| 规则评估 | 规则热加载 | P0 | 通过 vmalert reload API 热加载规则文件 |
| 部署模型 | vmalert + vmstorage + AM 共部署 | P0 | 存储侧部署单元 |
| 部署模型 | prime 存储接收告警规则 | P0 | 规则分发到 prime 存储的 vmalert |
| 查询路径 | vmalert → vmselect 查询 | P0 | 全局指标视图 |
| 规则包管理 | 控制面板推送规则包 | P0 | 推送到 prime 存储的 vmalert |
| 规则包管理 | 规则包版本追踪 | P0 | 版本校验，增量更新 |
| 规则包管理 | 规则文件热加载 | P1 | 写入规则目录后调用 reload API |
| 告警输出 | vmalert 告警生成 | P0 | vmalert 规则触发时生成告警 |
| 告警输出 | 告警格式转换 | P0 | 添加 zone_id 等平台标签，转发至 Alertmanager |
| 告警输出 | 健康上报 | P1 | vmalert 运行状态上报 |

### 3.2 规则评估引擎

vmalert 作为独立组件部署在存储侧，查询 vmselect 获取全局指标视图进行规则评估。

#### 3.2.1 评估流程

```
vmalert 评估周期触发 (每 evaluation_interval):
    │
    ▼
1. vmalert 加载当前存储实例的规则组文件
    │
    ▼
2. 对每个规则组：
    │
    ├── 2a. 遍历规则组中的每条规则
    │       │
    │       ▼
    │   vmalert 执行 PromQL 查询
    │   └── 查询 vmselect (fan-out 到所有 vmstorage)
    │       │
    │       ▼
    │   vmalert 原生评估表达式
    │   ├── 结果非零 → 规则条件满足
    │   │   ├── 首次满足 → 状态变为 PENDING，记录 pending_at
    │   │   ├── 已 PENDING 且持续 >= for → 状态变为 FIRING，发送告警到 Alertmanager
    │   │   └── 已 FIRING → 保持 firing 状态
    │   │
    │   └── 结果为零 → 规则条件不满足
    │       ├── 已 PENDING → 状态清除（假触发）
    │       ├── 已 FIRING → 状态变为 RESOLVED，发送 resolved 告警到 Alertmanager
    │       └── 无状态 → 无操作
    │
    └── 2b. vmalert 记录评估统计（耗时、结果数、错误）
    │
    ▼
3. vmalert 将告警发送到同部署的 Alertmanager
```

vmalert 的最小化定制部分：
- **规则文件热加载**：控制面板推送新规则包后写入 vmalert 规则文件目录，通过 vmalert 的 HTTP reload API 触发热加载
- **告警格式转换**：vmalert 发送告警前，添加 `zone_id` 等平台标签
- **健康上报**：定期上报 vmalert 运行状态（评估耗时、错误数、规则包版本等）

#### 3.2.2 规则状态机

规则状态机由 vmalert 原生管理，状态转换与原生 vmalert 行为一致：

```
               条件满足
                 │
                 ▼
  ┌────────┐  ┌────────┐   持续 >= for   ┌────────┐
  │  IDLE  │─▶│ PENDING │───────────────▶│ FIRING │
  └────────┘  └────┬────┘               └────┬───┘
                   │                          │
              条件不满足                  条件不满足
                   │                          │
                   ▼                          ▼
              ┌────────┐               ┌──────────┐
              │ (清除)  │               │ RESOLVED │
              └────────┘               └──────────┘
```

| 状态 | 含义 | 动作 |
|------|------|------|
| IDLE | 规则条件未满足 | 无（vmalert 内部管理） |
| PENDING | 规则条件刚满足，等待持续时间 | vmalert 记录 pending_at |
| FIRING | 规则条件持续满足超过 for 时间 | vmalert 发送告警到 Alertmanager |
| RESOLVED | 规则条件不再满足 | vmalert 发送 resolved 告警到 Alertmanager |

#### 3.2.3 vmalert 规则文件格式

控制面板推送的规则包采用 vmalert 兼容格式（YAML）：

```yaml
# vmalert 规则文件
groups:
  - name: <rule_group_name>
    interval: <evaluation_interval>    # 评估间隔
    rules:
      - alert: <alert_name>
        expr: <promql_expr>            # PromQL 表达式
        for: <duration>                # 持续时间阈值
        labels:
          zone_id: <zone_id>           # 网区 ID
          severity: <severity>         # critical | warning | info
        annotations:
          summary: <summary>
          description: <description>
```

关键约束：
- `instance` 标签来自指标数据（PromQL 查询结果），而非 vmalert 节点注入
- vmalert 通过 HTTP reload API（`/-/reload`）热加载新规则文件
- vmalert 自动处理规则 diff（新增/删除/修改），无需手动管理

### 3.3 部署模型

#### 3.3.1 存储侧共部署

```
每个存储实例的部署单元:

  ┌──────────────────────────────────────────────────┐
  │  Storage Instance (部署单元)                       │
  │                                                    │
  │  ┌──────────────┐  ┌──────────┐  ┌─────────────┐ │
  │  │  vmstorage    │  │ vmalert  │  │Alertmanager │ │
  │  │  (数据存储)    │  │ (规则    │  │ (去重/分组/ │ │
  │  │              │  │  评估)   │  │  通知)      │ │
  │  └──────┬───────┘  └────┬─────┘  └──────┬──────┘ │
  │         │               │               │         │
  │         │    ┌──────────┴──────────┐    │         │
  │         │    │ vmselect             │    │         │
  │         │    │ (fan-out 到所有      │    │         │
  │         │    │  vmstorage)         │    │         │
  │         │    └──────────┬──────────┘    │         │
  │         │               │               │         │
  │         └───────────────┼───────────────┘         │
  │                         │                          │
  └─────────────────────────┼──────────────────────────┘
                            │
                            ▼
                    消息队列 → 平台
```

#### 3.3.2 vmalert 查询 vmselect 的优势

| 特性 | 说明 |
|------|------|
| 全局指标视图 | vmselect fan-out 到所有 vmstorage，vmalert 可评估跨区规则 |
| 统一查询入口 | vmalert 只需配置一个 vmselect 地址 |
| 去重保证 | vmselect 内置去重，vmalert 查询结果无重复 |
| 简化部署 | vmalert 不需要知道底层有多少 vmstorage 实例 |

### 3.4 规则包管理

#### 3.4.1 规则分发机制

告警规则由控制面板分发到 prime 存储的 vmalert：

```
规则分发流程:

  控制面板
    │
    │  1. 规则变更事件
    │
    ▼
  DC 网关
    │
    │  2. 推送规则包到 prime 存储的 vmalert
    │     (通过 HTTP API 或配置文件分发)
    │
    ▼
  prime vmstorage 的 vmalert
    │
    │  3. 写入规则文件目录
    │  4. 调用 reload API 热加载
    │
    ▼
  vmalert 开始评估新规则

  注: 规则分发到 prime 存储，因为 prime 是 Worker 的默认关联存储。
  非 prime 存储是否需要规则评估视具体需求而定。
```

#### 3.4.2 规则包结构

```yaml
RulePackage:
  zone_id: string                       # 目标网区
  storage_id: string                    # 目标存储实例
  version: uint64                       # 规则包版本号
  updated_at: timestamp

  rule_groups:
    - group_id: string
      name: string                      # 规则组名称
      evaluation_interval: duration     # 评估间隔

      rules:
        - rule_id: string
          alert_name: string            # 告警名称
          expr: string                  # PromQL 表达式
          for: duration                 # 持续时间
          severity: string              # critical | warning | info
          labels:                       # 告警标签
            zone_id: string
          annotations:                  # 告警注释
            summary: string
            description: string
```

#### 3.4.3 规则包热更新

```
规则包更新流程:
    │
    ▼
1. 控制面板推送新规则包到 vmalert
   (通过 DC 网关分发)
    │
    ▼
2. vmalert 校验规则包
   ├── version > current_version → 接受
   ├── version <= current_version → 忽略
   └── 完整性校验通过 → 继续
    │
    ▼
3. 写入 vmalert 规则文件目录
   ├── 新增规则组 → 写入新规则文件
   ├── 删除规则组 → 删除对应规则文件
   ├── 修改规则 → 更新规则文件内容
   └── 修改评估间隔 → 更新规则文件中的 interval
    │
    ▼
4. 调用 vmalert reload API (/-/reload) 触发热加载
   ├── vmalert 自动处理规则 diff（新增/删除/修改）
   ├── 已触发的告警：如果规则被删除，告警自动 RESOLVED
   └── 新增的规则：从 IDLE 状态开始评估
```

### 3.5 告警生成与转发

#### 3.5.1 告警格式

```yaml
Alert:
  # vmalert 生成的原始告警
  alert_name: string                    # 告警名称

  # 标签（用于 Prometheus fingerprint 计算）
  labels:
    zone_id: string                     # 网区 ID
    rule_id: string                     # 规则 ID
    severity: string                    # critical | warning | info
    instance: string                    # 触发告警的实例（来自 PromQL 结果）
    # ... 规则定义中的其他标签

  # 状态
  state: enum                           # FIRING | RESOLVED
  starts_at: timestamp                  # 触发时间
  ends_at: timestamp                    # 解决时间

  # 注释
  annotations:
    summary: string                     # 告警摘要
    description: string                 # 告警描述
    value: string                       # 触发值

  # 元数据（不参与 fingerprint 计算）
  metadata:
    source_zone_id: string              # 来源网区 ID
    source_storage_id: string           # 来源存储 ID
    eval_duration: duration             # 评估耗时
    query_series_count: uint32          # 查询返回的序列数
```

#### 3.5.2 告警转发

告警转发路径：vmalert → Alertmanager (同部署) → 消息队列 → 平台

```
vmalert                              Alertmanager (同部署)              消息队列         平台
  │                                       │                              │              │
  │  告警 (Prometheus 格式)               │                              │              │
  │──────────────────────────────────────▶│                              │              │
  │                                       │  去重、分组、静默、抑制      │              │
  │                                       │─────────────────────────────▶│              │
  │                                       │                              │  告警生命周期  │
  │                                       │                              │─────────────▶│
  │                                       │                              │              │  认领/通知/关闭
```

Alertmanager 负责：
- **告警去重**：基于 Prometheus fingerprint = hash(alertname + sorted labels)
- **告警分组**：按标签将相关告警分组为单个通知
- **静默**：特定时间段内静默特定告警
- **抑制**：高优先级告警抑制低优先级告警
- **通知**：发送到消息队列进行最终处理

#### 3.5.3 告警去重策略

| 层级 | 策略 | 说明 |
|------|------|------|
| Alertmanager（主要） | Prometheus fingerprint 去重 | fingerprint = hash(alertname + sorted labels)，节点无关 |
| vmselect（查询层） | 数据去重 | -dedup 保证 vmalert 查询结果无重复 |
| vmalert 本地 | 无需去重 | Alertmanager 已处理 |

---

## 四、核心数据模型

### 4.1 VmalertState（vmalert 实例状态）

```yaml
VmalertState:
  vmalert_id: string                    # vmalert 实例唯一标识
  storage_id: string                    # 关联存储实例 ID
  zone_id: string                       # 所属网区
  state: enum                           # RUNNING | DEGRADED | STOPPED
  datasource_url: string                # vmselect 查询地址
  notifier_url: string                  # Alertmanager 通知地址
  rule_package_version: uint64          # 当前规则包版本
  total_groups: uint32                  # 规则组总数
  total_rules: uint32                   # 规则总数
  firing_rules: uint32                  # 当前 firing 的规则数
  pending_rules: uint32                 # 当前 pending 的规则数
  last_eval_duration: duration          # 最后一次全量评估耗时
  last_eval_errors: uint32              # 最后一次评估的错误数
  started_at: timestamp                 # 启动时间
```

### 4.2 RuleGroupState（规则组状态）

```yaml
RuleGroupState:
  group_id: string                      # 规则组 ID
  storage_id: string                    # 所属存储实例
  evaluation_interval: duration         # 评估间隔
  last_eval_at: timestamp               # 最后评估时间
  last_eval_duration: duration          # 最后评估耗时
  last_eval_result: enum                # SUCCESS | FAILED | TIMEOUT
  total_rules: uint32                   # 规则总数
  firing_rules: uint32                  # 当前 firing 的规则数
  pending_rules: uint32                 # 当前 pending 的规则数
```

### 4.3 RuleState（规则状态）

```yaml
RuleState:
  rule_id: string                       # 规则 ID
  group_id: string                      # 所属规则组
  alert_name: string                    # 告警名称
  state: enum                           # IDLE | PENDING | FIRING | RESOLVED
  pending_at: timestamp                 # 进入 PENDING 的时间
  firing_at: timestamp                  # 进入 FIRING 的时间
  resolved_at: timestamp                # 进入 RESOLVED 的时间
  last_eval_at: timestamp               # 最后评估时间
  last_eval_result: bool                # 最后评估结果 (true = 条件满足)
  active_labels: map<string, string>    # 触发告警的标签集合
  active_value: float64                 # 触发值
  alert_id: string                      # 关联的告警 ID
```

---

## 五、接口与交互

### 5.1 vmalert → vmselect 查询

```
vmalert                                 vmselect
  │                                         │
  │  GET /api/v1/query                      │
  │  ?query=<promql_expr>                   │
  │  &time=<eval_time>                      │
  │────────────────────────────────────────▶│
  │                                         │
  │  vmselect 内部 fan-out 到所有 vmstorage │
  │  合并 + 去重后返回                      │
  │                                         │
  │  Response:                              │
  │  {                                      │
  │    status: "success",                   │
  │    data: {                              │
  │      resultType: "vector" | "matrix",   │
  │      result: [...]                      │
  │    }                                    │
  │  }                                      │
  │◀────────────────────────────────────────│
```

| 接口 | 方向 | 协议 | 频率 | 说明 |
|------|------|------|------|------|
| Instant Query | vmalert → vmselect | HTTP (Prometheus API) | evaluation_interval | 即时查询 |
| Range Query | vmalert → vmselect | HTTP (Prometheus API) | 按需 | 范围查询（部分规则需要） |

### 5.2 控制面板 → vmalert 规则分发

```
DC 网关                                vmalert (prime 存储)
  │                                         │
  │  POST /api/v1/rules                     │
  │  RulePackage {                          │
  │    version: 42,                         │
  │    rule_groups: [...]                   │
  │  }                                      │
  │────────────────────────────────────────▶│
  │                                         │
  │  写入规则文件目录                         │
  │  POST /-/reload                         │
  │────────────────────────────────────────▶│
  │                                         │
  │  200 OK                                 │
  │◀────────────────────────────────────────│
```

| 接口 | 方向 | 协议 | 频率 | 说明 |
|------|------|------|------|------|
| PushRulePackage | Proxy → vmalert | HTTP | 事件驱动 | 规则包推送 |
| Reload | Proxy → vmalert | HTTP | 事件驱动 | 触发热加载 |

### 5.3 vmalert → Alertmanager 告警转发

```
vmalert                                 Alertmanager (同部署)
  │                                         │
  │  POST /api/v2/alerts                    │
  │  [                                      │
  │    {                                    │
  │      "labels": {                        │
  │        "alertname": "HighCPU",          │
  │        "zone_id": "zone-1",             │
  │        "severity": "critical",          │
  │        "instance": "ora-01"             │
  │      },                                 │
  │      "annotations": {                   │
  │        "summary": "CPU usage > 90%",    │
  │        "description": "..."             │
  │      },                                 │
  │      "startsAt": "2026-09-23T10:00:00Z" │
  │    }                                    │
  │  ]                                      │
  │────────────────────────────────────────▶│
  │                                         │
  │  200 OK                                 │
  │◀────────────────────────────────────────│
```

### 5.4 可观测性接口

```
vmalert 暴露的指标和 API:

  GET /metrics                          # Prometheus 格式自身指标
  GET /api/v1/rules                     # 当前加载的规则列表和状态
  GET /api/v1/alerts                    # 当前活跃的告警列表
  POST /-/reload                        # 触发热加载
  GET /-/health                         # 健康检查

  指标包括：
  · vmalert_alerts_firing_total        # firing 告警总数
  · vmalert_alerts_pending_total       # pending 告警总数
  · vmalert_iteration_duration_seconds # 评估迭代耗时
  · vmalert_iteration_errors_total     # 评估迭代错误总数
  · vmalert_rule_groups_loaded         # 加载的规则组数
```

---

## 六、设计决策与替代方案

### DEC-RC-01：规则评估引擎选型

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：vmalert（当前） | 使用 VictoriaMetrics vmalert 开源组件 | 成熟稳定；与 VM 生态完全兼容；社区维护 | 定制能力受限于 vmalert 扩展点 |
| B：自研 PromQL 引擎 | 自行实现 PromQL 求值和规则状态机 | 完全可控 | 开发成本高；与生态不兼容；维护负担 |
| C：Alloy 内置告警 | 使用 Alloy 内置的告警能力 | 减少组件数 | 告警与采集耦合；无全局视图 |

**[决策 2026-09-23]**：方案 A（vmalert）。vmalert 作为独立组件部署在存储侧，查询 vmselect 获取全局视图。方案 C 曾被短暂采用（2026-09-22），但已废弃（2026-09-23），因为告警评估应与存储层共部署而非在采集节点。

### DEC-RC-02：vmalert 部署位置

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：存储侧共部署（当前） | vmalert 与 vmstorage + AM 共部署 | 查询路径短；职责清晰；全局视图 | 存储节点资源需求增加 |
| B：DC 侧部署（旧方案） | vmalert 部署在 DC 节点上 | 靠近数据源 | 无全局视图；DC 节点复杂；peer 组协商开销 |
| C：独立部署 | vmalert 独立于存储部署 | 灵活 | 增加部署复杂度；查询路径更长 |

**[决策 2026-09-23]**：方案 A。vmalert 查询 vmselect 获得全局视图，与 AM 共部署减少通知路径延迟。DC 侧不再部署任何告警评估组件。

### DEC-RC-03：规则分发方式

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：控制面板推送（当前） | 控制面板通过 Proxy 推送规则到 prime 存储的 vmalert | 实时性好；集中管理 | 需要控制面板与存储侧的通信 |
| B：vmalert 定时拉取 | vmalert 定时从控制面板拉取规则 | 简单 | 更新延迟；增加控制面板负载 |
| C：拉取 + 紧急通知 | vmalert 定时拉取 + 紧急变更时通知立即拉取 | 平衡 | 需要两套机制 |

**[决策 2026-09-23]**：方案 A。控制面板推送模式实时性最好，规则变更立即生效。DC 网关作为控制面对 DC 的唯一出口，天然适合做规则分发。

### DEC-RC-04：告警管理架构

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：Alertmanager（当前） | 告警发送到同部署的 Alertmanager 统一处理 | 成熟生态；去重/分组/静默/抑制开箱即用 | 引入 Alertmanager 依赖 |
| B：vmalert 本地处理 | vmalert 自行处理告警去重和分组 | 无外部依赖 | 重复造轮子；功能有限 |

**[决策]**：方案 A（Alertmanager）。Alertmanager 是 Prometheus 生态的标准告警管理组件。

---

## 七、冲突与开放问题

| ID | 问题 | 影响 | 状态 |
|----|------|------|------|
| RC-01 | vmalert 评估大量规则（>1000 条）时的性能 | 评估耗时可能超过评估间隔 | 待压测 |
| RC-02 | vmalert 查询 vmselect 的性能影响 | 大量并发 PromQL 查询对 vmselect 的压力 | 待压测 |
| RC-03 | 规则包中 PromQL 表达式的安全性 | 恶意或错误的 PromQL 可能导致 vmalert OOM | 待确认（需要查询限制） |
| RC-04 | prime 存储故障时的告警规则迁移 | 是否需要自动迁移到新的 prime 存储 | 待确认 |
| RC-05 | 非 prime 存储是否需要规则评估 | 多写场景下非 prime 存储是否也需要告警能力 | 待确认 |
| RC-06 | vmalert 版本升级与定制扩展点的兼容性 | 需确保定制不受 vmalert 升级影响 | 待确认 |
| RC-07 | DC 侧 peer 组/slot 协商的废弃迁移 | 旧部署中 RC peer 组的处理 | 已废弃（2026-09-23） |

---

## 八、废弃内容

> 以下内容在 v2.0（2026-09-23）中废弃，保留索引以供追溯。

| 废弃项 | 原内容 | 替代方案 |
|--------|--------|----------|
| RC Peer 组 | VRRP 风格的 RC 节点 peer 组 | vmalert 存储侧独立部署，无需 peer 协商 |
| RC Slot 协商 | epoch fencing 风格的规则组归属协商 | 规则由控制面板直接分发到 prime 存储 |
| DC 侧 RC 部署 | vmalert 部署在 DC 节点上 | vmalert 部署在存储侧，与 vmstorage + AM 共部署 |
| RC → 本地存储查询 | vmalert 直接查询本地 VM/vmselect | vmalert 查询全局 vmselect |
| RC ↔ Scheduler 交互 | RC 从 Scheduler 拉取规则包 | 控制面板推送规则到 vmalert |
| Mode A 不部署 RC | Mode A 区无告警能力 | 所有存储实例都部署 vmalert |
| RCAdvertisement 心跳 | RC 节点间心跳协议 | 不再需要，vmalert 独立运行 |
| RuleGroupTakeover | 规则组接管提案/投票 | 不再需要，无 peer 组概念 |
