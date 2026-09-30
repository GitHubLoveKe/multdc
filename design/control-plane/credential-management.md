# 凭据管理 (Credential Management)

> 版本：v1.0 | 日期：2026-09-29
> 状态：设计定稿，含实施期必验项
>
> **本文档修订 DEC-016**（凭据合并入实例记录）：保留「凭据作为实例记录的一部分、取消独立凭据服务」，但**推翻其「仅靠传输层 TLS 保障安全」的前提**，升级为 mTLS + 节点证书 + 信封加密 + Vault 集中存储。
>
> **本文档同时使以下既有表述失效**：
> - `README.md` MC-07「Manifest 不含凭据，只含 credential_id 引用」——需改写（见 §9.2）
> - `zone-manifest-protocol.md` L258「凭据永远不通过跨区通道传输」——在 A1 载荷路径下不成立
> - `credential-service.md`（已标废弃）L17/L24/L25/L69 的「Manifest 直接包含凭据」——载体已不存在
>
> 上游依赖：`collection-topology.md`（collector 架构与 probe 契约）、`instance-management.md`（实例台账）

---

## 一、概述

本模块负责被监控资源凭据的**存储、加密、分发、轮换与审计**。核心约束来自用户明确要求（2026-09-29）：

> 密码不要明文传输，通信 TLS，同时使用证书加解密。

以及实际环境特征：

> 数据库类监控会有大量互不相同的账密；IPMI、拨测等也有认证；账密、私钥、证书都可能有。规模为万级实例。

### 1.1 凭据流转全景

```
┌─────────────────────────────────────────────────────────────────┐
│ 中心控制面                                                       │
│                                                                  │
│  Vault (Raft 三节点 HA)          控制面 DB                       │
│   └ secret/monitoring/<zone>/    └ instance 表：只存 profile 引用  │
│       <instance_id>                  与凭据元数据，不存凭据值      │
│         · username / password                                      │
│         · 私钥 / 证书（文件类）                                    │
│         · SNMP community / v3 参数                                 │
│         · bearer token                                             │
└──────────────┬──────────────────────────────────────────────────┘
               │ mTLS（节点证书）跨区
┌──────────────▼──────────────────────────────────────────────────┐
│ 采集节点                                                         │
│                                                                  │
│  Vault Agent ──unix socket──▶ collector                          │
│   · auto_auth（节点证书 cert auth）    · 按 instance_id 懒加载    │
│   · cache（不开 persist_dir）          · 内存缓存 TTL 5m          │
│   · token renew                        · 凭据不落盘               │
└──────────────────────────────────────────────────────────────────┘
```

### 1.2 三条通道分离（核心架构原则）

| 通道 | 承载内容 | 变更频率 | 机制 |
|------|----------|----------|------|
| **http_sd** | target 列表（地址 + `instance_id` + `module` + 标签） | 高（实例增删） | Alloy 周期拉取，DC 网关渲染 |
| **Alloy 配置** | 组件结构、clustering、remote_write、TLS 证书路径 | 极低 | DC 网关配置分发 + Alloy 热加载 |
| **Vault** | 凭据值 | 独立生命周期（轮换） | Vault Agent → collector 懒加载 |
| **采集模板** | OID 集 / 自定义 SQL / 探测参数 / 指标开关 | 低 | DC 网关版本化拉取（见 §七） |

**关键收益**：凭据轮换时前三条通道都不用动；实例增删时只动 http_sd；模板变更时只动模板通道。**四条变更路径完全解耦**，这是「平台侧维护、变更后下发即生效」的结构基础。

---

## 二、职责边界

**本文档负责**：
- 凭据的数据模型与 profile 化
- 四类凭据形态的投递方式
- 加密方案（节点证书体系、信封加密、mTLS）
- Vault 拓扑、认证方式、policy 边界、可用性缓冲
- collector 侧的凭据获取契约与缓存策略
- 采集模板（`collector_template`）的下发机制
- 凭据相关的安全红线
- 凭据轮换流程与审计

**本文档不负责**：
- collector 的 probe 契约与采集逻辑（→ `collection-topology.md`）
- 实例台账与生命周期（→ `instance-management.md`）
- 上报类（push）的入向鉴权（→ `data-ingestion.md`，机制不同：用哈希不用加密）
- Vault 自身的部署运维细节（→ 基础设施文档）
- 节点证书的 CA 体系建设（本文档只定义需求，见 §5.1）

