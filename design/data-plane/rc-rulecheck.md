# RC 规则检测

> 版本：v1.0 | 日期：2026-09-21
> 状态：设计中

---

## 一、概述

RC（RuleCheck）是采集层中的规则评估引擎，负责周期性查询本地时序存储、评估告警规则、生成告警事件。RC 的核心设计约束是**绑定存储**——仅部署在拥有本地时序存储的网区（mode B/C），mode A 网区不部署 RC。

RC 节点复用 Job Scheduler 的 slot 协商模式，形成独立的同构 peer 组。RC 与 RC 之间通过相同的 VRRP 风格 peer 检测和 epoch fencing 机制进行规则组归属的协商，但 RC 的 peer 组与 Job Scheduler 的 peer 组完全独立。

### 核心定位

```
┌──────────────────────────────────────────────────────────────────┐
│ Zone (Mode B/C)                                                   │
│                                                                    │
│  ┌────────────┐    ┌────────────┐    ┌────────────┐             │
│  │ RC Node 1  │    │ RC Node 2  │    │ RC Node 3  │             │
│  │            │    │            │    │            │             │
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
│  RC 评估结果 → 告警 → 转发至控制面                                  │
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
- RC 规则评估引擎的核心逻辑
- RC 的存储绑定策略（mode B/C 部署，mode A 不部署）
- RC peer 组的设计（独立于 Job Scheduler peer 组）
- RC slot 协商机制（复用 epoch fencing 模式）
- 规则包管理与热更新
- 告警生成与转发协议
- RC 节点的部署与运维模型

**本文档不负责**：
- RuleSpec 的定义与管理（→ `control-plane/`）
- 规则包的分发协议（→ `cross-plane/zone-manifest-protocol.md`）
- Job Scheduler 的 slot 协商（→ `data-plane/job-scheduler.md`）
- 告警的汇聚、去重与通知（→ `control-plane/` 告警管理模块）
- 本地存储的部署与管理（→ `data-plane/storage.md`）
- 降级模式下的告警处理（→ `cross-plane/degradation-autonomy.md`）

---

## 三、功能清单

### 3.1 功能总览

| 功能模块 | 功能项 | 优先级 | 说明 |
|---------|--------|--------|------|
| 规则评估 | PromQL 表达式求值 | P0 | 查询本地存储，计算规则表达式 |
| 规则评估 | 规则状态机管理（pending → firing → resolved） | P0 | 跟踪规则的持续时间和状态 |
| 规则评估 | 评估间隔调度 | P0 | 按 evaluation_interval 周期执行 |
| RC Peer | RC 节点间 VRRP 心跳 | P0 | 独立于 Job Scheduler 的 peer 组 |
| RC Peer | RC slot 归属协商 | P0 | 规则组归属的协商与 epoch fencing |
| RC Peer | RC 节点状态机 | P0 | REGISTER → HEALTHY → EXPIRED 等 |
| 规则包管理 | 接收规则包（从 Zone Agent） | P0 | RuleSpec 的本地存储 |
| 规则包管理 | 规则包版本追踪 | P0 | 热更新，版本校验 |
| 规则包管理 | 规则包 diff 应用 | P1 | 增量更新规则包 |
| 告警输出 | 告警生成 | P0 | 规则触发时生成告警 |
| 告警输出 | 告警转发至控制面 | P0 | 通过 Zone Agent 转发 |
| 告警输出 | 告警本地缓存（降级时） | P0 | 中心不可达时本地缓存 |
| 告警输出 | 告警去重与抑制 | P1 | 避免重复告警 |

### 3.2 规则评估引擎

#### 3.2.1 评估流程

```
评估周期触发 (每 evaluation_interval):
    │
    ▼
1. 加载当前节点拥有的规则组列表
    │
    ▼
