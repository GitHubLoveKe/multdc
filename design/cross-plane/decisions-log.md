# 设计决策日志

> 版本：v3.1 | 日期：2026-09-23
> 本文档记录所有设计决策，包括已确认的、待确认的、已废弃的、以及存在冲突的决策。
> 每条决策包含背景、候选方案、最终选择和理由。
>
> **v3.1 变更摘要（2026-09-23）**：DC 网关（DC Gateway）统一。Target Syncer 功能并入控制面 Proxy，重命名为 DC 网关。DC 侧进程从 2（Alloy + Target Syncer）降至 1（仅 Alloy）。新增 DEC-027，更新 DEC-024。
>
> **v3.0 变更摘要（2026-09-23）**：存储-Worker 分离架构重构。新增 DEC-022~DEC-026，废弃 DEC-002/003/004/009/012~021（Alloy 统一化 + 存储独立化）。详见各决策条目。

---

## 一、已确认决策

### DEC-001：任务定义归属 — 控制面定义，Scheduler 自治执行

**背景**：用户初始需求中将「采集任务管理」和「RC 任务管理」列在控制面，但以 `#` 标注了对其归属的疑问。核心矛盾是：控制面应该是「定义权威」，但任务的运行时调度是「区内实时行为」。

**候选方案**：

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：全在控制面 | TaskSpec 定义 + 分配 + 运行时调度全在中心 | 全局最优；简单 | 违反 P1；中心故障=全区停采 |
| B：全在协调面 | 各区自行定义任务，中心只审计 | 完全自治 | 丧失全局一致性；无法跨区协调 |
| **C：定义/调度分离** | 控制面定义 TaskSpec/RuleSpec；区内 Scheduler 自治调度 | 符合 P1；降级自治；全局视图 | 需要数据同步协议 |

**最终选择**：方案 C。

**理由**：与核心原则 P1 完全一致。控制面是「做什么」的唯一权威，Scheduler 是「怎么做」的区内权威。协调层仅作为数据中继（见 DEC-012），不参与调度决策。

**影响模块**：C1-C8（控制面），D1（Job Scheduler）

> **v2.0 补充（2026-09-22）**：原设计中「协调面生成 Manifest 并调度」已修正为「协调层仅做数据中继，Scheduler 完全自治调度」。核心原则不变，执行主体从协调层下沉到 Scheduler。参见 DEC-012、DEC-013。

---

### DEC-002：采集器架构 — Job + Agent 分离 + OTel Collector 数据管道

**背景**：原始 v0.2 设计中 Collector 是全功能组件（调度+采集+数据输出）。经过多轮讨论，决定拆分为三个独立组件。

**候选方案**：

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：vmagent 单体 | 使用 Prometheus vmagent 作为采集器 | 生态兼容；简单 | 无法支持多类型 Agent；调度能力弱 |
| B：全功能 Collector | v0.2 原设计，Collector 承担所有职责 | 组件少；部署简单 | 职责耦合；扩缩不灵活 |
| **C：Job + Agent + OTel** | Job Scheduler 调度 + Agent 采集 + OTel Collector 数据管道 | 职责清晰；独立扩缩；OTel 生态 | 组件多；部署复杂 |

**最终选择**：方案 C。

**理由**：
- Job + Agent 分离使得调度逻辑和采集逻辑可以独立演进
- OTel Collector 作为统一数据管道，天然支持多输出路由、标签注入、缓冲重试
- OTel 生态丰富，后续扩展日志采集等能力无需重新设计

**影响模块**：D1（Job Scheduler），D2（Agent），D3（OTel Collector）

---

### DEC-003：时序存储 — VictoriaMetrics 全链路统一

**背景**：时序库选型影响整个技术栈。需要在 Prometheus TSDB 和 VictoriaMetrics 之间选择。

**候选方案**：

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：Prometheus TSDB | 原生 Prometheus 存储 | 生态标准 | 单点性能瓶颈；集群方案复杂 |
| **B：VictoriaMetrics** | 高性能时序数据库 | 单节点性能优异；集群模式成熟；兼容 PromQL；remote-write 兼容 | 社区相对小 |
| C：混合 | 中心用 VM，区内用 Prometheus | 各取所长 | 两套技术栈；运维复杂 |

**最终选择**：方案 B。

**理由**：
- VM 单节点性能远超 Prometheus TSDB，适合区内场景
- VM 集群模式（mode C）天然支持水平扩展
- 完全兼容 PromQL，Grafana 无需额外适配
- remote-write 协议兼容，OTel Collector 可直接输出
- 全链路统一降低运维复杂度

**影响模块**：D6（Storage），C8（Query Gateway），D5（Zone Query Proxy）

---

### DEC-004：RC 与存储绑定

**背景**：RC（RuleCheck）规则检测引擎应该部署在哪里？是全区部署还是按条件部署？

**候选方案**：

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：全区部署 | 所有网区都部署 RC | 告警覆盖完整 | Mode A 无本地数据可查；浪费资源 |
| **B：存储绑定** | RC 仅部署在有本地存储的网区（mode B/C） | RC 从本地存储取数，低延迟；不浪费 | Mode A 无规则告警 |
| C：中心集中 | RC 全部部署在中心 | 集中管理 | 中心负载大；跨区取数延迟高 |

**最终选择**：方案 B。

**理由**：
- RC 的核心行为是「从本地存储取数 → 评估规则 → 产生告警」
- Mode A 无本地存储，RC 无从取数
- 存储绑定使得 RC 的数据路径最短，不依赖跨区网络
- Mode A 的告警覆盖可通过中心「虚拟 RC」补充（见 DEC-004a）

