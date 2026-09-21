# 凭据服务 (Credential Service)

## 一、概述

凭据服务是中心控制面的安全基础设施模块，负责安全地存储、管理和分发所有被监控实例的认证凭据（数据库密码、SSH 密钥、SNMP Community String、API Token 等）。该模块遵循**凭据与配置分离**的核心原则——TaskSpec 和 Zone Manifest 中仅包含凭据引用（credential_id），而非实际凭据值。

在三层架构中，凭据服务是控制面的独占模块，所有凭据的存储和管理集中在中心，数据层 Agent 在执行采集时按需获取凭据。这种集中式凭据管理确保了安全审计的统一性和凭据轮换的可控性。

```
  ┌──────────────────────────────────────────────────────────────┐
  │                       中心控制面                              │
  │                                                              │
  │  ┌──────────────────────────────────────────────────┐       │
  │  │                 凭据服务模块                      │       │
  │  │                                                  │       │
  │  │  ┌──────────┐ ┌──────────┐ ┌──────────────┐    │       │
  │  │  │ 凭据存储  │ │ 访问控制  │ │ 凭据轮换     │    │       │
  │  │  │ (加密)    │ │ (RBAC)   │ │ (计划/应急)  │    │       │
  │  │  └────┬─────┘ └────┬─────┘ └──────┬───────┘    │       │
  │  │       │            │              │             │       │
  │  │  ┌────┴────────────┴──────────────┴──────┐     │       │
  │  │  │           审计日志                     │     │       │
  │  │  └───────────────────────────────────────┘     │       │
  │  └──────────────────────────────────────────────────┘       │
  │                          │                                   │
  └──────────────────────────┼───────────────────────────────────┘
                             │
            ┌────────────────┼────────────────┐
            ▼                ▼                ▼
     ┌──────────┐    ┌──────────┐    ┌──────────┐
     │ 实例管理  │    │ Manifest │    │  Agent   │
     │(凭据引用) │    │(凭据引用) │    │(按需获取) │
     └──────────┘    └──────────┘    └──────────┘
```

## 二、职责边界

### 本模块负责

| 职责 | 说明 |
|------|------|
| 凭据安全存储 | 加密存储各类认证凭据 |
| 凭据引用管理 | 管理 credential_id 与凭据值的映射 |
| 凭据分发 | Agent 采集时按需分发凭据 |
| 访问控制 | 基于 RBAC 控制谁/什么可以访问哪些凭据 |
| 凭据轮换 | 支持计划性和应急性凭据轮换 |
| 审计追踪 | 记录所有凭据访问和变更操作 |

### 本模块不负责

| 不负责项 | 归属模块 |
|----------|----------|
| 实例与凭据的关联配置 | 实例管理模块 (instance-management) |
| 凭据在 Manifest 中的引用传递 | Manifest 分发模块 |
| 目标实例上的实际密码修改 | 外部系统 / 手动操作 |
| Agent 端的凭据缓存管理 | 数据层 Agent |

## 三、功能清单

### 3.1 凭据存储

| 功能 | 描述 |
|------|------|
| 凭据创建 | 创建新凭据记录，指定类型和凭据值 |
| 凭据类型 | 支持多种凭据类型（密码、SSH Key、SNMP Community、API Token、证书等） |
| 加密存储 | 凭据值使用 AES-256-GCM 加密后存储 |
| 凭据更新 | 更新凭据值（自动加密新版本） |
| 凭据删除 | 软删除凭据（标记为已删除，保留审计记录） |
| 凭据分组 | 按团队/环境/用途对凭据进行分组管理 |

**支持的凭据类型：**

| 类型 | 说明 | 存储内容 |
|------|------|----------|
| password | 用户名/密码 | username + encrypted_password |
| ssh_key | SSH 私钥 | encrypted_private_key + passphrase(可选) |
| snmp_community | SNMP Community String | encrypted_community_string |
| snmpv3_user | SNMPv3 认证 | username + auth_password + priv_password |
| api_token | API Token / Bearer Token | encrypted_token |
| tls_cert | TLS 证书 | encrypted_cert + encrypted_key |
| custom | 自定义键值对 | encrypted_key_value_pairs |

### 3.2 凭据引用

| 功能 | 描述 |
|------|------|
| 引用绑定 | 实例通过 credential_id 引用凭据，不直接存储凭据值 |
| 引用验证 | 绑定凭据时验证 credential_id 的有效性和类型匹配 |
| 引用完整性 | 删除凭据前检查是否有实例引用，阻止或级联处理 |
| 引用查询 | 查询某个凭据被哪些实例引用 |