2. 对每个规则组：
    │
    ├── 2a. 遍历规则组中的每条规则
    │       │
    │       ▼
    │   构造 PromQL 查询
    │   ├── expr: 规则表达式
    │   ├── 时间范围: [now - lookback, now]
    │   └── 附加标签过滤: zone_id = self.zone_id
    │       │
    │       ▼
    │   查询本地存储
    │   ├── Mode B: 查询本地 VM 单实例
    │   └── Mode C: 通过 vmselect 查询 VM 集群
    │       │
    │       ▼
    │   评估表达式
    │   ├── 结果非空 → 规则条件满足
    │   │   ├── 首次满足 → 状态变为 PENDING，记录 pending_at
    │   │   ├── 已 PENDING 且持续 >= for → 状态变为 FIRING，生成告警
    │   │   └── 已 FIRING → 更新告警（刷新 active_at）
    │   │
    │   └── 结果为空 → 规则条件不满足
    │       ├── 已 PENDING → 状态清除（假触发）
    │       ├── 已 FIRING → 状态变为 RESOLVED，生成解决告警
    │       └── 无状态 → 无操作
    │
    └── 2b. 记录评估统计（耗时、结果数、错误）
    │
    ▼
3. 输出告警到转发队列
```

#### 3.2.2 规则状态机

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
| IDLE | 规则条件未满足 | 无 |
| PENDING | 规则条件刚满足，等待持续时间 | 记录 pending_at |
| FIRING | 规则条件持续满足超过 for 时间 | 生成告警，周期性重复告警 |
| RESOLVED | 规则条件不再满足 | 生成解决告警，清除状态 |

#### 3.2.3 PromQL 查询构造

```yaml
RuleEvaluation:
  rule_id: string
  alert_name: string
  expr: string                      # PromQL 表达式
  for: duration                     # 持续时间阈值
  severity: string                  # critical | warning | info

  # 查询参数
  query:
    promql_expr: string             # 原始表达式（可能包含变量）
    eval_time: timestamp            # 评估时间点
    lookback_delta: duration        # 回看窗口（默认 5m）
    timeout: duration               # 查询超时
    max_series: uint32              # 最大返回序列数（防止 OOM）

  # 评估上下文
  context:
    zone_id: string                 # 当前网区
    rc_node_id: string              # 当前 RC 节点
    rule_group_id: string           # 所属规则组
    source_slot_ids: [uint32]       # 依赖的采集 slot
```

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

#### 3.4.1 规则包来源

规则包（Rule Package）由控制面定义，包含在 Zone Manifest 中下发：

```
Control Plane (RuleSpec)
    │
    │  打包进 Zone Manifest
    │  (rule_groups 字段)
    │
    ▼
Zone Agent
    │
    │  广播到区内 RC 节点
    │  (仅 mode B/C 区有 RC 节点)
    │
    ▼
RC Nodes
    │
    │  接收并加载规则包
    │  按规则组归属执行评估
```

#### 3.4.2 规则包结构

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
          alert_name: string          # 告警名称
          expr: string                # PromQL 表达式
          for: duration               # 持续时间
          severity: string            # critical | warning | info
          labels:                     # 告警标签
            zone_id: string
            rule_group_id: string
          annotations:                # 告警注释（支持模板）
            summary: string
            description: string
```

#### 3.4.3 规则包热更新

```
规则包更新流程：
    │
    ▼
1. Zone Agent 推送新规则包 (version N+1)
    │
    ▼
2. RC 节点接收并校验
   ├── version > current_version → 接受
   ├── version <= current_version → 拒绝
   └── 完整性校验通过 → 继续
    │
    ▼
3. 对比新旧规则包 diff
   ├── 新增规则组 → 加入评估队列
   ├── 删除规则组 → 从评估队列移除，清除相关状态
   ├── 修改规则 → 更新评估参数
   └── 修改评估间隔 → 更新调度器
    │
    ▼
4. 热加载生效（不重启 RC 进程）
   ├── 正在评估的规则组：当前评估完成后应用新配置
   ├── 已触发的告警：如果规则被删除，告警自动 RESOLVED
   └── 新增的规则：从 IDLE 状态开始评估
```

### 3.5 告警生成与转发

