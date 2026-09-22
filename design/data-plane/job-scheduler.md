# Job Scheduler 作业调度器

> 版本：v2.0 | 日期：2026-09-22
> 状态：设计中
> v2.0 核心变更：废弃 Slot 模型 + VRRP，改用 Rendezvous Hashing + Gossip 协议。Scheduler 完全自治，不依赖协调层做调度决策。合并健康检测（K3 → D1）。新增代理服务。

---

## 一、概述

Job Scheduler 是采集层（Data Plane）在每个网区节点上的核心调度组件。它是该区节点的「大脑」，负责**自主决定**本节点应采集哪些实例、将任务分配给本地 Agent 执行，并通过 Gossip 协议与同级节点同步拓扑视图。

Scheduler 是完全自治的决策者——不依赖协调层做任何调度决策。协调层仅为 Scheduler 提供实例数据的缓存查询服务。所有 Scheduler 运行相同的确定性算法（Rendezvous Hashing），在相同的拓扑视图下产生相同的分配结果。

### 核心定位

```
                    协调层 (Redis 缓存)
                         │
                         │ QueryInstanceData
                         │ (仅提供数据，不做决策)
                         ▼
┌─────────────────────────────────────────────┐
│ Job Scheduler (每节点一个)                     │
│                                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Instance │  │ Gossip   │  │Rendezvous│   │
│  │ Sync     │  │ Protocol │  │ Hashing  │   │
│  │(从协调层  │  │(拓扑同步) │  │(实例→节点│   │
│  │ 拉取数据)│  │          │  │ 映射)    │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│       │              │              │         │
│       └──────────────┼──────────────┘         │
│                      │                        │
│               ┌──────┴──────┐                 │
│               │   Agent     │                 │
│               │  Scheduler  │                 │
│               │(任务分配 +   │                 │
│               │ 健康检测)   │                 │
│               └──────┬──────┘                 │
└──────────────────────┼────────────────────────┘
                       │ Push 采集指令 + Pull 任务同步
                       ▼
                  Agent 采集器
```

---

## 二、职责边界

**本文档负责**：
- 从协调层拉取实例数据（增量 + 全量校验）
- Gossip 协议（拓扑同步、节点状态感知）
- Rendezvous Hashing（实例→节点的确定性映射）
- Agent 调度（任务分配、负载均衡、故障重分配）
- 健康检测（合并原 K3 组件健康模块）
- 节点加入/离开的三层防抖
- 代理服务（防火墙简化）
- 状态上报（向协调层和控制面的观测数据）

**本文档不负责**：
- 实例数据的定义与管理（→ 控制面实例注册表）
- 实例数据的缓存与中继（→ `coordination-plane/collection-task-scheduling.md`）
- Agent 的内部采集实现（→ `data-plane/agent.md`）
- 降级阶梯的整体定义（→ `cross-plane/degradation-autonomy.md`）
- OTel Collector 的数据管道管理（→ `data-plane/otel-collector.md`）

---

## 三、功能清单

### 3.1 功能总览

| 功能模块 | 功能项 | 优先级 | 说明 |
|---------|--------|--------|------|
| 实例数据同步 | 从协调层增量拉取实例变更 | P0 | 基于 updatetime 的增量查询 |
| 实例数据同步 | root_hash 快速对账 | P0 | 一致时跳过拉取 |
| 实例数据同步 | 定期全量校验 | P1 | 修正增量同步遗漏 |
| 实例数据同步 | 本地缓存管理 | P0 | 协调层故障时使用本地缓存 |
| Gossip 协议 | 拓扑信息传播 | P0 | 节点上下线、健康状态 |
| Gossip 协议 | 网络分区处理 | P0 | 各分区独立计算，允许重复采集 |
| Gossip 协议 | 分区恢复后去重 | P1 | Gossip 收敛后自动消除重复 |
| Rendezvous Hashing | 实例→节点确定性映射 | P0 | hash(instance_id + node_id) 最高分 |
| Rendezvous Hashing | 节点变更时最小迁移 | P0 | 仅故障节点的实例需要重新分配 |
| Rendezvous Hashing | 三层防抖 | P0 | 稳定窗口 + 迁移限速 + 冷却期 |
| Agent 调度 | Agent 注册与发现 | P0 | 管理本节点所有 Agent |
| Agent 调度 | 采集任务分配 | P0 | 按类型/负载/健康分配 |
| Agent 调度 | Agent 健康检测 | P0 | 合并原 K3 组件健康模块 |
| Agent 调度 | Agent 故障重分配 | P1 | Agent 失效时迁移 target |
| Agent 调度 | Push + Pull 双模任务分配 | P0 | Push 为主，Pull 安全网 |
| 代理服务 | Scheduler Proxy | P1 | 防火墙简化（N×M → N×1） |
| 状态上报 | 观测数据上报 | P1 | 采集统计、节点状态 |

