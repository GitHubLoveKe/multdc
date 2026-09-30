# 采集拓扑与 Collector 架构

> 版本：v1.0 | 日期：2026-09-29
> 状态：设计定稿，含实施期必验项（见 §八）
>
> 本文档是 2026-09-29 采集侧架构讨论的落盘结果。它取代以下已作废的中间结论：
> - 「Alloy 定开清单 P0~P3」（含 P0 凭据提供器组件）——见 DEC-COL-02
> - 「外置社区 exporter 优先」——见 DEC-COL-07
> - 「DC 网关按分片渲染 `__address__`」——见 §5.1
>
> 上游依赖：`credential-management.md`（凭据与  拓扑）、`storage.md`（Worker-Storage 绑定）、`instance-management.md`（实例台账与 CMDB 拓扑富化）

---

## 一、概述

采集侧的最终形态是 **stock Alloy + 独立 collector 进程 + Vault Agent**，三者同机部署于每个采集节点。

```
                        中心控制面
                            │
              ┌─────────────┴──────────────┐
              │        DC 网关              │
              │  http_sd（target 列表）      │   采集模板（版本化拉取）
              │  配置分发 / 组件通信 / 健康   │
              └──────┬──────────────┬──────┘
                     │              │
     ┌───────────────▼──────────────▼───────────────────┐
     │  采集节点（每个网区数十~数百个，全网同构）          │
     │                                                   │
     │  ┌────────────────────────────────────────────┐  │
     │  │ Alloy (stock，不定开)                       │  │
     │  │  · clustering（一致性哈希分配 target）       │  │
     │  │  · discovery.http ← DC 网关 http_sd         │  │
     │  │  · prometheus.scrape → 127.0.0.1:9101       │  │
     │  │  · prometheus.remote_write → vmstorage      │  │
     │  │  · otelcol.receiver.otlp（上报类接入）       │  │
     │  └───────────────┬────────────────────────────┘  │
     │                  │ mTLS + /probe                  │
     │  ┌───────────────▼────────────────────────────┐  │
     │  │ collector（自研，单一二进制，注册表路由）     │  │
     │  │  · 按 module 分发到通用/特化采集器           │  │
     │  │  · 无状态：懒加载凭据、按需取模板            │  │
     │  └──────┬──────────────────────┬──────────────┘  │
     │         │ unix socket          │                  │
     │  ┌──────▼──────────┐    ┌──────▼──────────────┐  │
     │  │ Vault Agent     │    │ 目标资源             │  │
     │  │ （凭据）         │    │ DB/SNMP/IPMI/HTTP…  │  │
     │  └─────────────────┘    └─────────────────────┘  │
     └───────────────────────────────────────────────────┘

     被监控机上（独立生命周期）：node_exporter / windows_exporter
```

### 1.1 DC 侧进程清单

| 进程 | 职责 | 数量 |
|------|------|------|
| Alloy | clustering + scrape + remote_write + push 接收 | 1 |
| Vault Agent | 凭据代理，unix socket listener | 1 |
| collector | 采集执行，注册表路由 | 1（可按 profile 拆为 2~3） |

> ⚠️ DEC-027 的「DC 侧仅 Alloy 一个进程」不变式在本文档中**正式放弃**。放弃的幅度包含 collector 与 Vault Agent 两个新进程。理由见 DEC-COL-02 与 `credential-management.md`。

### 1.2 核心设计原则

| # | 原则 | 含义 |
|---|------|------|
| CP1 | **Alloy 保持 stock** | 不在 Alloy 上定开采集逻辑，不用 OCB 自定义构建。Alloy 承担 clustering / scrape / remote_write / push 接收四项，是数据出口，采集代码不得与之同进程 |
| CP2 | **clustering 是承重墙** | Alloy clustering 是废弃 Scheduler / slot / Gossip / VRRP / 整个协调层的唯一基础。任何定开不得触碰 clustering / remote_write / discovery 层 |
| CP3 | **变更只走 http_sd** | 新增/删除/修改实例只改 http_sd 响应；Alloy 配置与 collector 配置均保持静态 |
| CP4 | **凭据不进 Alloy** | Alloy 配置树内不得出现任何凭据，凭据只在 collector 进程内 |
| CP5 | **分片由 clustering 承担** | 不引入第二套分片协调机制 |
| CP6 | **全网同构部署** | 所有采集节点部署相同的 profile 集合 |

---

## 二、职责边界

**本文档负责**：
- 采集形态的分层模型与判据
- 采集器类型注册表的数据模型
- collector 的 probe 契约、错误语义、状态模型、并发与退避
- Alloy ↔ collector 的地址与路由机制
- Alloy ↔ collector 的 mTLS 信任链
- collector 的构建、打包与 profile 机制
- 通用采集器与类型特化的划分

**本文档不负责**：
- 凭据的加密、Vault 拓扑、采集模板下发（→ `credential-management.md`）
- Alloy clustering 的内部机制（→ VictoriaMetrics/Grafana 上游）
- 目标发现的数据来源与 CMDB 拓扑富化（→ `instance-management.md` §3.7）
- 数据写入存储后的去重与保留（→ `storage.md`）
- 上报类与外接数据源的接入模型（→ `data-ingestion.md`）
- 被监控机上 node_exporter 的部署与升级（→ `instance-management.md`，**当前为文档空白，见 OC-COL-06**）

---

## 三、采集形态分层模型

### 3.1 三层（原四层，层③已取消）

| 层 | 形态 | 承载类型 | 说明 |
|----|------|----------|------|
| **①** | Alloy 内置组件 | SNMP、拨测（可选）、本机 unix/windows | 零定开；`prometheus.exporter.snmp` 与 `.blackbox` 已支持多目标 + `config_file` |
| **②** | **自研 collector（主路径）** | Oracle / MySQL / PostgreSQL / MSSQL / MongoDB / Redis / Memcached / Kafka / ES / SNMP / IPMI / 拨测 / HTTP-JSON / JMX | 注册表路由，链接社区 collector Go 库复用采集逻辑 |
| **③** | 被监控机上的 agent | node_exporter / windows_exporter | 独立生命周期，无 per-instance 配置，装一次基本不改 |