---

## 三、硬约束：生态不存在 per-target 采集凭据

这是整个凭据设计的起点，也是源码级核实的事实，不是推测。

| 证据 | 内容 |
|------|------|
| `prometheus/prometheus` `config/config.go` | 一个 `ScrapeConfig` 只内嵌**一份** `HTTPClientConfig` |
| `prometheus/common` `config/http_config.go` | 无任何按 label/target 取值的凭据字段；`secret_files` grep 计数为 0 |
| `prometheus/prometheus` `discovery/targetgroup/targetgroup.go` | SD 结构体只有 `Targets []model.LabelSet` + `Labels` + `Source`，**没有凭据字段** |
| `prometheus/prometheus` `scrape/target.go` | per-target 只影响 `URL()`，可覆盖的仅 `__param_*` / `__address__` / `__scheme__` / `__metrics_path__` / `__scrape_interval__` / `__scrape_timeout__`，**无 auth / TLS 通道** |
| Alloy `prometheus.scrape` | 同构：`basic_auth` / `authorization` / `tls_config` / `oauth2` 全是**组件级** block |
| `prometheus/prometheus#1176`（2016） | 诉求「通过 relabeling 设置认证参数」，最终只落地 interval/timeout/scheme/path，**认证部分未实现** |

**结论**：「一实例一凭据」无法在 scrape 层表达。生态唯一的既有解法是官方 [multi-target exporter pattern](https://prometheus.io/docs/guides/multi-target-exporter/)——**凭据下沉到采集器侧的命名 profile，服务发现只下发 profile 名（或 instance_id）作 `__param_*`**。

本设计遵循该 pattern：collector 收到 `instance_id` 后自行向 Vault 取凭据（见 `collection-topology.md` §6.1/§6.2）。

---

## 四、凭据模型

### 4.1 profile 化凭据

凭据的单位是 **profile**，与实例一对一（或一对多，当多实例共享同一监控账号时）。profile 由 `instance_id` 索引。

```yaml
# Vault KV v2: secret/monitoring/<zone_id>/<instance_id>
data:
  profile_type: userpass          # userpass | dsn | snmp_v2 | snmp_v3 | token | cert_key | ssh_key
  username: monitor_ro
  password: <value>
  metadata:
    instance_id: ora-00042
    collector_type: oracle
    rotation_policy: 90d
    last_rotated_at: 2026-09-01T00:00:00Z
```

控制面 DB 的 `instance` 表**只存 profile 引用与元数据，不存凭据值**：

```sql
ALTER TABLE instance
    ADD COLUMN credential_profile_id VARCHAR(128),   -- Vault 路径的末段，通常等于 instance_id
    ADD COLUMN credential_type       VARCHAR(32),    -- profile_type 的副本，用于 UI 展示与校验
    DROP COLUMN credential_id;                        -- 原 C7 凭据服务的外键，已随 DEC-016 废弃
```

> **对 DEC-016 的修订**：DEC-016 决定「凭据作为实例记录的第四层属性直接存储」。本设计保留「凭据与实例一对一绑定、无独立凭据服务」的结论，但**凭据值存储在 Vault 而非控制面 DB**。理由：集中审计、轮换、版本化、访问控制由 Vault 承担，且控制面 DB 泄露不等于凭据泄露。

### 4.2 四类凭据形态与投递方式

| 形态 | 场景 | profile_type | 投递到 collector 的形式 |
|------|------|--------------|------------------------|
| **结构化凭据** | DB 账密、bearer token、HTTP basic | `userpass` / `dsn` / `token` | 内存中的结构体，直接传给采集逻辑 |
| **SNMP 参数** | 网络设备 v2 community / v3 全套认证参数 | `snmp_v2` / `snmp_v3` | 内存结构体（community、security_level、username、password、auth_protocol、priv_protocol、priv_password、context_name） |
| **文件凭据** | 客户端证书、私钥、SSH key | `cert_key` / `ssh_key` | **必须写成文件**（tmpfs，0600），采集逻辑只拿路径 |
| **入向凭据**（上报类） | 上报方认证 | 不适用 | **htpasswd 哈希文件**，见 §4.3 |

**文件凭据为什么必须落文件**：blackbox 类探测的 `tls_config` 只接受 `ca_file` / `cert_file` / `key_file` **路径**，不支持内联 PEM。SSH 私钥同理。所以证书类凭据没有「纯内存」的选项。

落盘约束：
- 写入 **tmpfs**（内存文件系统），重启即清
- 权限 `0600`，属主为 collector 的运行用户
- 路径不可预测（含随机后缀），避免本机其他进程猜测
- 用后立即删除，或按 TTL 清理

### 4.3 上报类（push）用哈希而非加密

数据上报场景的凭据方向是**入向**（collector/Alloy 校验上报方身份），与出站采集完全不同：

- 用 `otelcol.auth.basic` + **htpasswd 文件（bcrypt 哈希）**
- **平台永不持有上报方密码明文**，因此不存在「明文传输」问题，也不需要信封加密
- htpasswd 文件本身是敏感物，走同一条 mTLS 配置分发通道下发，权限 0600

这也是 push 接入选 `otelcol.receiver.otlp` 而非 `prometheus.receive_http` 的理由之一：**后者没有接收侧鉴权配置**（已核实），前者支持 `otelcol.auth.basic`（含 htpasswd 文件）与 `otelcol.auth.bearer`。

详见 `data-ingestion.md`。

---

## 五、加密与传输

### 5.1 节点证书体系

| 项 | 设计 |
|----|------|
| 签发方 | 平台自建 CA（或对接企业既有 CA） |
| 证书持有者 | 每个采集节点一张客户端证书；CN/SAN 编码 `alloy-<node_id>` 与 `zone_id` |
| 私钥 | 只存在于本机（0600 或 TPM），**永不出机器** |
| 登记 | 平台侧 Worker 注册表记录该节点的公钥证书 |
| 有效期与轮换 | 建议 90 天 + 自动轮换，CA 侧保留 7 天重叠窗口（OC-CRED-01） |
| 吊销 | CRL 或短有效期 + 定期轮换 |
| 注册到 Vault | 每个采集节点的证书需注册进 Vault 的 `certs/` 路径（可走 Vault API 自动化）。**Agent 数 = 采集节点数（数十~数百），不是被监控实例数（万级），因此逐个注册可行** |

一张证书同时承担三个角色：**身份认证**（mTLS）、**加密密钥分发**（信封加密的接收方公钥）、**Vault 认证**（cert auth method）。

### 5.2 信封加密（用于配置分发通道）

对需要经跨区通道下发的敏感物（htpasswd 文件、文件凭据、Alloy 的 TLS 证书私钥等）：

```
控制面：
  1. 生成 DEK（按 (secret_id, node_cert_fingerprint) 用 HKDF 确定性派生）
  2. AES-256-GCM 加密明文 → {nonce, ciphertext, tag}
  3. 用目标节点公钥加密 DEK（RSA-OAEP 或 ECIES）→ encrypted_dek
  4. 下发 {encrypted_dek, nonce, ciphertext, tag, key_id, cert_fingerprint}

DC 节点：
  5. 用本机私钥解 encrypted_dek → DEK
  6. 用 DEK 解 ciphertext → 明文
  7. 写入 tmpfs（0600）或交给 collector
```

**DEK 必须确定性派生而非每次随机**，否则下发物每次都变，会触发下游不必要的重载。轮换只在凭据或证书变更时发生。

密文可以安全经过任何中间环节（日志、缓存、DC 网关内存），只有持私钥的目标节点能解。

> **注意**：DB 类账密**不走这条通道**。它们由 collector 通过本机 Vault Agent 懒加载获取，从不经过 DC 网关。信封加密只用于「必须由平台推送到节点的文件类敏感物」。

### 5.3 mTLS 覆盖的三条链路

| 链路 | 方向 | 机制 |
|------|------|------|
| Alloy ↔ collector | 同机 | mTLS，Alloy 用 `tls_config`（stock 能力，零改动），collector 用 `tls.RequireAndVerifyClientCert` + CN 校验 |
| Vault Agent ↔ 中心 Vault | 跨区 | mTLS，节点证书 |
| collector ↔ DC 网关（模板拉取） | 跨区 | mTLS，节点证书 |
| collector ↔ Vault Agent | 同机 | **unix socket + 文件权限**，不用 TLS（见 §6.3） |

### 5.4 信任链取代端点白名单

```
DC 网关（可信）→ http_sd 按台账与注册表渲染 target → Alloy（持节点证书）→ collector（验证证书 CN）
```

`instance_id` 的合法性由信任链上游保证，**collector 不需要维护 instance_id 白名单**，从而保持完全无状态（`collection-topology.md` §6.2）。

---

## 六、Vault 拓扑

### 6.1 部署形态

| 组件 | 部署 | 说明 |
|------|------|------|
| **Vault** | 中心控制面，**Raft 三节点 HA** | 不做区级 performance replica（Agent 数少、QPS 低，跨区延迟可接受） |
| **Vault Agent** | **每采集节点一个** | unix socket listener，供本机 collector 访问 |
| **Secrets engine** | **KV v2** | 见 §6.6，不用 database dynamic credentials |

### 6.2 为什么每采集节点一个，而不是每区共享一个

**决定性事实（已核实）**：Vault Agent 的 auto_auth 是「**Agent 自己向 Vault 认证并管理 token 续期**，代本地应用行事，客户端不直接对 Vault 认证」。

因此 **Agent 的 Vault policy 覆盖范围 = 它的爆炸半径**：

| 部署 | Agent 身份 | policy 范围 | 一个 Agent 被攻破的后果 |
|------|-----------|------------|------------------------|
| 每节点一个 | 节点证书 | 本网区（见 §6.4） | 泄露该区凭据，但**认证材料、token、审计粒度均按节点分离** |
| 每区共享（网络化） | 区级证书 | 必须覆盖全区 | 同上，且**失去节点级审计粒度**，并新增跨机依赖 |

网络化共享 Agent 的额外代价：collector 依赖另一台机器的 Agent，那台机器故障或区内网络分区会波及本节点采集——**把一个已被 systemd 解决的本地问题换成了跨机网络依赖**。

**「单节点故障」实际上是两种故障，都不需要网络化**：

| 故障 | 影响 | 已有解法 |
|------|------|----------|
| Vault Agent 进程挂（机器还活着） | collector 取不到新凭据 | systemd `Restart=always` 秒级恢复 + collector 内存缓存 5m → **采集完全无感** |
| 整台采集节点挂 | 该节点的 collector 也一起挂了 | Agent 是否 HA **完全无关**——没有 collector 需要它。Alloy clustering 把 target rebalance 到其他节点，那些节点各有自己的 Agent |

### 6.3 unix socket 而非 TCP + TLS

| | unix socket | localhost TCP + TLS |
|---|---|---|
| 网络可达性 | **无**（不经网络栈） | 有端口 |
| 安全边界 | 文件权限 | TLS + 证书 |
| 配置面 | socket 路径 | 端口 + 一套证书 |

同机通信下 unix socket 的边界**更强**，因为没有网络可达性。TLS 在这里不适用也不必要。

> **硬约束（易漏且后果严重）**：Vault Agent 的 unix socket 是本机取凭据的唯一入口，它的文件权限就是这一跳的全部安全边界：
> - socket 属组限定（如 `vault-clients` 组），只有 collector 的运行用户在该组内
> - 权限 `0660` 或更严，**绝不能 0777**——否则本机任何进程都能取走全部凭据
> - Vault Agent 与 collector 用**不同系统用户**运行，靠组权限打通
>
> 这比 mTLS 那一跳更容易被忽视，而失效后果更严重：mTLS 失效是外部攻击面，socket 权限失效是本机任意进程直接拿到全部凭据。

### 6.4 ⚠️ policy 边界是网区级，不是节点分片

**这是一个反直觉但必须接受的结论。**

早先曾认为「per-node Agent + 节点级 policy → 爆炸半径 = 该节点分片」。**该说法错误**，被 Alloy clustering 的动态性推翻：

一致性哈希的性质决定——当其他节点都故障时，任何一个节点都可能被分配到任何一个 target。所以「该节点可能需要的凭据集合」的**上界是全网区**。精确到分片的 policy 会在 rebalance 后导致新节点取不到凭据、采集失败。

> **数学上，精确 per-node policy 与 clustering 的动态 rebalance 不兼容。** policy 边界必须是网区级。

因此 per-node Vault Agent 的价值需要重新表述：

| 价值 | 是否成立 |
|------|----------|
| **审计粒度**：每节点独立 token，Vault 审计日志能定位「哪个节点读了哪个凭据」 | ✅ |
| **缓存本地化**：减少跨区 Vault 调用，Vault 短暂不可达时本地缓存兜底 | ✅ |
| **认证材料分散**：节点证书各自独立，不共享一份 | ✅ |
| **无跨机依赖** | ✅ |
| ~~授权边界收窄到节点分片~~ | ❌ **做不到**，边界是网区级 |

**实际爆炸半径 = 单网区凭据。** 跨网区隔离仍然成立（网区 A 的节点读不到网区 B 的凭据）。

收窄手段（不改变边界，但提高检测与限制能力）：
- 短 TTL 凭据与短 token TTL
- Vault 审计日志 + **异常批量读取告警**（单节点在短窗口内读取远超其分片规模的凭据数即告警）
- 可选：`response wrapping`

### 6.5 三层可用性缓冲

真正需要担心的不是 Agent 单点，而是**中心 Vault 不可用**：

```
① 中心 Vault 自身 HA（Raft 三节点）
② Vault Agent 的 cache 块（不开 persist_dir）
③ collector 内存缓存（TTL 5m）
```

三层任一层生效，**存量采集就不受影响**；只有「新实例首采」与「凭据轮换生效」会延迟，而这两件事延迟几分钟完全可接受。

> ⚠️ **不开 Vault Agent 的 `cache.persist_dir`**。它会把缓存写到磁盘，等于凭据落盘，与不落盘目标冲突。接受「Agent 重启后需重新向 Vault 取」，反正第 ③ 层还在。

### 6.6 认证方式与 secrets engine 选型

**auth method：TLS certificate（cert auth）**

- Vault 的 cert auth 要求 mTLS + 客户端证书，将证书链与 `certs/` 路径下**显式注册的证书或 CA** 比对
- ⚠️ 它**不按 CN/SAN 自动映射到 policy**，且「cannot read trusted certificates from an external source」
- **注册 CA** → 所有节点共享同一 policy → 任一节点被攻破可读全区凭据。这与「注册逐个节点证书」相比没有额外损失（因为 §6.4 已确定边界是网区级），但**会失去节点级审计粒度**，因此仍建议**逐个注册节点证书**
- Agent 数为数十~数百，通过 Vault API 自动化注册可行

备选：AppRole（每节点一对 role_id/secret_id）。缺点是 secret_id 首次投递需要安全通道，**引入一条新的凭据分发路径**；而 cert auth 复用已在节点上的证书，不引入新路径。故选 cert。

**secrets engine：KV v2，不用 database dynamic credentials**

Vault 的 database secrets engine 可按需生成短 TTL 数据库账号，看似能消灭「万级静态账密」，但前置条件过重：

- **Vault 必须能直连每一个被监控数据库**（才能在上面建账号），且该连接需要有建用户权限
- 在多网区、网络隔离、万级实例环境下，意味着要么给 Vault 开遍所有网区的 DB 端口，要么每区部署 Vault

代价远超收益。**只用 KV v2 存静态凭据，Vault 不需要连任何 DB。**

### 6.7 collector 侧的 Vault 客户端做成可切换实现

```go
// framework/vault/vault.go
type Provider interface {
    Get(ctx context.Context, instanceID string) (Credential, error)
}

// 实现 A（默认）：unix socket 代理，走本地 Vault Agent
type AgentSocketProvider struct{ socketPath string; cache *ttlCache }

// 实现 B（可选）：内嵌 Vault SDK，collector 自己认证
type EmbeddedProvider struct{ client *vaultapi.Client; cache *ttlCache }
```

collector 业务代码只依赖 `Provider` 接口，切换是配置项。

**默认用实现 A（独立 Vault Agent）**，理由：

1. **认证与 token 生命周期是安全关键代码**。内嵌意味着自己实现 cert auth 登录、token renew（到期窗口内续期、renew 失败重登录）、Vault 不可达时的降级、并发刷新竞态（single-flight）、证书轮换处理。Vault Agent 已做好且经大规模验证。自研的风险收益不划算——写错的后果是凭据泄露或采集中断。
2. **保住「拆分零改动」的性质**。`collection-topology.md` DEC-COL-04 确定拆分是构建期决策、业务代码不动。若 Vault 认证内嵌，拆成 N 个二进制后每个都要独立认证 → Vault 侧看到 N 倍 token 与登录请求，且 N 个进程各持一份认证材料。

**切到实现 B 的条件**：确认永不拆分，且团队接受认证代码的长期维护。因为它是接口切换，这个决定可后期做。

---

## 七、采集模板下发

### 7.1 定位

采集模板是**独立于凭据的第二条动态数据流**，承载「采什么」而非「用什么身份采」。

| | 凭据 | 采集模板 |
|---|---|---|
| 来源 | Vault | 平台（DC 网关） |
| 通道 | 本机 Vault Agent unix socket | DC 网关，mTLS，版本化拉取 |
| 索引键 | `instance_id` | `template_id`（按 module 共享，非 per-target） |
| 变更频率 | 轮换周期 | 低 |
| 敏感性 | 高 | 低，但**需完整性保护** |

### 7.2 为什么不放 http_sd

- 模板可能很大（SNMP OID 集数百条），而 http_sd 是周期全量拉取，会撑爆响应
- 模板按 `module` 共享而非 per-target，放 http_sd 会重复 N 份

### 7.3 下发机制

```
GET /api/v1/collector-templates?type=snmp&since_version=<N>
→ [{ "template_id": "if_mib", "version": 42, "spec": {...} }, ...]
```

- collector 启动时全量拉取，之后按版本号增量拉（周期 + 变更通知）
- **本地缓存最后一份**，DC 网关不可达时继续用缓存采集 —— 与 `degradation-autonomy.md` 的 L1 语义一致
- http_sd 只带 `__param_module=<template_id>`（标识，不是内容）

### 7.4 数据模型

```sql
CREATE TABLE collector_template (
    template_id      VARCHAR(64)   NOT NULL,
    collector_type   VARCHAR(32)   NOT NULL,           -- FK → collector_type
    version          BIGINT        NOT NULL,
    spec             JSON          NOT NULL,           -- 类型相关的模板内容
    description      TEXT,
    created_at       TIMESTAMP     NOT NULL,
    created_by       VARCHAR(64),
    PRIMARY KEY (template_id, version)
);

CREATE INDEX ct_idx_type ON collector_template(collector_type);
```

`spec` 按类型不同：

| collector_type | spec 内容 |
|----------------|-----------|
| `snmp` | OID walk 列表（name / oid / type / help / labels）+ walk 参数 |
| `sql`（Oracle/MySQL/PG/MSSQL…） | 查询语句、列→指标映射、类型、标签 |
| `http_json` | 路径、JSONPath→指标映射、期望状态码、凭据 profile 引用 |
| `jmx` | MBean 路径、属性→指标映射 |
| `probe`（拨测） | 超时、期望状态码、TLS 校验开关、响应正则 |

### 7.5 与既有 `config_template` 的关系

`instance-management.md` §4.3 的 `config_template`（`config_spec` 为 Prometheus scrape_config 格式）与本文档的 `collector_template` **不是一回事**：

| | `config_template` | `collector_template` |
|---|---|---|
| 回答 | 「怎么连、多久采一次」 | 「采什么指标」 |
| 新架构下的归属 | 大部分由 http_sd + Alloy 承担，剩余部分需重新定义 | 本文档 |

**建议：区分保留两者，并修订 `instance-management.md` §4.3** 说明 `config_template` 在新架构下的实际职责范围（OC-CRED-05）。

---

## 八、安全红线

七条，全部为硬约束，需在代码评审与 CI 中可自动检查者应尽量自动化。

| # | 红线 | 理由 | 可否自动检查 |
|---|------|------|-------------|
| **CR1** | **凭据绝不进 `__param_`** | `__param_*` 的值会拼进 URL query，明文出现在 collector access log、Alloy `/api/v1/targets`、中间任何 HTTP 代理日志。这是生态固有行为，定开改不了。只有 `instance_id` / `module` / `target` 可以放 | 部分（检查 http_sd 渲染代码） |
| **CR2** | **凭据不进 Alloy 配置树** | River 的 `secret` 类型只是显示层脱敏，值仍在配置文件里；且可被 Alloy 管理端点导出。Alloy 配置里只允许出现 target 地址、module 名、证书**路径** | ✅ 可静态检查 River 配置 |
| **CR3** | **Vault Agent unix socket 权限 `0660`，独立用户 + 组授权** | 该 socket 是本机取凭据的唯一入口，权限就是这一跳的全部安全边界。`0777` 意味着本机任意进程可取走全部凭据 | ✅ 部署校验 |
| **CR4** | **DB 监控账号必须是只读账号** | 通用 SQL 采集器 = 任意 SQL 执行能力。必须靠**数据库侧权限**限制，不靠 collector 自觉。配套：SQL 语法校验只允许 SELECT、禁多语句、查询超时、行数上限、模板变更审计 | 部分（SQL 校验可自动，账号权限需 DBA 流程） |
| **CR5** | **采集模板不得包含目标地址** | target 地址只能来自 http_sd（实例台账）。这条分离**天然限制了 SSRF**——通用 HTTP 采集器无法被模板诱导去请求任意内网地址。实现时不得图方便让模板带地址 | ✅ 可校验 template schema |
| **CR6** | **模板通道必须 mTLS + 版本校验** | OID 模板本身不是秘密，但被篡改可改变采集行为；SQL 模板被篡改后果更重 | ✅ 部署校验 |
| **CR7** | **文件凭据写 tmpfs、0600、路径含随机后缀、用后清理** | 证书/私钥类凭据被迫落文件（blackbox `tls_config` 只接受路径），需最小化暴露窗口 | ✅ 可单元测试 |

---

## 九、对既有决策与文档的影响

### 9.1 决策层面

| 决策 | 影响 |
|------|------|
| **DEC-016**（凭据合并入实例记录） | **修订而非推翻**。保留「凭据与实例一对一、取消独立凭据服务」；凭据值存储位置由控制面 DB 改为 **Vault**；「仅靠传输层 TLS 保障安全」升级为 mTLS + 节点证书 + 信封加密。DEC-016 中标为 Phase 2 的「方案 C：凭据运行时获取」**实际上被本设计采纳**（collector 懒加载），只是获取对象是 Vault 而非控制面 API |
| **DEC-027**（DC 侧仅 Alloy 一个进程） | **正式放弃**。DC 侧新增 Vault Agent 与 collector 两个进程 |
| **GD-04 / DEC-008**（凭据安全模型三阶段） | 已废弃，本设计是其实际替代方案，建议在 `decisions-log.md` 中建立指向关系 |
| 新增 **DEC-CRED-01** | 凭据值存 Vault KV v2，控制面 DB 只存 profile 引用 |
| 新增 **DEC-CRED-02** | Vault 拓扑：中心 Raft 三节点 + 每采集节点一个 Vault Agent + unix socket |
| 新增 **DEC-CRED-03** | **policy 边界为网区级**，因 clustering 动态 rebalance 与精确分片 policy 不兼容 |
| 新增 **DEC-CRED-04** | 不用 database dynamic credentials，只用 KV v2 |
| 新增 **DEC-CRED-05** | 采集模板走 DC 网关版本化拉取，不走 http_sd，不走配置文件渲染 |

### 9.2 文档层面

| 文档 | 需修订内容 |
|------|-----------|
| `README.md` | MC-07「Manifest 不含凭据，只含 credential_id 引用」→ 改为「http_sd 响应不含任何凭据材料；凭据由 collector 通过本机 Vault Agent 懒加载」。GD-04 已随 DEC-008 废弃，需销项 |
| `credential-service.md` | 已标废弃，但 L17/L24/L25/L69 的「Manifest 直接包含凭据」表述与基线相反。归档时在废弃头中注明「其『凭据内嵌』方向被 DEC-016 采纳，但载体 Manifest 已不存在，且安全前提被本文档升级」 |
| `zone-manifest-protocol.md` | L97「credential_id 引用（NOT 实际凭据）」与 L258「凭据永不通过跨区通道传输」需随 Manifest 概念废弃一并处理。文件凭据与 htpasswd 经信封加密后**确实过跨区通道**（密文），L258 表述不再成立 |
| `instance-management.md` | §4.1 `instance` 表：`credential_id` 改为 `credential_profile_id` + `credential_type`；§4.3 `config_template` 与 `collector_template` 的职责区分；§3.2 类型表的「所需 Agent 类型」列需按新采集形态重写 |
| `collection-task-scheduling.md` §4.2 | `InstanceRecord` 的凭据层字段（username/password/bearer_token/tls_cert）**不再随实例记录同步**。该文档整体已废弃（见审计报告），此条仅作记录 |
| `decisions-log.md` | 增补 DEC-CRED-01~05；修订 DEC-016 条目；补 GD-04 销项说明 |

---

## 十、凭据轮换流程

```
1. 管理员在平台 UI 更新实例凭据
   → 控制面写入 Vault KV v2（新版本，旧版本保留供回滚）
   → 记录审计日志（谁、何时、哪个 instance_id、旧版本→新版本）

2. Vault Agent 的 cache TTL 到期后重新取（或收到 Vault 的 lease 过期通知）

3. collector 的内存缓存 TTL（5m）到期后重新向 Vault Agent 取

4. 下一次 /probe 请求使用新凭据

5. 若新凭据无效 → 采集失败 → probe_success=0 + probe_failure_reason=auth_failed
   → 告警路由给平台运维（错误语义两分法中属"目标资源故障"，但 reason 可区分）
```

**总生效延迟 ≤ collector 缓存 TTL（5m）+ 一个采集周期。** 无需重启任何进程，无需下发任何配置。

**文件凭据（证书/私钥）的轮换**需要额外一步：Vault Agent 或 collector 重新写入 tmpfs 文件并通知采集逻辑重新加载。这类凭据的轮换频率低，可接受较高延迟。

**回滚**：Vault KV v2 保留版本历史，回滚 = 将当前版本指向旧版本，同样在 5m 内生效。

---

## 十一、冲突与开放问题

| ID | 问题 | 影响 | 状态 |
|----|------|------|------|
| OC-CRED-01 | 节点证书有效期与轮换周期未定 | 建议 90 天 + 自动轮换 + 7 天重叠窗口。需与 CA 体系的既有实践对齐 | 待定 |
| OC-CRED-02 | Vault Agent 的 TCP listener TLS 字段名未核实 | 仅在将来改为网络化部署时相关（§6.2 已否决）。已核实 listener 支持 TCP 与 Unix 两种类型 | 低优先 |
| OC-CRED-03 | collector 内存缓存 TTL 取值 | 5m 是建议值。太短→Vault 负载高；太长→轮换生效慢且凭据在内存驻留久 | 待压测 |
| OC-CRED-04 | 通用 SQL 采集器的 SQL 校验严格程度 | 只允许 SELECT 是最小要求。是否需要禁子查询、禁 `INTO OUTFILE`、禁系统函数，取决于 DB 类型 | 待定，建议按 DB 类型分别定白名单 |
| OC-CRED-05 | `config_template` 与 `collector_template` 的职责边界 | 两者并存会造成概念混淆。需修订 `instance-management.md` §4.3 | **需处理** |
| OC-CRED-06 | 多实例共享同一监控账号时的 profile 建模 | §4.1 提到 profile 可与实例一对多，但 Vault 路径按 `instance_id` 组织。若共享账号，路径应改为按 profile 组织并让多个实例引用同一 profile | **需处理**，影响 Vault 路径设计 |
| OC-CRED-07 | Vault 审计日志的「异常批量读取」告警阈值 | §6.4 的收窄手段之一。阈值需按实际分片规模标定 | 待运行数据 |
| OC-CRED-08 | CA 体系是自建还是对接企业既有 CA | 影响证书签发自动化程度与轮换机制 | 待业务方确认 |
| OC-CRED-09 | 上报类 htpasswd 的轮换机制 | 上报方密码变更时需重新下发 htpasswd。上报方数量与变更频率未评估 | 待定，见 `data-ingestion.md` |