### 3.2 实例数据同步

#### 3.2.1 同步策略

Scheduler 通过协调层获取实例数据，采用「hash 优先 + 增量拉取 + 全量兜底」的三层策略：

```
同步流程:
  1. Scheduler 定期向协调层请求 root_hash
  2. 与本地 root_hash 比较:
     ├── 相同 → 跳过，无需拉取（快速路径）
     └── 不同 → 发送增量查询（since_updatetime）
  3. 增量拉取后再次校验 root_hash:
     ├── 相同 → 同步完成
     └── 不同 → 发送全量查询（兜底）
  4. 定期（默认 60s）执行全量校验，修正增量同步的遗漏
```

#### 3.2.2 双层版本对账

```
外层版本: snapshot_version
  └── 协调层从控制面拉取数据的时间戳
  └── 标识协调层缓存的整体新鲜度

内层版本: updatetime (per instance)
  └── 每个实例记录的独立更新时间
  └── 用于增量查询和逐实例对比

对账流程:
  Scheduler 上报 hash(all instance_id + updatetime pairs)
    → 协调层对比自身 hash
    → 匹配 = 完全一致，跳过
    → 不匹配 = 逐实例比对 updatetime，仅更新变化的实例
```

#### 3.2.3 降级行为

```
协调层不可达时:
  1. Scheduler 使用最后已知的实例数据（本地缓存）
  2. 继续正常运行，不影响已分配的采集任务
  3. 不感知控制面的新增/删除/变更
  4. 协调层恢复后，自动追赶缺失的变更
```

### 3.3 Gossip 协议

#### 3.3.1 协议概述

Scheduler 间通过 Gossip 协议同步拓扑视图（哪些节点在线/离线、健康状态）。**不传播任务配置**——仅传播拓扑信息。所有 Scheduler 运行相同的确定性算法，因此相同的拓扑视图必然产生相同的分配结果。

```
Gossip 传播内容:
  ├── node_id: 节点标识
  ├── status: alive / suspect / dead
  ├── last_seen: 最后活跃时间
  ├── agent_inventory: 本节点 Agent 类型与数量摘要
  └── incarnation: 节点启动版本号（防止旧信息复活）

不传播:
  ├── 实例配置（从协调层获取）
  ├── 任务分配结果（本地独立计算）
  └── 凭据数据（从协调层获取）
```

#### 3.3.2 Gossip 传播机制

```
传播模式:
  每个 Scheduler 周期（默认 3s）选择 1~2 个随机 peer，
  发送自身状态 + 已知的其他节点状态摘要。

  5 节点示例:
    Round 1: A→B, C→D
    Round 2: B→E, D→A
    Round 3: A→C, E→B
    ...

  收敛时间: O(log N) 轮，5 节点约 3~5 轮（9~15s）
```

#### 3.3.3 网络分区处理

```
分区场景:
  ┌──────────────┐     ┌──────────────┐
  │  A, B, C     │     │  D, E        │
  │  (分区 1)     │     │  (分区 2)     │
  │              │     │              │
  │  独立计算:    │     │  独立计算:    │
  │  认为 D,E 死  │     │  认为 A,B,C 死│
  │  接管 D,E 的  │     │  接管 A,B,C 的│
  │  实例         │     │  实例         │
  └──────────────┘     └──────────────┘

  结果: 部分实例被两个分区同时采集（重复采集）
  这是可接受的——重复采集优于数据空洞

  恢复后:
    分区愈合 → Gossip 收敛（O(log N) 轮）
    → 所有节点看到相同拓扑视图
    → Rendezvous Hashing 产生相同结果
    → 重复采集自动消除
```

