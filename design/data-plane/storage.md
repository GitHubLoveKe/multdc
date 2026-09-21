# 存储层

> 版本：v1.0 | 日期：2026-09-21
> 状态：设计中

---

## 一、概述

存储层是采集层（Data Plane）中负责时序数据持久化的基础设施。根据网区的规模、可靠性和查询需求，存储层提供三种部署模式：Mode A（无本地存储）、Mode B（本地 VM 单实例 + 远程写入）、Mode C（本地 VM 集群）。所有模式统一采用 VictoriaMetrics 作为时序存储引擎，保证查询语言（PromQL）和写入协议（remote-write）的一致性。

存储模式的选择是网区级别的决策，影响数据写入路径、查询路径、RC 部署、降级行为等方方面面。它是采集层架构中最具全局影响力的基础设施决策之一。

### 三种模式总览

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Mode A — 无本地存储                                                       │
│                                                                          │
│   Agent → OTel Collector ──── remote-write ────▶ 中心 VM (长期)          │
│                                                                          │
│   特点：最简基础设施，所有数据直接写中心                                    │
│   适用：边缘区、1 节点区、可靠中心连接、低数据量                            │
│   RC：不部署（无本地数据可评估）                                           │
│   Query Proxy：不部署（无本地数据可查）                                    │
├─────────────────────────────────────────────────────────────────────────┤
│ Mode B — 本地 VM + 远程写入                                               │
│                                                                          │
│   Agent → OTel Collector ──┬── remote-write ──▶ 中心 VM (长期)           │
│                            └── local write ──▶ 本地 VM (短期, 7d)        │
│                                                                          │
│   特点：本地短期存储 + 中心长期存储，双写                                   │
│   适用：标准区、2-3 节点区、需要本地查询能力                                 │
│   RC：部署（查询本地 VM）                                                  │
│   Query Proxy：部署（聚合本地 VM）                                         │
├─────────────────────────────────────────────────────────────────────────┤
│ Mode C — 本地 VM 集群                                                     │
│                                                                          │
│   Agent → OTel Collector ──┬── VM cluster write ──▶ 本地 VM 集群 (主)    │
│                            └── remote-write ──▶ 中心 VM (可选, 灾备)     │
│                                                                          │
│   特点：本地集群化存储，HA + 高容量                                        │
│   适用：关键区、高数据量、需要 HA 本地存储                                  │
│   RC：部署（通过 vmselect 查询）                                           │
│   Query Proxy：部署（连接 vmselect）                                       │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 二、职责边界

**本文档负责**：
- 三种存储模式的定义与选型标准
- VictoriaMetrics 作为统一存储引擎的设计决策
- 数据写入路径（per mode）
- 数据保留策略
- 去重机制（中心端）
- 容量规划指导
- 模式间的升级路径

**本文档不负责**：
- OTel Collector 的 Exporter 实现（→ `data-plane/otel-collector.md`）
- VM 集群的具体部署运维（vmselect/vminsert/storage 内部机制）
- 中心 VM 的全局管理（→ `control-plane/` 或基础设施团队）
- 数据查询接口（→ `data-plane/zone-query-proxy.md`）
- RC 规则评估的查询（→ `data-plane/rc-rulecheck.md`）

---

## 三、功能清单

### 3.1 功能总览

| 功能模块 | 功能项 | 优先级 | 说明 |
|---------|--------|--------|------|
| 模式管理 | Mode A 无本地存储 | P0 | 纯远程写入模式 |
| 模式管理 | Mode B 本地 VM + 远程写入 | P0 | 双写模式 |
| 模式管理 | Mode C 本地 VM 集群 | P0 | 集群模式 |
| 写入路径 | remote-write 到中心 VM | P0 | 所有模式（Mode C 可选） |
| 写入路径 | 本地 VM 单实例写入 | P0 (mode B) | 本地短期存储 |
| 写入路径 | VM 集群写入 (vminsert) | P0 (mode C) | 集群写入 |
| 数据保留 | 本地保留策略配置 | P0 (mode B/C) | 按区配置保留时长 |
| 数据保留 | 中心保留策略 | P1 | 全局策略 |
| 去重 | 中心端数据去重 | P0 | 按复合键去重 |
| 标签管理 | 写入标签注入规范 | P0 | zone_id, collector_id 等 |
| 容量规划 | 存储容量估算 | P1 | 基于 target 数和保留期 |
| 升级路径 | Mode B → Mode C 升级 | P2 | 需要数据迁移评估 |