**引用关系：**

```
  Instance                    Credential Service
  ┌──────────┐               ┌──────────────────┐
  │ id: i-01 │               │ id: cred-oracle-01│
  │ name:    │               │ type: password    │
  │  ora-01  │──credential──▶│ username: system  │
  │ type:    │   _id:        │ password: ****    │
  │  oracle  │   cred-oracle │ (encrypted)       │
  │ -01      │   -01         │                   │
  └──────────┘               └──────────────────┘

  Manifest 中:
  {
    "instance_id": "i-01",
    "credential_ref": "cred-oracle-01",  ← 仅引用，不含实际值
    "target": "10.1.2.3:1521"
  }
```

### 3.3 凭据分发

| 功能 | 描述 |
|------|------|
| 按需获取 | Agent 在采集前通过 API 获取所需凭据 |
| 认证与授权 | Agent 获取凭据前需验证身份和权限 |
| 临时凭据 | （未来）支持生成短期有效的临时凭据 |
| 缓存支持 | 允许 Agent 缓存凭据，带 TTL 过期机制 |
| 批量获取 | Agent 可一次性获取同一批次任务所需的多个凭据 |

**凭据获取流程：**

```
  Agent                    凭据服务                   凭据存储
   │                         │                         │
   │──获取凭据请求──────────▶│                         │
   │  (credential_id,       │                         │
   │   agent_id,            │──验证 Agent 身份────────▶│
   │   zone_id)             │──检查访问权限            │
   │                         │──解密凭据──────────────▶│
   │                         │◀──返回明文──────────────│
   │◀──返回凭据─────────────│                         │
   │  (credential_value,    │                         │
   │   ttl_seconds)         │──记录审计日志            │
   │                         │                         │
   │  [Agent 本地缓存]       │                         │
   │  TTL=300s              │                         │
   │                         │                         │
```

### 3.4 访问控制

| 功能 | 描述 |
|------|------|
| 网区级访问控制 | 限制网区只能访问该网区实例关联的凭据 |
| Agent 级访问控制 | 限制 Agent 只能获取其被分配任务所需的凭据 |
| 角色级访问控制 | 管理员可管理所有凭据，操作员仅可查看引用（不可见值） |
| 审计日志 | 所有凭据访问操作记录审计日志 |
| 异常访问检测 | 检测异常凭据访问模式（如非工作时间、异常频率） |

**访问控制矩阵：**

| 操作 | 管理员 | 网区管理员 | 操作员 | Agent |
|------|--------|-----------|--------|-------|
| 创建/编辑凭据 | ✅ | ❌ | ❌ | ❌ |
| 查看凭据值 | ✅ | ❌ | ❌ | ✅(仅所需) |
| 查看凭据引用 | ✅ | ✅ | ✅ | ❌ |
| 删除凭据 | ✅ | ❌ | ❌ | ❌ |
| 获取凭据值 | ✅ | ❌ | ❌ | ✅(授权范围) |
| 查看审计日志 | ✅ | ✅(本网区) | ❌ | ❌ |

### 3.5 凭据轮换

| 功能 | 描述 |
|------|------|
| 计划轮换 | 设定轮换周期（如每 90 天），到期提醒 |
| 应急轮换 | 安全事件触发时立即轮换凭据 |
| 轮换流程 | 生成新凭据 → 更新凭据服务 → 通知 Agent 刷新缓存 → 在目标实例上应用 |
| 轮换历史 | 记录凭据的每次轮换（时间、操作者、原因） |
| 批量轮换 | 支持批量轮换同一类型/同一网区的凭据 |

**凭据轮换流程：**

```
  管理员/定时任务          凭据服务              Agent(s)            目标实例
       │                    │                    │                    │
       │──触发轮换─────────▶│                    │                    │
       │                    │──生成新凭据────────│                    │
       │                    │──更新存储──────────│                    │
       │                    │──通知Agent刷新────▶│                    │
       │                    │                    │──清除本地缓存──────│                    │
       │                    │                    │──获取新凭据────────│                    │
       │                    │                    │──(下次采集使用新凭据)│                    │
       │                    │                    │                    │
       │──(可选)在目标实例──▶│                    │                    │
       │   修改密码         │                    │                    │
       │                    │                    │                    │
```

### 3.6 安全模型

**三种安全模型对比：**