> **原层③「DC 侧社区标准 exporter 独立进程」已取消**（DEC-COL-07）。取消理由：社区 exporter 只认配置文件（`snmp.yml` / `.my.cnf` / `auth_modules` / `modules`），而本设计确定「不走 YAML 渲染、走标准调用」。它们的 multi-target 参数命名各异、热更新能力不一致（postgres_exporter 源码确认无热更新），需要为每种写一套配置渲染 + reload 适配器，是 O(N) 的长期负担。

### 3.2 层①与层②的取舍

层①（Alloy 内置）对 SNMP 与拨测是零定开可用的，但存在两个约束：

1. **凭据必须走 `config_file`，不能用 `config` inline**——inline 会让凭据进入 Alloy 配置树，可被 Alloy 的配置 API 导出，违反 CP4
2. **`config_file` 是否监听文件变更并自动重载，未核实**（OC-COL-01）

因此本设计将 SNMP 与拨测**默认归入层②**（自研 collector），层① 作为可选优化：若 OC-COL-01 验证通过且团队愿意接受"凭据文件由 Vault Agent 渲染"这条路径，可切回层① 省去这两类的定开。

**切换成本很低**：两者对 Alloy 都表现为「一个 localhost 端点 + probe 契约」，http_sd 渲染逻辑相同，仅 `endpoint_resolver` 的返回值不同。

### 3.3 判据（写死，防止实现时走回头路）

> **能否零定开或极小定开归入层①，取决于两个条件同时成立：Alloy 内置组件已支持多目标，且凭据能外置到 `config_file`。** 任一不成立则归入层②。
>
> 必须在被监控机本机运行的，归入层③。

### 3.4 已核实的 Alloy 内置组件能力矩阵

判据不是「开源/闭源」，而是**多目标能力 + 凭据能否外置**。

| Alloy 内置组件 | 多目标 | 凭据可外置 | 可用于规模化 |
|----------------|--------|-----------|-------------|
| `prometheus.exporter.snmp` | ✅ `target` 块 + `targets` 列表 | ✅ `config_file` | ✅ |
| `prometheus.exporter.blackbox` | ✅ `target` 块 | ✅ `config_file` | ✅ |
| `prometheus.exporter.oracledb` | ✅ `database` 块 | ❌ 仅内联 `username`/`password`，无 `config_file`/`passwordFile` | ❌ 凭据进配置树 |
| `prometheus.exporter.postgres` | ✅ `data_source_names` 是 `list(secret)` | ❌ 内联 DSN | ❌ |
| `prometheus.exporter.mysql` | ❌ 单 `data_source_name`，无 target 块/targets/auth_module | ❌ | ❌ |
| `prometheus.exporter.redis` | ❌ 单目标 | ⚠️ 有 `redis_password_file` 但单目标 | ❌ |
| `prometheus.exporter.mongodb` | ❌ 单 `mongodb_uri`（官方文档：集群每节点需独立 exporter 实例） | ❌ | ❌ |
| `prometheus.exporter.mssql` | ❌ 单 `connection_string` | ❌ user:pass 内联于连接串 | ❌ |
| `prometheus.exporter.memcached` | ❌ 单 `address` | — | ❌ |
| `prometheus.exporter.kafka` | ❌ `kafka_uris` 是同一集群的 broker 列表 | — | ❌ |
| `prometheus.exporter.ipmi` | — | — | **组件不存在** |
| `prometheus.exporter.unix` / `.windows` | 本机 | 无需对外凭据 | ✅（仅当 Alloy 装在被监控机上） |

> 注：`prometheus.exporter.unix` 采的是 **Alloy 自己所在的本机**。在集中采集节点模型下它采不到被监控机的 OS 指标，因此 OS 指标必须靠层③ 的 node_exporter。

**为什么「凭据内联进 Alloy 配置」是硬伤**：River 的 `secret` 类型只是显示层脱敏（日志与 UI 打码），值本身在配置文件里。DC 网关推配置即导致凭据明文落盘，且可被 Alloy 管理端点导出。`sys.env()` 配合环境变量注入理论可行，但万级实例 = 万级环境变量，超出进程环境总大小上限（通常 128KB~2MB）。

---

## 四、采集器类型注册表

注册表的抽象**不得假设采集器是 Alloy 内置组件、自研 collector 模块，还是被监控机上的 agent**。这样一个类型在层间迁移只需改注册表一行，http_sd 渲染、凭据分发、健康监控、部署规划全部不动。

### 4.1 数据模型

```sql
CREATE TABLE collector_type (
    collector_type     VARCHAR(32)   PRIMARY KEY,      -- oracle / mysql / snmp / ipmi / http_2xx / node …
    display_name       VARCHAR(64)   NOT NULL,
    runtime_form       ENUM('alloy_builtin',
                           'collector_module',
                           'on_target_agent')  NOT NULL,
    endpoint_resolver  VARCHAR(32)   NOT NULL,
        -- 'local_collector'  → 127.0.0.1:<collector_port>
        -- 'alloy_component'  → Alloy 内置组件导出的 targets
        -- 'target_host'      → 被监控机地址:<port>（node_exporter 等）
    module_name        VARCHAR(64),                    -- probe 请求的 module 参数值
    profile_schema_id  VARCHAR(64),                    -- 该类型的凭据 profile 字段定义
    template_schema_id VARCHAR(64),                    -- 该类型的采集模板 schema（可空）
    shard_basis        VARCHAR(32),                    -- connection_pool / subprocess / cpu / series_count
    shard_max          INT,                            -- 单分片上限
    lifecycle_owner    ENUM('platform', 'target_owner') NOT NULL,
    system_deps        JSON,                           -- ["freeipmi", "oracle-instantclient"]
    capabilities       JSON,                           -- ["CAP_NET_RAW"]
    enabled            BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMP     NOT NULL,
    updated_at         TIMESTAMP     NOT NULL
);
```