### 3.2 Mode A — 无本地存储

#### 3.2.1 架构

```
Mode A Zone:
  ┌──────────────────────────────────────────────────────┐
  │                                                        │
  │  Node 1                                                │
  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐    │
  │  │   Job    │  │  Agent   │  │  OTel Collector   │    │
  │  │ Scheduler│  │  集群    │──▶│                   │    │
  │  └──────────┘  └──────────┘  │  Exporters:       │    │
  │                              │  · center RW ✅   │    │
  │                              │  · local VM ❌    │    │
  │                              └────────┬──────────┘    │
  └───────────────────────────────────────┼────────────────┘
                                          │
                                          │ remote-write
                                          │ (跨区网络)
                                          ▼
                              ┌──────────────────────┐
                              │    中心 VM            │
                              │  (全局长期存储)        │
                              └──────────────────────┘
```

#### 3.2.2 特征

| 特征 | 说明 |
|------|------|
| 基础设施 | 最简——仅需 Job Scheduler + Agent + OTel Collector |
| 数据持久性 | 完全依赖中心 VM 和网络连通性 |
| 查询能力 | 无本地查询——所有查询通过 Query Gateway → 中心 VM |
| RC 部署 | 不部署——无本地数据可评估 |
| 降级行为 | L1（中心不可达）时数据丢失（无本地缓冲） |
| 成本 | 最低——无本地存储资源 |
| 适用场景 | 边缘区、1 节点区、网络可靠、数据量小 |

#### 3.2.3 数据流

```
写入：
  Agent → OTel Collector → remote-write → 中心 VM
  (无本地副本)

查询：
  Query Gateway → 中心 VM
  (直接查询，无 Proxy)

告警：
  无本地 RC
  中心部署「虚拟 RC」评估 Mode A 规则（如果启用）
```

### 3.3 Mode B — 本地 VM + 远程写入

#### 3.3.1 架构

```
Mode B Zone:
  ┌──────────────────────────────────────────────────────┐
  │                                                        │
  │  Node 1                    Node 2                    │
  │  ┌──────────┐              ┌──────────┐              │
  │  │   Job    │              │   Job    │              │
  │  │ Scheduler│              │ Scheduler│              │
  │  └──────────┘              └──────────┘              │
  │  ┌──────────┐              ┌──────────┐              │
  │  │  Agent   │              │  Agent   │              │
  │  └──────────┘              └──────────┘              │
  │  ┌──────────────────┐    ┌──────────────────┐       │
  │  │  OTel Collector   │    │  OTel Collector   │       │
  │  │  Exporters:       │    │  Exporters:       │       │
  │  │  · center RW ✅   │    │  · center RW ✅   │       │
  │  │  · local VM ✅    │    │  · local VM ✅    │       │
  │  └────────┬─────────┘    └────────┬─────────┘       │
  │           │                       │                   │
  │           ▼                       ▼                   │
  │  ┌──────────────┐      ┌──────────────┐             │
  │  │  本地 VM-1   │      │  本地 VM-2   │             │
  │  │  (7d 保留)   │      │  (7d 保留)   │             │
  │  └──────────────┘      └──────────────┘             │
  │                                                        │
  │  ┌──────────────────────────────────────────────┐    │
  │  │  Zone Query Proxy                             │    │
  │  │  (聚合 VM-1 + VM-2 的查询结果)                │    │
  │  └──────────────────────────────────────────────┘    │
  │                                                        │
  │  ┌──────────────────────────────────────────────┐    │
  │  │  RC (规则评估，查询本地 VM)                    │    │
  │  └──────────────────────────────────────────────┘    │
  └──────────────────────────────────────────────────────┘
                    │
                    │ remote-write (双写)
                    ▼
          ┌──────────────────────┐
          │    中心 VM            │
          └──────────────────────┘
```

