# RC 规则检测

> 版本：v1.1 | 日期：2026-09-21
> 状态：设计中

---

## 一、概述

RC（RuleCheck）是采集层中的规则评估引擎，负责周期性查询本地时序存储、评估告警规则、生成告警事件。RC 复用 VictoriaMetrics 生态的开源组件 **vmalert** 作为规则评估引擎，仅做最小化定制（规则热加载、告警格式转换、健康上报）。RC 不自行实现 PromQL 求值，规则状态机（pending → firing → resolved）由 vmalert 原生管理。告警的去重、分组、静默、抑制交由服务端 **Alertmanager** 统一处理。

RC 的核心设计约束仍然是**绑定存储**——仅部署在拥有本地时序存储的网区（mode B/C），mode A 网区不部署 RC。

RC 节点复用 Job Scheduler 的 slot 协商模式，形成独立的同构 peer 组。RC 与 RC 之间通过相同的 VRRP 风格 peer 检测和 epoch fencing 机制进行规则组归属的协商，但 RC 的 peer 组与 Job Scheduler 的 peer 组完全独立。

### 核心定位

```
┌──────────────────────────────────────────────────────────────────┐
│ Zone (Mode B/C)                                                   │
│                                                                    │
│  ┌────────────┐    ┌────────────┐    ┌────────────┐             │
│  │ RC Node 1  │    │ RC Node 2  │    │ RC Node 3  │             │
│  │            │    │            │    │            │             │
│  │ vmalert    │    │ vmalert    │    │ vmalert    │             │
│  │ Rule Group │    │ Rule Group │    │ Rule Group │             │
│  │ A, B       │    │ C, D       │    │ E, F       │             │
│  └─────┬──────┘    └─────┬──────┘    └─────┬──────┘             │
│        │                 │                 │                      │
│        │ PromQL 查询      │                 │                      │
│        ▼                 ▼                 ▼                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              本地存储 (VM / VM 集群)                       │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                    │
│  vmalert → 告警 → Alertmanager (服务端) → 控制面                  │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ Zone (Mode A)                                                     │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  无 RC 部署                                               │   │
│  │  告警能力依赖中心控制面的「虚拟 RC」(如果有)                │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

---

## 二、职责边界

**本文档负责**：
- RC 规则评估引擎的核心逻辑（基于 vmalert）
- RC 的存储绑定策略（mode B/C 部署，mode A 不部署）
- RC peer 组的设计（独立于 Job Scheduler peer 组）
- RC slot 协商机制（复用 epoch fencing 模式）
- 规则包拉取与热更新（Pull 模式）
- 告警生成与转发（vmalert → Alertmanager）
- RC 节点的部署与运维模型

**本文档不负责**：
- RuleSpec 的定义与管理（→ `control-plane/`）
- 规则包的分发协议（→ `cross-plane/zone-manifest-protocol.md`）
- Job Scheduler 的 slot 协商（→ `data-plane/job-scheduler.md`）
- Alertmanager 的告警去重、分组、静默、抑制（→ `control-plane/` 告警管理模块）
- vmalert 组件本身的实现与维护（→ VictoriaMetrics 社区）
- 本地存储的部署与管理（→ `data-plane/storage.md`）
- 降级模式下的告警处理（→ `cross-plane/degradation-autonomy.md`）

---

## 三、功能清单

### 3.1 功能总览

| 功能模块 | 功能项 | 优先级 | 说明 |
|---------|--------|--------|------|
| 规则评估 | vmalert 规则评估 | P0 | vmalert 原生 PromQL 求值与规则状态机管理 |
| 规则评估 | 评估间隔调度 | P0 | vmalert 按 evaluation_interval 周期执行 |
| 规则评估 | 规则热加载 | P0 | 通过 vmalert reload API 热加载规则文件 |
| RC Peer | RC 节点间 VRRP 心跳 | P0 | 独立于 Job Scheduler 的 peer 组 |
| RC Peer | RC slot 归属协商 | P0 | 规则组归属的协商与 epoch fencing |
| RC Peer | RC 节点状态机 | P0 | REGISTER → HEALTHY → EXPIRED 等 |
| 规则包管理 | 定时拉取规则包（从调度器） | P0 | RC 周期性拉取 vmalert 格式规则文件 |
| 规则包管理 | 规则包版本追踪 | P0 | 版本校验，增量更新 |
| 规则包管理 | 规则文件热加载 | P1 | 写入规则目录后调用 reload API |
| 告警输出 | vmalert 告警生成 | P0 | vmalert 规则触发时生成告警 |
| 告警输出 | 告警格式转换 | P0 | 添加 zone_id 等平台标签，转发至 Alertmanager |
| 告警输出 | 告警本地缓存（降级时） | P0 | 中心不可达时本地缓存 |
| 告警输出 | 健康上报 | P1 | RC 节点健康状态上报 |

### 3.2 规则评估引擎

RC 复用 VictoriaMetrics 生态的开源组件 **vmalert** 作为规则评估引擎，仅做最小化定制。RC 不自行实现 PromQL 求值，规则状态机由 vmalert 原生管理。

#### 3.2.1 评估流程

vmalert 原生评估流程：

```
vmalert 评估周期触发 (每 evaluation_interval):
    │
    ▼
