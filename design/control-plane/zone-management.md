# 网区管理 (Zone Management)

## 一、概述

网区管理模块是中心控制面的基础模块之一，负责管理整个多区域监控平台的网络拓扑结构。它将物理网络划分为逻辑"网区"（Zone），每个网区对应一个独立的网络区域（如数据中心、可用区、边缘站点），并维护网区与 IP 网段的映射关系、网区内节点拓扑、存储模式等核心元数据。

在三层架构中，网区管理是**定义层**的关键组成部分——它回答"哪些节点属于哪个网区"这一根本问题，直接影响任务下发、数据路由、查询路径等所有下游行为。

```
                    ┌─────────────────────────┐
                    │     中心控制面 (RDS)      │
                    │  ┌───────────────────┐  │
                    │  │   网区管理模块      │  │
                    │  │  - 网区注册/生命周期 │  │
                    │  │  - IP 网段映射      │  │
                    │  │  - 网区自动推荐     │  │
                    │  │  - Manifest 版本    │  │
                    │  └────────┬──────────┘  │
                    └───────────┼─────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                  ▼
        ┌──────────┐     ┌──────────┐      ┌──────────┐
        │ Zone-A   │     │ Zone-B   │      │ Zone-C   │
        │ (Mode A) │     │ (Mode B) │      │ (Mode C) │
        │ 边缘站点  │     │ 区域中心  │      │ 主数据中心│
        └──────────┘     └──────────┘      └──────────┘
```

## 二、职责边界

### 本模块负责

| 职责 | 说明 |
|------|------|
| 网区注册与生命周期 | 创建、启用、禁用、退役网区 |
| IP 网段映射维护 | 维护 IP 网段到网区的映射表，确保无重叠 |
| 网区自动推荐 | 新实例接入时，根据 IP/DNS 自动推荐所属网区 |
| 网区拓扑维护 | 记录每个网区内的节点列表及其角色（JS/Agent/OTel/RC/Storage） |
| 网区元数据管理 | 存储模式（A/B/C）、HA 配置、协调器类型、节点数等 |
| Manifest 版本追踪 | 记录每个网区当前运行的 Zone Manifest 版本号 |

### 本模块不负责

| 不负责项 | 归属模块 |
|----------|----------|
| 实例的具体属性管理 | 实例管理模块 (instance-management) |
| 任务定义与下发 | 任务定义模块 (task-definition) |
| 网区内的实时调度与槽位分配 | 协调层 (Zone Coordinator) |
| 数据路由策略执行 | 查询网关 (query-gateway) |
| 节点健康检测 | 实例状态维护 (instance-status) |

## 三、功能清单

### 3.1 网区注册与生命周期

| 功能 | 描述 |
|------|------|
| 创建网区 | 指定 zone_id、名称、描述、存储模式、协调器类型等，生成唯一 zone_id |
| 启用网区 | 将网区状态从 `disabled` 切换为 `active`，允许接收任务和实例 |
| 禁用网区 | 将网区状态切换为 `disabled`，暂停该网区的任务调度（已有采集不受影响） |
| 退役网区 | 将网区标记为 `decommissioned`，触发任务迁移流程，最终归档 |
| 网区状态查询 | 查询单个或全部网区的当前状态及元数据 |

**生命周期状态机：**

```
  [created] ──enable──▶ [active] ──disable──▶ [disabled]
                            │                      │
                            │                      │
                            ▼                      ▼
                      [decommissioning] ──▶ [decommissioned]
```

### 3.2 IP 网段映射

| 功能 | 描述 |
|------|------|
| 添加网段映射 | 为网区绑定一个或多个 IP 网段（CIDR 格式），如 `10.1.0.0/16` |
| 删除网段映射 | 解除网区与某网段的绑定关系 |
| 网段重叠检测 | 新增映射时自动检测是否与已有映射冲突，拒绝重叠 |
| 网段查询 | 给定 IP 地址，返回匹配的网区；给定网区，返回所有关联网段 |
| 网段导入/导出 | 批量导入导出网段映射配置 |

**约束规则：**
- 同一网段不可映射到多个网区（严格不重叠）
- 支持子网段划分：大网段可拆分为子网段分配到不同网区，但父网段不可同时整体映射
- 网段变更需记录审计日志