#### 3.3.2 特征

| 特征 | 说明 |
|------|------|
| 基础设施 | 每节点一个 VM 实例 + OTel Collector 双写 |
| 数据持久性 | 本地短期（7d）+ 中心长期（双保险） |
| 查询能力 | 本地查询（低延迟）+ 中心查询（长期数据） |
| RC 部署 | 部署——查询本地 VM 评估规则 |
| 降级行为 | L1（中心不可达）时本地数据不丢失，RC 正常工作 |
| 成本 | 中等——每节点需 VM 存储资源 |
| 适用场景 | 标准区、2-3 节点区、需要本地查询 |

#### 3.3.3 数据流

```
写入（双写）：
  Agent → OTel Collector ──┬── remote-write → 中心 VM (长期)
                           └── local write  → 本地 VM (7d)
  两个 Exporter 独立运行，互不影响

查询：
  近期数据 → Query Gateway → Zone Query Proxy → 本地 VM
  长期数据 → Query Gateway → 中心 VM
  (Query Gateway 根据时间范围自动选择)

告警：
  RC → 查询本地 VM → 评估规则 → 生成告警
```

#### 3.3.4 本地 VM 数据分布

Mode B 中每个节点有独立的 VM 实例，数据分布策略：

```
数据分布方案：

  方案 1: 按节点分片（推荐）
    · 每个节点的 OTel Collector 只写本地 VM
    · 数据天然按节点分片
    · Query Proxy fan-out 到所有 VM 并合并
    · 优点：简单；无跨节点写入
    · 缺点：节点故障时该节点数据不可达

  方案 2: 全量复制
    · 每个节点的数据复制到所有 VM
    · 优点：任何 VM 有完整数据
    · 缺点：写入放大 N 倍；不推荐

  方案 3: 哈希分片
    · 按 metric hash 分片到不同 VM
    · 优点：均匀分布
    · 缺点：需要路由层；复杂度高于收益

  [建议] 方案 1（按节点分片）。与 OTel Collector per-node 部署一致。
```

### 3.4 Mode C — 本地 VM 集群

#### 3.4.1 架构

```
Mode C Zone:
  ┌──────────────────────────────────────────────────────┐
  │                                                        │
  │  Node 1                    Node 2                    │
  │  ┌──────────┐              ┌──────────┐              │
  │  │   Job    │              │   Job    │              │
  │  │ Scheduler│              │ Scheduler│              │
  │  └──────────┘              └──────────┘              │
  │  ┌──────────────────┐    ┌──────────────────┐       │
  │  │  OTel Collector   │    │  OTel Collector   │       │
  │  │  Exporters:       │    │  Exporters:       │       │
  │  │  · VM cluster ✅  │    │  · VM cluster ✅  │       │
  │  │  · center RW (opt)│    │  · center RW (opt)│       │
  │  └────────┬─────────┘    └────────┬─────────┘       │
  │           │                       │                   │
  │           └───────────┬───────────┘                   │
  │                       ▼                               │
  │  ┌──────────────────────────────────────────────┐    │
  │  │  VictoriaMetrics Cluster                      │    │
  │  │                                                │    │
  │  │  ┌──────────┐  ┌──────────┐  ┌──────────┐   │    │
  │  │  │vminsert-1│  │vminsert-2│  │  ...     │   │    │
  │  │  └────┬─────┘  └────┬─────┘              │    │
  │  │       └──────┬──────┘                      │    │
  │  │              ▼                              │    │
  │  │  ┌──────────┐  ┌──────────┐  ┌──────────┐ │    │
  │  │  │storage-1 │  │storage-2 │  │storage-3 │ │    │
  │  │  └──────────┘  └──────────┘  └──────────┘ │    │
  │  │              │                              │    │
  │  │       ┌──────┴──────┐                      │    │
  │  │       ▼             ▼                       │    │
  │  │  ┌──────────┐  ┌──────────┐               │    │
  │  │  │vmselect-1│  │vmselect-2│               │    │
  │  │  └──────────┘  └──────────┘               │    │
  │  └──────────────────────────────────────────────┘    │
  │                                                        │
  │  ┌──────────────────────────────────────────────┐    │
  │  │  Zone Query Proxy → vmselect                  │    │
  │  │  RC → vmselect                                │    │
  │  └──────────────────────────────────────────────┘    │
  └──────────────────────────────────────────────────────┘
                    │
                    │ remote-write (可选)
                    ▼
          ┌──────────────────────┐
          │    中心 VM (灾备)     │
          └──────────────────────┘
```