**Model 1: 凭据内嵌 TaskSpec 参数**

```
  TaskSpec = {
    instance: "10.1.2.3:1521",
    params: {
      username: "system",
      password: "plaintext_or_encrypted"    ← 凭据在 TaskSpec 中
    }
  }
```

| 优点 | 缺点 |
|------|------|
| 实现最简单 | 安全性最低 |
| 无需额外 API 调用 | Manifest 中包含凭据 |
| Agent 无需额外网络请求 | 凭据轮换需重新下发 Manifest |

**适用场景：** 内网环境、安全要求不高的初期阶段。

**Model 2: 运行时凭据获取 [建议 Phase 2]**

```
  TaskSpec = {
    instance: "10.1.2.3:1521",
    credential_ref: "cred-001"              ← 仅引用
  }

  Agent 采集时:
  Agent → Credential Service API → 获取凭据 → 执行采集
```

| 优点 | 缺点 |
|------|------|
| Manifest 不含凭据 | 需要额外的 API 调用 |
| 凭据轮换无需重发 Manifest | Agent 需要访问凭据服务 API |
| 集中审计 | 凭据服务成为关键依赖 |

**Model 3: Vault 集成 [建议 Phase 3]**

```
  TaskSpec = {
    instance: "10.1.2.3:1521",
    vault_path: "secret/data/monitoring/oracle-01"
  }

  Agent 采集时:
  Agent → Vault API (短期 Token) → 获取凭据 → 执行采集
```

| 优点 | 缺点 |
|------|------|
| 最高安全性 | 需要部署和维护 Vault |
| 短期 Token 自动过期 | Agent 需要 Vault 客户端 |
| 完整的审计和访问控制 | 架构复杂度显著增加 |
| 支持动态凭据生成 | |

**分阶段实施建议：**

```
Phase 1: Model 1 (内嵌)
  └── 适用于内网环境，快速上线
  └── 凭据在 Manifest 中加密传输

Phase 2: Model 2 (运行时获取)
  └── Manifest 仅含 credential_ref
  └── Agent 按需从凭据服务获取
  └── Agent 本地缓存 + TTL

Phase 3: Model 3 (Vault 集成)
  └── 引入 HashiCorp Vault
  └── Agent 使用短期 Token 获取凭据
  └── 支持动态凭据（如临时数据库账号）
```

## 四、核心数据模型

### 4.1 Credential（凭据）

```sql
CREATE TABLE credential (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    credential_id    VARCHAR(64)   NOT NULL UNIQUE,   -- 凭据标识
    name             VARCHAR(128)  NOT NULL,           -- 凭据名称 (人类可读)
    credential_type  ENUM('password', 'ssh_key', 'snmp_community',
                         'snmpv3_user', 'api_token', 'tls_cert', 'custom')
                     NOT NULL,
    encrypted_value  BLOB          NOT NULL,           -- 加密后的凭据值
    encryption_key_id VARCHAR(64)  NOT NULL,           -- 使用的加密密钥 ID
    metadata         JSON,                             -- 凭据元数据 (非敏感)
    -- metadata 示例 (password 类型):
    -- { "username": "system", "port": 1521 }
    -- 注意: 实际密码在 encrypted_value 中
    group_id         VARCHAR(64),                      -- 凭据分组
    rotation_policy  JSON,                             -- 轮换策略
    -- rotation_policy 示例:
    -- { "interval_days": 90, "auto_rotate": false, "notify_before_days": 7 }
    last_rotated_at  TIMESTAMP,
    expires_at       TIMESTAMP,                        -- 过期时间 (可选)
    status           ENUM('active', 'rotating', 'expired', 'revoked')
                     NOT NULL DEFAULT 'active',
    created_at       TIMESTAMP     NOT NULL,
    updated_at       TIMESTAMP     NOT NULL,
    created_by       VARCHAR(64),
    updated_by       VARCHAR(64)
);
```

### 4.2 CredentialAccessPolicy（凭据访问策略）

```sql
CREATE TABLE credential_access_policy (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    policy_id        VARCHAR(64)   NOT NULL UNIQUE,
    principal_type   ENUM('agent', 'user', 'role', 'zone')  NOT NULL,
    principal_id     VARCHAR(64)   NOT NULL,           -- 主体 ID
    credential_group VARCHAR(64),                      -- 凭据分组 (空=全部)
    permission       ENUM('read', 'write', 'admin')   NOT NULL,
    conditions       JSON,                             -- 附加条件 (时间/IP等)
    enabled          BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMP     NOT NULL,
    updated_at       TIMESTAMP     NOT NULL,
    INDEX idx_principal (principal_type, principal_id)
);
```