1. vmalert 加载当前节点拥有的规则组文件
    │
    ▼
2. 对每个规则组：
    │
    ├── 2a. 遍历规则组中的每条规则
    │       │
    │       ▼
    │   vmalert 执行 PromQL 查询
    │   ├── Mode B: 查询本地 VM 单实例
    │   └── Mode C: 通过 vmselect 查询 VM 集群
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
3. vmalert 将告警发送到 Alertmanager
```

RC 的最小化定制部分：
- **规则文件热加载**：RC 拉取新规则包后写入 vmalert 规则文件目录，通过 vmalert 的 HTTP reload API 触发热加载
- **告警格式转换**：vmalert 发送告警前，RC 中间层添加 `zone_id` 等平台标签（不添加 `rc_node_id` 等节点特定标签，以确保告警 fingerprint 在节点间一致）
- **健康上报**：RC 定期上报 vmalert 运行状态（评估耗时、错误数、规则包版本等）

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

> 注：RC 不自行实现状态机逻辑，上述状态由 vmalert 内部维护。RC 仅通过 vmalert 的 API 获取规则状态用于健康上报。

#### 3.2.3 vmalert 规则文件格式

RC 从调度器获取规则包后，转换为 vmalert 的规则文件格式（YAML）：

```yaml
# vmalert 规则文件（由 RC 从规则包转换生成）
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
          # 注意：不包含 rc_node_id 等节点特定标签
          # 以确保告警 fingerprint 在节点间一致
        annotations:
          summary: <summary>
          description: <description>
```

关键约束：
- 规则文件中**不包含**节点特定标签（`rc_node_id` 等），以确保告警 fingerprint 在节点间一致
- `instance` 标签来自指标数据（PromQL 查询结果），而非 RC 节点注入
- RC 通过 vmalert 的 HTTP reload API（`/-/reload`）热加载新规则文件
- vmalert 自动处理规则 diff（新增/删除/修改），无需 RC 手动管理

### 3.3 RC Peer 组

#### 3.3.1 独立 peer 组设计

RC 节点形成自己的同构 peer 组，与 Job Scheduler 的 peer 组完全独立：

```
┌─────────────────────────────────────────────────────────┐
│ Zone                                                      │
│                                                            │
│  Job Scheduler Peer Group          RC Peer Group          │
│  ┌──────┐  ┌──────┐  ┌──────┐    ┌──────┐  ┌──────┐    │
│  │ JS-1 │──│ JS-2 │──│ JS-3 │    │ RC-1 │──│ RC-2 │    │
│  │      │  │      │  │      │    │      │  │      │    │
│  │ Slot │  │ Slot │  │ Slot │    │ Rule │  │ Rule │    │
│  │ 0-3  │  │ 4-7  │  │ 8-11 │    │ A,B  │  │ C,D  │    │
│  └──────┘  └──────┘  └──────┘    └──────┘  └──────┘    │
│       │         │         │            │         │        │
│  VRRP 心跳 (3s)              VRRP 心跳 (3s)              │
│  (JS ↔ JS)                   (RC ↔ RC)                   │
│                                                            │
│  两个 peer 组：                                            │
│  · 独立的 peer table                                       │
│  · 独立的状态判定                                           │
│  · 独立的 epoch fencing                                    │
│  · 可部署在不同节点上                                       │
└─────────────────────────────────────────────────────────┘
```

独立 peer 组的意义：
- RC 和 Job Scheduler 的职责不同，故障模式不同
- RC 需要访问本地存储，Job Scheduler 不需要
- RC 可以部署在与 Job Scheduler 相同的节点上，也可以部署在专用节点上
- 两个 peer 组的故障检测互不干扰

#### 3.3.2 RC 心跳协议

RC 节点间的心跳协议与 Job Scheduler 类似，但携带的信息不同：

```yaml
RCAdvertisement:
  sender_rc_node_id: string
  zone_id: string
  owned_rule_groups: [string]     # 当前拥有的规则组列表
  owned_groups_hash: string       # 规则组归属 hash
  health_status: enum             # HEALTHY | DEGRADED | OVERLOADED
  storage_accessible: bool        # 本地存储是否可访问
  last_eval_duration: duration    # 最后一次评估耗时
  last_eval_errors: uint32        # 最后一次评估的错误数
  rule_package_version: uint64    # 当前规则包版本
  epoch_token: string             # 当前 epoch
  timestamp: timestamp
  seq: uint64
