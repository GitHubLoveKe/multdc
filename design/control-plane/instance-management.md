# 实例管理 (Instance Management)

## 一、概述

实例管理模块是中心控制面的核心台账模块，作为所有被监控实例的**全局唯一信息源**（Single Source of Truth）。它维护每个被监控目标（数据库服务器、操作系统、网络设备、自定义目标等）的完整元数据，包括连接信息、类型分类、网区归属、采集配置模板等。

实例管理模块与网区管理模块紧密协作——网区管理回答"在哪里"，实例管理回答"是什么"和"怎么采"。同时，它通过标签系统与任务定义模块关联，实现任务的灵活选择与匹配。

```
  ┌──────────────────────────────────────────────────────┐
  │                   中心控制面 (RDS)                     │
  │                                                      │
  │  ┌─────────────┐    ┌─────────────┐                 │
  │  │  网区管理    │◄───│  实例管理    │                 │
  │  │  (在哪)      │    │  (是什么)    │                 │
  │  └─────────────┘    └──────┬──────┘                 │
  │                            │                         │
  │              ┌─────────────┼─────────────┐          │
  │              ▼             ▼             ▼          │
  │        ┌─────────┐  ┌─────────┐  ┌─────────┐      │
  │        │ 任务定义 │  │ 凭据服务 │  │ 状态维护 │      │
  │        │(标签匹配)│  │(凭据引用)│  │(状态同步)│      │
  │        └─────────┘  └─────────┘  └─────────┘      │
  └──────────────────────────────────────────────────────┘
```

## 二、职责边界

### 本模块负责

| 职责 | 说明 |
|------|------|
| 实例台账维护 | 所有被监控实例的注册、属性管理、生命周期 |
| 实例分类 | 按类型（Oracle/MySQL/Linux/Windows/网络设备/自定义）分类管理 |
| 网区归属 | 维护实例与网区的映射关系（通过自动推荐或手动指定） |
| 采集配置模板 | 为不同类型实例维护标准采集配置模板 |
| 快速测试 | 在正式接入前，通过 Agent 执行一次性测试采集 |
| 批量操作 | 支持批量导入/导出、批量标签分配 |
| 标签管理 | 实例级别的标签管理，标签流入 TaskSpec 选择器匹配 |

### 本模块不负责

| 不负责项 | 归属模块 |
|----------|----------|
| 实例的实时运行状态 | 实例状态维护模块 (instance-status) |
| 实例的网段到网区映射 | 网区管理模块 (zone-management) |
| 实际的采集任务调度 | 协调层 (Zone Coordinator) + 数据层 (Job Scheduler) |
| 凭据的实际存储 | 凭据服务 (credential-service) |
| 采集数据的存储与查询 | 数据层 (OTel Collector + VM) |

## 三、功能清单

### 3.1 实例注册与生命周期

| 功能 | 描述 |
|------|------|
| 手动注册 | 通过 Web UI / API 手动添加实例，填写 IP、端口、类型、凭据引用等 |
| 批量导入 | 通过 CSV/Excel/JSON 批量导入实例 |
| 自动发现 | （未来）支持从 CMDB、云平台 API 自动发现实例 |
| 生命周期管理 | 管理实例状态流转：pending → testing → active → suspended → decommissioned |
| 批量导出 | 导出实例列表为 CSV/JSON |

**生命周期状态机：**

```
                  ┌──────────┐
                  │ pending  │  ← 新注册
                  └────┬─────┘
                       │ 触发快速测试
                       ▼
                  ┌──────────┐
            ┌─────│ testing  │
            │     └────┬─────┘
            │ 测试失败  │ 测试成功
            ▼          ▼
       ┌────────┐ ┌──────────┐
       │pending │ │ active   │ ← 正式采集中
       │(修复后 │ └────┬─────┘
       │ 重测)  │      │
       └────────┘      │
                  ┌────┴──────────┐
                  ▼               ▼
           ┌───────────┐  ┌──────────────┐
           │ suspended │  │decommissioned│
           └───────────┘  └──────────────┘
```