### 4.3 CredentialAuditLog（凭据审计日志）

```sql
CREATE TABLE credential_audit_log (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    credential_id    VARCHAR(64)   NOT NULL,
    action           ENUM('create', 'read', 'update', 'delete',
                         'rotate', 'access_grant', 'access_revoke')
                     NOT NULL,
    actor_type       ENUM('user', 'agent', 'system') NOT NULL,
    actor_id         VARCHAR(64)   NOT NULL,
    zone_id          VARCHAR(64),                     -- Agent 所在网区
    source_ip        VARCHAR(45),
    success          BOOLEAN       NOT NULL,
    error_message    VARCHAR(256),
    details          JSON,                             -- 额外详情
    created_at       TIMESTAMP     NOT NULL,
    INDEX idx_credential (credential_id, created_at),
    INDEX idx_actor (actor_type, actor_id, created_at),
    INDEX idx_action_time (action, created_at)
);
```

### 4.4 EncryptionKey（加密密钥管理）

```sql
CREATE TABLE encryption_key (
    id               BIGINT        PRIMARY KEY AUTO_INCREMENT,
    key_id           VARCHAR(64)   NOT NULL UNIQUE,
    key_name         VARCHAR(128)  NOT NULL,
    algorithm        VARCHAR(32)   NOT NULL DEFAULT 'AES-256-GCM',
    encrypted_key    BLOB          NOT NULL,           -- 主密钥加密后的数据密钥
    status           ENUM('active', 'deprecated', 'revoked')
                     NOT NULL DEFAULT 'active',
    created_at       TIMESTAMP     NOT NULL,
    deprecated_at    TIMESTAMP
);
```

## 五、接口与交互

### 5.1 上游依赖

| 来源 | 交互内容 | 协议 |
|------|----------|------|
| 实例管理模块 | 凭据创建/绑定请求 | 内部 API |
| 运维人员 | 凭据管理操作 | REST API |
| Vault (Phase 3) | 凭据存储后端 | Vault API |

### 5.2 下游提供

| 消费方 | 提供内容 | 协议 |
|--------|----------|------|
| Agent (数据层) | 凭据值（按需获取） | gRPC / HTTPS |
| Manifest 分发 | 凭据引用验证结果 | 内部 API |
| 审计系统 | 凭据访问审计日志 | 日志推送 |

### 5.3 对外 API

```
# 凭据管理 (管理员)
POST   /api/v1/credentials                        # 创建凭据
GET    /api/v1/credentials                        # 查询凭据列表 (不返回值)
GET    /api/v1/credentials/{credential_id}        # 查询凭据详情 (不返回值)
PUT    /api/v1/credentials/{credential_id}        # 更新凭据
DELETE /api/v1/credentials/{credential_id}        # 删除凭据
POST   /api/v1/credentials/{credential_id}/rotate # 触发凭据轮换
GET    /api/v1/credentials/{credential_id}/history # 凭据变更历史
GET    /api/v1/credentials/{credential_id}/references # 查询引用该凭据的实例

# 凭据获取 (Agent 调用)
POST   /api/v1/credentials/fetch                  # 获取凭据值
  Body: { "credential_id": "cred-001", "agent_id": "agent-01", "zone_id": "zone-east-1" }
  Response: { "credential_value": {...}, "ttl_seconds": 300 }
  Auth: mTLS / Agent Token

POST   /api/v1/credentials/fetch-batch            # 批量获取凭据
  Body: { "credential_ids": ["cred-001", "cred-002"], "agent_id": "...", "zone_id": "..." }

# 访问策略管理
GET    /api/v1/credential-policies                 # 查询访问策略
POST   /api/v1/credential-policies                 # 创建策略
PUT    /api/v1/credential-policies/{policy_id}     # 更新策略
DELETE /api/v1/credential-policies/{policy_id}     # 删除策略

# 审计日志
GET    /api/v1/credential-audit-logs               # 查询审计日志
GET    /api/v1/credential-audit-logs/stats         # 审计统计
```

### 5.4 凭据安全模型演进路径