```

#### 3.3.3 RC Slot 协商

RC 的「slot」是规则组（rule group），而非采集 slot：

```
规则组归属协商：
    │
    ▼
1. 计算规则组总数与 RC 节点数
   总规则组: 6 (A, B, C, D, E, F)
   RC 节点数: 2
   每节点分配: 6 / 2 = 3 个规则组
    │
    ▼
2. 初始分配
   RC-1: [A, B, C]
   RC-2: [D, E, F]
    │
    ▼
3. Epoch fencing (与 Job Scheduler 相同机制)
   RC-1 的 epoch token: ze-42:rg-1 (rule group version 1)
   RC-2 的 epoch token: ze-42:rg-1
    │
    ▼
4. RC-1 故障时的接管
   RC-2 检测到 RC-1 EXPIRED
   → RC-2 接管 [A, B, C]
   → 新 epoch token: ze-42:rg-2
   → RC-2 现在拥有 [A, B, C, D, E, F]
```

### 3.4 规则包管理

#### 3.4.1 规则包拉取

RC 定时从调度器拉取规则包（Pull 模式），而非由 Zone Agent 推送：

```
Scheduler (调度器)
    │
    │  暴露 HTTP 端点供 RC 拉取规则文件
    │  GET /api/v1/rules?zone_id=<zone_id>
    │
    ▲
    │  RC 周期性拉取（默认 30s）
    │
RC Nodes
    │
    │  拉取并加载规则包
    │  按规则组归属执行评估
```

拉取机制：
- RC 周期性（默认 30s）向调度器请求最新规则包
- 调度器暴露 HTTP 端点供 RC 拉取规则文件
- 紧急更新时，调度器可主动通知 RC 立即拉取（Push 作为补充，见 3.4.3）

#### 3.4.2 规则包结构

规则包采用 vmalert 兼容格式：

```yaml
RulePackage:
  zone_id: string
  version: uint64                     # 规则包版本号
  updated_at: timestamp

  rule_groups:
    - group_id: string
      name: string                    # 规则组名称
      evaluation_interval: duration   # 评估间隔
      source_slot_ids: [uint32]       # 依赖的采集 slot

      rules:
        - rule_id: string
          alert_name: string          # 告警名称（vmalert alert 字段）
          expr: string                # PromQL 表达式（vmalert expr 字段）
          for: duration               # 持续时间（vmalert for 字段）
          severity: string            # critical | warning | info
          labels:                     # 告警标签（vmalert labels 字段）
            zone_id: string
            # 注意：不包含 rc_node_id 等节点特定标签
          annotations:                # 告警注释（vmalert annotations 字段）
            summary: string
            description: string
```

> 注：规则包结构与 vmalert 规则文件格式（YAML）一一对应，RC 拉取后可直接写入 vmalert 规则文件目录。

#### 3.4.3 规则包热更新

```
规则包更新流程（Pull 模式）：
    │
    ▼