### 4.2 http_sd 渲染规则

DC 网关按注册表渲染每个 target：

```json
{
  "targets": ["127.0.0.1:9101"],
  "labels": {
    "__metrics_path__": "/probe",
    "__param_instance_id": "ora-00042",
    "__param_target": "10.0.1.5:1521",
    "__param_module": "oracle",
    "instance_id": "ora-00042",
    "instance": "10.0.1.5:1521",
    "job": "oracle-prod",
    "zone_id": "zone-east-1",
    "host_id": "host-07",
    "rack_id": "rack-east-03",
    "switch_id": "sw-east-01",
    "cluster_id": "cluster-db-prod"
  }
}
```

- `targets[0]` 由 `endpoint_resolver` 决定，**对 `collector_module` 恒为 `127.0.0.1:<collector_port>`**（静态，见 §5.1）
- `__param_*` 由 Alloy relabel 转为 URL query
- 拓扑标签由 CMDB 富化链路注入（`instance-management.md` §3.7），**本文档不重复定义，链路零改动**

> **DC 网关渲染前必须校验该 target 的 `module` 在本节点已注册**（查 collector 的 `/api/v1/info`）。未注册则**不渲染该 target 并告警**——静默不渲染比渲染后失败更难排查。

---

## 五、地址与路由

### 5.1 `__address__` 是静态的 127.0.0.1

**不做动态地址渲染，不做分片规划。** 分片完全由 Alloy clustering 承担：

```
target X → 一致性哈希分给节点 A → A 请求 127.0.0.1:9101 → A 本机的 collector
target Y → 一致性哈希分给节点 B → B 请求 127.0.0.1:9101 → B 本机的 collector
```

collector 的负载天然跟随 clustering 的分片。节点增减时 Alloy 自动 rebalance，collector 负载随之变化，无需任何外部协调。

**前提：所有采集节点必须部署 collector（同构，CP6）。** 因为 clustering 可能把任何 target 分给任何节点。

### 5.2 不做健康检测重路由

collector 故障时，**不得**由 DC 网关把 target 重路由到其他节点的 collector。理由是决定性的：

collector 取凭据要通过本机 Vault Agent，而 Agent 的 Vault policy 限定了它能读的路径。重路由到节点 B 后，B 的 Agent 要读原属 A 的 instance_id 凭据 → **policy 不允许 → 取不到凭据 → 采集失败**。要让它工作就得把 policy 放宽到全局，那会用可用性换掉整个凭据隔离设计。

**正确路径**：collector 故障 → Alloy scrape 失败 → `up = 0` → 走既有告警链路（`up == 0` 看门狗 + 带外心跳）。故障节点的 target 由 **Alloy clustering 自行 rebalance** 到其他节点——那是 clustering 的本职，且 rebalance 后新节点的 Vault Agent 有权限（policy 边界为网区级，见 `credential-management.md` §6.4）。

**健康检测只用于可观测与告警，不用于地址路由。**

### 5.3 不引入 nginx 或主进程路由

| 方案 | 否决理由 |
|------|----------|
| nginx 按路径转发 | 不消除注册表，只是把它搬进 nginx 配置，**新增一条配置渲染与 reload 路径**（与「不走配置文件渲染」矛盾）；路由信息出现在两处，不一致时失败模式难排查；mTLS 终结点后 nginx→collector 需再套一层或退回明文；引入新的运维面与 CVE 面 |
| 主进程 + socket 转发到 worker | 多一跳序列化；需自管 worker 生命周期、健康检查、重启——**而 Alloy + http_sd 已经把路由做完了** |
| 按需 fork 子进程 | 万级 target × 15s = 每秒数百次 fork+exec；DB 连接无法复用（Oracle 建连昂贵）。仅适用于本身就要 shell out 的类型（IPMI 内部） |

类型 → 端口的映射由注册表的 `endpoint_resolver` 承担，**单一数据源**。端口是固定常量，一次分配永不变。

---

## 六、Collector 架构

### 6.1 probe 契约