**子决策 DEC-004a**：Mode A 告警补充方案
- [建议] 中心部署「虚拟 RC」，专门评估 mode A 网区的规则
- 虚拟 RC 从中心 VM 取数（mode A 数据通过 remote-write 到达中心）
- 阶段 1 可不做（接受 mode A 告警盲区），阶段 3 评估

**影响模块**：D4（RC），C4（Alert Management）

---

### DEC-005：任务路由 / 读取路由 / RC 路由 三路分离

**背景**：原始设计中任务下发和查询路由混在一起。实际上三者有不同的决策逻辑。

**三路分离定义**：

| 路由类型 | 决策内容 | 决策者 | 输入 |
|---------|---------|--------|------|
| 任务路由 | 实例的采集任务应该下发到哪个 zone | 中心控制面 | 实例所在网区（IP 段映射） |
| 读取路由 | 查询某实例数据时应该从哪里取 | 查询网关 | 该 zone 的存储模式 + 数据可用性 |
| RC 路由 | 规则检测应该在哪个 zone 执行 | 中心控制面 | 该 zone 的存储模式（跟随写入目的地） |

**理由**：
- 任务路由由实例的网段归属决定（相对固定）
- 读取路由由存储模式和数据可用性决定（可能动态切换）
- RC 路由由存储位置决定（跟随数据写入目的地）
- 三者独立使得每一路可以独立优化

**影响模块**：C1（Zone Management），C8（Query Gateway），K2（RC Task Scheduling）

---

### ~~DEC-006：去除加权，采用均等 slot 分配~~ [已废弃]

> **废弃原因**：slot 模型整体废弃（见 DEC-014）。实例到节点的映射改用 Rendezvous Hashing，不再需要 slot 分配概念。

---

### DEC-009：存储模式范围

**候选方案**：

| 方案 | 描述 | 实现工作量 |
|------|------|-----------|
| A：三种全做 | Mode A + B + C 全部实现 | 大 |
| B：先 B 后扩展 | 阶段 1 只做 Mode B，阶段 3 扩展 A 和 C | 中 |
| C：只做 B | 永远只做 Mode B | 小 |

**当前倾向**：方案 B
**阻塞**：业务方确认各网区存储需求
**影响模块**：D6（Storage），D3（OTel Collector），D5（Zone Query Proxy）

---

### ~~DEC-010：scrape slot 和 probe slot 独立性~~ [已废弃]

> **废弃原因**：slot 模型整体废弃（见 DEC-014）。不同类型 Agent 的负载均衡通过 Rendezvous Hashing 中的能力约束自然实现。

---

### DEC-011：中心长期存储

**候选方案**：

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：做 | 中心 VM 长期保存所有数据 | 跨区分析；历史回溯 | 存储成本高 |
| B：不做 | 中心只保存近期数据（remote-write 的保留期） | 成本低 | 无历史数据 |

**当前倾向**：若无强跨区分析需求，先不做
**阻塞**：业务方确认是否需要跨区历史分析
**影响模块**：C8（Query Gateway），D6（Storage）

---

### DEC-012：协调层定位 — 纯数据中继，仅部署于核心网区

**背景**：早期设计考虑过每区部署协调层（K1-K5），后简化为仅核心网区部署，且角色从「决策者」进一步缩减为「数据中继」。

**候选方案**：

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：每区独立协调层 | 每个网区部署完整的协调层 | 各区完全自治 | 运维复杂；一致性难保证 |
| B：核心网区协调层 + 决策 | 仅核心网区部署，协调层参与调度决策 | 集中管控 | 协调层成为瓶颈和单点故障 |
| **C：核心网区协调层 + 纯中继** | 仅核心网区部署，仅做数据缓存和中继，不参与决策 | 无瓶颈；Scheduler 完全自治；简单 | 需要 Scheduler 具备完整决策能力 |

**最终选择**：方案 C。

**理由**：
- 协调层不参与调度决策，消除了瓶颈和单点故障
- 协调层使用 Redis 缓存控制面数据快照，供 Scheduler 查询
- 协调层不可用时，Scheduler 使用最后缓存的数据继续运行
- 大幅简化协调层实现——不需要 etcd/Coordinator 集群

**Redis 数据结构**：
```
# 实例数据（Hash 结构）
HSET instance:{id} target "host:9090" port 9090 scheme "https"
                     metrics_path "/metrics" scrape_interval "15s"
                     auth_type "bearer" credential "token123"
                     content_hash "abc123..." updatetime 1695000123

# 全量实例索引
SADD all_instances "{id1}" "{id2}" ...

# 时间线索引（用于增量同步）
ZADD instance_timeline {updatetime} "{id}"

# 根哈希（用于快速完整性校验）
SET root_hash "xyz789..."

# 快照版本
SET snapshot_version {timestamp}
```

**影响模块**：K1（协调层全局），D1（Job Scheduler）

---

### DEC-013：Scheduler 完全自治 — 本地决策，不依赖协调层

**背景**：原设计中 Scheduler 需要与 Coordinator 交互完成 slot 分配、epoch 签发等操作。简化后 Scheduler 完全自治。

**最终选择**：Scheduler 拥有完整的本地决策能力：

| 决策类型 | 原方案 | 新方案 |
|---------|--------|--------|
| 实例→节点映射 | Coordinator 分配 slot | Rendezvous Hashing（确定性算法） |
| 节点健康检测 | 协调层三源交叉验证 | Scheduler 本地检测 + Gossip 同步 |
| 重平衡 | Coordinator 驱动 | Scheduler 自主 + 3 层防抖 |
| 冲突解决 | 协调层仲裁 epoch fencing | Gossip 收敛自动解决 |
| 故障接管 | 多数派投票 + Coordinator 签发 | Rendezvous Hashing 自动重映射 |

