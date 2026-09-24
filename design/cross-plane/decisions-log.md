# 设计决策日志

> 版本：v3.3 | 日期：2026-09-24
> 本文档记录所有设计决策，包括已确认的、待确认的、已废弃的、以及存在冲突的决策。
> 每条决策包含背景、候选方案、最终选择和理由。
>
> **v3.3 变更摘要（2026-09-24）**：告警链路补齐「通知 / 恢复 / 静默」三块设计。新增 DEC-034~DEC-037——通知策略（路由、重复通知、自动升级、分级、多渠道）全部落平台侧并新增 `notification_scheduler`；恢复语义五层化，明确「无数据即恢复」的危险性并以规则发布期强制看门狗声明补偿；静默分层为「告警屏蔽（Flink）/ 通知静默（平台）」，人工关闭三选一且复活为预期行为；Alertmanager 进一步收缩为**零用户配置**组件，Flink 算子链重排修正两处实质缺陷。修订 DEC-033（双向清理→单向、带外心跳扩展到整条存储侧链路）、DEC-029（引入 `dedup_key`）。闭环 MC-09 / MC-11 / MC-14 / MC-15，裁决 RC-05 / RC-08，新增 MC-16 / RC-09 / RC-10。
>
> **v3.2 变更摘要（2026-09-24）**：告警链路重构。新增 DEC-028~DEC-033——引入 Flink 收敛引擎承担跨域去重/收敛/逐级抑制/抖动抑制/屏蔽与全量事件账本，Alertmanager 从「策略执行引擎」降级为「存储域去重引擎」，AM 与平台之间引入单 Kafka 集群六 topic，拓扑数据由 CMDB 标签富化提供，不做降级旁路而以带外心跳补偿。部分修订 DEC-026（AM 职责）。闭环 MC-10（告警风暴），新增 MC-12~MC-15。
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
                       Alertmanager (~~去重/分组/静默/抑制~~ → v3.3: 仅去重 + resolved 检测，零用户配置)
                          ↓
                       消息队列 → 平台
```

**部署模型**：
- 每个存储实例与 vmalert + Alertmanager 共部署（存储 + vmalert + AM 为一个单元）
- vmalert 查询 vmselect（而非直连 vmstorage），获得全局指标可见性
- 告警规则分发到 prime 存储的 vmalert

**不变的部分**：
- ~~Alertmanager 作为策略执行引擎（分组、去重、静默、抑制）~~ → **v3.2 修订**：AM 降级为存储域去重引擎，仅保留 fingerprint 去重与 resolved 检测，见 DEC-028
- ~~控制面作为 AM 策略配置面~~ → **v3.2 修订**：控制面改为配置 Flink 收敛/抑制/屏蔽规则（`alert.rule` topic），AM 侧仅剩去重参数
- 平台负责告警运维操作（认领、通知、关闭 + AM 回写）
- 基于 fingerprint 的去重
- ~~告警生命周期端点：Alertmanager → 消息队列 → 平台~~ → **v3.2 修订**：Alertmanager → am-bridge → Kafka → Flink → Kafka → 平台

**理由**：
- vmalert 作为独立组件提供更好的关注点分离——告警评估属于存储层，不属于采集节点
- vmselect 为 vmalert 提供统一的查询入口，跨所有 zone 的全局指标可见性
- 存储 + vmalert + AM 共部署，简化部署和运维

**影响模块**：vmalert/RC，存储层，告警链路全局

> **v3.2 修订（2026-09-24）**：本决策的部署模型（vmalert + AM 存储侧共部署、vmalert 查询 vmselect、规则分发到 prime 存储）**全部保持有效**。变更的只是 AM 的职责范围——从「策略执行引擎」降级为「存储域去重引擎」，分组/静默/抑制/路由分别下沉到 Flink 收敛引擎与平台。同时明确 **AM 之间不组集群**，跨域去重由 Flink 统一裁决。详见 DEC-028、DEC-029。
>
> **v3.3 修订（2026-09-24）**：部署模型仍不变，但两处进一步明确——① AM 收缩为**零用户配置**组件，config 由部署模板生成、变更走发布流程（DEC-037）；② 「规则分发到 prime 存储」由倾向性表述升格为**硬裁决**：多 DC 实例的规则包**仅**下发 prime，非 prime 存储不部署 vmalert（RC-05 闭环，`instance-management.md` §3.6.6 已同步修订）。

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

---

### DEC-028：告警链路重构 — Flink 收敛引擎 + AM 降级为去重引擎

**背景**：v3.1 的告警链路为 `vmalert → Alertmanager → 消息队列 → 平台`，AM 定位为「策略执行引擎」，承担分组、去重、静默、抑制、限流、路由全部职责。MC-10（告警风暴）长期未闭环——AM 的 inhibition 只能做标签匹配，无法表达「交换机故障 → 抑制其下挂全部实例告警」这类基于拓扑的因果关系，也没有地方记录「一条告警被哪条规则以何种方式处理」。

**候选方案**：

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：自研轻引擎 | Go/Java 服务 + Redis/PG 状态 | 运维成本最低；数据模型完全可控 | 无 exactly-once；无 CEP；拓扑关联需自管 join 状态 |
| B：复用夜莺类开源引擎 | 采用 n9e 告警事件处理层 | 内置聚合/抑制/屏蔽 + UI + 事件账本 | 规则模型仅标签匹配，无法表达拓扑 RCA；n9e 是平台而非库，UI/用户体系/订阅升级与本模块正面重叠 |
| **C：Flink 作业** | KeyedState + Timer + Broadcast + CEP | 拓扑 RCA 原生支持；规则 broadcast 热更新不重启；exactly-once；状态可溢盘无内存天花板 | 运维成本高（集群 + checkpoint 存储 + savepoint 流程）；收敛逻辑与规则 DSL 需自研 |

**最终选择**：方案 C。

**新链路**：
```
CMDB → 平台标签富化 → Alloy → vmstorage → vmselect → vmalert
                                                        ↓
                              Alertmanager（存储域内仅去重，零用户配置）
                                                        ↓ webhook (send_resolved=true)
                                                  am-bridge (+dedup_key)
                                                        ↓
                                    Kafka: alert.raw / alert.rule / alert.topo / alert.control
                                                        ↓
                                        Flink 收敛引擎（屏蔽→去重→收敛→逐级抑制→恢复延迟→轨迹）
                                          ↓ alert.event                    ↓ alert.converged
                                     账本落库 worker              平台告警管理（+notification_scheduler）