1. RC 定时拉取新规则包 (version N+1)
   或收到调度器紧急通知后立即拉取
    │
    ▼
2. RC 校验规则包
   ├── version > current_version → 接受
   ├── version <= current_version → 忽略
   └── 完整性校验通过 → 继续
    │
    ▼
3. RC 写入 vmalert 规则文件目录
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

紧急更新机制：
- 调度器在关键规则变更时，主动通知 RC 立即拉取（Push 作为补充）
- 通知方式：调度器通过 HTTP POST 到 RC 的 `/-/notify-rule-update` 端点
- RC 收到通知后立即执行一次规则包拉取，不等待下一个 30s 周期

### 3.5 告警生成与转发

#### 3.5.1 告警格式

告警由 vmalert 生成，RC 中间层进行格式转换（添加平台标签）：

```yaml
Alert:
  # vmalert 生成的原始告警
  alert_name: string                  # 告警名称（来自规则定义）

  # 标签（用于 Prometheus fingerprint 计算）
  labels:
    zone_id: string                   # 网区 ID
    rule_id: string                   # 规则 ID
    severity: string                  # critical | warning | info
    instance: string                  # 触发告警的实例（来自 PromQL 结果，非 RC 节点注入）
    # ... 规则定义中的其他标签
    # 注意：不包含 rc_node_id 等节点特定标签

  # 状态
  state: enum                         # FIRING | RESOLVED
  starts_at: timestamp                # 触发时间
  ends_at: timestamp                  # 解决时间（RESOLVED 时）

  # 注释
  annotations:
    summary: string                   # 告警摘要
    description: string               # 告警描述（模板渲染后）
    value: string                     # 触发值（来自 PromQL 结果）

  # 元数据（不参与 fingerprint 计算）
  metadata:
    source_zone_id: string            # 来源网区 ID（元数据，不在 labels 中）
    degraded_mode: bool               # 是否在降级模式下生成
    eval_duration: duration           # 评估耗时
    query_series_count: uint32        # 查询返回的序列数
```

关键约束：
- `labels` 中**不包含** `rc_node_id` 等节点特定标签，以确保 Prometheus fingerprint 在节点间一致
- `instance` 标签来自指标数据（PromQL 查询结果），而非 RC 节点注入
- `source_zone_id` 作为元数据（metadata），不参与 fingerprint 计算

#### 3.5.2 告警转发

告警转发路径：RC (vmalert) → Alertmanager (服务端) → Control Plane

```
RC Node (vmalert)                    Alertmanager (服务端)              Control Plane
  │                                       │                              │
  │  告警 (Prometheus 格式)               │                              │
  │──────────────────────────────────────▶│                              │
  │                                       │  去重、分组、静默、抑制      │
  │                                       │─────────────────────────────▶│
  │                                       │                              │  告警管理模块
  │                                       │                              │  通知处理
  │                                       │                              │
```

Alertmanager 负责：
- **告警去重**：基于 Prometheus fingerprint = hash(alertname + sorted labels)
- **告警分组**：按标签将相关告警分组为单个通知
- **静默**：特定时间段内静默特定告警
- **抑制**：高优先级告警抑制低优先级告警
- **通知**：发送到控制面进行最终处理

故障接管时的去重保证：
- Prometheus fingerprint = hash(alertname + sorted labels)，与生成节点无关
- 当 RC 故障接管发生时，新 RC 产生的告警 fingerprint 与原 RC 完全一致
- Alertmanager 基于 fingerprint 自动去重，不会产生重复告警
- **关键约束**：规则包中**不得包含**节点特定标签（如 `rc_node_id`），否则 fingerprint 会因节点不同而不同

降级模式下的告警处理：

```
正常模式 (L0)：
  RC (vmalert) → Alertmanager → Control Plane (实时处理)

降级模式 (L1-L3)：
  RC (vmalert) → 本地告警队列 (文件/SQLite)
                         │
                    中心恢复后
                         │
                         ▼
                   批量发送到 Alertmanager
                   (Alertmanager 基于 fingerprint 自动去重)
```

#### 3.5.3 告警去重策略

告警去重由 Alertmanager 统一处理，RC 本地不再需要去重逻辑：