#### 3.4.2 特征

| 特征 | 说明 |
|------|------|
| 基础设施 | VM 集群（vminsert + storage + vmselect） |
| 数据持久性 | 本地集群 HA + 可选中心灾备 |
| 查询能力 | 通过 vmselect 查询，天然支持分布式查询 |
| RC 部署 | 部署——通过 vmselect 查询 |
| 降级行为 | L1 时本地集群完全独立运行，RC 正常 |
| 成本 | 最高——需要多节点 VM 集群 |
| 适用场景 | 关键区、高数据量、HA 需求 |

#### 3.4.3 VM 集群组件说明

| 组件 | 功能 | 最少实例数 | 说明 |
|------|------|-----------|------|
| vminsert | 写入入口 | 2 | 接收 remote-write，分发到 storage |
| storage | 数据存储 | 2 | 实际存储时间序列数据 |
| vmselect | 查询入口 | 2 | 从 storage 读取，合并返回 |

集群推荐配置：
- 最小集群：2 vminsert + 2 storage + 2 vmselect = 6 进程
- 可运行在 2-3 个物理节点上（组件混部）
- 存储节点建议使用 SSD

### 3.5 VictoriaMetrics 统一存储引擎

#### 3.5.1 选型理由

| 评估维度 | VictoriaMetrics | Prometheus TSDB | InfluxDB | Thanos |
|---------|----------------|-----------------|----------|--------|
| PromQL 兼容 | 完全兼容 + VM 扩展 | 原生 | 不完全 | 完全兼容 |
| 远程写入 | 原生支持 | 不支持（需 Thanos） | 自有协议 | 原生支持 |
| 资源消耗 | 低（Go，优化内存） | 中 | 高 | 高（依赖多组件） |
| 长期存储 | 原生支持 | 有限 | 原生支持 | 依赖对象存储 |
| 集群模式 | VM Cluster | 无 | 企业版 | 原生 |
| 去重 | 原生支持 | 无 | 无 | 需配置 |
| 运维复杂度 | 低（单二进制） | 低 | 中 | 高 |

**[决策 P7]**：VictoriaMetrics 作为所有时序存储的标准引擎。

#### 3.5.2 VM 单实例 vs 集群

| 特性 | VM 单实例 | VM 集群 |
|------|----------|---------|
| 部署 | 单二进制，极简 | 多组件，较复杂 |
| 数据量 | 适合 <1M 活跃序列 | 适合 >1M 活跃序列 |
| 写入吞吐 | 单节点上限 | 水平扩展 |
| 查询吞吐 | 单节点上限 | vmselect 水平扩展 |
| HA | 无（需外部 HA 方案） | 内置（多副本） |
| 资源需求 | 低 | 高 |

### 3.6 数据写入路径

#### 3.6.1 标签注入规范

所有写入的数据都经过标签注入，确保数据可追溯、可去重：

```yaml
必注入标签:
  zone_id: string              # 网区 ID（所有模式）
  collector_id: string         # OTel Collector ID（所有模式）
  node_id: string              # 节点 ID（所有模式）
  slot_id: string              # Slot ID（所有模式）
  instance: string             # 采集目标实例（来自 Target 定义）
  job: string                  # 任务组名（来自 Target 定义）

系统标签:
  __replica__: string          # 副本标识（Mode C 集群内部使用）
  __name__: string             # 指标名称

可选标签:
  __instance_type__: string    # 实例类型（oracle/mysql/linux/windows）
  __metrics_path__: string     # 指标路径
  __scheme__: string           # 协议（http/https）
```

#### 3.6.2 写入路径汇总