**降级行为**：协调层不可用时，Scheduler 使用最后缓存的实例列表 + Gossip 同步的拓扑视图，完全独立运行。

**影响模块**：D1（Job Scheduler），K1（协调层）

---

### DEC-014：废弃 Slot 模型，改用 Rendezvous Hashing

**背景**：原设计使用 slot 模型（固定数量的槽位 + VRRP/epoch fencing 协商归属）。slot 模型引入大量复杂度：slot 总数恒定、分配策略、epoch fencing、所有权冲突解决等。

**候选方案**：

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：Slot 模型 | 固定 slot 数，节点协商归属 | 与 VRRP 天然配合 | 复杂度高；slot 总数变更代价大 |
| **B：Rendezvous Hashing** | 实例直接映射到节点，无需 slot | 简单；最小迁移；天然均衡 | 需所有节点运行相同算法 |
| C：一致性哈希 | 虚拟节点环 + 哈希分配 | 成熟方案 | 虚拟节点管理复杂；迁移量大于 Rendezvous |

**最终选择**：方案 B。

**算法**：
```
对于每个 instance_id，遍历所有在线节点 node_id：
  score = hash(instance_id + node_id)
将实例分配给 score 最高的节点
```

**性质**：
- **确定性**：相同拓扑视图 → 相同分配结果（无需通信达成共识）
- **最小迁移**：节点离开时，仅该节点的实例需要重新分配（其他节点不受影响）
- **天然均衡**：标准差约 3-5%，无需加权
- **非取模**：取模分布在节点数变化时约 90% 实例需重分配——不可接受

**影响模块**：D1（Job Scheduler），K1（协调层），全面取代原 slot 相关设计

---

### DEC-015：Gossip 协议替代 VRRP 心跳

**背景**：原设计使用 VRRP 风格的 Advertisement 进行节点间心跳。VRRP 设计偏向于主备选举场景，而实际需求是拓扑同步。

**候选方案**：

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：VRRP Advertisement | 3s 全连接广播 | 简单 | 偏向主备选举；扩展性差 |
| **B：Gossip 协议** | 随机 peer 间传播拓扑信息 | 最终一致性；网络容忍度高 | 收敛时间略长 |

**最终选择**：方案 B。

**Gossip 传播内容**：
- 仅传播拓扑信息（哪些节点在线/离线、健康状态）
- 不传播完整任务配置（配置通过协调层 Redis 获取）
- 所有 Scheduler 运行相同的确定性算法，相同拓扑视图 → 相同分配

**网络分区处理**：
- 各分区独立计算，允许跨分区重复采集
- Gossip 收敛后，重复采集自动消除
- 宁可重复采集也不丢数据（at-least-once 语义）

**影响模块**：D1（Job Scheduler）

---

### DEC-016：废弃 C7 凭据服务，凭据合并入实例记录

**背景**：原设计有独立的 C7 Credential Service，提供凭据加密存储、按需分发、轮换等功能。经评估，对于监控场景的凭据管理需求，独立服务的复杂度不值得。

**候选方案**：

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：独立 C7 服务 | 独立的凭据存储和分发服务 | 安全性最高；职责分离 | 运维复杂度高；多一条同步链 |
| **B：合并入实例记录** | 凭据作为实例记录的一部分，随实例数据同步 | 简单；少一个服务；少一条同步链 | 凭据扩散到更多组件 |
| C：运行时获取（Phase 2） | Manifest 仅含引用，Agent 按需获取 | 安全性较高 | 需要额外 API 调用 |

**最终选择**：方案 B。

**安全措施**：
- 传输全程 TLS 加密
- 存储端加密（Redis 持久化加密、Scheduler 本地存储加密）
- 凭据更新触发实例 updatetime 递增，通过正常同步链传播

**理由**：监控场景的凭据种类有限（bearer token、basic auth、SNMP community 等），更新频率低（通常数月一次），独立服务的运维成本远超其安全收益。

**影响模块**：C7（废弃），D1（Job Scheduler），D2（Agent），K1（协调层）

---

### DEC-017：健康检测合并入 Scheduler（K3 → D1）

**背景**：原设计在协调层有独立的组件健康模块（K3），负责三源交叉验证（主动探测 + 自报告 + 对等报告）。简化后，健康检测职责合并入 Scheduler。

**最终选择**：
- Scheduler 负责本地 Agent 的健康检测（主动探测 + Agent 自报告）
- Scheduler 通过 Gossip 同步其他节点的健康状态
- 健康状态上报至协调层（仅供全局可见性，不用于决策）
- 协调层不再做三源交叉验证

**理由**：
- 健康检测是调度的前置条件，合并减少通信开销
- Scheduler 最了解本地 Agent 的实际状态
- 消除协调层的健康模块，进一步简化协调层

**影响模块**：K3（废弃，合并入 D1），D1（Job Scheduler）

---

### DEC-018：双层版本对账机制

**背景**：需要一种高效机制来检测 Scheduler/Worker 持有的实例数据是否与协调层一致。

**最终选择**：双层版本对账：

```
外层：snapshot_version（协调层从控制面拉取快照的时间戳）
内层：每个实例的 content_hash + updatetime

对账流程：
1. Worker 上报所有 (instance_id, updatetime) 对的聚合哈希
2. Scheduler 对比自身视图的哈希
3. 哈希匹配 → 跳过（无需逐实例检查）
4. 哈希不匹配 → 逐实例比较 updatetime，仅更新变化的实例
```