### 3.4 Rendezvous Hashing（最高随机权重）

#### 3.4.1 算法描述

Rendezvous Hashing 替代了 Slot 模型（DEC-014）。每个实例通过确定性哈希直接映射到节点，无需中间的槽位层。

```
算法:
  对于每个 instance_id:
    对每个在线节点 node_id:
      score = hash(instance_id + node_id)
    将实例分配给 score 最高的节点

  示例 (3 节点, 5 实例):
    inst-001: hash(A)=0.82, hash(B)=0.45, hash(C)=0.67 → A
    inst-002: hash(A)=0.31, hash(B)=0.91, hash(C)=0.53 → B
    inst-003: hash(A)=0.44, hash(B)=0.28, hash(C)=0.89 → C
    inst-004: hash(A)=0.15, hash(B)=0.73, hash(C)=0.62 → B
    inst-005: hash(A)=0.56, hash(B)=0.41, hash(C)=0.78 → C

  结果: A=1, B=2, C=2 (基本均衡)
```

#### 3.4.2 关键性质

| 性质 | 说明 |
|------|------|
| 完全确定性 | 相同拓扑视图 → 相同分配结果，无需节点间协商 |
| 最小迁移 | 节点离开时，仅该节点的实例需要重新分配 |
| 天然均衡 | 标准差约 3~5%，无需虚拟节点或环 |
| 无需协调 | 每个节点独立计算，结果一致 |

**与 Slot 模型对比：**

```
Slot 模型 (已废弃):
  实例 → Slot → 节点
  需要: 槽位管理、VRRP 协商、Epoch Fencing、多数派投票
  复杂度: 高

Rendezvous Hashing (当前):
  实例 → 节点（直接映射）
  需要: 哈希函数 + 在线节点列表
  复杂度: 低
```

#### 3.4.3 节点变更处理

```
节点离开 (Node B 故障):
  原分配: A=1, B=2, C=2
  inst-002 和 inst-004 需要重新计算

  inst-002: hash(A)=0.31, hash(C)=0.53 → C (从 B 迁移到 C)
  inst-004: hash(A)=0.15, hash(C)=0.62 → C (从 B 迁移到 C)

  新分配: A=1, B=0, C=4
  仅 B 的 2 个实例迁移，A 和 C 的原有实例不受影响

节点加入 (Node D 恢复):
  所有实例重新计算，部分从 B/C 迁移到 D
  迁移量取决于 D 的哈希覆盖范围
```

### 3.5 三层防抖机制

#### 3.5.1 概述

节点加入/离开时，为避免因网络抖动或短暂故障导致的频繁重分配，采用三层防抖机制（DEC-019）。

```
┌──────────────────────────────────────────────────────────────┐
│                    三层防抖机制                                 │
│                                                              │
│  Layer 1: 稳定窗口 (Stabilization Window)                     │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ 节点心跳超时 → 等待 3 个心跳周期 (~9s)                   │  │
│  │ 期间若恢复 → 不触发迁移                                  │  │
│  │ 防止: 网络抖动导致的误判                                  │  │
│  └────────────────────────────────────────────────────────┘  │
│                          │                                    │
│                          ▼                                    │
│  Layer 2: 迁移限速 (Migration Rate Limit)                     │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ 每个协调周期最多迁移 10% 的总实例数                       │  │
│  │ 超出部分排队到下一个周期                                  │  │
│  │ 防止: 大量实例同时迁移导致的负载尖峰                       │  │
│  └────────────────────────────────────────────────────────┘  │
│                          │                                    │
│                          ▼                                    │
│  Layer 3: 冷却期 (Cooldown)                                   │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ 迁移完成后等待 5 分钟，期间不允许新的迁移                   │  │
│  │ 防止: 迁移本身导致的负载波动触发新一轮迁移                  │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

#### 3.5.2 参数配置

| 参数 | 默认值 | 说明 |
|------|--------|------|
| heartbeat_interval | 3s | Gossip 传播间隔 |
| stabilization_window | 9s (3 × heartbeat) | 节点离线确认等待时间 |
| migration_rate_limit | 10% / cycle | 每周期最大迁移比例 |
| cooldown_period | 5 min | 迁移后冷却时间 |

### 3.6 Agent 调度

#### 3.6.1 Agent 注册

节点上的每种 Agent 类型在启动时向本地 Job Scheduler 注册：

```yaml
AgentRegistration:
  agent_id: string              # Agent 唯一标识
  agent_type: string            # scrape / snmp / probe / oracle / mysql / ...
  node_id: string               # 所在节点
  capacity: uint32              # 最大可承载 target 数
  supported_protocols: [string] # 支持的协议列表
  version: string               # Agent 版本
  metadata: map<string, string> # 扩展信息