**状态说明：**
- `pending`：已注册但未测试，或测试失败待修复
- `testing`：正在进行快速测试
- `active`：测试通过，正在被正式采集
- `suspended`：暂停采集（维护、故障等），配置保留
- `decommissioned`：已退役，配置归档

### 3.2 实例分类与属性

| 功能 | 描述 |
|------|------|
| 类型定义 | 预定义实例类型：Oracle、MySQL、PostgreSQL、Linux、Windows、NetworkDevice、Custom |
| 类型属性模板 | 每种类型有标准属性集（如 Oracle 需要 SID/Service Name，MySQL 需要 port/socket） |
| 自定义属性 | 支持为实例添加自定义键值对属性 |
| 凭据引用 | 实例关联 credential_id，不存储实际凭据 |
| 连接参数 | IP、端口、连接超时、采集间隔等连接相关配置 |

**预定义实例类型及关键属性：**

| 类型 | 关键属性 | 所需 Agent 类型 |
|------|----------|----------------|
| Oracle | SID/Service Name, Port(1521), PDB 名称 | oracle-agent |
| MySQL | Port(3306), Socket 路径 | mysql-agent |
| PostgreSQL | Port(5432), Database 名称 | postgres-agent |
| Linux | SSH Port(22), 认证方式 | node-exporter / ssh-agent |
| Windows | WMI/WinRM Port, 认证方式 | windows-agent |
| NetworkDevice | SNMP Version, Community/Index | snmp-agent |
| Custom | 自定义 endpoint, 采集协议 | custom-agent |

### 3.3 快速测试 (Quick Test)

| 功能 | 描述 |
|------|------|
| 连通性测试 | 验证从目标网区 Agent 到实例的网络连通性 |
| 认证测试 | 验证凭据是否有效 |
| 采集测试 | 执行一次完整的采集，返回采集到的指标样本 |
| 数据质量评估 | 对测试采集结果进行基本质量评估（指标数量、数据完整性） |
| 测试报告 | 生成测试报告，包含通过/失败项及详细信息 |

**快速测试流程：**

```
  用户触发快速测试
       │
       ▼
  [控制面] 确定目标网区 → 选择可用 Agent
       │
       ▼
  [控制面 → 协调层] 请求目标网区分配测试任务
       │
       ▼
  [协调层 → 数据层] Job Scheduler 调度 Agent 执行测试
       │
       ▼
  [Agent] 执行测试采集:
       ├── 1. 网络连通性检查 (TCP connect)
       ├── 2. 认证验证 (login/auth)
       ├── 3. 指标采集 (单次 scrape)
       └── 4. 结果封装
       │
       ▼
  [Agent → 协调层 → 控制面] 返回测试结果
       │
       ▼
  [控制面] 生成测试报告
       ├── 连通性: OK / FAIL (原因)
       ├── 认证: OK / FAIL (原因)
       ├── 采集: OK / FAIL (原因)
       ├── 指标样本: [前 10 条指标]
       └── 质量评估: 指标数=N, 覆盖率=X%
```

**超时与异常处理：**
- 整体超时：30 秒
- 连通性测试超时：5 秒
- 认证测试超时：10 秒
- 采集测试超时：15 秒
- 任一环节失败即终止后续步骤，返回失败原因

### 3.4 标签管理

| 功能 | 描述 |
|------|------|
| 标签添加/删除 | 为实例添加/删除键值对标签 |
| 批量标签 | 批量为多个实例添加相同标签 |
| 标签继承 | 自动继承网区标签（如 zone=east-1） |
| 标签查询 | 按标签组合查询实例列表 |
| 标签建议 | 根据已有标签模式提供自动补全建议 |

**标签来源优先级：**
1. 用户手动设置的标签（最高优先级）
2. 网区自动继承的标签
3. 类型默认标签（如 type=oracle）