```

> **v3.3 修订**：算子链顺序已调整（DEC-037）——屏蔽前移到去重之前并改为纯 broadcast，抖动抑制升级为「恢复延迟 + 抖动锁定」并移到抑制之后。原文的「去重→屏蔽→…→抖动」顺序存在实质缺陷，见 DEC-037。

**AM 职责变更**：

| 原职责（DEC-026） | v3.2 归属 | v3.3 归属 |
|-------------------|-----------|-----------|
| fingerprint 去重 | **保留在 AM**（存储域内，时间维度） | 不变 |
| resolved 检测 | **保留在 AM**（`send_resolved: true`） | 不变；`resolve_timeout` 5m → **30m**（DEC-035） |
| 重发抑制（repeat_interval） | **保留在 AM** | 不变；语义明确为**下游状态续约心跳**，不触达人（DEC-034） |
| 告警分组通知 | → Flink 收敛算子 | 不变 |
| 屏蔽 (Silence) | → Flink 屏蔽算子 | 不变；**「关闭时回调 AM silence」的残留入口已删除**（DEC-037，闭环 CONFLICT-008） |
| 抑制 (Inhibition) | → Flink 逐级抑制算子 | 不变；新增抑制解除信号 `inhibit_released`（DEC-035） |
| 限流节流 | → Flink 收敛算子 | 拆分：事件量 → Flink 收敛；消息条数 → 平台 `notify_buffer_s`；投递速率 → 通知渠道限流 |
| 路由树与 receiver | → 平台通知渠道模块 | 明确：**路由定义与匹配在告警管理**，投递执行在通知渠道模块（DEC-034） |
| 告警状态权威源 | 拆分：收敛状态权威 = Flink；运维生命周期权威 = 平台 | 不变 |
| AM 配置面（UI 下发 + 热加载） | 保留（仅去重参数） | **删除**——AM 成为零用户配置组件，config 由部署模板生成（DEC-037） |

**新增组件**：am-bridge（无状态 webhook→Kafka 桥接，AM 原生无 Kafka sink；v3.3 起兼负 `dedup_key` 计算）、Flink 收敛引擎、账本落库 worker、`notification_scheduler`（v3.3，平台侧通知调度）。

**理由**：
- 拓扑关联 RCA 是 MC-10 的核心解法，只有真流处理引擎能以合理复杂度表达
- 动态规则通过 broadcast state 热更新，不重启作业，满足「规则可持续调优」的运营需求
- 全量事件账本 + 处理轨迹首次让降噪效果可量化（收敛率/抑制率/去重率按规则维度统计）
- keyed state 落 RocksDB 可溢盘，不受 AM 那样「全量活跃告警驻内存」的限制

**影响模块**：告警链路全局，Alertmanager，平台告警管理，通知渠道管理，新增 Flink 作业与 Kafka 集群

---

### DEC-029：去重分层 — AM 存储域内（时间维度）+ Flink 全局（空间维度）

**背景**：DEC-022 存储-Worker 分离后，Worker 可多写多个存储实例，每个存储共部署一套 vmalert + AM（DEC-026）。双写场景下同一批指标会被多个 vmalert 独立评估，产生 fingerprint 相同的重复告警，经不同 AM 到达平台。同时，AM 之间若不组集群则互相不可见，无法裁决跨域重复。

**候选方案**：

| 方案 | 覆盖范围 | 优点 | 缺点 |
|------|----------|------|------|
| 仅 AM 本域去重 | 同域重发 | 零新增逻辑 | 双写重复无人裁决；平台看到重复告警 |
| 仅 Flink 统一去重 | 同域重发 + 跨域重复 | 语义唯一 | vmalert 每评估周期重推全部 firing 告警，Flink 入口流量放大约 240 倍；需自行重实现 resolved 检测与重发抑制 |
| **分层去重（选定）** | AM 管时间 + Flink 管空间 | AM 削峰约两个数量级；Flink 是唯一全局裁决点；AM 之间零耦合 | 去重语义分两层，排查需看两处 |
| AM 中心化大集群 | 全局 | 单一去重点 | 见下方否决理由 |

**最终选择**：分层去重。AM 做存储域内时间维度去重（周期性重发抑制），Flink 做全局空间维度去重（跨存储/跨网区同 fingerprint 裁决）。

**量级论证**：5 万实例、5% 同时 firing（2500 条活跃）、vmalert 评估周期 1min——无 AM 去重时 Flink 入口约 2500 事件/分钟持续灌入；AM `repeat_interval=4h` 压至约 2500/4h。差约 240 倍。风暴场景下这个差距决定 Flink 能否存活。

**AM 中心化集群的否决理由**（本次评估的核心结论）：

| 问题 | 说明 |
|------|------|
| 集群语义误解 | AM gossip 集群同步 silences 与 notification log，**不同步告警本身**。全局去重要求每个 vmalert 向集群每个成员全量推送。推论：**LB + 多副本 ≠ 去重**——轮询到不同副本的同 fingerprint 告警互不可见 |
| 扩可用性不扩吞吐 | 每个成员处理全量告警（全复制），AM 无原生分片，风暴内存上限 = 单 AM 上限，加机器无解 |
| N×M 跨网区连接 | 每网区 vmalert 需连通中心集群每个成员 + gossip 端口，与 DEC-021「简化防火墙规则」方向相反 |
| 跨 WAN gossip 脆弱 | `peer_timeout` 默认 15s、gossip 间隔按局域网调参；跨网区抖动导致通知重复或丢失 |
| **违反核心设计目标** | `degradation-autonomy.md` 明确「中心不可用时各区仍能自治运行」。中心 AM 集群意味着中心故障或 WAN 分区时全网区去重与投递一起断——告警链路是降级时最不能失效的一条 |

**结论**：「平台侧统一去重」诉求正确，但正确执行组件是 Flink（天然全局汇聚、keyed state 可溢盘、无 N×M 连接、不破坏网区自治），不是 AM 集群。

**必须对齐的参数**：

| 参数 | 值 | 约束 |
|------|-----|------|
| AM `repeat_interval` | 4h | — |
| Flink fingerprint 状态 TTL | 24h | **必须显著大于 `repeat_interval`**，否则 AM 重发时 Flink 已遗忘该 fingerprint，老告警被当新告警放行 |
| AM `send_resolved` | true | resolved 必须穿透重发抑制，否则 Flink 状态无法回收 |

**跨域裁决规则**：first-wins，保留最先到达 `alert.raw` 的事件，其余标 `action=deduped`，轨迹记 `dedup_of` + `source_am` + `source_storage` + `source_zone_id`（排查双写不一致的唯一线索）。

> ✅ **v3.3 已闭环（原缺口，见 alert-management.md MC-09）**：原文指出 fingerprint = hash(alertname + 全部标签) 含 `zone`，导致**多 DC 实例规则下发到所有关联 DC**、**实例跨网区迁移期新旧网区同时评估**这两类最主要的跨域重复场景中，两条告警 fingerprint 不同、first-wins 无法识别为重复——最需要去重的场景恰好是去重失效的场景。
>
> **裁决**：引入 `dedup_key = hash(alertname + sorted(labels − 来源标识标签))` 专用于跨域裁决，排除列表为 `zone` / `zone_id` / `source_storage` / `source_am` / `dc`（列为系统保留标签）。`fingerprint` 保留用于 AM 域内去重与告警身份展示。`dedup_key` 由 **am-bridge** 计算注入，并作为 `alert.raw` 的 **Kafka partition key**（跨域副本必须落到同一分区，first-wins 才能在单 subtask 内裁决）。`alert.control` 消息体必须同时携带 `fingerprint` 与 `dedup_key`。
>
> RC-05 同步裁决为「**仅 prime 存储评估规则**」，消除多 DC 场景的主要重复来源；但 prime 迁移窗口仍无法完全消除，故 `dedup_key` 依然必要。`instance-management.md` §3.6.6 已修订。详见 DEC-037 与 `rc-rulecheck.md` DEC-RC-06。

**影响模块**：Alertmanager，Flink 收敛引擎，am-bridge，账本模型

---

### DEC-030：拓扑数据来源 — CMDB 标签富化，Flink 不做运行时 join

**背景**：逐级抑制（MC-10 解法）需要拓扑信息判断「谁是谁的父级」。平台现有数据模型（`instance-management.md`）只有 instance ↔ zone 映射与标签，无 host/switch/rack/cluster 层级。

**候选方案**：

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| **A：拓扑标签化（选定）** | CMDB → 平台富化 `instance.labels` → 采集下发注入 target labels → 标签随指标流转到告警 | RCA 退化为标签 keyBy + broadcast 查表；无 CDC、无 join 状态、无 lookup I/O | 拓扑标签进入 fingerprint；存在标签陈旧窗口 |
| B：Flink 运行时 join | 拓扑表经 CDC 进 Flink，与告警流 join | 拓扑实时 | 需维护拓扑流状态与一致性；CMDB 变更需实时传播；算子复杂度高一个量级 |

**最终选择**：方案 A。这是本次设计中收益最大的一次复杂度削减。

**同步链路**：
```
CMDB（拓扑原始真源）→ 平台同步 → instance.labels 富化
  → 采集配置下发注入 target labels（Alloy http_sd 返回的 target 携带拓扑标签）
  → 指标带标签写入 vmstorage → vmalert 评估继承标签 → AM 去重（fingerprint 含拓扑标签）
  → Flink 按标签 keyBy / broadcast 做 RCA