### 3.3 网区自动推荐

| 功能 | 描述 |
|------|------|
| DNS 解析推荐 | 解析实例主机名的 IP 地址，匹配 IP 网段，推荐所属网区 |
| IP 直接匹配 | 根据实例 IP 直接匹配网段映射表，推荐网区 |
| 推荐置信度 | 返回推荐结果时附带置信度（精确匹配/子网匹配/无匹配） |
| 手动覆盖 | 允许用户忽略自动推荐结果，手动指定网区 |
| 推荐历史记录 | 记录每次推荐的输入、结果、用户最终选择 |

**推荐算法流程：**

```
输入: instance_ip (或 hostname)
  │
  ▼
[1] 如果是 hostname → DNS 解析获取 IP
  │                    解析失败 → 返回 "无法推荐"
  ▼
[2] 精确匹配: 查找包含该 IP 的最具体网段
  │
  ├── 找到唯一匹配 → 返回推荐 (置信度: HIGH)
  ├── 找到多个匹配 → 返回最长前缀匹配 (置信度: MEDIUM)
  └── 无匹配 → 返回 "无匹配网段" (置信度: NONE)
  │
  ▼
[3] 用户确认或手动覆盖
```

### 3.4 网区拓扑维护

| 功能 | 描述 |
|------|------|
| 节点注册 | 记录网区内每个节点的 IP、角色（JS/Agent/OTel/RC/Storage/QP） |
| 节点角色变更 | 更新节点角色（如 Agent → Agent + OTel） |
| 节点移除 | 从网区拓扑中移除节点 |
| 拓扑视图 | 展示网区内完整的节点拓扑图 |
| 拓扑一致性校验 | 定期校验网区拓扑与协调层上报的实际节点是否一致 |

### 3.5 网区元数据管理

| 功能 | 描述 |
|------|------|
| 存储模式设置 | 设置网区的存储模式（A/B/C），影响下游数据流和 RC 部署 |
| HA 配置 | 配置网区的高可用参数（协调器类型、副本数等） |
| 协调器类型 | 记录网区使用的协调器类型（etcd / 自建双节点） |
| 容量参数 | 记录网区的预期节点数、任务容量上限等 |
| 标签管理 | 为网区添加自定义标签（如 env:production, region:cn-east） |

### 3.6 Manifest 版本追踪

| 功能 | 描述 |
|------|------|
| 版本上报接收 | 接收协调层上报的当前 Manifest 版本号 |
| 版本对比 | 对比控制面定义的期望版本与实际运行版本 |
| 版本差异告警 | 当实际版本与期望版本不一致时产生告警 |
| 版本历史 | 记录每个网区的 Manifest 版本变更历史 |

## 四、核心数据模型

### 4.1 Zone（网区）

```sql
CREATE TABLE zone (
    zone_id          VARCHAR(64)   PRIMARY KEY,     -- 全局唯一网区标识
    name             VARCHAR(128)  NOT NULL,         -- 网区名称
    description      TEXT,                           -- 网区描述
    status           ENUM('created', 'active', 'disabled',
                         'decommissioning', 'decommissioned')
                     NOT NULL DEFAULT 'created',
    storage_mode     ENUM('A', 'B', 'C')            -- 存储模式
                     NOT NULL,
    coordinator_type ENUM('etcd', 'dual_node')       -- 协调器类型
                     NOT NULL,
    ha_replicas      INT           NOT NULL DEFAULT 3, -- HA 副本数
    max_nodes        INT,                            -- 预期最大节点数
    max_tasks        INT,                            -- 任务容量上限
    expected_version VARCHAR(64),                    -- 期望 Manifest 版本
    actual_version   VARCHAR(64),                    -- 实际运行版本
    labels           JSON,                           -- 自定义标签
    created_at       TIMESTAMP     NOT NULL,
    updated_at       TIMESTAMP     NOT NULL,
    created_by       VARCHAR(64),
    updated_by       VARCHAR(64)
);
```

### 4.2 ZoneNetworkSegment（网区网段映射）