**优化**：Scheduler 也可以先哈希自身视图与协调层比对，如果匹配则连逐实例比较都跳过。

**大规模优化**：实例数量极大时，可使用 Merkle Tree 分层对账，仅递归检查不一致的子树。

**数据同步模型**：
- 协调层 ↔ 控制面：增量查询（按 updatetime）+ 定期全量比对
- Scheduler ↔ Scheduler：Gossip 同步拓扑视图，最终一致性
- Scheduler ↔ Worker：增量（版本比较）+ 定期全量比对

**影响模块**：D1（Job Scheduler），K1（协调层）

---

### DEC-019：三层防抖机制（节点加入/离开）

**背景**：节点故障或恢复时，需要避免调度震荡。

**最终选择**：三层防抖：

| 层级 | 机制 | 参数 | 作用 |
|------|------|------|------|
| 第一层 | 稳定窗口 | 连续 3 次心跳超时（~9s）才判定节点下线 | 防止网络抖动误判 |
| 第二层 | 迁移速率限制 | 每个对账周期最多迁移总实例数的 10% | 防止大批量迁移 |
| 第三层 | 冷却期 | 迁移完成后等待 5 分钟才允许下次迁移 | 防止频繁迁移 |

**影响模块**：D1（Job Scheduler）

---

### DEC-020：实例双状态生命周期

**背景**：实例的「是否采集」需要区分管理层面和运行时层面。

**最终选择**：双状态模型：

| 状态维度 | 管理者 | 含义 | 存储位置 |
|---------|--------|------|---------|
| 管理状态（enabled/disabled） | 控制面 | 管理员手动启停 | 协调层 Redis |
| 本地状态（healthy/unhealthy） | Scheduler | 运行时健康检测 | Scheduler 本地 |

**采集判定**：
```
实际采集 = enabled（来自协调层）AND healthy（来自本地检测）
```

**场景**：
- 管理员禁用实例 → enabled=false → 所有节点停止采集
- 目标不可达 → healthy=false → 该节点停止采集，但其他节点可能仍在采集
- 节点故障 → 该节点的实例由 Rendezvous Hashing 重映射到其他节点

**影响模块**：C1（控制面），D1（Job Scheduler），K1（协调层）

---

### DEC-021：Scheduler 代理服务（防火墙简化）

**背景**：原设计中控制面需要直连每个 Agent（N×M 防火墙规则），大规模部署时防火墙规则管理困难。

**最终选择**：每个网区的 Scheduler 暴露一个代理端口：
- 控制面发送测试任务到 Scheduler 代理 → 转发到本地 Worker
- Worker 上报状态到 Scheduler → Scheduler 批量上报到控制面
- 防火墙规则从 N×M（控制面到每个 Agent）简化为 N×1（控制面到每个网区的 Scheduler）

```
原方案（N×M）：
  控制面 → Agent-1, Agent-2, ..., Agent-M  （每个网区 M 条规则）
  N 个网区 × M 个 Agent = N×M 条规则

新方案（N×1）：
  控制面 → Scheduler-Proxy（每个网区 1 条规则）
  N 个网区 × 1 = N 条规则
```

**影响模块**：D1（Job Scheduler），跨区通信全局

---

### DEC-022：存储-Worker 分离 — 存储作为独立层

**背景**：原设计中 Worker（Alloy）与存储存在隐式绑定——Mode A/B/C 决定了 Worker 的写入路径、RC 的部署位置、查询的路由。这种耦合导致存储模式变更牵动整个采集层。2026-09-23 决策将存储提升为独立的、可单独维护的一等公民。

**候选方案**：

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：维持绑定 | Worker 按存储模式（Mode A/B/C）决定行为 | 与旧设计兼容 | 存储变更牵动全局；Mode 概念复杂 |
| **B：存储独立** | 存储作为独立层，Worker 仅负责采集并 remote_write | 存储可独立演进；Worker 行为统一；简化 DC 节点 | 需要新的 Worker-Storage 绑定模型 |

**最终选择**：方案 B。

**理由**：
- Worker（Alloy）职责简化为「采集 + remote_write」，不再关心存储模式
- 存储层可独立管理生命周期（扩容、迁移、模式变更不影响 DC 节点）
- DC 节点行为统一——无论存储拓扑如何变化，Alloy 的写入目标由绑定配置决定
- Mode A/B/C 概念整体废弃，所有存储实例统一为 vmstorage

**废弃内容**：
- Mode A/B/C 存储模式分类 → 所有存储统一为 vmstorage 实例
- 中心 VM 概念 → 每个存储实例独立，无特殊「中心」角色
- Zone Query Proxy → 查询由 DC 网关通过 vmselect 聚合

**影响模块**：存储层全局，DC 采集层，查询网关，RC/vmalert

> **v2.0 补充（2026-09-23）**：此决策是 2026-09-23 架构重构的核心决策之一，导致 storage.md、zone-query-proxy.md、query-gateway.md、rc-rulecheck.md 四份设计文档的重大更新。

---

### DEC-023：Prime Storage — 多存储选择与主存储指定

**背景**：Worker 与存储解耦后，需要一种机制描述 Worker 与存储之间的关系。一个 Worker 可能关联多个存储（双写冗余、数据分流等场景），但告警规则等核心功能需要一个明确的「主存储」。

