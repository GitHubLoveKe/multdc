# Zone Manifest 协议与跨层通信

> 版本：v1.0 | 日期：2026-09-21
> 状态：设计中

---

## 一、概述

Zone Manifest 是连接中心控制面与协调层/采集层的核心载体。它是控制面「期望态」的具体表达，以声明式的方式描述一个网区内「应该采集什么、怎么采集、由谁执行」。

本文档定义 Manifest 的格式、下发协议、降级时的广播机制，以及跨层通信的通用协议。

---

## 二、职责边界

**本文档负责**：
- Zone Manifest 的数据结构与版本规范
- 控制面 → 协调层的 Manifest 下发协议
- 协调层内部的 Manifest 广播与同步
- Manifest 的热更新与回滚机制
- 跨层通信的通道选型（M1/M2/M3）

**本文档不负责**：
- Manifest 中 slot 归属的具体协商算法（→ `coordination-plane/collection-task-scheduling.md`）
- Manifest 中 TaskSpec 的定义（→ `control-plane/` 相关模块）
- RC 规则包的分发（→ `coordination-plane/rc-task-scheduling.md`，但共享部分通道设计）

---

## 三、Zone Manifest 数据结构

### 3.1 顶层结构

```yaml
ZoneManifest:
  # 元信息
  zone_id: string              # 网区唯一标识
  version: uint64              # Manifest 版本号（单调递增）
  created_at: timestamp        # 生成时间
  generated_by: string         # 生成者（Control Plane instance_id）

  # 全局配置
  config:
    scrape_interval_default: duration    # 默认抓取间隔（如 15s）
    scrape_timeout_default: duration     # 默认抓取超时（如 10s）
    evaluation_interval: duration        # RC 规则评估间隔
    external_labels:                     # 附加到所有时序的外部标签
      zone_id: string
      cluster: string

  # Slot 定义（全区完整清单）
  slots:
    - slot_id: uint32
      targets: [Target]                  # 该 slot 负责的采集目标列表
      required_agent_type: string        # 所需 Agent 能力类型
      priority: uint8                    # slot 优先级（用于驱离排序）

  # Agent 能力注册（全区 Agent 清单）
  agents:
    - agent_id: string
      node_id: string                    # 所在 Job Scheduler 节点
      agent_type: string                 # 能力类型
      capacity: uint32                   # 最大可承载 target 数
      status: enum                       # idle / active / draining

  # RC 规则包（仅 mode B/C 网区）
  rule_groups:                           # [mode A 时为空]
    - group_id: string
      rules: [Rule]
      evaluation_interval: duration
      source_slot_ids: [uint32]          # 该规则组依赖的 slot（取数来源）

  # 归属映射（轻量级，可被覆盖）
  ownership:
    slot_assignments:
      - slot_id: uint32
        owner_node: string               # 归属的 Job Scheduler 节点
        epoch_token: string              # epoch fencing token
    rc_assignments:                      # [mode A 时为空]
      - group_id: string
        owner_rc_node: string
        epoch_token: string
```

### 3.2 Target 结构

```yaml
Target:
  instance_id: string          # 关联控制面实例台账
  endpoint: string             # 采集地址（host:port）
  metrics_path: string         # 指标路径（默认 /metrics）
  scheme: string               # http / https
  scrape_interval: duration    # 覆盖默认间隔（可选）
  scrape_timeout: duration     # 覆盖默认超时（可选）
  credential_id: string        # 凭据引用（NOT 实际凭据）
  labels:
    __instance_type__: string  # oracle / mysql / linux / windows
    __zone_id__: string        # 所属网区
    job: string                # 任务组名
    # ... 用户自定义标签
```

### 3.3 Rule 结构

```yaml
Rule:
  rule_id: string
  alert_name: string
  expr: string                 # PromQL 表达式
  for: duration                # 持续时间
  severity: string             # critical / warning / info
  labels:
    zone_id: string
    rule_group_id: string
  annotations:
    summary: string
    description: string
```

---

## 四、Manifest 下发协议

### 4.1 正常流程（L0）

