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
| 多 DC 模式 | 类型级别配置多网区关联能力（disabled/optional/required），控制前端 DC 选择器行为 |
| 自定义属性 | 支持为实例添加自定义键值对属性 |
| 凭据引用 | 实例关联 credential_id，不存储实际凭据 |
| 连接参数 | IP、端口、连接超时、采集间隔等连接相关配置 |

**预定义实例类型及关键属性：**

| 类型 | 关键属性 | 所需 Agent 类型 | multi_zone_mode |
|------|----------|----------------|-----------------|
| Oracle | SID/Service Name, Port(1521), PDB 名称 | oracle-agent | disabled |
| MySQL | Port(3306), Socket 路径 | mysql-agent | disabled |
| PostgreSQL | Port(5432), Database 名称 | postgres-agent | disabled |
| Linux | SSH Port(22), 认证方式 | node-exporter / ssh-agent | disabled |
| Windows | WMI/WinRM Port, 认证方式 | windows-agent | disabled |
| NetworkDevice | SNMP Version, Community/Index | snmp-agent | disabled |
| DialTest | 目标 URL/IP, 拨测协议, 拨测端口 | dial-test-agent | optional |
| Custom | 自定义 endpoint, 采集协议 | custom-agent | optional |

> `multi_zone_mode` 为类型级别的默认值，管理员可在类型定义中调整。前端根据该配置自动切换 DC 选择器的单选/多选模式。

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

#### 3.6.1 基础映射能力

| 功能 | 描述 |
|------|------|
| 自动映射 | 新实例注册时，调用网区管理的自动推荐功能，根据 IP/域名自动勾选推荐 DC |
| 手动指定 | 用户可手动选择/改选实例所属网区 |
| 映射变更 | 支持变更实例的网区归属（触发任务迁移） |
| 映射校验 | 校验实例 IP 是否属于目标网区的网段范围 |
| 多 DC 关联 | 当实例类型的 `multi_zone_mode` 为 optional/required 时，支持关联多个 DC |

#### 3.6.2 多 DC 映射

实例与 DC 的关系分两种模式：

- **单 DC 模式（多对一）**：`multi_zone_mode = disabled` 的类型，实例有明确的 IP 地址，根据网段自动推荐唯一归属 DC。`instance.zone_id` 即为主归属 DC。
- **多 DC 模式（多对多）**：`multi_zone_mode = optional/required` 的类型（如跨区域拨测），实例需要关联多个 DC 同时采集。通过 `instance_zone_mapping` 表维护多对多关联。

**`multi_zone_mode` 三种模式：**

| 模式 | 含义 | DC 选择器行为 |
|------|------|--------------|
| `disabled` | 单 DC | 单选，自动推荐预填 |
| `optional` | 可选多 DC，最少选一个 | 多选，推荐结果预填，用户可追加 |
| `required` | 强制多 DC，至少选两个 | 多选，前端校验至少选两个 |

#### 3.6.3 添加实例完整交互流程

```
1. 用户选择实例类型（如 mysql）
   → 表单加载该类型专属字段
   → 读取 multi_zone_mode 决定 DC 选择器模式（单选/多选）

2. 用户填入目标地址（IP 或域名）

3. 系统调用 /api/v1/zones/recommend → DC 候选框自动勾选推荐项

4. 用户可手动改选；若 multi_zone_mode 为 optional/required，可追加多个 DC

5. 每选中一个 DC，系统实时检查该 DC 下 Agent 的 PluginInventory
   → 校验结果实时展示（就绪/缺失）

6. 用户点保存：
   → 插件就绪的 DC → mapping status = active，任务正常下发
   → 插件缺失的 DC → mapping status = unavailable，不下发任务
```

#### 3.6.4 三方插件可用性校验

添加实例时，若所选类型涉及三方插件采集，系统检查每个选中 DC 的 Agent PluginInventory（Agent 启动时、状态变更时、每 30s 上报给 Job Scheduler）。

**校验结果与交互：**

| 情况 | 前端行为 |
|------|---------|
| 全部 DC 插件就绪 | 无提示，正常保存 |
| 部分 DC 缺少插件 | 黄色警告："zone-west-1 未安装 mysql-exporter 插件，该 DC 采集将不可用"，用户可继续保存 |
| 全部 DC 缺少插件 | 同上警告，用户仍可保存 |

**保存后行为：**