```sql
CREATE TABLE zone_network_segment (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    zone_id          VARCHAR(64)   NOT NULL,         -- 关联网区
    cidr             VARCHAR(48)   NOT NULL,         -- CIDR 格式网段
    description      TEXT,                           -- 网段描述
    created_at       TIMESTAMP     NOT NULL,
    UNIQUE KEY uk_zone_cidr (zone_id, cidr)
);
```

### 4.3 ZoneNode（网区节点）

```sql
CREATE TABLE zone_node (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    zone_id          VARCHAR(64)   NOT NULL,
    node_id          VARCHAR(64)   NOT NULL,         -- 节点标识
    ip_address       VARCHAR(45)   NOT NULL,         -- 支持 IPv6
    roles            JSON          NOT NULL,         -- ["JS","Agent","OTel","RC","Storage","QP"]
    status           ENUM('active', 'inactive', 'unknown')
                     NOT NULL DEFAULT 'unknown',
    last_heartbeat   TIMESTAMP,
    created_at       TIMESTAMP     NOT NULL,
    updated_at       TIMESTAMP     NOT NULL,
    UNIQUE KEY uk_zone_node (zone_id, node_id)
);
```

### 4.4 ZoneManifestVersion（Manifest 版本历史）

```sql
CREATE TABLE zone_manifest_version (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    zone_id          VARCHAR(64)   NOT NULL,
    version          VARCHAR(64)   NOT NULL,
    applied_at       TIMESTAMP     NOT NULL,
    previous_version VARCHAR(64),
    change_source    VARCHAR(64),                    -- 变更来源
    notes            TEXT
);
```

## 五、接口与交互

### 5.1 上游依赖

| 来源 | 交互内容 | 协议 |
|------|----------|------|
| 实例管理模块 | 新实例注册时调用网段匹配，获取推荐网区 | 内部 API (gRPC/HTTP) |
| 协调层 (Zone Coordinator) | 上报网区实际 Manifest 版本、节点拓扑变更 | gRPC / etcd watch |
| 任务定义模块 | 查询网区存储模式，决定 RC 部署策略 | 内部 API |

### 5.2 下游提供

| 消费方 | 提供内容 | 协议 |
|--------|----------|------|
| 查询网关 | 网区列表、存储模式、Zone Query Proxy 地址 | 内部 API |
| 告警管理 | 网区标签用于告警路由 | 内部 API |
| 凭据服务 | 网区级别的凭据访问控制策略 | 内部 API |

### 5.3 对外 API

```
# 网区 CRUD
POST   /api/v1/zones                    # 创建网区
GET    /api/v1/zones                    # 查询网区列表
GET    /api/v1/zones/{zone_id}          # 查询单个网区
PUT    /api/v1/zones/{zone_id}          # 更新网区
DELETE /api/v1/zones/{zone_id}          # 删除网区（软删除）
POST   /api/v1/zones/{zone_id}/enable   # 启用
POST   /api/v1/zones/{zone_id}/disable  # 禁用

# 网段管理
POST   /api/v1/zones/{zone_id}/segments           # 添加网段
DELETE /api/v1/zones/{zone_id}/segments/{seg_id}   # 删除网段
GET    /api/v1/zones/{zone_id}/segments            # 查询网段列表

# 自动推荐
POST   /api/v1/zones/recommend          # 根据 IP/hostname 推荐网区
  Body: { "ip": "10.1.2.3" } 或 { "hostname": "db-server-01.example.com" }
  Response: { "zone_id": "zone-east-1", "confidence": "HIGH", "matched_segment": "10.1.0.0/16" }

# 网区拓扑
GET    /api/v1/zones/{zone_id}/topology  # 查询网区拓扑
POST   /api/v1/zones/{zone_id}/nodes     # 注册节点
DELETE /api/v1/zones/{zone_id}/nodes/{node_id}  # 移除节点

# Manifest 版本
GET    /api/v1/zones/{zone_id}/manifest-version   # 查询当前版本
PUT    /api/v1/zones/{zone_id}/manifest-version   # 上报版本（协调层调用）
```

## 六、设计决策与替代方案

### 6.1 网区 ID 生成策略 [已确认]