```
Control Plane                      Zone Agent                    Job Schedulers
    │                                  │                              │
    │  1. TaskSpec 变更                │                              │
    │  → 生成新 Manifest (v+1)         │                              │
    │                                  │                              │
    │  2. Push Manifest v+1 ──────────▶│                              │
    │     (via M2/M3 跨区通道)          │  3. 区内广播 Manifest v+1    │
    │                                  │─────────────────────────────▶│
    │                                  │                              │
    │                                  │  4. ACK (all nodes)          │
    │                                  │◀─────────────────────────────│
    │  5. 汇总 ACK                    │                              │
    │◀─────────────────────────────────│                              │
    │                                  │                              │
    │                                  │      6. 各节点独立执行        │
    │                                  │         slot 归属协商         │
```

**关键约束**：
- Manifest 是全区完整清单，所有 Job Scheduler 持有相同内容
- 归属映射（ownership）初始由控制面生成，但可被协调层覆盖（自治场景）
- 控制面只推 Manifest，不推归属决定（归属是区内协商的结果）

### 4.2 版本号规则

- `version` 单调递增，每次 TaskSpec 变更（增删 target、修改规则等）+1
- Job Scheduler 拒绝接受 version ≤ 当前 version 的 Manifest
- 版本号不跳号（v1 → v2 → v3），便于检测丢失

### 4.3 热更新机制

- Manifest 变更时，控制面主动 push 到 Zone Agent
- Zone Agent 广播到区内所有 Job Scheduler
- Job Scheduler 对比新旧 Manifest diff：
  - 新增 target → 加入对应 slot
  - 删除 target → 从 slot 移除
  - 修改配置 → 下次采集时生效
  - slot 结构变更（增删 slot）→ 触发全量重映射（高成本操作）
- **不需要重启任何组件**

---

## 五、降级时的 Manifest 处理

### 5.1 L1 — 中心不可达

```
Control Plane [不可达]
    ╳ (跨区通道中断)
    │
Zone Agent                         Job Schedulers
    │                                  │
    │  持有最后已知 Manifest            │
    │  标记为 "stale"                   │
    │                                  │
    │  区内继续按最后 Manifest 执行      │
    │  归属协商正常运行                 │
    │                                  │
    │  不接受新的 TaskSpec 变更          │
    │  （无法获取新版本）                │
```

- Zone Agent 缓存最后成功接收的 Manifest
- 标记 `sync_status: stale`，持续尝试重连控制面
- 区内按最后 Manifest 正常运行
- 冻结能力：任务定义变更（无法获取新 Manifest）

### 5.2 L2 — Coordinator 主不可用

- Manifest 不受影响（Manifest 存储在 Job Scheduler 本地）
- 但归属协商可能暂停（切换期间）
- 备 Coordinator 接管后恢复

### 5.3 L3 — 协调器全失

```
Control Plane [可能可达]
    │
    │  Manifest 下发可能正常
    │  (M2/M3 通道可能仍通)
    │
Zone Agent                         Job Schedulers (纯分布式)
    │                                  │
    │  Manifest 可更新                  │  peer 互探继续
    │                                  │  多数派接管继续
    │                                  │  再均衡冻结
    │                                  │  新 slot 分配冻结
```

- Manifest 可以更新（如果跨区通道仍通）
- 但 slot 归属协商退化为纯多数派模式
- 新节点加入无法分配 slot（需要 Coordinator 签发 epoch）

---

## 六、跨区通道选型

### 6.1 通道模型对比

| 模型 | 描述 | 优点 | 缺点 | 适用场景 |
|------|------|------|------|---------|
| M1 | 直接 HTTP：控制面直连每个 Job Scheduler | 最简单 | 需控制面到每个节点的网络可达；安全面大 | 1 节点区/测试环境 |
| M2 | Zone Agent 代理：控制面 → Zone Agent → 区内广播 | 安全面小；区内广播高效 | Zone Agent 是单点（可主备） | 推荐方案 |
| M3 | 长连接 push：Zone Agent 与控制面保持长连接，控制面主动 push | 低延迟；实时性好 | 连接管理复杂；NAT 穿透问题 | 需要实时变更的场景 |

### 6.2 推荐方案：M2 + M3 混合

```
Control Plane
    │
    │  M3 长连接（Manifest push、指令下发）
    │  M2 接口自检（心跳、状态查询、快照同步）
    │
Zone Agent
    │
    │  区内广播（Manifest 同步）
    │
Job Schedulers
```