#### 3.5.1 告警格式

```yaml
Alert:
  alert_id: string                    # 告警唯一标识
  alert_name: string                  # 告警名称（来自规则定义）
  rule_id: string                     # 触发的规则 ID
  rule_group_id: string               # 所属规则组

  # 状态
  state: enum                         # FIRING | RESOLVED
  starts_at: timestamp                # 触发时间
  ends_at: timestamp                  # 解决时间（RESOLVED 时）
  fired_at: timestamp                 # 本次告警生成时间

  # 标签
  labels:
    zone_id: string                   # 网区 ID
    rc_node_id: string                # 生成告警的 RC 节点
    rule_id: string                   # 规则 ID
    severity: string                  # critical | warning | info
    instance: string                  # 触发告警的实例（来自 PromQL 结果）
    # ... 规则定义中的其他标签

  # 注释
  annotations:
    summary: string                   # 告警摘要
    description: string               # 告警描述（模板渲染后）
    value: string                     # 触发值（来自 PromQL 结果）

  # 元数据
  metadata:
    degraded_mode: bool               # 是否在降级模式下生成
    eval_duration: duration           # 评估耗时
    query_series_count: uint32        # 查询返回的序列数
```

#### 3.5.2 告警转发

```
RC Node                              Zone Agent                    Control Plane
  │                                       │                              │
  │  ForwardAlert(alert)                   │                              │
  │──────────────────────────────────────▶│                              │
  │                                       │  缓存到跨区发送队列          │
  │                                       │─────────────────────────────▶│
  │                                       │                              │  告警管理模块
  │  ForwardAck(alert_id)                  │                              │  处理去重、通知
  │◀──────────────────────────────────────│                              │
  │                                       │                              │
```

降级模式下的告警处理：

```
正常模式 (L0)：
  RC → Zone Agent → Control Plane (实时转发)

降级模式 (L1-L3)：
  RC → Zone Agent → 本地告警队列 (文件/SQLite)
                         │
                    中心恢复后
                         │
                         ▼
                   批量补发到 Control Plane
                   (标记 degraded_mode: true)
```

#### 3.5.3 告警去重与抑制

RC 节点本地的告警去重策略：

| 策略 | 说明 | 配置 |
|------|------|------|
| 重复抑制 | 同一规则、同一实例的告警，在 firing 期间不重复生成 | `repeat_interval: 4h` |
| 分组聚合 | 同一规则组的告警按标签分组 | `group_by: [zone_id, severity]` |
| 抑制规则 | 高优先级告警抑制低优先级告警 | `inhibit_rules: [...]` |

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

### 5.1 RC → 本地存储查询

```
RC Node                               本地存储
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
| Instant Query | RC → VM | HTTP (Prometheus API) | evaluation_interval | 即时查询 |
| Range Query | RC → VM | HTTP (Prometheus API) | 按需 | 范围查询（部分规则需要） |

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

### 5.3 RC ↔ Zone Agent 交互

```
Zone Agent                              RC Node
  │                                         │
  │  PushRulePackage(rule_package)           │
  │────────────────────────────────────────▶│
  │                                         │  加载规则包
  │  RulePackageAck(version)                 │
  │◀────────────────────────────────────────│
  │                                         │
  │  ForwardAlertRequest(alert)              │
  │◀────────────────────────────────────────│
  │                                         │
  │  ForwardAlertAck(alert_id)               │
  │────────────────────────────────────────▶│
  │                                         │