**候选方案**：

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：单一绑定 | 每个 Worker 只能关联一个存储 | 最简单 | 无法支持双写等场景 |
| **B：多选 + Prime** | Worker 可关联多个存储，必须指定一个为 prime | 灵活；支持双写；告警有明确归属 | 需要 prime 选举/配置机制 |
| C：全自动路由 | 系统自动决定数据写入哪个存储 | 用户无感 | 黑盒；不可控 |

**最终选择**：方案 B。

**规则**：
- 安装 Worker 时选择关联存储（支持多选）
- 必须指定一个存储为 **prime**（默认主存储）
- 告警规则分发到 prime 存储的 vmalert
- 非 prime 存储的用途视具体情况（双写冗余、数据分流等）

**理由**：
- 多存储关联保留了灵活性（双写、灾备等场景）
- Prime 概念为告警规则分发提供了明确的归属点
- 安装时配置，运行时不变——避免动态路由的复杂度

**影响模块**：存储层，Worker 安装，告警规则分发

---

### DEC-024：DC 侧 Proxy 废弃 + 控制面 Proxy 升级为 DC 网关

**背景**：原设计中 DC 侧有 Proxy 组件作为中间层。存储独立化后，Alloy 可以直接 remote_write 到存储，DC 侧 Proxy 成为不必要的跳转。同时，控制面 Proxy 从单纯的查询网关升级为 DC 网关（DC Gateway），承担目标分发、配置分发、通信、查询、健康检测等全部管控职责。

**候选方案**：

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：保留 DC Proxy | DC 侧 Proxy 作为写入中间层 | 写入路径可控 | 多一跳；DC 节点多一个进程 |
| **B：废弃 DC Proxy** | Alloy 直接 remote_write 到存储 | DC 进程数减少；路径最短 | 需要 Alloy 配置管理写入目标 |
| C：控制面 Proxy 仅做查询 | 控制面 Proxy 只做查询聚合 | 职责简单 | 管理功能分散在多个组件 |
| **D：控制面 Proxy 升级为 DC 网关** | 承担目标分发 + 配置分发 + 通信 + 查询 + 健康检测 | 单一管控点；DC 侧零额外进程 | DC 网关负载集中 |

**最终选择**：方案 B + D。

**DC 网关五大职责**：
1. **目标分发**：查询 PostgreSQL，生成 target 列表，供 Alloy 通过 http_sd 拉取（合并原 Target Syncer 功能）
2. **配置分发**：向 Alloy、vmalert、Alertmanager 等分布式组件推送配置
3. **组件通信**：控制面与所有 DC/存储侧组件的双向通信枢纽
4. **查询聚合**：vmselect 扇出到所有 vmstorage 实例，原生合并/去重
5. **健康检测**：跨区组件状态智能探测

**DC 节点进程变化**：
- 废弃前：3+（Alloy + Target Syncer + Proxy）
- v3.0：2（Alloy + Target Syncer）
- v3.1（当前）：1（仅 Alloy）

**理由**：
- DC 侧 Proxy 在存储独立化后失去存在意义
- Target Syncer 功能上收到控制面侧后，DC 侧不再需要任何管理进程
- DC 网关是控制面对 DC 的唯一出口，所有管控功能集中于此
- DC 侧只保留 Alloy 一个进程，运维极简

**影响模块**：DC 采集层，DC 网关，跨区通信全局

> **v3.1 补充（2026-09-23）**：原 Target Syncer（DC 侧轻量 sidecar，负责 PG → file_sd）功能并入 DC 网关，改为 http_sd 模式。DC 侧进程从 2 降至 1。控制面 Proxy 正式更名为「DC 网关」。参见 DEC-027。

---

### DEC-025：vmselect 查询聚合 — 全量扇出模式（方案A）

**背景**：存储独立化后，数据分布在多个 vmstorage 实例中。查询聚合需要一个统一的入口。vmselect 天然支持挂载多个后端存储并扇出查询。

**候选方案**：

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| **A：vmselect 全量扇出** | vmselect 挂载所有 vmstorage，每次查询扇出到所有后端 | 简单；原生支持；无需智能路由 | 大规模时可能有性能开销 |
| B：智能路由 | 根据 zone 标签选择性查询特定存储 | 减少不必要查询 | vmselect 原生不支持；需定制开发 |
| C：Query Gateway 自建聚合 | 自建扇出+合并逻辑 | 完全可控 | 重复造轮子；维护成本高 |

**最终选择**：方案 A。

**理由**：
- vmselect 原生支持挂载多个 vmstorage 后端，fan-out + merge + dedup 是内置能力
- 当前数据规模（万级实例，约 10+ 网区）下，全量扇出的开销可接受
- vmselect 不支持智能路由——它总是查询所有后端，但这在当前规模下不是问题
- 智能路由（基于 zone 标签的选择性查询）作为未来优化方向保留
- 双写去重由 vmselect `-dedup` + `-replicationFactor` 原生处理

**查询路径**：
```
Query Gateway → DC 网关 (vmselect) → 扇出到所有 vmstorage → 合并 + 去重 → 返回
```

**数据模型含义**：
- 按 zone 查询 → 通过 vmselect 路由到关联的 prime 存储
- 跨 zone 查询 → vmselect 扇出，聚合结果
- 无 zone 标识标签 → 全局扇出到所有存储

**影响模块**：DC 网关，查询网关，存储层

---

### DEC-026：vmalert 恢复为独立组件 — 存储侧共部署

**背景**：vmalert 的部署位置经历了多次变更：最初在 DC 侧（DEC-004，RC 与存储绑定），2026-09-22 曾合并入 Alloy 内置告警，2026-09-23 重新评估后恢复为独立组件，部署在存储侧。