### 3.5 采集配置模板

| 功能 | 描述 |
|------|------|
| 预置模板 | 为每种实例类型提供预置采集配置模板 |
| 模板定制 | 用户可基于预置模板定制采集配置 |
| 模板版本 | 模板支持版本管理，更新不影响已绑定实例 |
| 模板绑定 | 实例可绑定一个采集配置模板 |

### 3.6 实例-to-网区映射

| 功能 | 描述 |
|------|------|
| 自动映射 | 新实例注册时，调用网区管理的自动推荐功能 |
| 手动指定 | 用户可手动选择实例所属网区 |
| 映射变更 | 支持变更实例的网区归属（触发任务迁移） |
| 映射校验 | 校验实例 IP 是否属于目标网区的网段范围 |

## 四、核心数据模型

### 4.1 Instance（实例）

```sql
CREATE TABLE instance (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    instance_id      VARCHAR(64)   NOT NULL UNIQUE,  -- 全局唯一实例标识
    name             VARCHAR(256)  NOT NULL,          -- 实例名称
    instance_type    VARCHAR(32)   NOT NULL,          -- 类型: oracle/mysql/linux/...
    ip_address       VARCHAR(45)   NOT NULL,          -- IP 地址
    port             INT,                             -- 端口
    zone_id          VARCHAR(64),                     -- 所属网区 (FK → zone)
    status           ENUM('pending', 'testing', 'active',
                         'suspended', 'decommissioned')
                     NOT NULL DEFAULT 'pending',
    credential_id    VARCHAR(64),                     -- 凭据引用 (FK → credential)
    config_template_id VARCHAR(64),                   -- 采集配置模板 ID
    connection_config JSON,                           -- 连接参数 (超时/重试等)
    custom_attributes JSON,                          -- 自定义属性
    labels           JSON,                           -- 标签
    description      TEXT,
    last_test_at     TIMESTAMP,                      -- 最近测试时间
    last_test_result ENUM('pass', 'fail', 'unknown'),
    created_at       TIMESTAMP     NOT NULL,
    updated_at       TIMESTAMP     NOT NULL,
    created_by       VARCHAR(64),
    updated_by       VARCHAR(64)
);

-- 索引: 按类型查询、按网区查询、按标签查询
CREATE INDEX idx_instance_type ON instance(instance_type);
CREATE INDEX idx_instance_zone ON instance(zone_id);
CREATE INDEX idx_instance_status ON instance(status);
```

### 4.2 InstanceTypeDefinition（实例类型定义）

```sql
CREATE TABLE instance_type_definition (
    type_id          VARCHAR(32)   PRIMARY KEY,       -- 类型标识
    name             VARCHAR(64)   NOT NULL,          -- 类型名称
    agent_type       VARCHAR(32)   NOT NULL,          -- 所需 Agent 类型
    default_port     INT,                             -- 默认端口
    required_fields  JSON          NOT NULL,          -- 必填字段定义
    optional_fields  JSON,                            -- 可选字段定义
    description      TEXT,
    is_builtin       BOOLEAN       NOT NULL DEFAULT FALSE
);
```

### 4.3 ConfigTemplate（采集配置模板）

```sql
CREATE TABLE config_template (
    template_id      VARCHAR(64)   PRIMARY KEY,
    name             VARCHAR(128)  NOT NULL,
    instance_type    VARCHAR(32)   NOT NULL,          -- 适用实例类型
    version          INT           NOT NULL DEFAULT 1,
    config_spec      JSON          NOT NULL,          -- 采集配置 (Prometheus scrape_config 格式)
    description      TEXT,
    is_default       BOOLEAN       NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMP     NOT NULL,
    updated_at       TIMESTAMP     NOT NULL
);
```

### 4.4 QuickTestRecord（快速测试记录）