| 层级 | 策略 | 说明 |
|------|------|------|
| Alertmanager（主要） | Prometheus fingerprint 去重 | fingerprint = hash(alertname + sorted labels)，节点无关 |
| Alertmanager（内置） | 故障接管去重 | RC 故障时，新 RC 产生相同 fingerprint 的告警，Alertmanager 自动去重 |
| RC 本地 | 无需去重 | Alertmanager 已处理，RC 仅负责生成和转发 |

关键约束：
- 规则包中**不得包含** `rc_node_id` 等节点特定标签
- `instance` 标签来自指标数据（PromQL 查询结果），而非 RC 节点注入
- 这确保了 fingerprint 在 RC 故障接管时保持一致，Alertmanager 自动完成去重

---

## 四、核心数据模型

### 4.1 RCNodeState（RC 节点状态）

```yaml
RCNodeState:
  rc_node_id: string                  # RC 节点唯一标识
  zone_id: string                     # 所属网区
  state: enum                         # REGISTER | WARMING | HEALTHY | SUSPECT |
                                      # EXPIRED | FENCED | DRAINING | OFFLINE
  owned_rule_groups: [string]         # 当前拥有的规则组 ID 列表
  last_heartbeat: timestamp           # 最后心跳时间
  epoch_token: string                 # 当前 epoch 令牌
  rule_package_version: uint64        # 当前规则包版本
  storage_mode: enum                  # B | C
  storage_accessible: bool            # 本地存储是否可访问
  storage_endpoint: string            # 本地存储地址
  started_at: timestamp               # 节点启动时间
```

### 4.2 RuleGroupState（规则组状态）

```yaml
RuleGroupState:
  group_id: string                    # 规则组 ID
  owner_rc_node: string               # 归属的 RC 节点
  epoch_token: string                 # epoch 令牌
  evaluation_interval: duration       # 评估间隔
  last_eval_at: timestamp             # 最后评估时间
  last_eval_duration: duration        # 最后评估耗时
  last_eval_result: enum              # SUCCESS | FAILED | TIMEOUT
  total_rules: uint32                 # 规则总数
  firing_rules: uint32                # 当前 firing 的规则数
  pending_rules: uint32               # 当前 pending 的规则数
```

### 4.3 RuleState（规则状态）

```yaml
RuleState:
  rule_id: string                     # 规则 ID
  group_id: string                    # 所属规则组
  alert_name: string                  # 告警名称
  state: enum                         # IDLE | PENDING | FIRING | RESOLVED
  pending_at: timestamp               # 进入 PENDING 的时间
  firing_at: timestamp                # 进入 FIRING 的时间
  resolved_at: timestamp              # 进入 RESOLVED 的时间
  last_eval_at: timestamp             # 最后评估时间
  last_eval_result: bool              # 最后评估结果 (true = 条件满足)
  active_labels: map<string, string>  # 触发告警的标签集合
  active_value: float64               # 触发值
  alert_id: string                    # 关联的告警 ID
```

### 4.4 AlertQueue（告警队列）

```yaml
AlertQueue:
  queue_id: string                    # 队列标识
  zone_id: string                     # 所属网区
  max_size: uint32                    # 最大队列大小
  current_size: uint32                # 当前队列大小

  # 队列状态
  state: enum                         # NORMAL | DRAINING | FULL
  drain_target: string                # 排空目标 (center | local_file)

  # 统计
  total_enqueued: uint64              # 总入队数
  total_dequeued: uint64              # 总出队数
  total_dropped: uint64               # 总丢弃数 (队列满时)

  # 降级信息
  degraded_mode: bool                 # 是否处于降级模式
  degraded_since: timestamp           # 降级开始时间
  last_sync_to_center: timestamp      # 最后同步到中心的时间
```

---

## 五、接口与交互

### 5.1 vmalert → 本地存储查询