- 插件就绪的 DC → `instance_zone_mapping.status = active`，Job Scheduler 正常下发 CollectionInstruction
- 插件缺失的 DC → `instance_zone_mapping.status = unavailable`，Job Scheduler 不下发该 DC 的任务

**自动恢复：** 用户在缺失 DC 安装插件后，Agent 上报 PluginInventory 变更，系统检测到对应实例所需插件已就绪，自动将 mapping status 从 `unavailable` 翻为 `active`（或提示用户手动确认激活）。

#### 3.6.5 前端展示

平台端实例列表平铺展示（不按 DC 分组折叠），DC 作为可筛选/可排序的列。提供两种视图切换（纯前端行为，不涉及后端 API）：

- **聚合视图（默认）**：一个实例一行，DC 列以标签形式展示所有关联 DC，整体状态取"任一 DC active 即 active"
- **按 DC 展开视图**：一个实例在每个关联 DC 下各占一行，便于运维查看每个 DC 的采集状态

#### 3.6.6 多 DC 实例的协调层行为

**Job 渲染仍由各 DC 的协调层独立完成。** 控制面将实例配置（含多 DC 映射）写入各关联 DC 的 Manifest，每个 DC 的 Zone Coordinator 独立渲染本区内的采集任务——槽位分配、Agent 选择、调度策略都在各自 DC 内闭环，与单 DC 实例的渲染逻辑完全一致，无需新增跨区协调逻辑。

**RC 策略需下发到所有关联 DC。** 多 DC 实例的告警/规则检查策略，控制面在构建 Manifest 时，将该实例的 RC 规则包推送到所有关联的 DC（不只是 primary），确保每个 DC 都能独立执行规则检查。

**控制面 Manifest 构建逻辑：**

```
对于每个 DC 的 Manifest 构建：
  1. 查询 instance_zone_mapping WHERE zone_id = 当前DC AND status = 'active'
  2. 将所有 active 的实例（无论 primary 还是 secondary）纳入该 DC 的 Manifest
  3. 对应的 RC 规则包同步纳入
  4. unavailable 的 mapping 不纳入 Manifest，不下发
```

**数据归属：** 各 DC 采集的数据按现有存储模式（A/B/C）写入各自的存储，查询时通过查询网关按 instance_id 聚合——与单 DC 实例的查询路径一致，只是结果来自多个 DC。

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
    multi_zone_mode  ENUM('disabled', 'optional', 'required')
                     NOT NULL DEFAULT 'disabled',     -- 多 DC 模式
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

### 4.5 InstanceZoneMapping（实例-网区多 DC 映射）

```sql
CREATE TABLE instance_zone_mapping (
    id          BIGINT       PRIMARY KEY AUTO_INCREMENT,
    instance_id VARCHAR(64)  NOT NULL,               -- FK → instance
    zone_id     VARCHAR(64)  NOT NULL,               -- FK → zone
    role        ENUM('primary', 'secondary') NOT NULL DEFAULT 'primary',
    -- primary: 主归属 DC（与 instance.zone_id 一致）
    -- secondary: 额外关联的 DC（拨测等场景）
    status      ENUM('active', 'unavailable') NOT NULL DEFAULT 'active',
    -- active: 该 DC 下插件就绪，正常下发任务
    -- unavailable: 该 DC 下插件未就绪，不下发任务
    created_at  TIMESTAMP    NOT NULL,
    UNIQUE KEY uk_inst_zone (instance_id, zone_id)
);

CREATE INDEX izm_idx_zone ON instance_zone_mapping(zone_id);
CREATE INDEX izm_idx_status ON instance_zone_mapping(status);
```

> `instance.zone_id` 保留作为主归属 DC，用于查询路由、标签继承等单值场景。`instance_zone_mapping` 中 `role = 'primary'` 的记录与 `instance.zone_id` 保持一致。

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
| 协调层 | 实例连接信息、凭据引用、采集配置（通过 Manifest 下发）；多 DC 实例按 `instance_zone_mapping` 展开，纳入所有 active 的 DC 的 Manifest | Manifest 推送 |
| 协调层 (RC) | 多 DC 实例的 RC 规则包下发到所有关联 DC，确保每个 DC 独立执行规则检查 | Manifest 推送 |
| 实例状态维护 | 实例列表及网区归属（用于确定查询目标） | 内部 API |
| 查询网关 | 实例-to-网区映射（用于查询路由）；多 DC 实例的查询需聚合多个 DC 的结果 | 内部 API |

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