```sql
CREATE TABLE quick_test_record (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    instance_id      VARCHAR(64)   NOT NULL,
    zone_id          VARCHAR(64)   NOT NULL,          -- 执行测试的网区
    agent_node_id    VARCHAR(64),                     -- 执行测试的 Agent 节点
    status           ENUM('running', 'passed', 'failed', 'timeout', 'error'),
    connectivity     JSON,                            -- { status, latency_ms, error }
    authentication   JSON,                            -- { status, error }
    collection       JSON,                            -- { status, metric_count, sample_metrics, error }
    quality_report   JSON,                            -- { score, details }
    started_at       TIMESTAMP     NOT NULL,
    completed_at     TIMESTAMP,
    duration_ms      INT
);
```

## 五、接口与交互

### 5.1 上游依赖

| 来源 | 交互内容 | 协议 |
|------|----------|------|
| 网区管理模块 | 查询网区列表、获取推荐网区、校验 IP 归属 | 内部 API |
| 凭据服务 | 验证 credential_id 是否有效（不获取实际凭据） | 内部 API |
| 用户 (Web UI / API) | 实例注册、配置变更、快速测试触发 | REST API |

### 5.2 下游提供

| 消费方 | 提供内容 | 协议 |
|--------|----------|------|
| 任务定义模块 | 实例列表、标签、类型信息（用于 TaskSpec 选择器匹配） | 内部 API |
| 协调层 | 实例连接信息、凭据引用、采集配置（通过 Manifest 下发） | Manifest 推送 |
| 实例状态维护 | 实例列表及网区归属（用于确定查询目标） | 内部 API |
| 查询网关 | 实例-to-网区映射（用于查询路由） | 内部 API |

### 5.3 对外 API

```
# 实例 CRUD
POST   /api/v1/instances                    # 注册实例
GET    /api/v1/instances                    # 查询实例列表 (支持标签/类型/网区过滤)
GET    /api/v1/instances/{instance_id}      # 查询单个实例
PUT    /api/v1/instances/{instance_id}      # 更新实例
DELETE /api/v1/instances/{instance_id}      # 删除实例 (软删除)

# 生命周期操作
POST   /api/v1/instances/{instance_id}/test           # 触发快速测试
GET    /api/v1/instances/{instance_id}/test/result     # 查询测试结果
POST   /api/v1/instances/{instance_id}/activate        # 激活
POST   /api/v1/instances/{instance_id}/suspend         # 暂停
POST   /api/v1/instances/{instance_id}/resume          # 恢复
POST   /api/v1/instances/{instance_id}/decommission    # 退役

# 批量操作
POST   /api/v1/instances/import            # 批量导入
GET    /api/v1/instances/export            # 批量导出
POST   /api/v1/instances/batch-labels      # 批量标签操作

# 标签
PUT    /api/v1/instances/{instance_id}/labels       # 更新标签
DELETE /api/v1/instances/{instance_id}/labels/{key}  # 删除标签

# 配置模板
GET    /api/v1/config-templates             # 查询模板列表
POST   /api/v1/config-templates             # 创建模板
GET    /api/v1/config-templates/{template_id} # 查询模板

# 实例类型
GET    /api/v1/instance-types               # 查询支持的实例类型
```

### 5.4 快速测试跨平面交互序列

```
  用户          控制面              协调层(目标网区)       数据层(Agent)
   │              │                      │                    │
   │──触发测试──▶│                      │                    │
   │              │──分配测试任务──────▶│                    │
   │              │   (instance_config,  │                    │
   │              │    credential_ref)   │──调度Agent执行───▶│
   │              │                      │                    │
   │              │                      │                    │──TCP Connect
   │              │                      │                    │──Auth
   │              │                      │                    │──Scrape
   │              │                      │                    │
   │              │                      │◀──测试结果────────│
   │              │◀──测试结果──────────│                    │
   │◀──测试报告──│                      │                    │
   │              │                      │                    │
```

## 六、设计决策与替代方案

### 6.1 实例状态：实时 vs 周期同步 [待确认]