**候选方案**：

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：DC 侧 RC（原 DEC-004） | vmalert 部署在 DC 节点，查询本地存储 | 低延迟 | DC 进程多；peer 组复杂 |
| B：Alloy 内置告警（2026-09-22） | 利用 Alloy 内置 alerting 组件 | 无额外进程 | 告警评估与采集耦合；全局视图受限 |
| **C：存储侧独立 vmalert** | vmalert 与存储共部署，查询 vmselect | 关注点分离；全局指标可见性 | 额外进程（在存储侧） |

**最终选择**：方案 C。

**告警链路**：
```
Alloy → remote_write → vmstorage
                          ↓
                       vmselect (扇出聚合)
                          ↓
                       vmalert (评估告警规则)
                          ↓
                       Alertmanager (去重/分组/静默/抑制)
                          ↓
                       消息队列 → 平台
```

**部署模型**：
- 每个存储实例与 vmalert + Alertmanager 共部署（存储 + vmalert + AM 为一个单元）
- vmalert 查询 vmselect（而非直连 vmstorage），获得全局指标可见性
- 告警规则分发到 prime 存储的 vmalert

**不变的部分**：
- Alertmanager 作为策略执行引擎（分组、去重、静默、抑制）
- 控制面作为 AM 策略配置面
- 平台负责告警运维操作（认领、通知、关闭 + AM 回写）
- 基于 fingerprint 的去重
- 告警生命周期端点：Alertmanager → 消息队列 → 平台

**理由**：
- vmalert 作为独立组件提供更好的关注点分离——告警评估属于存储层，不属于采集节点
- vmselect 为 vmalert 提供统一的查询入口，跨所有 zone 的全局指标可见性
- 存储 + vmalert + AM 共部署，简化部署和运维

**影响模块**：vmalert/RC，存储层，告警链路全局

---

### DEC-027：DC 网关（DC Gateway）— Target Syncer 并入 + 重命名

**背景**：v3.0 中 DC 侧保留 Alloy + Target Syncer 两个进程。Target Syncer 作为轻量 sidecar，负责查询 PostgreSQL 并生成 file_sd 格式的 target JSON 文件供 Alloy 消费。经评估，该功能可以上收到控制面 Proxy 侧，通过 http_sd 替代 file_sd，使 DC 侧仅保留 Alloy 一个进程。

**候选方案**：

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：保留 DC 侧 Target Syncer | sidecar 查询 PG → 生成 file_sd JSON | DC 自治；离线可用 | DC 多一个进程；PG 连接扩散 |
| **B：并入控制面 Proxy + http_sd** | Proxy 查询 PG → 暴露 http_sd 接口 → Alloy 拉取 | DC 仅 Alloy 一个进程；集中管理；PG 连接集中 | 依赖控制面网络 |
| C：Push 模式 | Proxy 主动推送 target 变更到 Alloy | 实时性好 | Alloy 需实现接收端；复杂度高 |

**最终选择**：方案 B。

**工作机制**：
```
PostgreSQL (实例数据)
    │
    │ 查询（增量 + 定期全量校验）
    ▼
DC 网关 (控制面侧，每区一个实例)
    │
    │ HTTP 接口 (http_sd 格式)
    ▼
Alloy (http_sd → prometheus.scrape)
    │
    │ clustering 自动分配 targets 到集群节点
    ▼
采集执行
```

**DC 网关目标分发职责**：
- 定期查询 PostgreSQL 获取实例列表（增量查询 + 定期全量校验）
- 暴露 HTTP 接口，返回 Prometheus http_sd 格式的 target JSON
- 包含凭据信息（bearer token、basic auth 等）
- Alloy 集群中每个节点独立拉取同一接口，clustering 自动分配

**降级行为**：
- DC 网关本地缓存最后一次查询结果（内存或本地文件）
- PG 不可达时使用本地缓存继续提供目标列表
- 恢复后自动追赶

**理由**：
- DC 侧只保留 Alloy 一个进程，运维极简
- http_sd 是 Prometheus 原生机制，稳定可靠，无需修改 Alloy 源码
- 目标分发逻辑集中在 DC 网关，PG 连接集中在控制面侧
- 凭据随 target 响应分发，延续 DEC-016 思路
- 与 DEC-022（存储独立化）、DEC-024（DC Proxy 废弃）一脉相承

**影响模块**：DC 采集层，DC 网关，目标发现机制

> **v3.1 新增（2026-09-23）**：此决策使 DC 侧进程从 2（Alloy + Target Syncer）降至 1（仅 Alloy）。Target Syncer 作为独立 DC 组件正式废弃。

### DEC-007：跨区连通模型

**候选方案**：

| 方案 | 描述 | 适用场景 |
|------|------|---------|
| M1 | 直接 HTTP：控制面直连每个 Job Scheduler | 1 节点区/测试 |
| M2 | Zone Agent 代理：控制面 → Zone Agent → 区内 | 推荐 |
| M3 | 长连接 push：Zone Agent 与控制面长连接 | 实时变更需求 |
| M2+M3 | 混合：M2 自检 + M3 push | 推荐（详见 manifest-protocol.md） |

**当前倾向**：M2+M3 混合
**阻塞**：安全评审、网络架构确认
**影响模块**：跨区通信全局

> **v2.0 补充**：DEC-021 的 Scheduler 代理服务进一步简化了跨区连通需求，控制面只需连接每个网区的 Scheduler 代理端口。

---

### DEC-009：存储模式范围