```

**拓扑标签集**：`host_id`、`rack_id`、`switch_id`、`cluster_id`（来源 CMDB）+ `zone`（网区继承，已有）。

**接受的代价**：

| 代价 | 处理 |
|------|------|
| 拓扑标签进入 fingerprint，CMDB 变更归属 → fingerprint 变更 → 在飞告警被当新告警 | 记录为已知行为；first-wins 去重不会因此错误合并 |
| 标签陈旧窗口（CMDB → 富化 → http_sd 刷新 → 新样本，约一个事件周期） | 窗口内按旧拓扑判定，可能漏抑制或误抑制。接受，见 `alert-management.md` AM-MC-12 |

**连带硬约束**：vmalert 规则**不得裁剪拓扑标签**（`labels` / `drop` 配置需校验），否则 Flink 无从 keyBy，RCA 静默失效。需在规则管理模块增加校验规则。

**影响模块**：实例管理（标签富化），CMDB 集成（新增），采集配置下发，vmalert 规则规范，Flink 抑制算子

---

### DEC-031：抑制时序 — 先放行后抑制，根因状态用 broadcast

**背景**：交换机故障时，下挂实例的 `InstanceDown` 通常在 T+0s 触发，而 `SwitchDown` 因规则 `for:` 更长在 T+3s 才触发。子告警到达时根因状态尚不存在，抑制无从判定。

**候选方案**：

| 方案 | 描述 | 否决/选定理由 |
|------|------|---------------|
| 统一滞留窗口 | 所有子告警延迟 Δ 再判定 | 否决：给全部告警增加延迟，critical 不可接受 |
| 选择性滞留 | 仅非 critical 且作用域有待决根因时滞留 | 否决：需预判「是否可能有根因」，逻辑复杂收益有限 |
| 回溯撤回 | 发更正事件折叠已放行告警 | 否决：已发通知无法真正撤回；已放行告警在当时信息下是正确决策，不应追认 |
| **先放行后抑制（选定）** | 根因到达前允许子告警放行；到达后逐级抑制后续事件 | 无额外延迟；无需撤回机制；风暴量由收敛算子拦截 |

**最终选择**：先放行后抑制。

**职责严格分离**：**收敛管「量」，抑制管「因果」**。根因到达前的首波风暴（如 3 秒内 200 条子告警）由 Stage 4 窗口收敛拦截（T 内 N 条 → 1 条代表事件），抑制算子拦不住也不该拦。

**根因状态用 broadcast state 而非 keyed state**：一条子告警需检查其全部祖先作用域（cluster/rack/switch/host/instance 共 5 级），keyed state 只能按单 key 查询，会导致「事件按作用域炸开再重聚合」的复杂度；活跃根因天然低基数（不会同时有一千个交换机故障），broadcast 到每个 subtask 全量持有可行。上限 10k 条，超限**自动降级为「仅收敛不抑制」**并告警（超限说明规则配错而非真实故障规模），见 `alert-management.md` AM-MC-14（v3.3 已闭环）。

**多级根因冲突**：rack 级与 switch 级根因同时活跃且互为祖先时，取作用域更高层作为 `inhibited_by`，轨迹记录全部命中以还原完整抑制链。

**平台侧关联**：根因激活时 Flink 向 `alert.converged` 发一条轻量 `scope_root_declared`（`{scope, root_event_id, rule_id, declared_at, expires_at}`），平台据此回填该作用域时间窗内已入库告警的 `root_event_id`，实现 UI 因果折叠。**Flink 不为每条子告警发更正事件。**

**辅助优化（建议非强制）**：拓扑层规则（`SwitchDown`/`HostDown`）的 `for:` 短于其下挂实例层规则，让根因尽量先到、缩小放行窗口。写入规则管理规范作为评审检查项。

**影响模块**：Flink 抑制算子，平台告警管理（根因回填），规则管理规范

---

### DEC-032：消息通道 — 单 Kafka 集群六 topic，账本前期 PG 后迁 ClickHouse

**背景**：原链路只写「消息队列」未指定实现。引入 Flink 后需要多条通道（原始事件、动态规则、拓扑、控制信号、事件账本、最终事件），且账本量级远高于运营数据，需要明确通道划分与落库存储。

**候选方案（通道）**：

| 方案 | 描述 | 评价 |
|------|------|------|
| **单 Kafka 六 topic（选定）** | 一个集群承载全部通道 | 组件最少；一套 offset/lag/故障域管理 |
| Kafka + 独立业务 MQ | Flink 输出写到公司标准 MQ | 两套 broker、两套 offset 管理、两处 lag 告警，解耦能力并不更强 |
| Flink 直连平台 API/DB | 去掉第二跳 | 平台故障会反压 Flink 作业；无缓冲，风暴直接击穿数据库 |

**Topic 契约**：

| topic | 生产者 | 消费者 | key | 类型 | 保留 |
|-------|--------|--------|-----|------|------|
| `alert.raw` | am-bridge | Flink | ~~fingerprint~~ → **`dedup_key`**（v3.3 修订） | 普通 | 7d |
| `alert.rule` | 控制面板 | Flink (broadcast) | rule_id | **compacted** | 永久 |
| `alert.topo` | CMDB 同步 | Flink (broadcast) | instance_id | **compacted** | 永久 |
| `alert.control` | 平台 | Flink | fingerprint（消息体须含 `dedup_key`） | 普通 | 7d |
| `alert.event` | Flink | 账本 worker | fingerprint | 普通 | 7d |
| `alert.converged` | Flink | 平台告警管理 | fingerprint | 普通 | 7d |

`alert.rule` / `alert.topo` 用 compacted topic，保证 Flink 重启可全量 bootstrap 规则与拓扑状态。`alert.event` 与 `alert.converged` **必须分开**：量级差 1~2 个数量级、消费者不同、故障域必须隔离，合并会让账本积压直接阻塞告警运营。

> **v3.3 修订（DEC-029 修订 / DEC-037 决策三）**：`alert.raw` 的 partition key 由 `fingerprint` 改为 **`dedup_key`**，由 am-bridge 计算注入。跨域重复的两条告警 fingerprint 不同（`zone` 标签不同）但 `dedup_key` 相同，只有落到同一分区，Flink stage 3 的 first-wins 才能在单 subtask 内完成裁决——否则两条副本在不同 subtask 上各自 first-wins，去重当场失效。`alert.control` 仍按 fingerprint 分区（平台只天然持有 fingerprint），但消息体必须同时携带 `dedup_key`，供 Flink 二次 keyBy 到主流分区。

**一致性**：Flink 事务性 sink + exactly-once；**所有消费端必须设 `isolation.level=read_committed`**，否则读到未提交事务消息。

**候选方案（账本存储）**：

| | 运营表 `alert_event` | 账本表 `alert_event_trace` |
|---|---|---|
| 内容 | 仅 `emit=true` 最终事件 | 全量事件 + 处理轨迹 |
| 量级 | 小（收敛后） | 大（高 1~2 个数量级） |
| 是否更新 | **是**（认领/通知/关闭反复 UPDATE） | **否**（append-only） |
| 主访问 | `alert_id` 高频点查 + 列表筛选 | 时间范围扫描 + 多维筛选 + 聚合分析 |
| **存储决策** | **PG，不换** | **PG 按天分区 → 阈值触发后迁 ClickHouse** |

**列式存储适用性结论**：对账本合适（append-only + 大范围扫描聚合是列式强项），对运营表不合适（列式 UPDATE 弱——ClickHouse mutation 是重写 part 而非行更新，而运营表核心就是状态流转）。两表访问模式相反，不可共用存储。

**迁移触发阈值**（写成可观测指标而非拍时间）：账本单分区 > 5000 万行 或 日增 > 500 万行；分析类查询 P95 > 3s；账本 worker 持续 lag。

**前期 PG 足够的理由**：告警量是尖峰型而非持续高吞吐——5 万实例正常日几百条，一次交换机故障瞬间几千条。

**架构保障**：账本 worker 是 `alert.event` 唯一消费者，换存储只是 worker 内部实现变更，Flink 与 topic 契约不动。Kafka 缓冲层同时把存储选型变成可延后的决定，并避免 Flink 直写击穿数据库。

**账本新鲜度约束**：已认领告警同样参与收敛抑制（DEC-033），运维下钻明细读的是账本表，因此账本 worker lag 直接表现为「详情页明细缺失」。需独立 lag 告警，目标 P95 < 10s（比运营链路更紧）。

**影响模块**：Kafka 集群（新增），Flink sink，账本 worker（新增），平台告警管理，数据库 schema

---

### DEC-033：无降级旁路 — Flink 硬单点 + 带外心跳补偿

**背景**：DEC-028 引入 Flink 后，告警链路多了一个单点：Flink 故障时 `alert.converged` 断流，运维收不到任何告警。

**候选方案**：

| 方案 | 描述 | 评价 |
|------|------|------|
| 降级旁路 | 平台持有 `alert.raw` consumer group，Flink 故障时直连消费 | **否决**：未去重、未收敛、未抑制的原始告警全量冲击通知渠道，等于在最糟的时刻制造最大的一波噪声风暴，比断流更危险 |
| **无旁路 + 补偿（选定）** | Flink HA + 带外心跳 + 链路水位监控 | 风险不可消除但可快速发现与恢复 |

**最终选择**：不做旁路，以补偿措施覆盖。

**补偿措施**：

| 措施 | 优先级 | 说明 |
|------|--------|------|
| **带外心跳监控** | **必须** | ~~Flink 每 10s 向独立于本链路的通道发心跳~~ → **v3.3 修订：覆盖整条存储侧链路**（Alloy / vmstorage / vmselect / vmalert / AM / am-bridge / Kafka / Flink），每 10s 发心跳；超时触发 critical「告警链路中断」，走**硬编码最小通知路径**（不经路由策略、不经 Flink、不经 Kafka）。链路自身不能监控自己 |
| Flink 作业 HA | 必须 | Standby JobManager + checkpoint 落可靠存储（S3/OSS/HDFS），自动 failover |
| 链路水位告警 | 必须 | `alert.raw` lag、checkpoint 时长与失败率、backpressure、broadcast 根因状态条数、收敛组成员数 |
| **伪恢复比例告警** | **必须** | **v3.3 新增**：`alert_resolved_by_reason_total{reason="data_missing"}` 占比突增 = 采集链路故障信号 |
| 账本 worker lag | 必须 | 独立告警，P95 < 10s。**v3.3 升级**：lag 还决定抑制解除补发的正确性，严重级别从「影响体验」上调为「影响告警完整性」 |
| AM 侧兜底信号 | 建议 | bridge/Kafka 不可达时 AM webhook 失败重试并暴露失败计数，作为第二信号源 |
| 恢复对账 | 必须 | `read_committed` 保证不重复投递；平台按 `event_id` 幂等入库；恢复期漏掉的告警由 AM `repeat_interval` 重发自然补回 |

**认领不放开降噪**（本决策的连带结论）：已认领告警**同样参与收敛与抑制**，`alert.control` 不承载 `claim` 信号，仅承载 `close`。理由：风暴量级不允许为单个认领动作放开降噪；处理人需要明细时通过账本下钻获取，账本保留了全量事件。

> **v3.3 补充**：「别催我」的诉求由平台侧**通知静默**（`alert_notify_mute`）满足，无需让 Flink 感知认领——事件照常产生入库、照常参与收敛计数，只是通知调度器跳过它。见 DEC-036。

**关闭的清理**：~~① 回调 AM API 建 silence（matchers = 告警标签 + TTL）阻止 vmalert 持续评估 + AM 重推——Flink 状态清了也拦不住重推，因为源头在 AM 之前；②~~ 发 `alert.control` 清除 keyed state、从收敛组摘除、若是根因则从 broadcast `activeRoots` 移除并侧输出 `inhibit_released`、账本回填 `state_cleared_at`。

> **v3.3 修订：双向清理 → 单向清理。** DEC-037 将 AM 收缩为零用户配置组件后，平台不再回调 AM silence API；AM 状态由 `resolve_timeout`(30m) 自清理，无需外部干预。原「①」已删除。
>
> **`alert.control` 必须携带 `dedup_key`**（v3.3，DEC-029 修订 / DEC-037 决策三连带）：引入 `dedup_key` 后主流在 stage 3 之后按 `dedup_key` 分区，而平台只天然持有 `fingerprint`。Flink **不能**为找 key 反查运营表（违反「不做重 I/O」），因此 control 消息体必须同时携带两者，由平台发送前从 `alert_event` 读出填入。缺失则清理静默失效。

**为什么必须走 control topic**：Flink keyed state 无法从外部直接删除——Queryable State 已废弃，State Processor API 仅支持离线批处理。向同一 keyed 流注入控制事件由算子内部 `state.clear()` 是唯一在线可行方式。

**残留风险**：

| 风险 | 处理 |
|------|------|
| keyed state 清理完整性无法外部校验 | 状态 TTL（24h）自然回收 + Flink 导出活跃计数指标 + 平台侧周期性比对，偏差超阈值告警；`alert_revived_after_close_total` 异常升高作为间接信号 |
| 带外心跳通道自身故障 | 必须与告警链路完全独立（不同集群、不同网络路径、不同通知渠道），并**定期主动触发演练**——该路径平时不走流量，不演练等同于不存在。见 `alert-management.md` AM-MC-13 |
| **vmalert / 存储侧故障 = 全量伪恢复** | **v3.3 新增，最高危**：vmalert 停止推送后 `resolve_timeout` 到期，AM 把其名下全部告警判定 resolved；vmstorage/vmselect/Alloy 故障导致表达式为空时效果相同。「告警全清」比「收不到新告警」危险一个量级——运维会误以为问题都好了。补偿见 DEC-035 |

**影响模块**：Flink 作业运维，平台告警管理，监控告警（元监控），AM 集成，RC/vmalert

---

### DEC-034：通知策略归属 — 全部平台侧，Flink 不参与通知决策

**背景**：DEC-028 把路由从 AM 移出后，需要确定重复通知、自动升级、告警分级、多渠道这四项能力放在 Flink 还是平台侧，以及如何维护。

**候选方案**：

| 方案 | 描述 | 评价 |
|------|------|------|
| A：放 Flink | keyed state + timer 实现重复通知与升级 | **否决**：① 升级依赖 `lifecycle_status`/`claimed_by` 等平台可变业务状态，DEC-033 已定 `claim` 不进流，搬进来等于让流状态成为平台操作表的镜像（同一事实两个权威源）；② 外部渠道 I/O 会拖住 checkpoint，反压收敛链路；③ 收敛规则月级变更 vs 路由周级变更，频率差一个数量级却绑在同一发布单元；④ 扩大 Flink 单点的爆炸半径 |
| **B：放平台（选定）** | 新增 `notification_scheduler`，PG 扫描 + `SKIP LOCKED` | 通知策略变更永不触碰 Flink；策略是 DB 行 + 内存缓存，秒级生效；调度器可水平扩展 |

**最终选择**：方案 B。

**量级不是反对理由**：到达平台的事件已被 Flink 收敛，通知调度器面对的是收敛后的量。若仍扛不住，正确的修法是提高收敛强度，不是把通知搬进 Flink。

**三级「重复通知」语义分离**（本决策的关键副产品）：三处都叫「重复」，语义完全不同，必须显式区分否则互相打架：

| 旋钮 | 位置 | 语义 | 值 | 是否触达人 |
|------|------|------|-----|-----------|
| AM `repeat_interval` | 存储域 AM | **下游状态续约心跳**，防止 Flink keyed state TTL 过期后把老告警当新告警 | 4h（TTL 24h，6 次续约） | **否**——被 Flink stage 3 吸收为 `renewed`，只写账本 |
| 投递幂等窗口（原 `dedup.window_seconds`） | 通知渠道模块 | 防止同一通知请求因重试而重复投递 | 300s | 是（去重） |
| `repeat_notify_s` | 告警管理 `alert_route` | **人工重复提醒**：未处理告警的周期性再提醒 | 14400s | 是 |

**续约吸收机制**：AM 每 4h 重发的持续 firing 告警，在 Flink stage 3 命中已有 `dedup_key` 状态时——读取状态以刷新 TTL（`StateTtlConfig` 必须用 `OnReadAndWrite`）、标记 `action='renewed'`、只写账本不写 `alert.converged`。这样平台永远只看到「新成立的事件」，`repeat_notify_s` 成为唯一的人工重复提醒权威。

**升级策略收敛到唯一权威**：v3.2 时升级配置散在三处，必然漂移：

| 原位置 | v3.3 处置 |
|--------|-----------|
| `alert_route.escalation_s`（单个秒数阈值） | **删除**，改为 `escalation_policy_id` 外键 |
| `escalation_policy.levels`（通知渠道模块，完整多级链） | **保留为唯一权威** |
| `notification_group.escalation_config`（组内嵌） | **删除** |

三处并存的后果是「改了路由阈值但升级链没改」，表现为升级时机与预期不符且极难排查——两处配置都「看起来是对的」。

**告警分级两层化**：`severity`（规则静态声明，事件生命周期内不变，用于路由过滤与规则匹配）/ `notify_level`（平台通知时刻派生 `f(severity, converged_count, escalation_level, 未处理时长)`，用于选择渠道强度，不落表）。L2 使「代表 500 条子事件的收敛组」自动比「代表 2 条」叫得更响，无需改规则。

**电话/短信由升级级别决定，不由 severity 直接决定**：`levels[n].channels` 含 `phone` 才打电话。critical 若要立即电话，把 level 1 配成 `delay=0, channels=[phone,sms]`。这把「问题多严重」与「叫人叫多响」解耦。

**receiver 归属**（闭环 notification-channel MC-12）：`alert_route.receiver_id → notification_group.group_id`。告警管理定「发给哪个组」，通知渠道模块定「组里有什么、怎么发」。

**维护模型的核心性质**：任何通知策略变更都不触碰 Flink。Flink 只从 `alert.rule` 看收敛/抑制/屏蔽规则，通知策略永不进流。

**静默失败的三道防线**：路由配错会静默吞掉告警且无任何报错（与 DEC-RC-05 同类）。防线为——默认路由不可删除且永远兜底、`notify_no_route_matched_total` 指标本身要告警、策略变更审计（actor + diff）。另建议 Phase 2 实现**通知策略回放**（用账本历史事件试算草稿策略），账本已免费存在，工具成本极低。

**值班排班不做**：`notification_group.members` 为静态列表。评估过外部 SaaS（需出网，隔离环境不可用）、Grafana OnCall 私有化（OSS 维护状态不确定，不宜作关键路径依赖）、自建最小值班表（可行但当前不需要）。选静态组不构成技术债锁定——成员解析抽象为 `resolve_members(group_id, at)`，将来只改这一个解析器。代价：跨时区静默期失去载体（MC-16）。

**影响模块**：平台告警管理，通知渠道管理，Flink 作业（无变更）

---

### DEC-035：告警恢复语义 — 五层责任 + 伪恢复治理

**背景**：v3.2 的链路只定义了 firing 路径，恢复路径仅有「AM 检测 resolved」一句。需要明确恢复信号如何产生、传递、裁决、落库，以及「无数据算不算恢复」。

**核心认知**：在 Prometheus/vmalert 语义下，**「恢复」不是独立信号，而是「本轮评估表达式结果为空」的推论**。表达式为空有两种原因——条件不再成立（真恢复），或样本消失（伪恢复）。vmalert 层面无法区分。后果：exporter 挂了、网络断了，`tablespace_usage > 85` 会**静默 resolved**，把正在处理的活告警清掉。

**恢复的五层责任**：

| 层 | 触发条件 | 是否权威 | 关键参数 |
|----|----------|----------|----------|
| L1 vmalert | 本轮评估表达式为空 | **权威源头** | `group_interval` |
| L2 AM 显式 | 收到 vmalert 推的 `status: resolved` | 透传 | receiver `send_resolved: true`（硬约束） |
| L3 AM 隐式 | `resolve_timeout` 内未收到更新 | **兜底，非主路径** | `resolve_timeout` 5m → **30m** |
| L4 Flink | 恢复延迟 + 抖动裁决 + 组级裁决 + 抑制解除 | **最终裁决** | `resolve_hold_s`、`grace_s` |
| L5 平台 | 人工关闭 / resolved→closed 流转 | 业务终态 | `auto_close_on_resolve`、`resolved_after_close_s` |

**L1 是「信号」，L4 才是「决定」。** 另需澄清一个常见误解：**Flink keyed state TTL 过期不是恢复**——TTL 过期只是状态回收，不产生 resolved 事件；若告警仍 firing 而 state 过期，下一条会被当作新告警重新准入导致重复通知，这正是 `repeat_interval(4h) < TTL(24h)` 约束存在的原因。

**伪恢复治理：不改恢复语义，改规则发布约束。** 评估过的路径：

| 方案 | 结论 |
|------|------|
| **A：接受默认语义 + 强制看门狗（选定）** | 可行 |
| B：Flink 区分 `resolved_because_empty` / `resolved_because_condition_false` | **不可行**——AM webhook 与 vmalert 都不携带该信息，除非改 vmalert |
| C：规则写成 `(expr) and on(instance) up == 1` | **无效**——`and` 在无数据时结果仍为空，照样 resolved |

方案 A 的落地形式复用 DEC-RC-05 的治理逻辑（把静默失败挡在发布环节而非运行环节）：控制面板创建/编辑规则时**强制回答「指标缺失时的期望行为」**，三选一，不填不允许发布——① 配套 `up == 0` 看门狗；② 配套 `absent(metric)` 看门狗；③ 显式声明「可容忍伪恢复」（留审计）。

**已有的逐级抑制使大规模伪恢复变得无害**：交换机故障 → 下挂实例指标消失 → 一批告警伪恢复 + 一批 `up == 0` firing → 交换机根因告警 firing → 逐级抑制压掉 `up == 0` 子告警。运维看到「1 条根因 + 一批恢复」，是正确结果。危险只存在于孤立单点缺失，而那正是 `up == 0` 覆盖的场景。

**`resolve_timeout` 由 5m 调大到 30m**：vmalert 每个评估周期向 AM 推送**全量当前 firing 集合**（`repeat_interval` 节流的是通知不是摄入），因此只要 vmalert 活着该参数永不触发。它只在 vmalert 停止推送时起作用——而那种情况下触发它是**错的**。调大零代价：真恢复走 L2 显式路径即时到达，该参数只影响 L3 隐式兜底。它挡住的是 vmalert 正常重启/滚动升级，挡不住彻底宕机（那靠带外心跳）。

**Flink 新增两项裁决**：

| 机制 | 内容 | 理由 |
|------|------|------|
| 恢复延迟 + 抖动锁定（stage 6） | resolved 不立即 emit，注册 `resolve_hold_s`(60s) timer；到期前收到 firing 则吞掉 resolved 并 `flapping_count++`；窗口内超 `flapping_threshold_n`(3) 次进入抖动锁定，直到稳定超 `flapping_window_s`(600s) 才解锁并 emit 真实状态 | v3.2 的抖动抑制是**事后**介入（抖了 N 次才聚合），改为**事前**延迟。抖动无法在规则层根治——`for:` 只延迟 firing 不延迟 resolved，迟滞阈值需拆两条规则 + recording rule 做状态保持，复杂度不值当。**显式代价：真恢复通知延迟 60s** |
| 收敛组组级恢复裁决（stage 4） | 只有组内**全部** fingerprint 都 resolved 才 emit 组级 resolved；keyed state 由 `ValueState<counter>` 改为 `MapState<fingerprint, status>` | 否决「换代表」（代表 `event_id` 跳变导致认领关系丢失）与「直接透传」（组内还有 300 条 firing 却告诉运维好了）。收敛组语义是「这一批是同一件事」，一件事只要还有一个子问题没好就没好 |

**抑制解除改为平台补发**：

| 方案 | 评价 |
|------|------|
| i：Flink 内 re-emit（broadcast 维护 `root_cause → Set<fingerprint>` 反向索引） | **否决**：要求被抑制事件在 keyed state 全量保留 → **抑制不减少 state 量，风暴期 RocksDB 照涨**；且 broadcast 侧无法按 fingerprint 直接 emit，需注回主流 union |
| **ii：平台侧补发（选定）** | Flink 只侧输出 `inhibit_released{scope, root_event_id, released_count}`；平台查账本 `inhibited_by = root_event_id AND status = firing` 补发。**Flink 无需为被抑制事件保留 keyed state，「抑制降低状态量」的收益才真正兑现**；查询走已建的 `idx_trace_root` |

方案 ii 的时序约束：账本 worker 有延迟，平台收到 `inhibit_released` 时账本可能未写完。处理——延迟 `trace_settle_s`(15s，须 > 账本 lag 的 **P99**)后查、用 `released_count` 校验条数、不足则重试（最多 3 次指数退避）、最终不足**记录差异并告警**（不可静默接受）。

**平台侧恢复处理**：`status → resolved` 写 `ends_at`；**不自动 closed**（resolved 是「指标恢复了」，closed 是「人确认处理完了」，且可能是伪恢复或临时缓解），由 `auto_close_on_resolve` 开关决定，默认 false；`resolved_after_close_s`(7d) 兜底归档；保留 `claimed_by`/`claimed_at` 供 MTTR 统计；resolved 是**主动清理触发点**（发 `alert.control` 清 Flink state + 摘除活跃根因），TTL 只是「从没收到 resolved」时的兜底。

**恢复通知策略**：沿用原路由的通知组；**渠道强度降级**（resolved 只发钉钉/企微/邮件，不发短信电话，即使原 severity=critical——问题已解决不需要叫人）；若 `escalation_level > 0` 则发给**该 alert_id 历史上所有被通知过的人**（总监被叫醒了应该告诉他问题好了），通过反查 `notification_record` 实现。

**`resolved_reason` 字段 v3.3 留出、Phase 2 回填**：事后给按天分区的账本表加字段代价高得多。推断方式为 resolved 入库时异步查一次 vmselect（该 instance 在 `[resolved_at-10m, resolved_at]` 是否有样本、`up` 值），映射为 `condition_cleared` / `data_missing` / `resolve_timeout` / `manual_close` / `silenced`。`data_missing` 时模板显式提示「可能为伪恢复」。

**参数排序不变式**（配置加载时校验，违反则拒绝启动）：

```
scrape_interval(15~60s) < vmalert group_interval(~1m) < Flink resolve_hold_s(60s)
  < AM resolve_timeout(30m) < AM repeat_interval(4h) < Flink state TTL(24h)