```

#### 3.6.2 任务分配策略

Job Scheduler 根据以下因素决定将 target 分配给哪个 Agent：

```
分配决策流程:
    1. 类型匹配: target 需要的 agent_type 必须与 Agent 声明的类型一致
    2. 容量检查: Agent 当前 target 数 < capacity
    3. 负载均衡: 在满足 1、2 的 Agent 中，选择 current_targets 最少的
    4. 健康检查: 排除 state 为 error 或 offline 的 Agent
    5. 亲和性（可选）: 优先分配给上次执行同一 target 的 Agent（减少上下文切换）
```

#### 3.6.3 采集决策：双状态模型

实例的采集决策由两个独立状态共同决定（DEC-020）：

```
actual_scrape = enabled (协调层) AND healthy (本地检测)

enabled (管理状态):
  ├── 来源: 协调层缓存的控制面数据
  ├── 变更: 管理员在控制面启用/禁用实例
  └── 含义: "这个实例应该被采集吗？"

healthy (健康状态):
  ├── 来源: Scheduler 本地健康检测
  ├── 变更: 健康检查通过/失败
  └── 含义: "这个实例现在能采到数据吗？"

组合结果:
  enabled=true  + healthy=true  → 正常采集
  enabled=true  + healthy=false → 暂停采集（目标不可达）
  enabled=false + healthy=true  → 不采集（管理员禁用）
  enabled=false + healthy=false → 不采集
```

#### 3.6.4 Agent 故障处理

```
Agent 故障检测与重分配:
    │
    ▼
Job Scheduler 检测到 Agent 健康检查失败
    │
    ├── 同类型有其他健康 Agent → 将 target 迁移到同类型 Agent
    │
    ├── 同类型无其他 Agent → 标记 target 为 pending
    │   └── 等待新 Agent 注册
    │
    └── 如果 Agent 间歇性故障 → 加入 quarantine 列表
        └── 不再分配新 target，等待恢复或手动干预
```

#### 3.6.5 Push + Pull 双模任务分配

任务分配采用 Push 为主、Pull 为辅的双模机制：

**Push 模式（主路径）**：
- 当 Rendezvous Hashing 结果变更、新实例到达、或 Agent 故障时，Scheduler 主动发送 CollectionInstruction 到 Agent
- 事件驱动，延迟低（毫秒级）
- Agent 收到指令后自行完成采集和数据推送

**Pull 模式（安全网）**：
- Agent 每 30s 向 Scheduler 发送 SyncTasks 请求，携带当前持有的任务列表
- Scheduler 对比自身视图，返回 diff（需要新增/删除/更新的任务）
- 补偿因网络抖动、消息丢失等原因导致的任务不一致

#### 3.6.6 采集间隔配置层级

采集间隔（scrape_interval）遵循以下优先级（从高到低）：

| 层级 | 配置来源 | 默认值 | 说明 |
|------|---------|--------|------|
| 平台默认 | 平台全局配置 | 60s | 所有任务的默认采集间隔 |
| TaskSpec 级别 | 控制面任务定义 | 继承平台默认 | 特定任务类型的采集间隔 |
| Target 级别 | 实例台账配置 | 继承 TaskSpec | 特定目标的采集间隔 |

CollectionInstruction 中的 scrape_interval 字段已经过层级解析，Agent 直接使用最终值。

### 3.7 健康检测（合并原 K3）

#### 3.7.1 概述

原 K3 组件健康模块的功能合并入 Scheduler（DEC-017）。Scheduler 直接检测本节点 Agent 和目标实例的健康状态，无需独立的健康检测组件。

```
健康检测范围:
  ├── Agent 健康: 本地 Agent 进程存活、资源使用、响应能力
  └── 目标健康: 采集目标可达性（通过采集结果判断）