（内容同上方已确认的 DEC-009，此处保留待确认状态）

---

### DEC-011：中心长期存储

（内容同上方已确认的 DEC-011，此处保留待确认状态）

---

## 三、已废弃决策

| 决策 ID | 原始内容 | 废弃原因 | 替代方案 |
|---------|---------|---------|---------|
| DEC-002 | Job+Agent+OTel 三分离 | Alloy 统一替代所有 DC 采集组件 | DEC-022 + Alloy 统一化 |
| DEC-003 | VM 全链路统一（Mode A/B/C） | Mode A/B/C 概念废弃，存储独立化 | DEC-022 存储-Worker 分离 |
| DEC-004 | RC 与存储绑定（DC 侧部署） | vmalert 移至存储侧共部署 | DEC-026 存储侧独立 vmalert |
| DEC-005 | 三路路由分离（RC 路由部分） | RC 路由不再存在，vmalert 在存储侧 | DEC-026 |
| DEC-006 | 均等 slot 分配 | Slot 模型整体废弃 | DEC-014 Rendezvous Hashing |
| DEC-008 | 凭据安全模型三阶段 | C7 服务废弃，凭据合并入实例记录 | DEC-016 |
| DEC-009 | 存储模式范围（Mode A/B/C） | Mode 概念整体废弃 | DEC-022 存储独立化 |
| DEC-010 | scrape/probe slot 独立池 | Slot 模型整体废弃 | DEC-014 Rendezvous Hashing |
| DEC-012 | 协调层纯数据中继（Redis） | Redis 废弃 + DC Proxy 废弃 | DEC-024 DC 网关 |
| DEC-013 | Scheduler 完全自治 | Scheduler 整体废弃，Alloy clustering 替代 | Alloy 统一化 |
| DEC-014 | Rendezvous Hashing 替代 Slot | Alloy clustering（gossip + consistent hashing）替代 | Alloy 统一化 |
| DEC-015 | Gossip 替代 VRRP | 合并入 Alloy clustering | Alloy 统一化 |
| DEC-017 | 健康检测合并入 Scheduler | Scheduler 废弃 | Alloy 统一化 |
| DEC-018 | 双层版本对账 | Scheduler 废弃，对账机制简化 | Alloy 统一化 |
| DEC-019 | 三层防抖机制 | Scheduler 废弃 | Alloy 统一化 |
| DEC-020 | 实例双状态生命周期 | Scheduler 废弃，状态管理简化 | Alloy 统一化 |
| DEC-021 | Scheduler 代理服务 | Scheduler 废弃 + DC Proxy 废弃 | DEC-024 |
| Target Syncer（DC 侧 sidecar） | PG → file_sd 目标同步 | 功能并入 DC 网关，改用 http_sd | DEC-027 |

---

## 四、冲突记录

### ~~CONFLICT-001：模式 A 与 v0.2 核心假设冲突~~ [已解决]

**描述**：v0.2 几乎所有设计都假设区内有本地 TSDB。Mode A 无本地 TSDB，这些设计全部失效。

**解决方式**：Mode A/B/C 概念整体废弃（DEC-022）。存储独立化后不再有模式区分，所有存储统一为 vmstorage 实例。

---

### ~~CONFLICT-002：加权 vs 均等分配的历史遗留~~ [已解决]

**解决方式**：Slot 模型废弃（DEC-014），加权/均等分配的问题不再存在。Rendezvous Hashing 天然均衡，无需显式加权。

---

### ~~CONFLICT-003：v0.2 全区广播与凭据安全的矛盾~~ [已解决]

**解决方式**：凭据合并入实例记录（DEC-016），随实例数据同步链传播，不再需要独立的凭据分发通道。传输安全由 TLS 保证。

---

### ~~CONFLICT-004：L3 自治与「中心为唯一权威」的张力~~ [已解决]

**描述**：L3 期间 Scheduler 集群可能做出与中心期望态矛盾的归属决定。

**解决方式**：Scheduler 废弃，Alloy clustering（gossip + consistent hashing）替代。Alloy 集群的确定性哈希分配消除了归属冲突。[已解决]

---

### ~~CONFLICT-005：Mode A 告警覆盖缺失~~ [已解决]

**描述**：RC 与存储绑定后，mode A 网区无本地 RC，无法产生规则告警。

**解决方式**：存储独立化（DEC-022）+ vmalert 存储侧共部署（DEC-026）后，告警规则分发到 prime 存储的 vmalert，vmalert 通过 vmselect 获得全局指标可见性。Mode A 的「无本地 RC」问题不再存在——所有存储实例统一为 vmstorage，vmalert 查询 vmselect 扇出到所有后端。

---

### ~~CONFLICT-006：slot 总数恒定性 vs 业务增长~~ [已解决]

**解决方式**：Slot 模型废弃（DEC-014），不再有 slot 总数概念。实例数量增长不影响分配算法，Rendezvous Hashing 天然适应任意数量的实例。

---

### CONFLICT-007：vmalert 部署位置的反复变更

**描述**：vmalert 的部署位置经历了三次变更：DC 侧（DEC-004）→ Alloy 内置（2026-09-22）→ 存储侧独立（DEC-026，2026-09-23）。

**处理**：DEC-026 为最终方案。存储侧共部署使 vmalert 通过 vmselect 获得全局可见性，同时保持与采集层的关注点分离。[已稳定]

---

## 五、决策变更历史