```

| 接口 | 方向 | 协议 | 频率 | 说明 |
|------|------|------|------|------|
| PushRulePackage | ZA → RC | HTTP | 事件驱动 | 规则包推送 |
| ForwardAlertRequest | RC → ZA | HTTP | 事件驱动 | 告警转发请求 |
| GetRulePackageVersion | ZA → RC | HTTP | 10s | 查询当前规则包版本 |

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

### DEC-RC-01：RC 部署模型

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：与 Job Scheduler 共置（当前推荐） | RC 运行在 Job Scheduler 同一节点 | 无需额外节点；部署简单 | 资源竞争；故障域重叠 |
| B：专用 RC 节点 | RC 运行在独立节点上 | 资源隔离；独立扩缩 | 需要额外节点；增加成本 |
| C：混合模式 | 默认共置，可选专用节点 | 灵活 | 两种模式增加运维复杂度 |

**[建议]**：阶段 1 用方案 A（共置）。RC 的资源消耗通常不大（PromQL 查询由存储端执行，RC 只做结果评估），共置不会造成显著的资源竞争。阶段 2 当规则数量极大时评估方案 C。

### DEC-RC-02：规则评估方式

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：Pull 查询存储（当前） | RC 周期性查询存储 | 简单；与 Prometheus 兼容 | 评估间隔限制了告警灵敏度 |
| B：Streaming 流式评估 | 存储主动推送数据变更到 RC | 实时性好；减少查询开销 | 实现复杂；存储需要支持推送 |
| C：混合模式 | 常规规则 Pull + 关键规则 Streaming | 平衡 | 两套评估路径 |

**[建议]**：方案 A（Pull 查询）。与 Prometheus 规则评估模型一致，VictoriaMetrics 原生支持 PromQL 查询 API。评估间隔通常 15-60s，对大多数告警场景足够。

### DEC-RC-03：告警转发路径

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：直接转发到控制面（当前） | RC → Zone Agent → Control Plane | 简单；实时 | 跨区通道中断时告警积压 |
| B：经 Zone Agent 聚合 | RC → Zone Agent 聚合 → Control Plane | 减少跨区流量 | Zone Agent 成为告警瓶颈 |
| C：本地通知 + 异步上报 | RC 本地通知 → 异步上报控制面 | 通知不受跨区影响 | 需要区内通知渠道 |

**[建议]**：方案 A。告警数据量通常不大，Zone Agent 仅做透传。降级时自动切换为本地缓存 + 补发模式（见 `cross-plane/degradation-autonomy.md`）。

### DEC-RC-04：RC Slot 池设计

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：独立 RC slot 池（当前） | RC 有独立的 peer 组和 slot 池 | 职责清晰；互不干扰 | 需要独立的心跳和协商 |
| B：共享 slot 池 | RC 复用 Job Scheduler 的 slot 池 | 减少协议复杂度 | 职责混合；调度复杂 |
| C：层次化 | Job Scheduler 同时管理 RC slot | 统一调度 | Job Scheduler 负载增加 |

**[建议]**：方案 A（独立 RC slot 池）。虽然增加了协议复杂度，但 RC 和采集的职责差异大（RC 需要存储访问，采集不需要），独立管理更清晰。

---

## 七、冲突与开放问题

| ID | 问题 | 影响 | 状态 |
|----|------|------|------|
| MC-02 | RC slot 池：独立 vs 共享（参见 DEC-RC-04） | 影响 RC 架构复杂度 | 待确认 |
| RC-01 | Mode A 告警覆盖：无本地 RC → 无规则告警能力 | Mode A 区在 L1 时完全无告警 | 待确认（接受为设计约束） |
| RC-02 | RC 评估大量规则（>1000 条）时的性能 | 评估耗时可能超过评估间隔 | 待压测 |
| RC-03 | RC 查询对本地存储的性能影响 | 大量并发 PromQL 查询可能影响存储写入性能 | 待压测 |
| RC-04 | 规则包中 PromQL 表达式的安全性 | 恶意或错误的 PromQL 可能导致 RC OOM | 待确认（需要查询限制） |
| RC-05 | RC 节点与 Job Scheduler 节点共置时的资源隔离 | RC 查询可能影响 Job Scheduler 的调度性能 | 待确认 |
| RC-06 | 告警补发时的去重策略 | 降级期间可能产生大量重复告警 | 待确认（参见 DA-01） |
| RC-07 | RC 节点故障时规则组的接管延迟 | 接管期间该规则组的告警暂停 | 待确认（通常 <30s） |