**决策：** 使用人类可读的 zone_id（如 `zone-east-1`、`zone-edge-sh-01`），而非纯数字或 UUID。

**理由：**
- zone_id 会出现在大量配置、日志、告警标签中，可读性至关重要
- 网区数量有限（通常数十到数百），不存在 ID 冲突风险
- 通过数据库唯一约束保证全局唯一性

**替代方案：** UUID — 全局唯一但不可读，在日志和配置中难以辨识。

### 6.2 网段重叠检测策略 [已确认]

**决策：** 严格不重叠模式。同一 IP 地址只能属于一个网区。

**理由：**
- 简化实例到网区的映射逻辑，无需处理"多网区匹配"的歧义
- 与网络实际拓扑一致——一个物理网段通常只属于一个管理域

**替代方案：** 允许重叠 + 最长前缀匹配 — 更灵活但增加复杂度。对于初期版本，严格模式更安全。

### 6.3 存储模式运行时变更 [待确认]

**决策（待确认）：** 允许在运行时变更网区存储模式，但需要满足前置条件。

**变更影响分析：**

| 变更方向 | 影响 | 前置条件 |
|----------|------|----------|
| A → B | 需部署本地 VM，OTel 配置需增加本地写入 | 本地 VM 已部署并验证 |
| A → C | 需部署 VM 集群，OTel 配置全面变更 | VM 集群已部署 |
| B → A | 本地 VM 数据需决策（保留/迁移/丢弃） | 数据处置方案已确认 |
| B → C | 本地 VM 升级为集群 | VM 集群已部署 |
| C → B | 集群降级为单节点 | 数据迁移完成 |
| C → A | 需确认数据处置 | 数据处置方案已确认 |

**替代方案：** 禁止运行时变更，必须新建网区并迁移 — 更安全但运维成本高。

### 6.4 自动推荐 vs 手动指定策略 [建议]

**建议：** 自动推荐作为辅助，最终网区分配必须经过用户确认。

**理由：**
- 自动推荐可能因 DNS 解析延迟、IP 复用等原因产生误判
- 网区分配影响数据流、告警路由等关键路径，不应全自动
- 推荐 + 确认模式兼顾效率和准确性

### 6.5 网区数量规模预期 [待确认]

**问题：** 系统预期管理的网区数量上限是多少？

**影响：**
- < 100 个网区：单表存储，简单查询即可
- 100-1000 个网区：需要考虑查询优化、缓存
- > 1000 个网区：可能需要分区或分层管理

## 七、冲突与开放问题

### MC-01: 任务定义归属权 [待确认]

**冲突描述：** 网区管理定义了网区的任务容量上限（max_tasks），但实际的任务定义和分配由协调层执行。当网区容量不足时，是由控制面拒绝新任务定义，还是由协调层拒绝调度？

**建议解决方案：** 控制面负责"定义"层面的容量校验（预检查），协调层负责"执行"层面的容量控制（实际拒绝）。两者通过容量水位线协调。

### MC-02: 网区自动推荐准确性 vs 手动覆盖策略 [待确认]

**冲突描述：** 自动推荐基于 IP 网段匹配，但实际部署中可能存在：
- 跨网区部署的服务器（IP 属于 A 网区，但物理位置在 B 网区）
- VPN/NAT 环境下的 IP 地址不反映真实网络位置
- 新网段尚未录入映射表

**待决策：** 当自动推荐置信度为 MEDIUM 或 NONE 时，是否应阻止实例注册，还是允许用户手动指定？

### MC-03: 网区退役的数据处置 [待确认]

**冲突描述：** 网区退役时，该网区内的时序数据如何处理？
- Mode A：数据在中心 VM，无需额外处理
- Mode B/C：本地 VM 中的数据是否需要迁移到中心？保留多久？

### MC-04: 网段映射与实例 IP 变更 [待确认]

**冲突描述：** 当实例 IP 变更（如 DHCP 续租获得新 IP）时，是否需要重新评估其网区归属？如果需要，由谁触发？

### MC-05: 网区标签与实例标签的关系 [待确认]

**冲突描述：** 网区标签是否应自动继承到该网区内的所有实例？还是实例标签完全独立？