检测方式:
  ├── Agent 自报告: Agent 在 SyncTasks 中上报自身状态
  ├── Scheduler 主动检查: 周期性健康检查请求
  └── 采集结果推断: 连续 N 次采集失败 → 标记目标不健康
```

#### 3.7.2 健康状态传播

```
健康检测结果仅影响本地 Scheduler 的采集决策:
  ├── healthy=true → actual_scrape = enabled（正常采集）
  └── healthy=false → actual_scrape = false（暂停采集）

健康状态不通过 Gossip 传播（每个节点独立检测自己的 Agent 和目标）
```

### 3.8 代理服务（Scheduler Proxy）

#### 3.8.1 概述

为简化防火墙配置，Scheduler 提供代理服务（DEC-021）。控制面/协调层只需与一个 Scheduler 建立连接，由该 Scheduler 转发到其他节点。

```
无代理 (N×M 连接):
  控制面 → Scheduler A
  控制面 → Scheduler B
  控制面 → Scheduler C
  协调层 → Scheduler A
  协调层 → Scheduler B
  协调层 → Scheduler C

有代理 (N×1 连接):
  控制面 → Scheduler A (代理)
  协调层 → Scheduler A (代理)
  Scheduler A → Scheduler B (内部转发)
  Scheduler A → Scheduler C (内部转发)

  防火墙只需开放 Scheduler A 的端口
```

#### 3.8.2 代理职责

| 功能 | 说明 |
|------|------|
| 数据转发 | 将控制面/协调层的请求转发到目标节点 |
| 响应聚合 | 收集各节点的响应，聚合后返回 |
| 代理选举 | 节点间通过 Gossip 协商，node_id 最小者为代理 |
| 故障转移 | 代理节点故障时，自动选举新代理 |

---

## 四、核心数据模型

### 4.1 NodeView（节点拓扑视图）

```yaml
NodeView:
  my_node_id: string                  # 本节点标识
  known_nodes:                        # 已知节点列表
    - node_id: string
      status: alive | suspect | dead
      last_seen: timestamp
      incarnation: uint64             # 启动版本号
      agent_inventory:
        total: uint32
        by_type: map<string, uint32>
  view_version: uint64                # 视图版本（每次更新递增）
  last_gossip_round: timestamp        # 最后一次 Gossip 传播时间
  root_hash: string                   # 从协调层获取的 root_hash
  local_instances: [InstanceRecord]   # 本地缓存的实例数据
```

### 4.2 AssignmentResult（分配结果）

```yaml
AssignmentResult:
  node_id: string                     # 本节点
  computed_at: timestamp              # 计算时间
  view_version: uint64                # 基于的拓扑视图版本

  # 本节点负责的实例列表
  my_instances:
    - instance_id: string
      assigned_by: "rendezvous_hash"  # 分配方式
      target: TargetInfo
      agent_id: string                # 分配的 Agent
      enabled: bool                   # 管理状态（来自协调层）
      healthy: bool                   # 健康状态（来自本地检测）
      actual_scrape: bool             # 实际是否采集

  # 统计
  total_instances: uint32             # 全区总实例数
  my_count: uint32                    # 本节点负责的实例数
  active_count: uint32                # 实际采集中的实例数
```

### 4.3 GossipMessage（Gossip 消息）

```yaml
GossipMessage:
  sender_id: string
  incarnation: uint64                 # 发送者的启动版本号

  # 传播的状态摘要
  entries:
    - node_id: string
      status: alive | suspect | dead
      last_seen: timestamp
      incarnation: uint64
      agent_summary:
        total: uint32
        healthy: uint32
        by_type: map<string, uint32>

  # 向量时钟（可选，用于检测信息新旧）
  vector_clock: map<string, uint64>   # node_id → 已知最新版本