# 多 DC 映射
GET    /api/v1/instances/{instance_id}/zones            # 查询实例关联的所有 DC
POST   /api/v1/instances/{instance_id}/zones            # 添加 DC 关联
DELETE /api/v1/instances/{instance_id}/zones/{zone_id}  # 移除 DC 关联
PUT    /api/v1/instances/{instance_id}/zones/{zone_id}  # 更新 DC 关联（如手动激活）

# 插件可用性校验
POST   /api/v1/instances/check-plugin-availability      # 批量校验插件可用性
  Body: { "instance_type": "mysql", "zone_ids": ["zone-east-1", "zone-west-1"] }
  Response: {
    "results": [
      { "zone_id": "zone-east-1", "plugin": "mysql-exporter", "status": "available", "agent_count": 3 },
      { "zone_id": "zone-west-1", "plugin": "mysql-exporter", "status": "unavailable", "agent_count": 0 }
    ]
  }

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
GET    /api/v1/instance-types               # 查询支持的实例类型（含 multi_zone_mode）
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

### 5.5 多 DC 实例 Manifest 分发交互序列

```
  控制面              协调层(Zone-A)        协调层(Zone-B)
   │                      │                    │
   │──构建 Manifest──▶   │                    │
   │  (instance + RC规则) │                    │
   │                      │                    │
   │──构建 Manifest──────────────────────────▶│
   │  (instance + RC规则) │                    │
   │                      │                    │
   │  [Zone-A 独立渲染]   │                    │
   │  ├── 槽位分配        │                    │
   │  ├── Agent 选择      │                    │
   │  └── 任务调度        │                    │
   │                      │                    │
   │                      │  [Zone-B 独立渲染] │
   │                      │  ├── 槽位分配      │
   │                      │  ├── Agent 选择    │
   │                      │  └── 任务调度      │
   │                      │                    │
   │  [各自独立采集，数据按存储模式写入]        │
   │                      │                    │
   │  [查询网关按 instance_id 聚合多 DC 结果]  │
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

### 6.2 实例-to-网区映射策略 [已确认]

**决策：** 混合模式——自动推荐 + 手动确认 + 允许强制覆盖。多 DC 场景由类型定义的 `multi_zone_mode` 驱动。详见 3.6 节。

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

### 6.6 多 DC 映射：类型驱动 vs 实例驱动 [已确认]

**决策：** 多 DC 能力由类型定义（`instance_type_definition.multi_zone_mode`）驱动，而非实例级别配置。

**理由：**
- 同类型实例的多 DC 需求具有一致性（拨测天然需要多 DC，MySQL 通常单 DC）
- 类型级别配置可驱动前端 UI 行为（选择器模式切换），无需逐实例判断
- 管理员调整类型配置即可影响该类型下所有新实例，运维成本低

**替代方案：** 实例级别 `multi_zone_enabled` 布尔标记 — 更灵活但增加逐实例配置负担，且同一类型的实例行为通常一致。

### 6.7 多 DC 实例的协调层职责划分 [已确认]

**决策：** 多 DC 实例的 Job 渲染仍由各 DC 的协调层独立完成，控制面负责将实例配置分发到所有关联 DC 的 Manifest。

**理由：**
- 各 DC 的 Zone Coordinator 已有完整的任务渲染能力（槽位分配、Agent 选择、调度），无需新增跨区协调逻辑
- RC 策略下发到所有关联 DC，确保每个 DC 独立执行规则检查
- 控制面按 `instance_zone_mapping` 展开构建各 DC 的 Manifest，逻辑简单且与现有流程一致

### 6.8 插件不可用时的状态粒度 [已确认]

**决策：** 可用性状态（active/unavailable）放在 `instance_zone_mapping` 表上，粒度为每个 DC 独立，而非放在 `instance` 表上。

**理由：**
- 多 DC 场景下，不同 DC 的插件可用性独立（DC-A 插件就绪、DC-B 插件缺失）
- 某个 DC 不可用不影响其他 DC 的正常采集
- 插件补齐后可自动或手动恢复单个 DC 的 mapping 状态，无需重新配置整个实例

## 七、冲突与开放问题

### MC-01: 实例-to-网区映射：自动 vs 手动 vs 混合 [已确认]

**已确认：** 采用混合模式——自动推荐 + 手动确认 + 允许强制覆盖 + 类型驱动的多 DC 关联。详见 3.6 节和 6.6 节。

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