```
Phase 1 (当前):
  ┌─────────────────────────────────────────┐
  │  TaskSpec/Manifest 中包含加密的凭据     │
  │  Agent 从 Manifest 中解密获取凭据       │
  │  加密密钥预分发到 Agent                  │
  └─────────────────────────────────────────┘

Phase 2 (迭代):
  ┌─────────────────────────────────────────┐
  │  Manifest 仅含 credential_ref           │
  │  Agent 通过 HTTPS + Agent Token         │
  │  调用凭据服务 API 获取凭据              │
  │  Agent 本地缓存 (TTL=5min)             │
  └─────────────────────────────────────────┘

Phase 3 (成熟):
  ┌─────────────────────────────────────────┐
  │  引入 HashiCorp Vault                   │
  │  凭据存储在 Vault 中                    │
  │  Agent 使用短期 Token 从 Vault 获取     │
  │  支持动态凭据生成 (临时 DB 账号)        │
  └─────────────────────────────────────────┘
```

## 六、设计决策与替代方案

### 6.1 凭据安全模型选择 [待确认]

**决策（待确认）：** Phase 1 采用 Model 1（凭据内嵌 TaskSpec），后续迭代到 Model 2。

**Phase 1 选择 Model 1 的理由：**
- 实现简单，无需额外的凭据服务 API
- 内网环境下安全风险可控
- Manifest 传输通道可加密（TLS）
- 快速上线，后续迭代

**Phase 1 的安全加固措施：**
- Manifest 传输全程 TLS 加密
- 凭据在 Manifest 中使用 AES-256 加密，密钥预分发
- Manifest 文件权限严格控制（仅 root 可读）
- Agent 内存中的凭据在使用后清零

### 6.2 凭据加密方案 [已确认]

**决策：** 使用 AES-256-GCM 加密凭据值，采用信封加密（Envelope Encryption）模式。

**方案：**
```
主密钥 (Master Key)
  └── 存储在安全位置 (HSM / KMS / 配置文件)
      └── 数据密钥 (Data Key)
          └── 加密后存储在 DB 中
              └── 用于加密实际凭据值
```

**理由：**
- 信封加密是行业标准做法
- 支持密钥轮换而不需重新加密所有凭据
- 数据密钥可定期轮换

### 6.3 Agent 凭据缓存策略 [建议]

**建议：** Agent 本地缓存凭据，TTL 5 分钟，减少 API 调用。

**策略：**
- 缓存存储在 Agent 进程内存中（不落盘）
- TTL 过期后重新从凭据服务获取
- 凭据服务返回 401/403 时立即清除缓存
- Agent 重启后缓存清空

### 6.4 凭据删除策略 [建议]

**建议：** 软删除 + 关联检查。

**策略：**
- 凭据删除为软删除（标记为 revoked）
- 删除前检查是否有实例引用
- 有引用时阻止删除，或要求先解除引用
- 软删除的凭据保留 90 天后物理删除

## 七、冲突与开放问题

### MC-07: 凭据分发 vs Manifest 广播 [待确认]

**冲突描述：** Phase 1 中凭据内嵌在 Manifest 中广播，与"Manifest 不含凭据"的安全目标冲突。

**待决策：**
- Phase 1 的凭据加密方案细节？
- 加密密钥如何安全分发到各网区 Agent？
- 是否需要为 Phase 1 → Phase 2 的迁移预留接口？

### GD-04: 凭据安全模型选择 [待确认]

**冲突描述：** 三种安全模型的切换涉及架构变更，需要规划迁移路径。

**待决策：**
- Phase 1 → Phase 2 的触发条件是什么？（安全审计要求？规模增长？）
- Phase 2 是否需要 Agent 端代码变更？
- 是否需要在 Phase 1 就预留 credential_ref 接口？

### MC-20: 凭据服务的可用性要求 [待确认]

**冲突描述：** Phase 2 中凭据服务成为 Agent 采集的关键依赖。如果凭据服务不可用：
- Agent 无法获取新凭据
- 已缓存凭据在 TTL 过期后失效

**待决策：**
- 凭据服务的 SLA 要求？
- 是否需要凭据服务的高可用部署？
- Agent 缓存 TTL 是否需要支持延长（降级模式）？

### MC-21: 凭据轮换的自动化程度 [待确认]

**冲突描述：** 凭据轮换涉及两个步骤：(1) 在凭据服务中更新 (2) 在目标实例上修改密码。步骤 (2) 通常需要访问目标实例，可能无法完全自动化。

**待决策：**
- Phase 1 是否仅支持手动轮换？
- 是否需要支持半自动轮换（提醒 + 一键更新凭据服务）？
- 全自动轮换（包括修改目标实例密码）是否纳入规划？