```

### 4.4 CollectionInstruction（采集指令）

```yaml
CollectionInstruction:
  instruction_id: string              # 指令唯一 ID
  instance_id: string                 # 关联控制面实例台账
  target: TargetInfo                  # 采集目标完整配置
  scrape_interval: duration           # 采集间隔（已解析最终值）
  scrape_timeout: duration            # 采集超时
  auth_type: string                   # 认证类型
  credential:                         # 凭据（合并入实例记录，DEC-016）
    username: string
    password: string
    bearer_token: string
    tls_cert: string
  output_endpoint: string             # 数据推送目标（OTel Collector 地址）
  labels:                             # 附加标签
    zone_id: string
    agent_id: string
    node_id: string
```

---

## 五、接口与交互

### 5.1 与协调层的交互

```
协调层 (Redis)                          Job Scheduler
    │                                        │
    │  QueryInstanceData (HashQuery)         │
    │◀───────────────────────────────────────│
    │  root_hash + snapshot_version          │
    │───────────────────────────────────────▶│
    │                                        │
    │  [hash 不同]                            │
    │  QueryInstanceData (IncrementalQuery)  │
    │◀───────────────────────────────────────│
    │  changes[]                             │
    │───────────────────────────────────────▶│
    │                                        │
```

| 接口 | 方向 | 协议 | 频率 | 说明 |
|------|------|------|------|------|
| QueryInstanceData (Hash) | JS → 协调层 | gRPC | 10s | 查询 root_hash |
| QueryInstanceData (Incremental) | JS → 协调层 | gRPC | 按需 | 增量拉取变更 |
| QueryInstanceData (Full) | JS → 协调层 | gRPC | 60s | 全量校验 |

### 5.2 与 Peer 节点的交互（Gossip）

```
Job Scheduler (A)                       Job Scheduler (B)
    │                                        │
    │  GossipMessage (3s)                    │
    │  {entries: [A:alive, C:alive]}        │
    │───────────────────────────────────────▶│
    │                                        │  合并到本地视图
    │  GossipMessage (3s)                    │
    │  {entries: [B:alive, D:suspect]}      │
    │◀───────────────────────────────────────│
    │                                        │
    │  [合并后: A:alive, B:alive, C:alive, D:suspect]
    │  [Rendezvous Hashing 重新计算]          │
```

| 接口 | 方向 | 协议 | 频率 | 说明 |
|------|------|------|------|------|
| GossipMessage | JS ↔ JS | HTTP/gRPC | 3s | 拓扑信息传播 |

### 5.3 与 Agent 的交互

```
Job Scheduler                             Agent
    │                                       │
    │  RegisterAgent(registration)           │
    │◀──────────────────────────────────────│
    │  RegisterResp(agent_id, status)        │
    │───────────────────────────────────────▶│
    │                                        │
    │  AssignTask(instruction)               │
    │───────────────────────────────────────▶│
    │                                        │  执行采集
    │  TaskResult(success, metrics_ref)      │  数据推送到 OTel Collector
    │◀──────────────────────────────────────│
    │                                        │
    │  HealthCheck(agent_id)                 │
    │───────────────────────────────────────▶│
    │  HealthResp(status, load)              │
    │◀──────────────────────────────────────│
    │                                        │
    │  SyncTasks (30s)                       │
    │  { current_tasks: [task_id, ...] }     │
    │───────────────────────────────────────▶│
    │                                        │  对比 Scheduler 视图
    │  SyncTasksResponse                     │  返回 diff
    │  { add_tasks: [...],                   │
    │    remove_tasks: [...],                │
    │    update_tasks: [...] }               │
    │◀───────────────────────────────────────│