采用 Prometheus 官方 [multi-target exporter pattern](https://prometheus.io/docs/guides/multi-target-exporter/)，与社区标准件接口兼容：

```
GET /probe?instance_id=ora-00042&target=10.0.1.5:1521&module=oracle
```

| 参数 | 含义 | 敏感性 |
|------|------|--------|
| `instance_id` | 凭据查找键 | 非敏感，可进 URL |
| `target` | 目标地址。冗余但保留，使 http_sd 继续作为「采什么」的唯一真源 | 非敏感 |
| `module` | 采集类型，决定注册表分发 | 非敏感 |

> **硬约束：凭据绝不进 `__param_`。** `__param_*` 的值会拼进 URL query，明文出现在 collector 的 access log、Alloy 的 `/api/v1/targets`、以及中间任何 HTTP 代理日志。这是生态的固有行为，定开也改不了。

### 6.2 完全无状态 + 懒加载

collector **不维护 target 注册表、不做全量同步**，只在请求到达时按 `instance_id` 懒加载凭据、按 `module` 取模板。

| 变更 | 是否需要动 collector |
|------|---------------------|
| 新增/删除实例 | ❌ http_sd 增减一个 target |
| 改实例地址/标签 | ❌ 下次请求带新值 |
| 凭据轮换 | ❌ 下次懒加载取到新值 |
| 采集模板变更 | ❌ 按版本号拉取 |
| 分片调整 | ❌ clustering 自动 rebalance |

**collector 配置退化为几乎静态**（监听地址、并发参数、Vault socket 路径、DC 网关地址）。这是 CP3「变更只走 http_sd」得以成立的基础。

代价：每次首采有一次 Vault 往返延迟，由 Vault Agent 的 cache 与 collector 的内存缓存吸收。

### 6.3 注册表路由

```go
// framework/collector.go
type Collector interface {
    Name() string
    Probe(ctx context.Context, req ProbeRequest, cred Credential, tpl Template) (Result, error)
    PoolLimits() PoolLimits        // 该类型的连接池/并发画像
}

var registry = map[string]Collector{}

func Register(c Collector) {
    if _, dup := registry[c.Name()]; dup { panic("duplicate collector: " + c.Name()) }
    registry[c.Name()] = c
}
```

各类型包在 `init()` 中自注册；`main` 通过 blank import 决定含哪些类型（见 §七）。**新增一个类型 = 加一个包 + 在需要的 profile 文件里加一行 import。**

### 6.4 错误语义两分法（硬约束）

| 失败类型 | 例子 | HTTP | 指标 | `up` | 告警路由给 |
|----------|------|------|------|------|-----------|
| **采集器自身故障** | 取不到凭据、Vault 不可达、模板缺失、并发槽耗尽、内部 panic | **500** | 无 | **0** | 平台运维 |
| **目标资源故障** | DB 拒连、认证失败、查询超时、实例宕机 | **200** | `probe_success = 0` + `probe_failure_reason` | **1** | 业务运维 |

> **绝对禁止第三种：HTTP 200 但无指标返回。** 那是静默失败——`up = 1` 看起来正常，但指标缺失导致 vmalert 表达式返回空 → **判定告警恢复 → 伪恢复**。这正是 `rc-rulecheck.md` §3.5.4 列为最高危的失效模式，而它会在采集层被无声制造出来。

有了显式 `probe_success`，目标不可达永远是主动信号而非「数据消失」。`rc-rulecheck.md` §3.5.5 那套「规则发布期强制声明缺失行为」的治理，在本采集模型下大部分可以省掉——因为不存在「缺失」，只存在 `probe_success = 0`。

### 6.5 标签职责划分

一次 `/probe` 只采一个 target，该次返回的所有指标都属于这一个实例。

- **collector 只产生**：原始业务指标 + `probe_success` + `probe_duration_seconds` + 自身状态指标
- **拓扑标签与平台标签由 Alloy 通过 relabel 注入**，来源是 http_sd 的 target labels

因此 `instance-management.md` §3.7 的 CMDB 拓扑富化链路（CMDB → `instance.labels` → http_sd target labels → 指标 → 告警 → Flink 逐级抑制）**一行都不用改**。

> 这条职责划分必须写死。否则很容易在 collector 里也打一份标签，两份不一致时排查极困难。

### 6.6 probe 模式，不用 all-in-one 模式

Oracle ADAM 支持两种形态，**必须选 probe**：

| | all-in-one（不采用） | probe（采用） |
|---|---|---|
| 端点 | 单一 `/metrics` 出全部库，靠 `database` 标签区分 | 一次请求采一个库 |
| `up` 语义 | N 个库共享一个 `up`，一个库挂了 `up` 仍为 1 → **静默失败** | per-target 清晰 |
| 标签 | collector 自己打 | Alloy relabel 注入 |
| 调度 | 需在 collector 内重做分片与 rebalance | 由 Alloy clustering 承担 |

ADAM 的文档默认推荐 all-in-one，实现时容易顺着走，需在评审中显式拦截。

### 6.7 连接池、并发、失败退避

| 项 | 设计 |
|----|------|
| **连接池** | DB 连接是 per-instance 的（不同主机与凭据），**池不能跨实例共享**。N 个实例 = N 个池。建议 `max_idle` 设 0 或 1、短 idle 超时——空闲即关、下次采集重建。代价是每次采集有建连开销（Oracle 约百毫秒级）。**参数需按类型分别调，不可一刀切**（OC-COL-05） |
| **并发上限** | Alloy 会在同一 interval 内并发触发该节点全部 target。必须有全局并发上限 + 排队 + 快速拒绝，否则 thrash |
| **失败退避** | 死目标每个周期都会耗满超时才失败，占着一个并发槽。分片内有几十个死目标即可吃光并发能力，**连带健康目标采不动**。必须对连续失败的 target 做指数退避（跳过若干周期），并在指标中暴露退避状态 |
| **per-target 隔离** | 一个 target 的连接挂住不得阻塞其他 target。每个请求独立 context 超时 |

> 参考数据点：Alloy `prometheus.exporter.oracledb` 的 `max_open_conns` 默认 **10**、`max_idle_conns` 默认 **0**，且是**组件级共享**而非 per-`database` 块。数百个库共享 10 个连接会严重排队。自研 collector 必须显式设计这一层。

### 6.8 通用采集器 + 类型特化

**首版实现四个通用采集器，而不是「每种数据库一个 collector」。** 这大幅降低首版工作量，也把 PoC 范围从「验五六个 exporter 包」收窄到「验一个 SQL 驱动 + 一个 SNMP 库」。

| 通用采集器 | 覆盖范围 | 模板定义什么 |
|-----------|---------|-------------|
| **通用 SQL** | Oracle / MySQL / PostgreSQL / MSSQL / 任何 SQL 数据源的自定义指标 | 查询语句、列→指标映射、类型、标签 |
| **通用 SNMP walk** | 所有网络设备、任何有 MIB 的设备 | OID 列表、名称、类型、标签映射、walk 参数 |
| **通用 HTTP/JSON** | 大量中间件、自研系统、云 API、任何暴露 JSON 指标的服务 | 路径、JSONPath→指标映射、凭据 profile 引用、期望状态码 |
| **通用 JMX** | Java 系中间件（Kafka / ES / Tomcat / Hadoop 等） | MBean 路径、属性→指标映射 |

有了这四个，**「新增一种监控」绝大多数时候变成「写一个模板」**——平台侧自助完成，不发版、不重启、不上机器。这比任何插件机制都彻底，因为插件仍需要有人写代码、构建、分发。

类型特化 collector 只保留给通用采集器覆盖不了的：
- 需要专有协议或复杂状态机的（Oracle 表空间/ASM 深度指标、MySQL replication 拓扑）
- 需要外部二进制的（IPMI → freeipmi）
- 需要特殊系统调用的（ICMP 拨测）

---

## 七、构建与打包

### 7.1 单仓库、单 main、profile 由 build tag 选择

```
multdc-collector/
├── go.mod                        # 单一 module
├── framework/                    # 所有 profile 共享
│   ├── collector/                # Collector 接口 + Registry
│   ├── probe/                    # HTTP server + /probe + 错误语义两分法
│   ├── mtls/  vault/  template/  limiter/  observ/
├── collectors/                   # 每类型一个包，init() 自注册
│   ├── oracle/ mysql/ postgres/ mssql/ mongodb/ redis/ memcached/
│   ├── snmp/ httpjson/ jmx/ probe/ ipmi/
├── cmd/collector/
│   ├── main.go                   # 唯一 main，组装 framework
│   ├── profile_all.go            # //go:build profile_all || (!profile_db && !profile_probe && …)
│   ├── profile_db.go             # //go:build profile_db
│   ├── profile_probe.go
│   ├── profile_ipmi.go
│   └── profile_snmp.go
├── build/
│   ├── profiles.yaml             # profile 的单一数据源
│   └── templates/                # systemd unit / rpm spec / deb control
├── Makefile
└── .gitlab-ci.yml
```

```go
// cmd/collector/profile_db.go
//go:build profile_db
package main

import (
    _ "multdc-collector/collectors/oracle"
    _ "multdc-collector/collectors/mysql"
    _ "multdc-collector/collectors/postgres"
    _ "multdc-collector/collectors/mssql"
    _ "multdc-collector/collectors/mongodb"
    _ "multdc-collector/collectors/redis"
)
```

逃生舱（临时排除某类型而不改 profile），与 `profile_*` 分开命名避免混用：

```go
// collectors/oracle/register.go
//go:build !exclude_oracle
func init() { framework.Register(&Oracle{}) }
```

### 7.2 profiles.yaml 是单一数据源

`CGO_ENABLED` 是**全局构建参数而非 per-package**，所以 profile 不能只用 build tags 表达，必须携带构建环境要求：

```yaml
version: 1
profiles:
  all:
    tags: []
    cgo: true
    system_deps: [oracle-instantclient-devel, freeipmi]
    capabilities: []
    run_user: collector
    port: 9101
  db:
    tags: [profile_db]
    cgo: true
    system_deps: [oracle-instantclient-devel]
    port: 9101
  snmp:
    tags: [profile_snmp]
    cgo: false
    system_deps: []
    port: 9103
  probe:
    tags: [profile_probe]
    cgo: false
    system_deps: []
    capabilities: [CAP_NET_RAW]     # 若 unprivileged ICMP 可行则为空
    port: 9102
  ipmi:
    tags: [profile_ipmi]
    cgo: false
    system_deps: [freeipmi]
    port: 9104
```

从这一份声明生成：**Makefile 目标、CI 矩阵、systemd unit（含 `AmbientCapabilities`）、RPM/DEB 的 `Requires`、运行用户与组、部署矩阵文档**。平台侧也可读它做部署规划。

一个 release 出多个产物，**统一版本号 + profile 后缀**：`collector-1.4.0.linux-amd64.tar.gz`、`collector-db-1.4.0.linux-amd64.tar.gz`。是一个 release 多产物，不是多版本。

### 7.3 二进制划分规则

> **all-in-one 起步。唯一的强制拆分条件是 CGO / 系统库依赖。**

若 PoC 确认 Oracle 必须用 `godror`（CGO + Oracle Instant Client），则 `collector-db` 必须拆出——让 SNMP、拨测、HTTP 采集也背上 Oracle Instant Client 的系统库依赖不可接受（部署复杂度、镜像体积、库版本冲突）。若能改用纯 Go 的 `go-ora`，则不拆。

权限（`CAP_NET_RAW`）优先尝试规避（unprivileged ICMP 或不做 ICMP），规避不了再拆。

**拆分成本 = 加一个 build tag 或一个 profile 文件，业务代码零改动。** 所以这个决定可以等 PoC 结论出来再做。

> ⚠️ 注意：**多二进制并不能隔离依赖版本**。同一个 Go module 内所有 profile 共享一份 `go.mod`，MVS 版本选择是全局的。真正的隔离需要 multi-module + `go.work`，代价是版本管理复杂度跳一个台阶且发布构建需脱离 workspace。**起步用单一 go.mod**，把依赖版本冲突列为 PoC 必验项，撞上再评估。

### 7.4 拆分触发条件

写进文档，否则会过早拆或永不拆：

- 某类型导致进程 OOM，或其 GC 压力使其他类型采集延迟超标
- 某类型 collector 反复 panic（即使有 recover）
- 某类型需要 CGO / 系统库依赖 / 特殊权限 / 外部二进制 → **一开始就拆，不等触发**
- 某类型的分片依据与其他类型差异过大（IPMI 按子进程并发、DB 按连接池、SNMP 按 CPU）
- 某类型需要独立升级节奏

### 7.5 运行时自描述

```
GET /api/v1/info
{
  "profile": "db",
  "version": "1.4.0",
  "git_commit": "abc123",
  "registered_modules": ["oracle","mysql","postgres","mssql","mongodb","redis"],
  "cgo": true,
  "capabilities": []
}
```

DC 网关渲染 http_sd 前据此校验（见 §4.2）。

---

## 八、Alloy ↔ collector 的 mTLS 信任链

### 8.1 Alloy 侧零改动

`prometheus.scrape` 原生支持 `tls_config` 块，字段含 `ca_file`/`ca_pem`、`cert_file`/`cert_pem`、`key_file`/`key_pem`、`server_name`、`insecure_skip_verify`、`min_version`。官方文档明确：配置客户端认证时必须同时提供 client certificate 与 client key。

```alloy
prometheus.scrape "collector" {
  targets = discovery.http.dc_gateway.targets
  scheme  = "https"
  clustering { enabled = true }
  tls_config {
    ca_file     = "/etc/alloy/certs/ca.crt"
    cert_file   = "/etc/alloy/certs/alloy-<node_id>.crt"
    key_file    = "/etc/alloy/certs/alloy-<node_id>.key"
    server_name = "multdc-collector"
  }
  forward_to = [prometheus.remote_write.storage.receiver]
}
```

`tls_config` 是**组件级**而非 per-target，此处正好够用：一个 Alloy 节点用一张客户端证书连本机 collector。

### 8.2 collector 侧

```go
&tls.Config{
    Certificates: []tls.Certificate{serverCert},
    ClientCAs:    caPool,
    ClientAuth:   tls.RequireAndVerifyClientCert,
    MinVersion:   tls.VersionTLS12,
    VerifyPeerCertificate: func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
        // 校验 CN 是否为本节点的 alloy-<node_id>
    },
}
```

性能无忧：multi-target pattern 下所有 target 打同一个 `host:port`，仅 query 参数不同，HTTP keep-alive 复用连接，握手次数很少。

### 8.3 信任链取代端点白名单

```
DC 网关（可信）→ http_sd 按分片渲染 target → Alloy（持节点证书）→ collector（验证证书 CN）
```

**instance_id 的合法性由信任链上游保证**——Alloy 只请求 DC 网关给它的 target，而 DC 网关按台账与注册表渲染。collector 只需确认「对面是本节点的合法 Alloy」，不需要自己知道分片归属。

因此 collector **保持完全无状态**（§6.2），不需要维护 instance_id 白名单。这取代了早先讨论过的三个端点安全选项（仅 localhost / 共享 token / instance_id 白名单）。

### 8.4 证书轮换

`tls_config` 用文件路径。轮换替换文件后 **Alloy 是否自动重读未核实**（OC-COL-02）——Prometheus 系的 TLS 实现有的用静态 `Certificates`（配置加载时读一次），有的用 `GetClientCertificate` 回调（每次握手读）。

**保守做法：轮换时重推一次 Alloy 配置触发热加载。** 证书 90 天有效期，轮换低频，代价可接受。

---

## 九、设计决策与已否决方案

### DEC-COL-01：采集调度层选 Alloy，不选 vmagent

| | Alloy | vmagent |
|---|---|---|
| target 分配 | gossip + 一致性哈希，**动态 rebalance** | `-promscrape.cluster.membersCount` / `memberNum`，**静态取模，启动参数** |
| 成员变更 | 自动 | **需外部重新分配所有 memberNum 并重启全部实例** |
| 扩容抖动 | 迁移 ~1/N | **几乎全量重分配**（取模分片的固有性质） |
| push 接收 | `otelcol.receiver.otlp` + `otelcol.auth.basic`（已核实） | 未核实，OTLP 大概率不支持 |

**决策：Alloy。** vmagent 的静态取模分片需要外部协调 memberNum，等于重造刚废弃的 Scheduler / slot 归属协商 / 冲突仲裁 / 行为决策；且扩容时的全量重分配会造成大面积采集中断窗口，而采集中断正是全量伪恢复的诱因（`rc-rulecheck.md` §3.5.4）。

### DEC-COL-02：不在 Alloy 上定开采集逻辑

**决策：Alloy 保持 stock。采集逻辑放独立 collector 进程。**

决定性理由是**故障域**：Alloy 同时承担 clustering、remote_write（带 WAL）、push 接收三项。把采集逻辑编进 Alloy，等于让万级实例的采集代码与**数据出口**同进程。一个 collector 的内存泄漏、goroutine 泄漏或未 recover 的 panic，后果不是「某类采集中断」，而是：

- remote_write 中断 → WAL 堆积 → 超容量后**数据丢失**
- clustering 节点退出 → 万级 target rebalance
- push 接收中断 → 上报类数据丢失

而 Alloy 的组件隔离**只覆盖配置评估失败**（官方文档：组件评估失败会标记 unhealthy 并用上一份有效配置继续运行、不级联），**运行时 panic 是否被 recover 文档未说明**（OC-COL-03）。定开引入的恰好全是新的运行时代码。

次要理由是**升级粒度**：升级 collector 逻辑若需换整个自定义 Alloy 二进制，会触发 clustering rebalance（万级 target 两次迁移）+ WAL 中断 + push 中断。独立进程下重启 collector，Alloy 完全不动。

其余理由：定开技术栈（Alloy 组件模型 + River + OCB + 跟上游版本 vs 标准 `net/http`）；官方明确「不为自定义构建提供商业支持」；凭据天然不进 Alloy 配置树。

**唯一优势是少一个进程**，与上述代价相比不划算。

> **连带结论：早先设计的 P0「凭据提供器 Alloy 组件」不需要做了。** 它是「在 Alloy 上定开」路线的必需品，独立进程下凭据天然在 collector 内部。

**例外（不适用本项目）**：若 all-in-one collector 只承载纯 Go、无外部依赖、低风险的类型（如只有 HTTP/JSON 采集），做成 Alloy 组件的风险小得多。但本项目明确含数据库（CGO 驱动）、IPMI（freeipmi 子进程）、拨测（可能需 `CAP_NET_RAW`），恰是三类风险最高的。

### DEC-COL-03：独立对等进程 + http_sd 路由

**决策：多个对等 collector 进程（若拆分），各自监听 localhost 不同端口，由 http_sd 的 `__address__` 分发。**

否决「主进程 + socket 转发」与「按需 fork 子进程」，理由见 §5.3。核心是 **Alloy + http_sd 已经是路由器**，运行时不需要任何 IPC。

### DEC-COL-04：all-in-one 起步，build tags 保留拆分能力

**决策：单一二进制起步，注册表路由；拆分保留为构建期选项，代码零改动。**

否决「一开始就多二进制」：多二进制真正能隔离的只有 CGO 构建、权限、故障域、升级影响四项，**不包括依赖版本**（同一 go.mod 内 MVS 全局统一）。而这四项中，CGO 是唯一可能在起步阶段就强制拆分的，其余可由 recover + per-module 限流 + 灰度发布缓解。

**配套硬要求**：单一二进制下，升级失败 = 全部采集停摆 = 全量伪恢复。因此**灰度发布 + 启动失败自动回滚从「最佳实践」升为「必需项」**。另需：每个 collector 模块强制 panic recover；带外心跳监控 Alloy 的 `alloy_component_controller_running_components{health_type!="healthy"}` 与 collector 自身 health，走硬编码最小通知路径。

### DEC-COL-05：不做运行时插件机制

| 方案 | 否决理由 |
|------|----------|
| Go 原生 `plugin`（`.so`） | 主程序与插件必须用**完全相同的 Go 版本 + 完全相同的依赖版本**编译，否则 `plugin.Open` 失败且错误晦涩；仅支持 Linux/FreeBSD/macOS；**插件无法卸载**；必须启用 CGO。Kubernetes、Prometheus 等项目均试过并放弃 |
| HashiCorp go-plugin（gRPC 子进程） | 技术可行（Terraform provider 机制），但需要插件生命周期管理、注册发现、版本协商、独立构建分发一整套运行时基础设施。**而这是为「高频新增类型」设计的，本项目的新增类型频率是每年几次** |

**决策：新增采集类型走「代码 + 灰度发布」，不做运行时插件。**

关键论证——「动态添加」有三种完全不同的东西，频率差三个数量级：

| 变更内容 | 频率 | 机制 | 需发版 |
|----------|------|------|--------|
| 新增**监控对象**（实例） | 每天 | http_sd 增减 target | ❌ |
| 新增/修改**采集内容**（OID 集、SQL、探测参数、指标开关） | 每周 | `collector_template` 下发 | ❌ |
| 新增**采集类型/协议** | 每年几次 | 加包 + `Register()` + 构建 | ✅ 灰度发布 |

只有第三类需要插件机制。用「重新构建 + 灰度发布」即可，而灰度发布在单一二进制下已是必需项（DEC-COL-04）。

**真正的解法是 §6.8 的通用采集器 + 模板**：它把第三类需求压缩到接近零，且比插件更彻底——插件仍需有人写代码、构建、分发，而模板是平台侧自助。

### DEC-COL-06：层③（社区标准 exporter 独立进程）取消

**决策：不走 YAML/INI 配置文件渲染，全部走标准调用（probe 契约）。**

理由：社区 exporter 只认配置文件，需要为每种实现一套「配置渲染 + 下发 + 触发生效」适配，而它们的生效机制各不相同（blackbox 支持 SIGHUP / `/-/reload` / auto-reload；Oracle ADAM 文件监听；snmp / ipmi / mysqld 源码有 `/-/reload` 但文档未承诺；**postgres_exporter 源码确认无热更新，改凭据必须重启进程**）。这是 O(N) 的长期适配负担，且其中一种还需要「平台远程重启 DC 侧进程」的额外控制通道。

复用粒度因此从「复用进程」变为「**复用代码库**」：collector 链接社区 exporter 的 collector Go 包（`mysqld_exporter/collector`、`snmp_exporter/collector`、Oracle ADAM collector 等），采集逻辑复用度相同，而配置/凭据/reload/端点全部统一。

**层③ 仅在嵌入 PoC 失败时作为兜底**（见 OC-COL-04）。

### DEC-COL-07：全网同构部署

**决策：所有采集节点部署相同的 profile 集合。**

异构部署（节点 A 只装 `collector-db`、节点 B 只装 `collector-probe`）疑与 Alloy clustering 冲突：**clustering 的 peer 列表来自集群 gossip（全部 Alloy 节点），而非「有该组件的节点」**。若某节点上没有对应的 `prometheus.scrape` 组件实例，分给它的 target 可能无人采集 → **静默数据空洞**。

⚠️ 此点**未核实**（OC-COL-04），是从 clustering 的 gossip 成员模型推断。它决定能否按网区裁剪部署，属实施前必验。验证成本很低：三节点集群，一个节点去掉某组件，观察 target 分配。

### 已作废的中间结论（保留索引以供追溯）

| 作废项 | 原内容 | 作废原因 |
|--------|--------|----------|
| Alloy 定开清单 P0~P3 | P0 凭据提供器组件、P1 Oracle/PG 增强、P2 MySQL/IPMI 组件、P3 中间件逐个定开 | DEC-COL-02：不在 Alloy 上定开 |
| `credential.provider` Alloy 组件 | 输入 profile 名输出 `secret`，供 Alloy 组件引用 | 同上；凭据在 collector 内，Alloy 无需感知 |
| OCB 自定义 Alloy 发行版 | 编辑 `collector/builder-config.yaml` 构建自定义 Alloy | 同上；stock Alloy 随上游升级零回归 |
| 外置社区 exporter 优先 | 第一期用 mysqld_exporter / ADAM / ipmi_exporter 独立进程 | DEC-COL-06：不走 YAML 渲染 |
| 凭据组 → `local.file` → `basic_auth.password` | 早先的 Alloy 侧凭据消费链路 | 生态无 per-target 凭据（见 `credential-management.md` §三），且违反 CP4 |
| DC 网关按分片渲染 `__address__` | 分片映射体现在 `__address__` 指向不同 collector 实例 | §5.1：分片由 clustering 承担，`__address__` 静态 |
| nginx 按路径转发 | 单一入口 + 多 exporter | §5.3 |
| 主进程 + socket 转发 / 按需 fork | collector 内部路由机制 | §5.3 |
| 端点安全 S1/S2/S3 | localhost / 共享 token / instance_id 白名单 | §8.3：mTLS 信任链取代三者 |
| 四层采集形态 | ①Alloy内置 ②聚合模块 ③社区exporter独立进程 ④机上agent | DEC-COL-06：层③取消，塌为三层 |

---

## 十、实施期必验项（PoC）

前四项决定方案可行性与工作量估算，**必须在框架开发前完成**。

| # | 验证项 | 决定的事 | 方法 |
|---|--------|----------|------|
| **OC-COL-04a** | **Oracle 驱动选型：`go-ora`（纯 Go）vs `godror`（CGO + Instant Client）** | 是否需要拆出 `collector-db`；整个二进制是否背 CGO 与系统库依赖 | 用监控采集实际会跑的 `v$` 视图查询逐个验证 go-ora 兼容性 |
| **OC-COL-04b** | **社区 collector 包能否干净嵌入** | 复用代码库这条路是否成立；层③ 是否需要作为兜底保留 | 拿 Oracle ADAM + mysqld_exporter + snmp_exporter 三个 collector 包编进同一二进制，验 kingpin 全局 flag 注册冲突、包级 `init()` 副作用、全局 Prometheus registry 冲突 |
| **OC-COL-04c** | **单一 go.mod 下的依赖版本冲突** | 是否需要 multi-module + `go.work` | 上述三包同时引入后跑 `go mod tidy`，检查 MVS 选出的版本是否破坏任一包 |
| **OC-COL-04d** | **Alloy clustering 在组件缺失节点上的行为** | 能否异构部署（按网区裁剪 profile） | 三节点集群，一个节点去掉某 `prometheus.scrape` 组件，观察 target 是否被分配给该节点造成空洞 |
| OC-COL-01 | Alloy `config_file` 是否监听文件变更并自动重载 | 层① 是否可用于 SNMP/拨测 | 改文件后观察是否生效，或是否需触发 Alloy reload |
| OC-COL-02 | Alloy `tls_config` 的证书文件是否自动重读 | 证书轮换是否需重推配置 | 替换证书文件后观察握手是否用新证书 |
| OC-COL-03 | Alloy 是否在组件框架层对 collector goroutine 做 panic recover | DEC-COL-04 的 recover 硬约束是否可由框架代劳 | 读 `internal/runtime/internal/controller` 或注入 panic 组件实测 |
| OC-COL-05 | 各类型的连接池实际参数（尤其 Oracle 建连开销） | `PoolLimits()` 的默认值 | 压测 |
| OC-COL-07 | `prometheus.exporter.snmp` 的 `targets` 能否由 `discovery.http` 喂（而非仅 `discovery.file`） | 层① 的新增设备是否需改 Alloy 配置 | 实测类型兼容性 |
| OC-COL-08 | unprivileged ICMP（`net.ipv4.ping_group_range`）能否替代 `CAP_NET_RAW` | `collector-probe` 是否必须独立 | 实测；社区 blackbox 的 icmp prober 默认走 raw socket，是否支持 unprivileged 模式需查 |
| OC-COL-09 | `secret` 值变化在 Alloy 组件图中的传导语义 | 仅当层① 被采用时相关 | — |

---

## 十一、冲突与开放问题

| ID | 问题 | 影响 | 状态 |
|----|------|------|------|
| OC-COL-04 | PoC 四项（a~d）未完成 | 决定工作量估算（2 人月 vs 8 人月的差别在此）与二进制划分 | **阻塞实施，优先做** |
| OC-COL-06 | **node_exporter / windows_exporter 的部署与升级归属未定** | 万级被监控机上的 agent 安装、版本上报、灰度升级无归属模块。`instance-management.md` 把 Linux 类型的 agent 写作 `node-exporter / ssh-agent`，但未说谁装、怎么升级、怎么知道版本 | 建议归 `instance-management`，新增「本机 agent 生命周期」一节 |
| OC-COL-10 | SSH 远程采集是否正式化为一类采集方式 | blackbox **无 SSH probe**（仅 icmp/tcp/unix/dns/http/grpc/websocket）。对不便安装 agent 的机器，SSH 采集是唯一「目标机零安装」的 OS 指标方案，代价是连接开销大、延迟高、并发受限、需私钥管理 | 建议正式化为补充手段并明确适用边界 |
| OC-COL-11 | 中间件类型的定开优先级 | 需各类型实例数量分布才能排序 | **待业务方提供数据** |
| OC-COL-12 | collector 的 `/probe` 端点是否需限流保护 | 恶意或错误的 Alloy 配置可能打爆 collector | 建议 framework 层统一限流 + 快速拒绝 |
| OC-COL-13 | `shard_max` 的实际取值 | 注册表字段已定义，取值需压测数据 | 待 OC-COL-05 |
| OC-COL-14 | collector 自身指标如何进入告警链路 | collector 的 health 指标需被采集才能告警；若由 Alloy scrape collector 的 `/metrics`，则 collector 故障时该 scrape 也失败——需带外心跳覆盖 | 建议纳入带外心跳监控范围（`rc-rulecheck.md` §3.5.4） |