**决策（待确认）：** 实例状态（active/suspended 等管理状态）由控制面维护，运行时健康状态由实例状态维护模块周期同步。

**两种方案对比：**

| 维度 | 方案 A: 实时 Webhook | 方案 B: 周期同步 |
|------|---------------------|-----------------|
| 实时性 | 高（秒级） | 中（分钟级） |
| 实现复杂度 | 高（需双向通信） | 低（单向拉取） |
| 控制面负载 | 高（事件驱动） | 低（周期批量） |
| 降级友好 | 差（依赖协调层可达） | 好（控制面独立运行） |

**建议：** 管理状态（active/suspended）由控制面独立维护，不依赖实时同步。运行时健康状态通过周期同步获取。

### 6.2 实例-to-网区映射策略 [建议]

**建议：** 混合模式——自动推荐 + 手动确认 + 允许强制覆盖。

**策略：**
1. 新实例注册时，自动调用网区管理的推荐接口
2. 推荐结果置信度为 HIGH 时，预填充推荐结果，用户可修改
3. 推荐结果置信度为 MEDIUM/NONE 时，要求用户手动选择
4. 允许用户强制将实例分配到任意网区（即使 IP 不在该网区网段内）

### 6.3 快速测试的执行方式 [已确认]

**决策：** 快速测试通过目标网区的 Agent 执行，而非控制面直接连接。

**理由：**
- 控制面可能无法直接访问目标实例（网络隔离）
- 测试应模拟真实采集环境，使用相同网区的 Agent 最能反映实际情况
- 复用现有调度通道，无需建立新的通信路径

### 6.4 实例 ID 生成策略 [已确认]

**决策：** 使用 `{type_prefix}-{auto_increment}` 格式（如 `ora-00001`、`mysql-00042`），兼顾可读性和唯一性。

**替代方案：**
- 纯自增 ID：简洁但不可读
- UUID：全局唯一但过长
- `{type}-{ip}-{port}` 组合：信息丰富但可能变更

### 6.5 采集配置模板格式 [建议]

**建议：** 模板使用 Prometheus scrape_config 的 JSON 序列化格式，确保与生态兼容。

## 七、冲突与开放问题

### MC-01: 实例-to-网区映射：自动 vs 手动 vs 混合 [待确认]

**冲突描述：** 完全自动（基于 IP 网段）可能不准确（VPN/NAT/跨区部署），完全手动效率低且易出错。

**待决策：** 是否允许同一 IP 注册为多个实例（如不同端口运行不同数据库）？

### MC-02: 快速测试的跨平面协调 [待确认]

**冲突描述：** 快速测试需要控制面 → 协调层 → 数据层 → 回传的完整链路。当协调层不可达时（L1 降级），快速测试不可用。

**待决策：**
- 是否需要支持控制面直连测试（绕过协调层，仅适用于网络可达的场景）？
- 快速测试失败是否应阻止实例注册？还是允许注册为 pending 状态？

### MC-03: 批量操作的规模限制 [待确认]

**冲突描述：** 批量导入可能涉及数千个实例，需要考虑：
- 单次导入上限
- 导入过程中的校验策略（全部校验 vs 逐条校验）
- 部分失败的处理策略（全部回滚 vs 成功部分入库）

### MC-04: 实例标签与 TaskSpec 选择器的匹配语义 [待确认]

**冲突描述：** 实例标签用于 TaskSpec 的 selector 匹配，需要明确：
- 匹配语义是 AND 还是 OR？（建议：同一 selector 内 AND，多 selector 间 OR）
- 标签变更是否应立即触发任务重新分配？还是等待下一个同步周期？

### MC-05: 采集配置模板与 TaskSpec 的关系 [待确认]

**冲突描述：** 采集配置模板定义了"怎么采"，TaskSpec 定义了"采什么"。两者的关系需要明确：
- 模板是否是 TaskSpec 的一部分？
- 一个 TaskSpec 是否可以引用多个模板？
- 模板更新是否影响已绑定的 TaskSpec？