| 日期 | 决策 ID | 变更内容 | 原因 |
|------|---------|---------|------|
| 2026-09-21 | DEC-001 | 新建：定义/调度分离 | 用户确认 P1 原则 |
| 2026-09-21 | DEC-002 | 新建：Job+Agent+OTel 三分离 | 用户确认架构决策 |
| 2026-09-21 | DEC-003 | 新建：VM 全链路统一 | 用户确认 VM 优先 |
| 2026-09-21 | DEC-004 | 新建：RC 与存储绑定 | 用户确认 RC 跟随存储 |
| 2026-09-21 | DEC-005 | 新建：三路路由分离 | 架构决策 |
| 2026-09-21 | DEC-006 | 新建：去除加权 | 用户确认阶段 1 均等分配 |
| 2026-09-22 | DEC-001 | 更新：协调面调度 → Scheduler 自治 | 协调层角色简化 |
| 2026-09-22 | DEC-006 | 废弃：Slot 模型整体废弃 | DEC-014 替代 |
| 2026-09-22 | DEC-008 | 废弃：C7 凭据服务废弃 | DEC-016 替代 |
| 2026-09-22 | DEC-010 | 废弃：Slot 独立池废弃 | DEC-014 替代 |
| 2026-09-22 | DEC-012 | 新建：协调层纯数据中继 | 架构简化 |
| 2026-09-22 | DEC-013 | 新建：Scheduler 完全自治 | 消除协调层决策瓶颈 |
| 2026-09-22 | DEC-014 | 新建：Rendezvous Hashing 替代 Slot | 降低复杂度 |
| 2026-09-22 | DEC-015 | 新建：Gossip 替代 VRRP | 更适合拓扑同步 |
| 2026-09-22 | DEC-016 | 新建：凭据合并入实例记录 | 简化架构 |
| 2026-09-22 | DEC-017 | 新建：健康检测合并入 Scheduler | 简化协调层 |
| 2026-09-22 | DEC-018 | 新建：双层版本对账 | 高效变更检测 |
| 2026-09-22 | DEC-019 | 新建：三层防抖机制 | 防止调度震荡 |
| 2026-09-22 | DEC-020 | 新建：实例双状态生命周期 | 区分管理与运行时状态 |
| 2026-09-22 | DEC-021 | 新建：Scheduler 代理服务 | 防火墙规则简化 |
| 2026-09-22 | CONFLICT-002 | 已解决 | Slot 模型废弃 |
| 2026-09-22 | CONFLICT-003 | 已解决 | 凭据合并入实例记录 |
| 2026-09-22 | CONFLICT-004 | 简化解决 | Rendezvous Hashing 确定性保证 |
| 2026-09-23 | CONFLICT-004 | 已解决 | Alloy clustering 替代 Scheduler |
| 2026-09-22 | CONFLICT-006 | 已解决 | Slot 模型废弃 |
| 2026-09-23 | DEC-002 | 废弃 | Alloy 统一替代 DC 采集组件 |
| 2026-09-23 | DEC-003 | 废弃 | Mode A/B/C 概念废弃，存储独立化 |
| 2026-09-23 | DEC-004 | 废弃 | vmalert 移至存储侧共部署 |
| 2026-09-23 | DEC-005 | 部分废弃 | RC 路由不再存在，任务/读取路由仍有效 |
| 2026-09-23 | DEC-009 | 废弃 | Mode 概念整体废弃 |
| 2026-09-23 | DEC-012 | 废弃 | Redis + DC Proxy 废弃，DC 网关 |
| 2026-09-23 | DEC-013 | 废弃 | Scheduler 废弃，Alloy clustering 替代 |
| 2026-09-23 | DEC-014 | 废弃 | Alloy clustering 替代 |
| 2026-09-23 | DEC-015 | 废弃 | 合并入 Alloy clustering |
| 2026-09-23 | DEC-017 | 废弃 | Scheduler 废弃 |
| 2026-09-23 | DEC-018 | 废弃 | Scheduler 废弃，对账简化 |
| 2026-09-23 | DEC-019 | 废弃 | Scheduler 废弃 |
| 2026-09-23 | DEC-020 | 废弃 | Scheduler 废弃 |
| 2026-09-23 | DEC-021 | 废弃 | Scheduler + DC Proxy 废弃 |
| 2026-09-23 | DEC-022 | 新建：存储-Worker 分离 | 存储作为独立层，Mode A/B/C 废弃 |
| 2026-09-23 | DEC-023 | 新建：Prime Storage 概念 | 多存储选择 + 主存储指定 |
| 2026-09-23 | DEC-024 | 新建：DC Proxy 废弃 + DC 网关 | DC 网关（配置+通信+查询+健康+目标分发） |
| 2026-09-23 | DEC-025 | 新建：vmselect 查询聚合方案A | 全量扇出，智能路由延后 |
| 2026-09-23 | DEC-026 | 新建：vmalert 恢复为独立组件 | 存储侧共部署，查询 vmselect |
| 2026-09-23 | CONFLICT-001 | 已解决 | Mode A/B/C 概念废弃 |
| 2026-09-23 | CONFLICT-005 | 已解决 | vmalert 存储侧 + vmselect 全局可见性 |
| 2026-09-23 | CONFLICT-007 | 新建：vmalert 部署位置反复 | DEC-026 为最终方案 |
| 2026-09-23 | DEC-024 | 更新：控制面 Proxy → DC 网关 | 合并 Target Syncer，重命名 |
| 2026-09-23 | DEC-027 | 新建：DC 网关 + Target Syncer 并入 | DC 侧仅保留 Alloy，http_sd 替代 file_sd |
| 2026-09-23 | Target Syncer | 废弃（DC 侧 sidecar） | 功能并入 DC 网关 |