```
Mode A 写入路径:
  Agent → OTel Collector → [remote-write] → 中心 VM
  标签: {zone_id, collector_id, node_id, slot_id, instance, job, ...}

Mode B 写入路径:
  Agent → OTel Collector → [remote-write] → 中心 VM
                        → [local write]  → 本地 VM
  标签: 同上（中心和本地写入的标签一致）

Mode C 写入路径:
  Agent → OTel Collector → [VM cluster write] → vminsert → storage
                        → [remote-write (可选)] → 中心 VM
  标签: 同上 + __replica__ (集群内部)
```

### 3.7 数据去重

#### 3.7.1 为什么需要去重

在 Mode B 双写和 Mode C 可选远程写入场景下，同一份数据可能存在于多个存储位置：
- Mode B：本地 VM + 中心 VM 各有一份
- Mode C：本地 VM 集群 + 中心 VM（可选）各有一份

当查询中心 VM 时，可能收到来自多个区的重复数据（同一 target 的数据被多个 Collector 写入）。

#### 3.7.2 去重键

```
去重复合键:
  (zone_id, collector_id, slot_id, __name__, labels_hash, timestamp)

含义:
  · zone_id: 同一网区
  · collector_id: 同一 Collector
  · slot_id: 同一 slot
  · __name__: 同一指标名
  · labels_hash: 同一标签组合
  · timestamp: 同一时间点

当两个数据点的去重键完全相同时，保留一个（取最后写入的）。
```

#### 3.7.3 去重实现

```
VictoriaMetrics 去重机制:

  VM 内置去重 (-dedup.minScrapeInterval):
    · 配置最小抓取间隔（如 15s）
    · 同一序列在去重窗口内的多个数据点，保留最后一个
    · 自动处理重复写入

  中心 VM 配置:
    -dedup.minScrapeInterval=15s

  本地 VM 配置 (Mode B/C):
    -dedup.minScrapeInterval=15s
```

### 3.8 数据保留策略

#### 3.8.1 保留策略矩阵

| 存储位置 | Mode A | Mode B | Mode C |
|---------|--------|--------|--------|
| 本地 VM | N/A | 7 天（可配置） | 30 天（可配置） |
| 中心 VM | 全局策略 | 全局策略 | 全局策略（可选） |

#### 3.8.2 保留策略配置

```yaml
RetentionConfig:
  # 本地保留（Mode B/C）
  local:
    retention_period: duration        # 保留时长
    # Mode B 默认: 7d
    # Mode C 默认: 30d
    max_disk_usage: uint64            # 最大磁盘使用量
    retention_type: enum              # time_based | size_based | hybrid

  # 中心保留
  center:
    retention_period: duration        # 全局保留时长
    # 默认: 365d (1 年)
    tier: enum                        # hot | warm | cold
    # hot: 最近 30 天，SSD
    # warm: 30-180 天，HDD
    # cold: 180-365 天，对象存储
```

### 3.9 容量规划

#### 3.9.1 容量估算公式

```
存储容量估算:

  活跃序列数 (active_series) =
    target_count × metrics_per_target

  每日数据量 (daily_bytes) =
    active_series × samples_per_day × bytes_per_sample

  其中:
    samples_per_day = 86400 / scrape_interval (秒)
    bytes_per_sample ≈ 16 bytes (VM 压缩后约 1-4 bytes，取保守值)

  总存储容量 (total_storage) =
    daily_bytes × retention_days × replication_factor

示例 (Mode B):
  target_count = 500
  metrics_per_target = 100
  scrape_interval = 15s
  retention = 7d

  active_series = 500 × 100 = 50,000
  samples_per_day = 86400 / 15 = 5,760
  daily_bytes = 50,000 × 5,760 × 4 bytes ≈ 1.1 GB
  total_storage = 1.1 GB × 7 = 7.7 GB (每节点本地 VM)
```

#### 3.9.2 各模式推荐规格

| 模式 | 场景 | VM 规格 | 存储 | 说明 |
|------|------|---------|------|------|
| A | 边缘区 | N/A | N/A | 无本地 VM |
| B | 标准区 (500 targets) | 2C4G | 20GB SSD | 每节点 |
| B | 标准区 (2000 targets) | 4C8G | 50GB SSD | 每节点 |
| C | 关键区 (5000 targets) | 集群 6 进程 | 200GB SSD | 3 节点 |
| C | 关键区 (20000 targets) | 集群 9+ 进程 | 500GB+ NVMe | 3-5 节点 |