```

**影响模块**：RC/vmalert，AM 配置，Flink 作业，平台告警管理，通知渠道管理

---

### DEC-036：静默分层 — 告警屏蔽（Flink）与通知静默（平台）

**背景**：需要支持「告警未恢复时认领并静默，维持告警状态，收到恢复后按开关自动关闭或仅标记」，以及「未恢复时关闭事件，静默可选」。这两类诉求在 v3.2 中混为一谈（都叫 silence，都指向 AM）。

**决策：静默分两层，语义、载体、执行点完全不同。**

| 维度 | 告警屏蔽（降噪） | 通知静默（免打扰） |
|------|------------------|--------------------|
| 决定什么 | 事件**是否成立** | 事件已成立，**是否叫人** |
| 执行位置 | **Flink** stage 2 屏蔽算子 | **平台** `notification_scheduler` |
| 配置载体 | `converge_rule`（`rule_type=mute`） | `alert_notify_mute` |
| 下发路径 | `alert.rule` compacted topic → broadcast | **不下发**，平台内存缓存 |
| 判定依赖 | 标签 + 时间窗 | `lifecycle_status`、`escalation_level`、`claimed_by` |
| 是否进 `alert_event` | **否**——活跃列表看不到 | **是**——活跃列表可见 |
| 是否参与收敛计数 | 不参与（stage 2 就被拦） | **参与**（`converged_count` 照常增长） |
| 典型语义 | 「已知问题 / 维护窗口，别产生告警」 | 「我在处理，别再催我」 |

一句话：**告警屏蔽决定这条告警存不存在，通知静默决定这条告警吵不吵。** 通知静默对 Flink 完全透明。

**为什么通知静默不放 Flink**：其判定依赖认领状态等平台可变业务状态，DEC-033 已定 `claim` 不进流（理由同 DEC-034 方案 A 的否决）。

**人工关闭时三选一**：

| 选项 | 事件是否产生 | 是否进活跃列表 | 是否通知 |
|------|--------------|----------------|----------|
| ① 不静默 | 是 | 是 | **是**（下一窗口复活） |
| ② 关闭 + 屏蔽通知 | 是 | **是** | 否 |
| ③ 关闭 + 告警屏蔽 | 只入账本 | **否** | 否 |

**复活是预期行为，不是缺陷。** v3.2 把「关闭后告警复活」当作 bug 并用 AM silence 去防，方向错了——静默的作用不是防止复活，而是控制复活之后的行为。问题还在却不报警，比报警更危险。配套指标 `alert_revived_after_close_total`：占比过高说明规则阈值配得不合理（关不掉的问题不该靠关闭处理），是规则调优的输入信号。

**认领时的三个正交开关**：

| 开关 | 默认 | 语义 |
|------|------|------|
| `notify_muted` | false | 压制**催促类**通知（重复提醒、升级），**不压状态变更类**（resolved） |
| `auto_close_on_resolve` | false | 收到 resolved 是否自动关闭。默认 false——保守，不自动销毁人工上下文 |
| `notify_on_resolve` | true | 收到 resolved 是否发恢复通知 |

`notify_muted` 只压催促类，因此与 `notify_on_resolve` 不会互相打架——静默中的告警恢复时仍会发恢复通知。

**升级计时在静默期间暂停**：记 `remaining = next_escalation_at - now()`，置 `next_escalation_at = NULL`；解除时 `next_escalation_at = now() + remaining`。否则「静默 2 小时，一解除就立刻升到总监」。

**静默安全阀**：静默期间若 `converged_count` 相对静默时刻增长超 10 倍、或本告警所属收敛组被更高级作用域根因抑制 → **强制解除静默并通知一次**，记审计。理由：severity 变化会产生新 fingerprint（是新告警，自动不受原静默影响），但同一 fingerprint 下规模扩大 100 倍时，严格尊重静默就变成了盲区。**宁可偶尔打扰，不可让静默成为盲区。**

**两条硬约束防静默变成事故源**（与 DEC-RC-05 的静默失败治理同源）：

| 约束 | 理由 |
|------|------|
| `reason` 强制填写，不允许空 | 事后追责与交接都靠它 |
| `ends_at` 强制有上限（≤ 7d），不允许永久静默 | 「临时静默」三年后还在生效、没人记得为什么——监控系统的经典死法 |

配套：到期前 10m 若该 fingerprint 仍 firing 则提示「续期 / 解除 / 保持」，不允许静默到期后突然开始吵而无人知晓。

**UI 硬要求**：关闭对话框必须原文写出②与③的区别——「②在告警列表里还看得见（只是不吵），③在告警列表里完全看不见（只能去账本查）」。否则用户必然选错。

**代价核算**：选项③中被屏蔽的告警仍走完 vmalert → AM → am-bridge → Kafka → Flink 才被拦下。但 AM 对持续 firing 告警每 `repeat_interval=4h` 才重发一次，10 万条被屏蔽告警约 7 events/sec，Flink 在 stage 2 一次 broadcast 查表后丢弃——**代价可忽略**。

**影响模块**：平台告警管理，Flink 作业，通知渠道管理，控制面板 UI

---

### DEC-037：Alertmanager 零配置化 + Flink 算子链重排

**背景**：DEC-028/029 已把 AM 降级为「存储域去重引擎」，但仍保留了「手动关闭时回调 AM API 创建 silence」这条路径，且控制面板仍可下发 AM 策略。这使 AM 同时持有两类来源的配置，且平台与 AM 之间存在双向写。

**决策一：AM 收缩为零用户配置组件。**

AM 只保留两项职责——存储域内 fingerprint 去重、resolved 检测（显式 + `resolve_timeout` 隐式兜底）。其 config 只有：一个指向 am-bridge 的 webhook receiver（`send_resolved: true`）+ `group_wait` / `group_interval` / `repeat_interval` / `resolve_timeout` 四个时间参数。**全部由部署模板生成，变更走发布流程，不走控制面板 UI。**

| 删除的能力 | 说明 |
|------------|------|
| 控制面板 → AM 策略下发链路 | `alert-management.md` v2.0 §1.2 的整块架构图删除 |
| 平台 → AM silence 回调 | DEC-033 的「双向清理」改为单向 |
| AM 配置渲染 / 热加载 / 校验 | `POST /api/v1/am/config/reload` 接口删除 |
| AM silence 作为屏蔽载体 | 全部由 Flink `converge_rule(type=mute)` 承担 |

**收益**：消除一整类故障——「UI 改了但 AM 没生效」「配置渲染错误导致 AM 拒绝加载」「热加载竞态」。配置下发链路从 2 条（规则→vmalert、策略→AM）减为 1 条。AM 状态自清理（`resolve_timeout` 兜底），平台无需干预。

**决策二：Flink 算子链重排，修正两处 v3.2 实质缺陷。**

| # | v3.2 | v3.3 | 修正的缺陷 |
|---|------|------|------------|
| 2 | 跨域去重（fingerprint, keyed） | **屏蔽（broadcast only，无 keyed state）** | ① 屏蔽原在去重之后，持续 firing 的告警先被去重吸收为 `renewed`，**广播式屏蔽规则永远拿不到事件**，形同虚设；② 屏蔽判定是纯查表、无需历史，标为 keyed 是错的，白白为每条被屏蔽告警分配 RocksDB 状态 |
| 3 | 屏蔽（fingerprint, keyed） | **跨域去重（`dedup_key`, keyed, TTL 24h）** | 判定键由 fingerprint 改为 `dedup_key`（DEC-029 修订） |
| 5→6 | 抖动抑制 | 逐级抑制 → **恢复延迟与抖动锁定** | 抑制必须在恢复延迟之前——resolved 需先到达抑制算子把自己从活跃根因集合摘掉，否则根因已恢复而子告警仍被压制 |

新链序：`规整 → 屏蔽(broadcast) → 跨域去重(dedup_key) → 收敛(MapState, 组级裁决) → 逐级抑制(broadcast + 侧输出 inhibit_released) → 恢复延迟与抖动锁定 → AI 富化(P2, 旁路) → 轨迹与输出`。

`inhibit_released` 走 stage 5 侧输出直达 stage 8，**不经过 stage 6**——它是控制信号不是告警事件，不该被恢复延迟和抖动逻辑处理。

**决策三（连带）：`dedup_key` 引入后 `alert.raw` 的 partition key 必须同步改为 `dedup_key`。** 跨域重复的两条告警 fingerprint 不同（`zone` 标签不同）但 `dedup_key` 相同，只有落到同一分区，first-wins 才能在单 subtask 内完成裁决——否则两条副本在不同 subtask 上各自 first-wins，去重当场失效。

**决策四（连带）：规则冷启动 bootstrap。** Flink broadcast state 模式中 broadcast 流与 keyed 流是**交错消费**的，没有「所有广播元素先处理完」的保证。作业重启后若主流积压事件先于 `alert.rule` 规则到达，会出现短暂漏屏蔽/漏抑制——正好在最不该出错的时候（重启通常伴随故障）。

| 方案 | 评价 |
|------|------|
| **A：`open()` 时同步从 PG 全量拉规则做 seed（选定）** | 简单可靠；一次性有界查询，不违反「Flink 不做重 I/O」；引入启动期对 PG 的依赖（PG 本就是规则源） |
| B：接受 warmup 窗口 | 等于承认会漏屏蔽，不可接受 |
| **C：savepoint 自带 broadcast state（选定，与 A 并用）** | 正常恢复自动带出，快且无 PG 依赖；但仅对 savepoint 恢复有效，首次部署与 state 不兼容的重启仍需 A |

A + C 并用：正常重启走 savepoint；`open()` 做一次 PG seed 作为兜底与首次部署路径，按 `version` 比对，PG 更新则覆盖。

**影响模块**：AM 部署与配置，Flink 作业，am-bridge，平台告警管理，控制面板 UI，RC/vmalert

---

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

### CONFLICT-008：Alertmanager 职责的三次收缩

**描述**：AM 的职责在两天内经历三次变更：

| 阶段 | AM 职责 | 决策 |
|------|---------|------|
| v1.x | 完整策略执行引擎：分组、去重、屏蔽、抑制、限流、路由、状态权威源 | 原始设计 |
| v3.2（2026-09-24） | 存储域去重引擎：fingerprint 去重 + `repeat_interval` + resolved 检测。**但保留**「手动关闭时平台回调 AM API 创建 silence」 | DEC-028 / DEC-029 / DEC-033 |
| v3.3（2026-09-24） | **零用户配置**：仅去重 + resolved 检测。silence 回调删除，config 退化为部署期静态模板 | DEC-037 |

**冲突点**：v3.2 同时声称「AM 不再负责屏蔽」又保留「关闭时回调 AM silence」，是自相矛盾的——屏蔽能力被搬到 Flink，却仍有一个屏蔽入口留在 AM。这个矛盾在 v3.2 中通过给职责表的该行加限定词（「用户配置的屏蔽规则」）掩盖了过去，而非真正解决。

**解决方式**：DEC-037 将 AM 收缩为零用户配置组件，屏蔽能力唯一归属 Flink `converge_rule(type=mute)`。DEC-033 的「双向清理」相应改为单向。代价核算：被屏蔽告警仍走完全链路才被 Flink 拦下，但 AM 每 4h 才重发一次，10 万条被屏蔽告警约 7 events/sec，可忽略。

**经验**：一个组件的职责被部分搬走时，必须检查是否还有**第二个入口**留在原处。「大部分搬走 + 保留一个特例」的设计几乎总是矛盾的来源。[已解决]

---

### CONFLICT-009：升级配置的三处并存

**描述**：升级（escalation）配置在 v3.2 时同时存在于三处：`alert_route.escalation_s`（告警管理，单个秒数阈值）、`escalation_policy.levels`（通知渠道，完整多级链）、`notification_group.escalation_config`（通知渠道，组内嵌配置）。

**冲突点**：三处并存必然漂移。典型故障是「改了路由的阈值但升级链没改」，表现为升级时机与预期不符且极难排查——两处配置都「看起来是对的」。

**解决方式**：DEC-034 收敛到 `escalation_policy.levels` **唯一权威**，另两处删除。`alert_route` 改为持有 `escalation_policy_id` 外键。同时明确职责切分：**通知渠道模块定义「升级链长什么样」，告警管理的 `notification_scheduler` 判定「什么时候该升级」**——定义与触发分离，避免两处都持有计时逻辑。[已解决]

---

### CONFLICT-010：「重复」一词的三种语义

**描述**：v3.2 中有三个都叫「重复」的旋钮，语义完全不同：AM `repeat_interval`（4h）、通知渠道 `rate_limit.dedup.window_seconds`（300s）、`alert_route.repeat_notify_s`（14400s）。

**冲突点**：若 AM 的续约事件被当作普通事件流到平台，每 4h on-call 就被叫一次，`repeat_notify_s=14400` 形同虚设。

**解决方式**：DEC-034 显式分离三级语义——① AM `repeat_interval` = **下游状态续约心跳**，不触达人（被 Flink stage 3 吸收为 `renewed`，只写账本）；② 通知渠道的窗口改名「**投递幂等窗口**」，防重试导致的重复投递；③ `repeat_notify_s` = **人工重复提醒**，唯一的触达人重复策略。

**经验**：命名冲突比逻辑冲突更难发现，因为每个旋钮单独看都是对的。跨模块的同名参数必须在文档中并列对照。[已解决]

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
| 2026-09-24 | DEC-028 | 新建：Flink 收敛引擎 + AM 降级为去重引擎 | 闭环 MC-10 告警风暴；拓扑 RCA 需真流处理 |
| 2026-09-24 | DEC-029 | 新建：去重分层（AM 时间维度 + Flink 空间维度） | AM 中心化集群方案否决；削峰约 240 倍 |
| 2026-09-24 | DEC-030 | 新建：CMDB 拓扑标签富化，不做运行时 join | RCA 复杂度削减一个量级 |
| 2026-09-24 | DEC-031 | 新建：抑制时序先放行后抑制 + broadcast 根因状态 | 否决滞留与回溯撤回 |
| 2026-09-24 | DEC-032 | 新建：单 Kafka 六 topic + 账本 PG→ClickHouse 演进 | 双队列方案否决；运营表与账本表访问模式相反 |
| 2026-09-24 | DEC-033 | 新建：无降级旁路 + 带外心跳补偿 | 旁路会在故障时制造更大噪声风暴 |
| 2026-09-24 | DEC-026 | 部分修订：AM 职责范围 | 部署模型不变，AM 从策略引擎降为去重引擎 |
| 2026-09-24 | MC-04 | 作废（Mode A 告警覆盖） | DEC-003/DEC-009 已废弃 Mode 概念 |
| 2026-09-24 | MC-10 | 已闭环（告警风暴） | DEC-028/031：收敛管量 + 逐级抑制管因果 + AI 建议 |
| 2026-09-24 | MC-12~MC-15 | 新建 | 拓扑标签陈旧窗口、Flink 硬单点、broadcast 容量、规则版本一致性 |
| 2026-09-24 | DEC-034 | 新建：通知策略全部平台侧 | 否决放 Flink（升级依赖平台可变状态 + 重 I/O 拖 checkpoint + 变更频率差一个量级 + 扩大单点爆炸半径）；新增 `notification_scheduler` |
| 2026-09-24 | DEC-034 | 三级「重复通知」语义分离 | AM 续约心跳（不触达人）/ 投递幂等窗口 / 人工重复提醒；Flink 新增 `renewed` 吸收机制 |
| 2026-09-24 | DEC-034 | 升级配置收敛到唯一权威 | 删 `alert_route.escalation_s` 与 `notification_group.escalation_config`，闭环 CONFLICT-009 与 MC-11 |
| 2026-09-24 | DEC-034 | 告警分级两层化 | `severity`（规则静态）/ `notify_level`（平台派生）；电话由升级级别而非 severity 决定 |
| 2026-09-24 | DEC-034 | 值班排班不做 | 否决外部 SaaS（需出网）与 Grafana OnCall（OSS 维护状态不确定）；静态通知组 + 成员解析接口预留扩展点 |
| 2026-09-24 | DEC-035 | 新建：恢复语义五层化 | L1 vmalert 信号 / L2-L3 AM / L4 Flink 裁决 / L5 平台终态；澄清 TTL 过期不是恢复 |
| 2026-09-24 | DEC-035 | 「无数据即恢复」治理 | 否决改恢复语义与 `and on() up==1` 写法（无效）；改为规则发布期强制声明 up/absent/可容忍三选一 |
| 2026-09-24 | DEC-035 | Flink 新增恢复延迟 + 抖动锁定 | v3.2 的抖动抑制是事后介入，改为事前延迟；代价是真恢复通知晚 60s |
| 2026-09-24 | DEC-035 | 收敛组组级恢复裁决 | 否决「换代表」（认领关系丢失）与「直接透传」（组内仍 firing 却报恢复）；state 改 MapState |
| 2026-09-24 | DEC-035 | 抑制解除改为平台补发 | Flink 只发 `inhibit_released`，使「抑制降低状态量」的收益真正兑现；含 `trace_settle_s` 时序约束 |
| 2026-09-24 | DEC-035 | AM `resolve_timeout` 5m → 30m | 零成本防线，覆盖 vmalert 重启窗口；真恢复走显式路径不受影响 |
| 2026-09-24 | DEC-036 | 新建：静默分层 | 告警屏蔽（Flink，事件不成立）/ 通知静默（平台，事件成立但不叫人）；载体与执行点完全分离 |
| 2026-09-24 | DEC-036 | 修正 v3.2 对「复活」的误判 | 复活是预期行为而非缺陷；静默的作用是控制复活后的行为，不是防止复活 |
| 2026-09-24 | DEC-036 | 认领三开关 + 关闭三选一 | `notify_muted`/`auto_close_on_resolve`/`notify_on_resolve` 正交；关闭时不静默/屏蔽通知/告警屏蔽 |
| 2026-09-24 | DEC-036 | 静默安全阀 + 两条硬约束 | 恶化超 10x 强制解除；`reason` 强制填写、`ends_at` 上限 7d 不允许永久静默 |
| 2026-09-24 | DEC-037 | 新建：AM 零配置化 | 删除控制面板→AM 下发链路与平台→AM silence 回调；config 退化为部署期静态模板；闭环 CONFLICT-008 |
| 2026-09-24 | DEC-037 | Flink 算子链重排 | 屏蔽前移至 stage 2 且改纯 broadcast（原位置广播规则永远拿不到事件）；抑制前移至恢复延迟之前 |
| 2026-09-24 | DEC-037 | 规则冷启动 bootstrap | `open()` PG seed + savepoint 自带双路径；broadcast 与 keyed 流交错消费无顺序保证 |
| 2026-09-24 | DEC-033 | 修订：双向清理 → 单向清理 | AM 零配置化后平台不再回调 AM；AM 状态由 `resolve_timeout` 自清理 |
| 2026-09-24 | DEC-033 | 修订：带外心跳扩展到整条存储侧链路 | vmalert 挂掉 = 全量伪恢复 + 全量静默，比 Flink 挂掉危险一个量级；心跳告警走硬编码最小通知路径 |
| 2026-09-24 | DEC-029 | 修订：引入 `dedup_key` | fingerprint 含 `zone` 导致跨域去重失效；`alert.raw` partition key 同步改为 `dedup_key`；闭环 MC-09 / RC-08 |
| 2026-09-24 | RC-05 | 已裁决：仅 prime 评估规则 | `instance-management.md` §3.6.6 / §5.2 / §6.7 同步修订 |
| 2026-09-24 | MC-09 | 已闭环 | `dedup_key` + 仅 prime，见 DEC-029 修订 |
| 2026-09-24 | MC-11 | 已闭环 | 升级链模型定稿，见 DEC-034 |
| 2026-09-24 | MC-14 | 已闭环 | 超限自动降级为「仅收敛不抑制」；收敛组成员超 1000 拆组。否决丢弃/淘汰（宁可少抑制不可丢事件） |
| 2026-09-24 | MC-15 | 已闭环 | 接受毫秒级版本偏差；规则变更**不清** keyed state（清了会导致重复通知风暴）；冷启动 bootstrap 见 DEC-037 |
| 2026-09-24 | NC-MC-12 | 已闭环 | `alert_route.receiver_id → notification_group.group_id` |
| 2026-09-24 | NC-MC-13 | 已闭环 | 升级通知豁免限流；升级计时与发送结果解耦 |
| 2026-09-24 | NC-MC-15 | 已闭环 | 否决 RC 直发外部通知；改为带外心跳 + 硬编码最小通知路径 |
| 2026-09-24 | MC-16 | 新建：跨时区通知静默期 | 值班表砍掉后失去 timezone 载体；建议全局统一时区 |
| 2026-09-24 | RC-09 | 新建：vmalert/存储侧故障 = 全量伪恢复 | 已接受 + 补偿（带外心跳 + resolve_timeout 调大 + 强制看门狗规则） |
| 2026-09-24 | RC-10 | 新建：`dedup_key` 排除列表维护 | 新增来源类标签未同步列表会导致跨域去重静默失效 |
| 2026-09-24 | CONFLICT-008 | 新建并解决：AM 职责三次收缩 | v3.2「AM 不再负责屏蔽」与「关闭时回调 AM silence」自相矛盾，DEC-037 彻底解决 |
| 2026-09-24 | CONFLICT-009 | 新建并解决：升级配置三处并存 | DEC-034 收敛到 `escalation_policy.levels` 唯一权威 |
| 2026-09-24 | CONFLICT-010 | 新建并解决：「重复」一词三种语义 | DEC-034 三级分离 + 通知渠道侧改名「投递幂等窗口」 |