```
RC Node (vmalert)                       本地存储
  │                                       │
  │  Mode B:                              │
  │  GET /api/v1/query                    │
  │  ?query=<promql_expr>                 │
  │  &time=<eval_time>                    │
  │──────────────────────────────────────▶│
  │                                       │
  │  Mode C:                              │
  │  GET http://vmselect:8481/            │
  │  select/{accountID}/prometheus/       │
  │  api/v1/query                         │
  │  ?query=<promql_expr>                 │
  │──────────────────────────────────────▶│
  │                                       │
  │  Response:                            │
  │  {                                    │
  │    status: "success",                 │
  │    data: {                            │
  │      resultType: "vector" | "matrix", │
  │      result: [...]                    │
  │    }                                  │
  │  }                                    │
  │◀──────────────────────────────────────│
  │                                       │
```

| 接口 | 方向 | 协议 | 频率 | 说明 |
|------|------|------|------|------|
| Instant Query | vmalert → VM | HTTP (Prometheus API) | evaluation_interval | 即时查询 |
| Range Query | vmalert → VM | HTTP (Prometheus API) | 按需 | 范围查询（部分规则需要） |

### 5.2 RC ↔ RC Peer 交互

```
RC Node A                              RC Node B
  │                                         │
  │  RCAdvertisement (3s)                   │
  │────────────────────────────────────────▶│
  │                                         │
  │  RCAdvertisement (3s)                   │
  │◀────────────────────────────────────────│
  │                                         │
  │  RuleGroupTakeoverProposal              │
  │  { groups: ["A","B","C"],               │
  │    from: "RC-A (EXPIRED)" }             │
  │────────────────────────────────────────▶│
  │                                         │
  │  RuleGroupTakeoverVote                  │
  │  { accept: true,                        │
  │    can_take: ["A","B"] }                │
  │◀────────────────────────────────────────│
  │                                         │
```

| 接口 | 方向 | 协议 | 频率 | 说明 |
|------|------|------|------|------|
| RCAdvertisement | RC ↔ RC | UDP/HTTP | 3s | RC peer 心跳 |
| RuleGroupTakeoverProposal | RC → RC | HTTP | 事件驱动 | 规则组接管提案 |
| RuleGroupTakeoverVote | RC → RC | HTTP | 响应 | 接管投票 |

### 5.3 RC ↔ 调度器 / Zone Agent 交互

```
调度器 (Scheduler)                        RC Node
  │                                         │
  │  GET /api/v1/rules?zone_id=<zone_id>    │
  │◀────────────────────────────────────────│  RC 定时拉取（默认 30s）
  │  RulePackageResponse(rule_package)       │
  │────────────────────────────────────────▶│
  │                                         │
  │  POST /-/notify-rule-update             │  紧急通知（可选）
  │────────────────────────────────────────▶│
  │                                         │

Zone Agent                              RC Node (vmalert)
  │                                         │
  │  ForwardAlertRequest(alert)              │
  │◀────────────────────────────────────────│  vmalert → Alertmanager
  │                                         │
  │  ForwardAlertAck(alert_id)               │
  │────────────────────────────────────────▶│
  │                                         │
```

| 接口 | 方向 | 协议 | 频率 | 说明 |
|------|------|------|------|------|
| PullRulePackage | RC → Scheduler | HTTP | 30s | RC 定时拉取规则包 |
| NotifyRuleUpdate | Scheduler → RC | HTTP | 事件驱动 | 紧急规则更新通知 |
| ForwardAlertRequest | RC → ZA | HTTP | 事件驱动 | 告警转发至 Alertmanager |

### 5.4 RC ↔ Coordinator 交互

```
Coordinator                             RC Node
  │                                         │
  │  Heartbeat (15s)                         │
  │◀────────────────────────────────────────│
  │  HeartbeatResp                           │
  │────────────────────────────────────────▶│
  │                                         │
  │  IssueEpoch(zone_epoch)                  │
  │◀────────────────────────────────────────│
  │  EpochResp(epoch_token)                  │
  │────────────────────────────────────────▶│
  │                                         │
```

| 接口 | 方向 | 协议 | 频率 | 说明 |
|------|------|------|------|------|
| Heartbeat | RC → Co | gRPC | 15s | RC 存活心跳 |
| IssueEpoch | RC → Co | gRPC | 事件驱动 | 请求签发 RC epoch |

---

## 六、设计决策与替代方案