---

## 四、核心数据模型

### 4.1 StorageZoneConfig（存储区配置）

```yaml
StorageZoneConfig:
  zone_id: string                       # 网区 ID
  storage_mode: enum                    # A | B | C
  vm_version: string                    # VictoriaMetrics 版本

  # Mode B 配置
  mode_b:
    local_vms:
      - node_id: string                 # 所在节点
        endpoint: string                # VM 地址
        retention_period: duration      # 本地保留时长
        max_disk_usage: uint64          # 最大磁盘使用
    remote_write:
      enabled: bool                     # 是否远程写入中心（默认 true）
      endpoint: string                  # 中心 VM 地址
      queue_size: uint32                # 写入队列大小

  # Mode C 配置
  mode_c:
    cluster:
      vminsert:
        replicas: uint32                # vminsert 副本数
        endpoints: [string]             # vminsert 地址列表
      storage:
        replicas: uint32                # storage 节点数
        replication_factor: uint32      # 数据副本因子
        retention_period: duration      # 保留时长
      vmselect:
        replicas: uint32                # vmselect 副本数
        endpoints: [string]             # vmselect 地址列表
    remote_write:
      enabled: bool                     # 是否远程写入中心（默认 optional）
      endpoint: string
```

### 4.2 WritePath（写入路径描述）

```yaml
WritePath:
  zone_id: string
  storage_mode: enum
  exporters:
    - exporter_id: string
      type: enum                        # remote_write | local_vm | vm_cluster
      target_endpoint: string
      enabled: bool
      priority: uint32                  # 优先级（影响写入顺序）
      labels:                           # 该路径注入的额外标签
        zone_id: string
        collector_id: string
      dedup_key: [string]               # 去重键字段列表
```

### 4.3 StorageCapacity（存储容量信息）

```yaml
StorageCapacity:
  zone_id: string
  storage_mode: enum
  timestamp: timestamp

  # 规模指标
  active_series: uint64                 # 当前活跃序列数
  target_count: uint32                  # 采集目标数
  metrics_per_target: float             # 平均每 target 指标数
  scrape_interval_avg: duration         # 平均采集间隔

  # 存储使用
  local_storage:
    total_bytes: uint64                 # 总存储空间
    used_bytes: uint64                  # 已使用空间
    utilization: float                  # 使用率
    retention_days: uint32              # 当前保留天数

  center_storage:
    total_series: uint64                # 中心存储的总序列数
    daily_ingest_bytes: uint64          # 每日写入量
```

### 4.4 DeduplicationConfig（去重配置）

```yaml
DeduplicationConfig:
  enabled: bool                         # 是否启用去重
  min_scrape_interval: duration         # 最小抓取间隔（去重窗口）
  dedup_key_fields: [string]            # 去重键字段
  # 默认: [zone_id, collector_id, slot_id, __name__, labels_hash, timestamp]
  conflict_resolution: enum             # 冲突解决策略
  # LAST_WRITE: 保留最后写入的
  # HIGHEST_VALUE: 保留最大值
  # LOWEST_VALUE: 保留最小值
```

---

## 五、接口与交互

### 5.1 OTel Collector → 中心 VM (Remote Write)

```
OTel Collector                          中心 VictoriaMetrics
  │                                          │
  │  POST /api/v1/write                      │
  │  Content-Type: application/x-protobuf    │
  │  Content-Encoding: snappy                │
  │  X-Prometheus-Remote-Write-Version: 1.0  │
  │                                          │
  │  WriteRequest {                          │
  │    timeseries: [                         │
  │      {                                   │
  │        labels: [                         │
  │          {name: "__name__", value: "up"},│
  │          {name: "zone_id", value: "z1"}, │
  │          {name: "instance", value: "..."},│
  │          ...                             │
  │        ],                                │
  │        samples: [                        │
  │          {value: 1.0, timestamp: ...}    │
  │        ]                                 │
  │      }                                   │
  │    ]                                     │
  │  }                                       │
  │─────────────────────────────────────────▶│
  │                                          │
  │  200 OK                                  │
  │◀─────────────────────────────────────────│
```