```

| 接口 | 方向 | 协议 | 频率 | 说明 |
|------|------|------|------|------|
| RegisterAgent | Agent → JS | HTTP/gRPC | 启动时 | Agent 注册 |
| AssignTask | JS → Agent | HTTP/gRPC | 事件驱动 | 分配采集任务 |
| TaskResult | Agent → JS | HTTP/gRPC | 每次采集后 | 上报采集结果（元数据） |
| HealthCheck | JS → Agent | HTTP | 5s | 健康检查 |
| SyncTasks | Agent → JS | HTTP/gRPC | 30s | Agent 同步任务列表 |

### 5.4 代理服务交互

```
控制面/协调层                          Scheduler A (代理)          Scheduler B
    │                                       │                         │
    │  Request(target=B)                    │                         │
    │──────────────────────────────────────▶│                         │
    │                                       │  Forward(target=B)      │
    │                                       │────────────────────────▶│
    │                                       │                         │
    │                                       │  Response               │
    │                                       │◀────────────────────────│
    │  Response                            │                         │
    │◀──────────────────────────────────────│                         │
```

---

## 六、设计决策与替代方案

### DEC-JS-01：拓扑同步协议选型

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：VRRP 风格心跳（v1.0） | 周期性广播 Advertisement，多数派投票 | 成熟稳定 | 2 节点无法多数派；需要 Slot 模型配合 |
| **B：Gossip 协议（当前）** | 随机节点间传播状态，最终一致性 | 大规模高效；容忍网络分区；无多数派依赖 | 收敛时间不确定 |
| C：Raft 共识 | 使用 Raft 的 leader election | 强一致性 | 过度设计；引入 Leader 概念与自治原则冲突 |

**选择 B。** 与 Rendezvous Hashing 的确定性特性完美配合——最终一致的拓扑视图 + 确定性算法 = 最终一致的分配结果。

### DEC-JS-02：实例→节点映射算法

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：Slot 模型（v1.0） | 实例→Slot→节点，VRRP 协商归属 | 灵活（可加权） | 复杂度高；Slot 总数固定不灵活 |
| **B：Rendezvous Hashing（当前）** | hash(instance_id + node_id) 最高分 | 简单；最小迁移；天然均衡 | 不支持加权 |
| C：一致性哈希 | 虚拟节点环 + 哈希 | 成熟方案 | 需要虚拟节点；迁移量不如 Rendezvous |
| D：取模分配 | instance_id % node_count | 最简单 | 节点变更时 ~90% 实例迁移——不可接受 |

**选择 B。** 最小迁移是关键特性——节点故障时仅该节点的实例需要重新分配。

### DEC-JS-03：Agent 任务调度模式

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：纯 Push | Scheduler 主动分配 | 实时性好 | 消息丢失时遗漏任务 |
| B：纯 Pull | Agent 轮询 Scheduler | 解耦 | 延迟高 |
| **C：Push 主 + Pull 辅（当前）** | Push 分配 + 30s SyncTasks 安全网 | 实时性 + 一致性保障 | 需要两套机制 |

**选择 C。** 事件驱动的 Push 保证实时性，周期性 SyncTasks 兜底一致性。

### DEC-JS-04：健康检测归属

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：独立 K3 组件（v1.0） | 独立健康检测模块 | 职责分离 | 增加组件间通信；协调层参与健康决策 |
| **B：合并入 Scheduler（当前）** | Scheduler 直接检测 Agent 和目标健康 | 减少组件；低延迟；与采集决策紧密耦合 | Scheduler 职责增加 |

**选择 B。** 健康检测的结果直接决定采集行为（actual_scrape = enabled AND healthy），合并后决策链路最短，无需跨组件通信。

---

## 七、开放问题

| ID | 问题 | 影响 | 状态 |
|----|------|------|------|
| JS-01 | Gossip 消息是否使用 mTLS？ | 安全性 vs 性能 | 待确认（建议默认 mTLS） |
| JS-02 | Rendezvous Hashing 的哈希函数选择？ | 分布均匀性 | 待压测（建议 MurmurHash3） |
| JS-03 | 大规模实例（10 万+）下 Rendezvous Hashing 计算耗时？ | 每次拓扑变更需遍历所有实例 | 待压测 |
| JS-04 | 代理服务的负载均衡能力？ | 单代理可能成为瓶颈 | 待评估（大 zone 可能需要多代理） |
| JS-05 | Agent 调度中的亲和性策略？ | 采集稳定性 vs 负载均衡 | 待确认 |
| JS-06 | 网络分区恢复后的去重策略？ | 短暂重复采集的指标数据如何处理 | 待确认（建议标记 duplicate 标签） |