### DEC-RC-01：规则评估引擎选型

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：vmalert（当前） | 使用 VictoriaMetrics vmalert 开源组件 | 成熟稳定；与 VM 生态完全兼容；社区维护 | 定制能力受限于 vmalert 扩展点 |
| B：自研 PromQL 引擎 | 自行实现 PromQL 求值和规则状态机 | 完全可控 | 开发成本高；与生态不兼容；维护负担 |

**[建议]**：方案 A（vmalert）。vmalert 是 VictoriaMetrics 生态的成熟组件，原生支持 PromQL 规则评估、Alertmanager 集成、规则热加载。自研引擎投入产出比不合理。

### DEC-RC-02：规则包分发模式

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：RC 定时拉取（当前） | RC 周期性从调度器拉取规则包 | 简单；与 vmalert 规则文件加载兼容；RC 自主控制节奏 | 更新延迟取决于拉取间隔 |
| B：调度器全量推送 | 规则变更时调度器主动推送到所有 RC | 实时性好 | RC 需要暴露推送接口；与 vmalert 原生加载模式不匹配 |
| C：拉取 + 紧急通知 | RC 定时拉取 + 紧急变更时调度器通知 RC 立即拉取 | 平衡实时性与简洁性 | 需要两套机制 |

**[建议]**：方案 C（拉取 + 紧急通知）。常规更新依赖 RC 定时拉取（30s 间隔），紧急变更（如关键告警规则修改）时调度器主动通知 RC 立即拉取。

### DEC-RC-03：告警管理架构

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：Alertmanager（当前） | 告警发送到服务端 Alertmanager 统一处理 | 成熟生态；去重/分组/静默/抑制开箱即用 | 引入 Alertmanager 依赖 |
| B：RC 本地处理 | RC 自行实现告警去重、分组、抑制 | 无外部依赖 | 重复造轮子；分布式去重困难 |

**[建议]**：方案 A（Alertmanager）。Alertmanager 是 Prometheus 生态的标准告警管理组件，天然支持基于 fingerprint 的去重，完美解决 RC 故障接管时的告警重复问题。

### DEC-RC-04：告警去重策略

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：Prometheus fingerprint（当前） | fingerprint = hash(alertname + sorted labels) | 节点无关；故障接管时自然去重 | 要求规则包不含节点特定标签 |
| B：节点 ID + 规则 ID | 告警 ID 包含生成节点信息 | 可追溯告警来源 | 同一规则在不同节点产生不同 ID，接管时无法去重 |

**[建议]**：方案 A（Prometheus fingerprint）。核心约束：规则包中不得包含 `rc_node_id` 等节点特定标签。`instance` 标签来自指标数据（PromQL 查询结果），而非 RC 节点注入。

---

## 七、冲突与开放问题

| ID | 问题 | 影响 | 状态 |
|----|------|------|------|
| MC-02 | RC slot 池：独立 vs 共享（参见 DEC-RC-04） | 影响 RC 架构复杂度 | 待确认 |
| RC-01 | Mode A 告警覆盖：无本地 RC → 无规则告警能力 | Mode A 区在 L1 时完全无告警 | 待确认（接受为设计约束） |
| RC-02 | vmalert 评估大量规则（>1000 条）时的性能 | 评估耗时可能超过评估间隔 | 待压测 |
| RC-03 | vmalert 查询对本地存储的性能影响 | 大量并发 PromQL 查询可能影响存储写入性能 | 待压测 |
| RC-04 | 规则包中 PromQL 表达式的安全性 | 恶意或错误的 PromQL 可能导致 vmalert OOM | 待确认（需要查询限制） |
| RC-05 | RC 节点与 Job Scheduler 节点共置时的资源隔离 | vmalert 查询可能影响 Job Scheduler 的调度性能 | 待确认 |
| RC-06 | 告警补发时的去重策略 | 降级恢复后 Alertmanager 基于 fingerprint 自动去重 | 已确认（依赖 Alertmanager fingerprint 去重） |
| RC-07 | RC 节点故障时规则组的接管延迟 | 接管期间该规则组的告警暂停 | 待确认（通常 <30s） |
| RC-08 | vmalert 版本升级与定制扩展点的兼容性 | 需确保 RC 定制（热加载、格式转换）不受 vmalert 升级影响 | 待确认 |