- **M3 长连接**：用于 Manifest push（低频、大报文）和实时指令
- **M2 接口自检**：用于心跳检测（高频、小报文）和状态查询
- **互补**：M3 断连时 M2 仍可检测；M2 不适合大报文传输

### 6.3 安全考量

- 跨区通道需要双向 TLS 认证
- Zone Agent 需持有控制面签发的证书
- Manifest 传输需要完整性校验（签名或 HMAC）
- 凭据永远不通过跨区通道传输（凭据走独立通道 → `credential-service.md`）

---

## 七、Rule 规则包分发协议

### 7.1 与 Manifest 的关系

Rule 规则包是 Manifest 的一部分（`rule_groups` 字段），但其分发有特殊约束：

- 仅 mode B/C 网区需要 Rule 规则包
- Mode A 网区的 `rule_groups` 为空
- Rule 规则包的变更频率通常低于 Target 变更

### 7.2 分发流程

```
Control Plane (RuleSpec)
    │
    │  打包进 Zone Manifest
    │  (或独立 Rule Package 推送)
    │
Zone Agent
    │
    │  广播到区内 RC 节点
    │
RC Nodes
    │
    │  热加载规则包
    │  按规则组归属执行评估
```

### 7.3 独立推送 vs 打包推送

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| 打包推送 | Rule 作为 Manifest 一部分 | 简单；版本一致 | Rule 变更触发 Manifest 全量更新 |
| 独立推送 | Rule 通过独立通道推送 | Rule 变更不影响 Manifest 版本 | 需维护两套版本；一致性复杂 |

**[建议]**：阶段 1 采用打包推送（简单可靠）。阶段 3 评估独立推送（当 Rule 变更频率显著高于 Target 时）。

---

## 八、RC 路由协议

### 8.1 RC 路由与任务路由的分离

RC 路由决定「哪个 RC 节点评估哪组规则」，与采集任务路由（「哪个 Job Scheduler 节点采集哪些 target」）独立：

```
采集路由：TaskSpec → slot → Job Scheduler node → Agent
RC 路由：RuleSpec → rule_group → RC node → 本地存储取数
```

### 8.2 RC 路由规则

- RC 节点从本地存储取数（不跨区取数）
- Rule 规则组的 `source_slot_ids` 指明依赖的采集 slot
- RC 节点必须能访问这些 slot 产生的数据（本地存储）
- 如果 slot 被迁移到其他节点，但数据仍在本地存储，RC 不受影响

---

## 九、设计决策与替代方案

### DEC-MANIFEST-01：Manifest 包含归属映射 vs 不包含

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：包含 | Manifest 携带初始归属映射 | 减少首次协商时间 | 控制面介入归属决策（违反 P1） |
| B：不包含 | Manifest 只描述 slot/target，归属完全由区内协商 | 完全符合 P1 | 首次启动时协商时间较长 |

**[建议]**：方案 A。控制面可以基于全局视图给出「建议归属」，但协调层有权覆盖。这既加速启动，又不违反原则（控制面给建议，协调层做最终决策）。

### DEC-MANIFEST-02：Manifest 粒度 — 全区一份 vs 分片

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：全区一份 | 所有 Job Scheduler 持有完整 Manifest | 简单；任何节点可回答全区问题 | 大 zone 时 Manifest 可能很大 |
| B：分片 | 每个节点只持有自己负责的 slot 子集 | 内存占用小 | 节点无法回答全区问题；跨片操作复杂 |

**[建议]**：方案 A（全区一份）。与 P2（任务内容与归属解耦）一致。Manifest 大小通常可控（1000 targets × ~200 bytes = ~200KB）。

---

## 十、冲突与开放问题

| ID | 问题 | 影响 | 状态 |
|----|------|------|------|
| CP-01 | 跨区通道选型（M1/M2/M3）未最终确认 | 影响 Manifest 下发延迟和可靠性 | 待确认（GD-01） |
| CP-02 | Manifest 大小上限 | 超大 zone（>5000 targets）时 Manifest 广播效率 | 待压测 |
| CP-03 | Rule 规则包是否需要独立于 Manifest 的版本控制 | 影响 Rule 变更的独立性 | 待确认 |
| CP-04 | 凭据分发通道的具体实现 | 影响安全性 | 待确认（GD-04） |
| CP-05 | Manifest 回滚机制：是否需要支持版本回退 | 影响版本管理复杂度 | 待确认 |