### 5.2 OTel Collector → 本地 VM (Mode B)

```
OTel Collector                          本地 VM
  │                                          │
  │  POST /api/v1/write                      │
  │  (同 remote-write 协议)                   │
  │─────────────────────────────────────────▶│
  │                                          │
  │  200 OK                                  │
  │◀─────────────────────────────────────────│
  │                                          │
  │  本地 VM 配置:                            │
  │  -storageDataPath=/var/lib/victoria-data │
  │  -retentionPeriod=7d                     │
  │  -dedup.minScrapeInterval=15s            │
```

### 5.3 OTel Collector → VM 集群 (Mode C)

```
OTel Collector                          vminsert
  │                                          │
  │  POST /insert/0/prometheus/api/v1/write  │
  │  (VM 集群写入协议)                         │
  │─────────────────────────────────────────▶│
  │                                          │
  │  vminsert 内部:                           │
  │  1. 解析时间序列                           │
  │  2. 按路由键分发到 storage 节点            │
  │  3. storage 节点写入本地数据               │
  │                                          │
  │  200 OK                                  │
  │◀─────────────────────────────────────────│
```

### 5.4 RC → 存储查询 (Mode B)

```
RC Node                                 本地 VM
  │                                          │
  │  GET /api/v1/query                       │
  │  ?query=up{zone_id="z1"}                 │
  │  &time=2026-09-21T10:00:00Z              │
  │─────────────────────────────────────────▶│
  │                                          │
  │  {                                       │
  │    "status": "success",                  │
  │    "data": {                             │
  │      "resultType": "vector",             │
  │      "result": [                         │
  │        {                                 │
  │          "metric": {"__name__": "up",...},│
  │          "value": [1726905600, "1"]      │
  │        }                                 │
  │      ]                                   │
  │    }                                     │
  │  }                                       │
  │◀─────────────────────────────────────────│
```

### 5.5 RC → vmselect 查询 (Mode C)

```
RC Node                                 vmselect
  │                                          │
  │  GET /select/0/prometheus/api/v1/query   │
  │  ?query=up{zone_id="z1"}                 │
  │─────────────────────────────────────────▶│
  │                                          │
  │  vmselect 内部:                           │
  │  1. 解析 PromQL                           │
  │  2. Fan-out 到 storage 节点               │
  │  3. 合并结果                              │
  │  4. 返回                                  │
  │                                          │
  │  Response                                │
  │◀─────────────────────────────────────────│
```

### 5.6 Zone Query Proxy → 存储

```
Zone Query Proxy (Mode B)               本地 VM 实例
  │                                          │
  │  Fan-out 查询到所有本地 VM                │
  │  GET /api/v1/query (并行)                 │
  │─────────────────────────────────────────▶│ VM-1
  │─────────────────────────────────────────▶│ VM-2
  │◀─────────────────────────────────────────│ 结果
  │◀─────────────────────────────────────────│ 结果
  │                                          │
  │  合并 + 去重 → 返回 Query Gateway         │

Zone Query Proxy (Mode C)               vmselect
  │                                          │
  │  直接转发到 vmselect                      │
  │  GET /select/0/prometheus/api/v1/query   │
  │─────────────────────────────────────────▶│
  │◀─────────────────────────────────────────│
```

---

## 六、设计决策与替代方案

### DEC-STOR-01：统一存储引擎选型

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：VictoriaMetrics（当前） | 所有模式统一使用 VM | 一致性好；运维简单；资源效率高 | 绑定单一供应商 |
| B：Prometheus TSDB | 使用原生 Prometheus 存储 | 生态原生 | 无集群模式；长期存储弱；无去重 |
| C：混合（VM + Prometheus） | 按模式选择不同引擎 | 灵活性 | 运维复杂度大幅增加 |
| D：Thanos | 基于 Thanos 的长期存储 | 功能丰富 | 依赖对象存储；运维复杂 |

**[决策 P7]**：方案 A。VictoriaMetrics 在资源效率、集群支持、去重能力方面全面优于替代方案。单一供应商的风险通过 VM 的 PromQL 兼容性缓解（迁移成本低）。

### DEC-STOR-02：Mode B 本地 VM 的 HA 方案

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：无 HA（当前推荐） | 每节点独立 VM，无副本 | 简单；资源省 | 节点故障时本地数据不可达 |
| B：VM HA 对 | 每两个节点的 VM 互为副本 | 本地 HA | 写入放大 2 倍；复杂度增加 |
| C：依赖中心回退 | 节点故障时查询中心 VM | 简单；利用已有数据 | 查询延迟增加；可能有复制延迟 |

**[建议]**：方案 A + 方案 C 回退。Mode B 定位为「标准区」，本地 VM 故障时通过 Query Gateway 回退到中心 VM 查询。真正的 HA 需求应使用 Mode C。

### DEC-STOR-03：Mode C 集群规模

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：最小 2 节点 | 2 storage + 2 vminsert + 2 vmselect | 最低成本 HA | 容量有限 |
| B：推荐 3 节点 | 3 storage + 2 vminsert + 2 vmselect | 良好平衡 | 中等成本 |
| C：大规模 5+ 节点 | 5+ storage + N vminsert + N vmselect | 高容量高可用 | 成本高；运维复杂 |

**[建议]**：方案 B（3 节点）作为默认推荐。关键区可根据数据量扩展到方案 C。

### DEC-STOR-04：远程写入策略

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：始终开启（Mode B 当前） | 双写始终启用 | 中心始终有副本 | 网络开销；中心负载 |
| B：可选（Mode C 当前） | 远程写入可配置开关 | 灵活 | 关闭时中心无数据 |
| C：批量异步 | 定期批量上传（非实时） | 减少实时网络开销 | 数据延迟；中心数据不完整 |
| D：自适应 | 网络好时实时写，差时批量 | 最优 | 实现复杂 |

**[建议]**：Mode B 用方案 A（始终开启），确保中心有完整副本用于回退查询。Mode C 用方案 B（可选），关键区可选择关闭以减少网络开销。

### DEC-STOR-05：运行时模式切换

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A：不支持运行时切换 | 模式在区创建时确定，不可变 | 简单；无迁移风险 | 升级需要重建区 |
| B：支持 A→B→C 升级 | 逐步升级，添加存储组件 | 灵活；渐进式投资 | 需要数据迁移；切换窗口 |
| C：支持双向切换 | 任意方向切换 | 最灵活 | 复杂度极高 |

**[建议]**：阶段 1 用方案 A（不支持运行时切换）。模式切换涉及数据迁移、组件部署、配置变更，复杂度高。阶段 2 评估方案 B（仅支持 A→B→C 单向升级）。

---

## 七、冲突与开放问题

| ID | 问题 | 影响 | 状态 |
|----|------|------|------|
| C10 (已解决) | 「双写」澄清为 VM 集群 2 副本 | Mode B 双写策略已明确 | 已解决 |
| GD-06 | 中心长期存储决策：是否启用中心 VM 作为长期存储 | 影响 Mode B/C 的远程写入策略 | 待确认 |
| STOR-01 | 运行时模式切换的复杂度评估（B→C 升级路径） | 影响区的生命周期管理 | 待评估 |
| STOR-02 | Mode B 本地 VM 故障时的数据丢失窗口 | 节点故障到回退查询中心之间的数据可见性延迟 | 待确认 |
| STOR-03 | VM 集群的最小部署规模：2 节点 vs 3 节点 | 影响 Mode C 的入门成本 | 待确认 |
| STOR-04 | 去重策略的精确语义：完全去重 vs 近似去重 | 影响查询结果的准确性 | 待确认 |
| STOR-05 | Mode C 远程写入的带宽成本评估 | 高数据量区的网络开销可能显著 | 待评估 |
| STOR-06 | 存储加密需求：静态加密 vs 传输加密 | 影响安全合规 | 待确认 |
| STOR-07 | VM 版本升级策略：滚动升级 vs 蓝绿部署 | 影响升级期间的数据可用性 | 待确认 |
