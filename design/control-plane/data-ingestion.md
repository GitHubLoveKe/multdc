# 数据接入模型 (Data Ingestion)

> 版本：v1.0 | 日期：2026-09-29
> 状态：设计定稿，含待裁决项（见 §六）
>
> 本文档定义平台支持的三类数据接入形态，以及每类在**平台查询 / rulecheck 策略 / 实例记录 / 数据管理**四个维度上的行为差异。
>
> 上游依赖：`collection-topology.md`（采集侧架构）、`credential-management.md`（凭据与模板）、`query-gateway.md`（查询路由）、`rc-rulecheck.md`（规则评估与恢复语义）、`alert-management.md`（收敛与去重）、`storage.md`（写入与去重）

---

## 一、概述

### 1.1 现有设计的单一隐含假设

既有文档只描述了一条链路：

```
instance 台账 → DC 网关 http_sd → Alloy scrape → vmstorage(prime)
  → vmselect fan-out → vmalert(prime) → AM → am-bridge → Kafka → Flink → 平台
```

它假设：**每个被监控目标都是平台主动采集的、有 IP 与端口的、可连通性测试的、产生 `up` 指标的 pull 型目标。**

三类接入场景各断在这条链路的不同位置：

| 场景 | 断在哪 | 连带失效的既有设计 |
|------|--------|-------------------|
| **数据上报类**（push，无采集任务） | 前两环（无 http_sd target、无 Alloy scrape） | `rc-rulecheck.md` §3.5.5 的伪恢复治理**完全建立在 `up == 0` 看门狗上**；`instance-management.md` §3.3 快速测试的连通性/认证/采集三步全是 pull 语义；`storage.md` §3.5.1 的标签注入规范假定 `instance`/`job`/`zone_id` 由平台注入 |
| **外接数据源**（非平台自建） | 从台账到 vmstorage 整段 | vmselect **只能挂 vmstorage**，挂不了外部 Prometheus，故 `query-gateway.md` §3.3 的 fan-out 模型覆盖不到；RC-05「规则仅下发 prime」的前提（vmalert 查 vmselect 即有全局视图）对外部源不成立 |
| **多网区采集**（N 份独立观测） | 不断链，但语义未定义 | `storage.md` §3.5.1 与 §3.6.2 的去重语义矛盾；`dedup_key` 排除 `zone` 会误杀独立观测（见 §5.1） |

### 1.2 统一模型

```sql
ALTER TABLE instance
    ADD COLUMN ingest_mode ENUM('pull','push') NOT NULL DEFAULT 'pull';
```

**外接数据源不进 instance 台账**，单列 `external_datasource` 实体（§四）。理由：配置单位是「源」而非「目标」；平台不拥有外部源的目标清单、无法测试、无法约束其标签。硬注册成 instance 只会得到一堆永远 `pending`、永远测不通的记录。

| ingest_mode | 数据流向 | 平台角色 |
|-------------|----------|----------|
| `pull` | 平台主动采集 | 主动方 |
| `push` | 上报方推送 | 被动方 |
| （external） | 外部系统持有数据 | 代理方 / 复制方 / 告警接收方 |

---

## 二、职责边界

**本文档负责**：
- 三类接入形态的实体模型与生命周期
- 每类在四个维度（查询 / rulecheck / 实例记录 / 数据管理）上的行为定义
- push 接入的鉴权、标签注入、配额与缺失检测
- 外接数据源三种访问模式的能力矩阵与限制
- 多网区独立观测的标签、去重与规则聚合语义

**本文档不负责**：
- 采集侧的进程模型与 probe 契约（→ `collection-topology.md`）
- 凭据加密与 Vault 拓扑（→ `credential-management.md`）
- vmselect fan-out 与查询路由实现（→ `query-gateway.md`）
- Flink 收敛引擎的算子链（→ `alert-management.md`）
- 但本文档 §五 提出对 `alert-management.md` §3.2.1 与 `storage.md` §3.5.1/§3.6.2 的**修订要求**

---

## 三、场景一：数据上报类（push，无采集任务）

### 3.1 实例记录

复用 `instance` 表（`ingest_mode = 'push'`），字段调整：

| 字段 | pull | push |
|------|------|------|
| `ip_address` | NOT NULL | **放宽为 nullable**（push 无拨号地址） |
| `port` | 目标端口 | 无意义 |
| `credential_id` → `credential_profile_id` | 出站凭据（平台登录目标） | **入向凭据**（校验上报方身份），类型为 htpasswd 条目 |
| `config_template_id` | scrape 配置模板 | 无意义，改用 `push_policy` |
| `multi_zone_mode` | 按类型 | **恒为 `disabled`** |
| `instance_zone_mapping` | 可多行 | **仍写一行 `role='primary'`**，让下游 join 不分叉 |

新增：

```sql
ALTER TABLE instance
    ADD COLUMN push_policy JSON;   -- 仅 ingest_mode='push' 有效

-- push_policy 结构
{
  "declared_interval": "60s",        -- 声明的上报间隔（用于缺失检测阈值）
  "heartbeat_metric": "app_heartbeat", -- 强制声明且只允许一个
  "metric_allowlist": ["app_*", "biz_*"],
  "label_allowlist": ["env", "service", "region"],
  "max_series": 5000,
  "max_samples_per_sec": 200,
  "ingest_zone_id": "zone-east-1"   -- 由接入点决定，注册时声明
}
```

**生命周期状态机不变**（`pending → testing → active → suspended → decommissioned`），但 `testing` 的触发方式改变：

| | pull | push |
|---|---|---|
| testing 语义 | 平台主动拨测（连通性 + 认证 + 单次采集） | **首包验收**：等待第一包数据到达，按 `push_policy` 校验 |
| 校验项 | TCP connect / auth / scrape | 心跳指标是否存在、标签是否在白名单内、速率是否合理、指标名是否匹配 allowlist |
| 结果记录 | `quick_test_record` | **复用 `quick_test_record`**，`agent_node_id` 填接入点标识 |

`instance-management.md` §3.3 的三步 pull 测试对 push 全部替换。

**zone 归属由接入点决定、注册时声明。** push 无 IP，网段推荐失效；而 zone 决定数据落哪个 prime storage、进而决定哪个 vmalert 评估——这条链不能断。

### 3.2 数据管理

**接入通道：复用现有 Alloy，不新增进程。**

用 `otelcol.receiver.otlp` 而非 `prometheus.receive_http`，理由是**接收侧鉴权**：

| 组件 | 接收侧鉴权 |
|------|-----------|
| `prometheus.receive_http` | ❌ **无任何鉴权配置**（已核实，只有 `http { listen_address, listen_port }`） |
| `otelcol.receiver.otlp` | ✅ `http.auth` / `grpc.auth` 可接 `otelcol.auth.basic`（含 **htpasswd 文件**）与 `otelcol.auth.bearer` |

> 官方文档提示：并非所有 `otelcol.auth.*` 组件都支持 receiver 侧认证，basic 与 bearer 支持。实施前需按所用 Alloy 版本再确认（OC-ING-01）。

**代价**：上报方必须会说 OTLP。若现实中上报方只会 Prometheus remote_write，则需 `prometheus.receive_http` + 前置鉴权代理（新组件）。**这是待裁决项 D1。**

**标签注入**：在 Alloy pipeline 内用 `otelcol.processor.attributes` / `prometheus.relabel` 注入 `instance=<instance_id>`、`zone_id`、`ingest_mode=push`。

标签优先级新增一级（修订 `instance-management.md` §3.4）：

```
1. 平台注入标签（instance / zone_id / ingest_mode）  ← 新增，最高
2. CMDB 拓扑标签（host_id / rack_id / switch_id / cluster_id）
3. 用户手动设置
4. 网区自动继承
5. 类型默认
```

上报方同名标签被覆写；白名单外的上报方标签丢弃。

**配额**：push 流量不受 `scrape_interval` 节流，**平台失去了唯一的天然限流阀**。

- 第一期：声明式配额（`max_series` / `max_samples_per_sec`）+ 超限记录与告警 + 事后审计
- **硬限流延后**：Alloy 无原生 per-tenant 限流；vminsert 的 `-maxInsertRequestSize` 粒度是请求而非租户

这是已知缺口，标记为「先软后硬」（OC-ING-02）。

**保留期**：跟随落地 storage 的 retention。VM 的 retention 是实例级的，不做 per-source 差异化。

### 3.3 平台查询

**零改动。** 数据在 vmstorage，vmselect fan-out 覆盖，`query-gateway.md` 的路由逻辑不变。

新增项：
- `ingest_mode` 作为实例列表的可筛选列
- `instance` 标签值约定必须稳定（如 `push-00042`），使 `{instance="push-00042"}` 可查

⚠️ **push 实例没有 `up` 指标**。所有依赖 `up` 的现成面板与查询集对 push 无效。`metric-management.md` 需为查询集标注 `ingest_mode` 适用性（OC-ING-03）。

### 3.4 rulecheck 策略

规则仍下发到该 zone 的 **prime vmalert**，与 RC-05 一致，**零改动**。

变的是**缺失检测**——`up == 0` 不可用，而 VictoriaMetrics 的 staleness 默认 **5m**（instant query 的 `step` 参数默认值），意味着上报停止后 `absent()` 最快也要 5 分钟才 firing。

**方案：成对自动生成两条规则。**

| 规则 | 表达式 | 覆盖范围 |
|------|--------|----------|
| **快规则**（精确） | `time() - timestamp(<heartbeat>{instance="X"}) > 3 × declared_interval` | 5m staleness 窗口内的上报迟到 |
| **慢规则**（兜底） | `absent(<heartbeat>{instance="X"})` | 序列彻底消失（窗口外） |

**必须成对**：单用快规则有陷阱——序列一旦超出 5m 窗口，表达式返回空 → 快规则自身「恢复」。

`push_policy.heartbeat_metric` **强制声明且只允许一个**，于是 `rc-rulecheck.md` §3.5.5 选项 2「`absent()` 成本高」的反对意见被消掉：从 N 个 `absent()` 降到 **1 对规则，且自动生成**。

**对 §3.5.5 的修订要求**：其三选一对 push 改写为「心跳指标 + 上述成对规则」，且为**强制项**而非三选一（选项 1 的 `up` 看门狗对 push 不适用）。

`keep_firing_for`（vmalert 原生支持的规则字段）可用于抑制上报抖动导致的瞬时恢复。

---

## 四、场景二：外接数据源（非平台自建）

### 4.1 实体模型

```sql
CREATE TABLE external_datasource (
    ds_id            VARCHAR(64)   PRIMARY KEY,
    name             VARCHAR(128)  NOT NULL,
    ds_type          ENUM('prometheus','victoriametrics','opentsdb',
                          'zabbix','cloudwatch','custom') NOT NULL,
    access_mode      ENUM('proxy','replicate','alert_only') NOT NULL,
    zone_id          VARCHAR(64)   NOT NULL,        -- 决定标签注入与规则归属
    status           ENUM('pending','testing','active','suspended','decommissioned')
                     NOT NULL DEFAULT 'pending',

    -- 通用
    credential_profile_id VARCHAR(128),
    labels           JSON,                          -- 注入该源全部数据的标签，含 source_ds
    query_capability JSON,                          -- 是否支持 PromQL / federation / remote_read

    -- proxy
    endpoint         VARCHAR(256),
    query_timeout_ms INT DEFAULT 30000,

    -- replicate
    replicate_config JSON,   -- { scrape_targets|federate_url, interval, metric_allowlist,
                             --   target_storage_id, retention_days }

    -- alert_only
    webhook_path     VARCHAR(128),                  -- 我方接收地址
    alert_mapping    JSON,                          -- 外部字段 → alertname/labels/severity
    sends_resolved   BOOLEAN NOT NULL DEFAULT FALSE,-- 外部系统是否发 resolved（必须显式声明）

    last_test_at     TIMESTAMP,
    last_test_result ENUM('pass','fail','unknown'),
    created_at       TIMESTAMP NOT NULL,
    updated_at       TIMESTAMP NOT NULL
);
```

**复用 `instance` 的生命周期状态机与测试记录结构**：
- proxy / replicate 的 `testing` = 连通性 + 一次探针查询
- alert_only 的 `testing` = webhook 握手

### 4.2 规则作用域的根本差异

**外接源没有 `instance_id`**，规则不能按实例挂载，必须按 **`source_ds="<ds_id>"` 标签作用域**挂载。

这是与现有规则模型最实质的差异。规则管理模块需支持「按数据源作用域」这一新维度（OC-ING-04）。

实现方式：proxy 模式的独立 vmalert 用 `-external.label=source_ds=<ds_id>` 给其全部规则统一打标（已核实为 vmalert 原生 flag）；replicate 模式在写入时注入该标签。

### 4.3 平台查询

| access_mode | 查询能力 | 实现 |
|-------------|----------|------|
| **replicate** | 与自建数据完全一致 | 数据落到指定 vmstorage → vmselect fan-out 覆盖 → **查询网关零改动** |
| **proxy** | **仅单源透传 + 序列级 union，不支持跨源聚合** | 查询网关层联邦：解析查询 → 并行发往 vmselect（内部）与各外部源的 `/api/v1/query_range` → 合并 |
| **alert_only** | **无任何查询能力** | 该源在 UI 上没有图表下钻 |

**proxy 模式的硬限制（必须在配置界面明示）**：

PromQL 的聚合函数**不能在网关二次合并**。`avg by(x)` 需要原始序列；把表达式下推到每个源再合并结果在数学上是错的（无法从各源的平均值算出全局平均值）。因此：

- 允许：单源查询（用户显式选源，网关透传）
- 允许：序列级 union（网关只做并集，不做聚合下推）
- **禁止**：跨源聚合表达式 → 必须报错或降级为单源，不得静默返回错误结果

Grafana 的 mixed datasource 受同样限制。

> 这正是 `query-gateway.md` §6.1 中被否决的「方案 B：自研聚合层」，现在为了 proxy 模式必须**部分**实现。需修订该文档的决策记录。

**用户选型指引（写进 access_mode 能力矩阵）**：要跨源聚合就选 replicate。

### 4.4 rulecheck 策略

| access_mode | 规则评估方式 | 部署 |
|-------------|-------------|------|
| **replicate** | 走现有链路：规则下发到数据落地 storage 的 **prime vmalert** | 存储侧，零改动 |
| **proxy** | **每源一个独立 vmalert**：`-datasource.url` 指向外部源、`-notifier.url` 指向某个 AM、`-external.label=source_ds=<ds_id>`（三个 flag 均已核实为 vmalert 原生支持） | **平台侧**（不查 vmselect，无需与存储共部署） |
| **alert_only** | 平台不评估规则，职责退化为**告警接入与归一化** | 新组件 `external-alert-bridge` |

**proxy 模式与 RC-05 的表述冲突，需修订 RC-05 措辞**：

RC-05 的实质约束是「**同一份规则包不下发多份**以防重复告警」，不是「全平台只能有 prime vmalert」。proxy vmalert 持有的是针对不同外部源的**不相交规则集**，不产生重复。建议改述为「同一规则包仅下发一个 vmalert」。

**alert_only 的注入点必须是 Kafka `alert.raw`，不能过 AM**：

AM 的两项职责对外部告警都不适用——外部告警没有存储域（fingerprint 去重无意义），而 `resolve_timeout`(30m) 会在外部系统 30 分钟没重发时**错误地把它判为 resolved**。

`external-alert-bridge`（与 am-bridge 同构）：webhook 接收 → 字段映射 → 计算 `dedup_key` → 写 `alert.raw`。

> ⚠️ **必须补偿的代价**：am-bridge 上游有 AM 做时间维度削峰（约两个数量级，DEC-029 明确这是 Flink 能在风暴下存活的前提）。alert_only 路径**绕过了 AM**，外部告警风暴会未削峰直接打到 Flink。因此 `external-alert-bridge` **必须自己实现 fingerprint 去重 + `repeat_interval` 重发抑制**——等于把 AM 的两项职责重复实现一遍。这是 alert_only 模式最主要的成本，选型时必须明示。

> ⚠️ **resolved 依赖外部系统主动发送**。`sends_resolved = false` 的源，其告警只能等 Flink state TTL(24h) 过期，表现为**永不恢复**。必须在接入配置时显式声明并在 UI 标注。

**replicate 模式的拓扑标签缺失问题**：

外部源没有 CMDB 富化，`host_id`/`rack_id`/`switch_id`/`cluster_id` 四个拓扑标签都不存在 → **Flink 逐级抑制对该源数据静默失效**（正是 DEC-RC-05 警告的失效模式：告警仍正常产生和通知，只是不再被抑制，故障时表现为告警风暴）。

| 方案 | 成本 | 建议 |
|------|------|------|
| (a) 在 replicate 的 relabel 阶段按映射表补拓扑标签 | 高（需维护外部标识 → CMDB 标识的映射） | 可选增强 |
| (b) **显式声明该源不参与 RCA 抑制，并在 UI 标注** | 零 | **默认** |

### 4.5 数据管理

| access_mode | 数据存储 | 保留期 | 降级行为 | 主要风险 |
|-------------|----------|--------|----------|----------|
| **proxy** | 平台不存 | 不拥有 | 外部源不可用 = 该源不可查，**无降级** | 查询延迟受外部源影响；需健康探测覆盖外部源 |
| **replicate** | 落到指定 vmstorage | 可独立配置 | 外部源不可用时停止增量，存量可查 | **外部源序列基数平台不可控，可能打爆 vmstorage** |
| **alert_only** | 无时序数据 | — | — | 只有告警事件进 `alert.event` 账本（已有，零改动） |

**replicate 的必备防护**：指标白名单 + 写入前 relabel/过滤 + 建议独立 storage 或独立 retention。

**replicate 的拉取通道**：优先用现有 **Alloy**（scrape 对方 `/federate` 端点，或接收对方的 remote_write），不引入 vmagent，保持组件收敛。

**健康探测**：外部源需纳入 DC 网关的健康检测职责范围（或平台侧独立探测），并在源不可用时告警。

---

## 五、场景三：多网区采集（N 份独立观测）

**语义定性（已裁决）**：多网区采集同一目标 = **N 份独立观测**（拨测语义），保留 `zone` 标签，**跨网区不合并**。

### 5.1 缺陷修正一：`dedup_key` 会误杀多网区独立观测

**现状**：`alert-management.md` §3.2.1 规定 `dedup_key = hash(alertname + sorted(labels − 来源标识标签))`，排除列表为 `zone` / `zone_id` / `source_storage` / `source_am` / `dc`。

**问题**：拨测实例 `dial-001` 从 zone-A、zone-B 各观测一次，prime vmalert 一次评估看到两条序列 → 产生两条告警（`zone` 不同）→ `dedup_key` 相同 → Flink first-wins **合并成一条**，丢掉「两个网区都失败」这个本该升级严重度的信号。

§3.2.1 的表格把「多 DC 实例」列为重复来源，但那一行的前提是「规则下发到所有关联 DC」——**RC-05 裁决为「仅 prime」后该前提已不成立**，文档自己也承认「这消除了多 DC 场景的主要重复来源」。排除 `zone` 的理由已失效一半。

**修订建议：判重条件从「`dedup_key` 相同」改为「`dedup_key` 相同 AND `source_am` 不同」。**

| 重复来源 | zone | source_am | 修订后 |
|----------|------|-----------|--------|
| prime 迁移窗口（新旧 prime 短暂同时持有规则） | 同 | **不同** | 判重 ✅ |
| 实例跨网区迁移期，新旧网区同时评估 | 不同 | **不同** | 判重 ✅ |
| 规则包重复下发到同一存储 | 同 | 同 | 不判重，但**同 fingerprint → AM 域内去重已覆盖** ✅ |
| **多网区独立观测（拨测）** | 不同 | 同 | **不判重 ✅（当前会误杀）** |

四类全覆盖。

**附带收益**：不再需要维护「来源标识标签排除列表」——**RC-10 那条开放问题（「新增来源类标签未同步列表会导致跨域去重静默失效」）一并消解**，因为判据从标签排除改成了物理来源标识。这是净简化。

> 需修订：`alert-management.md` §3.2.1、`rc-rulecheck.md` DEC-RC-06 与 §3.5.3、`decisions-log.md` DEC-029 / DEC-032（`alert.raw` partition key 仍为 `dedup_key`，不变）；Flink stage 3 逻辑。

### 5.2 缺陷修正二：`alloy_instance_id` 注入破坏同区副本去重

**现状**：`storage.md` §3.5.1 把 `zone_id` / `alloy_instance_id` / `node_id` 列为强制注入标签；§3.6.2 把去重键描述为 `(zone_id, alloy_instance_id, __name__, labels_hash, timestamp)`。

**问题**：Alloy clustering 用一致性哈希分配 target，理论上同一 target 只被一个 Alloy 采，但 **rebalance 窗口会重叠**。此时两个 Alloy 各写一份，label set 因 `alloy_instance_id` 不同而不同，vmselect `-dedup` **不会合并**（VM 按完整 label set 去重）→ 同区双份数据 → `avg by(instance)` 重复计数、阈值规则双触发。

**修订建议**：

| 标签 | 处置 |
|------|------|
| `zone_id` | **保留**（多网区独立观测需要它区分观测来源） |
| `instance` / `job` | 保留 |
| `alloy_instance_id` / `node_id` | **移出数据标签**，只保留在 Alloy 自身指标上（如 `up{job="alloy"}`）供排障 |

效果：同区副本 label set 一致 → VM dedup 生效；跨区 label set 不同 → 不合并，正是 N 份独立观测要的语义。

**同时修订 §3.6.2 的机制描述**：`(zone_id, alloy_instance_id, __name__, labels_hash, timestamp)` **不是 VictoriaMetrics 的实际机制**。`-dedup.minScrapeInterval` 是按**序列身份（完整 label set）**去重、每个间隔保留一个样本，**没有可配置的去重键**。当前描述会误导实现。

### 5.3 rulecheck 聚合语义

N 份独立观测要求规则**显式声明跨 zone 的聚合意图**，否则用户很容易写出对 N 份数据求 `avg` 的错规则。

**建议在规则模板层内置两类聚合，而不是让用户每次手写 PromQL**：

| 聚合语义 | 含义 | 表达式形态 |
|----------|------|-----------|
| `any_zone` | 任一网区触发即告警 | `count(<expr>) >= 1` |
| `quorum(M/N)` | M 个以上网区触发才告警——**过滤单网区网络抖动，拨测最常用** | `count(<expr>) >= M` |

**严重度联动**：quorum 命中数可作为 severity 升级依据（1 个网区失败 = warning，全部失败 = critical）。需规则模板支持，纯 PromQL 手写容易漏。

规则仍**只下发 prime**（RC-05 不变）。prime vmalert 通过 vmselect 看到全部 N 份观测，一次评估完成 quorum 判定。

### 5.4 数据管理与查询

- **序列数 ×N**。`storage.md` §3.8.1 的容量公式按 `target_count` 算，多网区实例应按 **Σ(关联 zone 数)** 计
- **查询侧 vmselect fan-out 已正确覆盖，无需改动**
- **前端约定**：多网区实例的图表必须**按 zone 分面**，否则 N 条同 `instance` 的序列画在一张图上无法区分。这是 UI 约定而非架构问题，但要写进 `metric-management.md` 的查询集规范

---

## 六、待裁决与开放问题

### 6.1 本轮已裁决（记录）

| # | 事项 | 裁决 |
|---|------|------|
| D-ING-01 | 上报类在台账中如何记录 | **复用 `instance` 表 + `ingest_mode` 字段**（否决独立 `push_source` 注册表与「不注册自动建档」） |
| D-ING-02 | 外接数据源的边界 | **按源可配 `proxy` / `replicate` / `alert_only`**（否决统一 replicate、统一 proxy、统一 alert-only） |
| D-ING-03 | 多网区采集语义 | **N 份独立观测**（拨测语义），保留 zone 标签，跨区不合并 |
| D-ING-04 | `dedup_key` 判据 | 改为「`dedup_key` 相同 AND `source_am` 不同」（§5.1） |
| D-ING-05 | `alloy_instance_id` / `node_id` | 移出数据标签（§5.2） |
| D-ING-06 | 外接源规则作用域 | 按 `source_ds` 挂载，不按 `instance_id` |
| D-ING-07 | replicate 模式的拓扑标签 | 默认不补，显式声明该源不参与 RCA 抑制并在 UI 标注 |
| D-ING-08 | proxy 模式的跨源聚合 | **不做**，只单源透传 + 序列级 union |
| D-ING-09 | `external-alert-bridge` 削峰 | 自己实现 fingerprint 去重 + `repeat_interval` 抑制 |

### 6.2 待裁决

| ID | 问题 | 建议 | 状态 |
|----|------|------|------|
| **OC-ING-01** | **push 接入协议**：`otelcol.receiver.otlp`（OTLP + htpasswd 鉴权）vs `prometheus.receive_http` + 前置鉴权代理 | 前者。**代价是上报方必须会说 OTLP**。若现实中上报方只会 Prometheus remote_write（更常见），则需后者，代价是新增一个 DC 侧组件 | **待业务方确认上报方形态** |
| OC-ING-02 | push 配额的硬限流实现 | 第一期声明式 + 告警 + 审计；硬限流延后 | 待定 |
| OC-ING-03 | `metric-management.md` 的查询集需标注 `ingest_mode` 适用性 | 需修订该文档 | 待处理 |
| OC-ING-04 | 规则管理模块支持「按数据源作用域」挂载 | 需新增维度 | 待设计 |
| OC-ING-05 | 外接源的健康探测归属：DC 网关扩展 vs 平台侧独立探测 | 建议 DC 网关（已是其五职责之一「健康检测」） | 待定 |
| OC-ING-06 | replicate 模式是否需要独立的 storage 与 retention | 建议是（外部源基数不可控） | 待定 |
| OC-ING-07 | `alert_only` 的外部告警字段映射如何管理 | 每源一份 `alert_mapping` JSON；是否需要可视化映射编辑器 | 待定 |
| OC-ING-08 | 多网区实例的 quorum 规则模板如何与既有 RuleSpec 模型融合 | 需修订规则管理相关文档 | 待设计 |
| OC-ING-09 | VictoriaMetrics 的 `timestamp()` 函数在 staleness 窗口边界的确切行为 | §3.4 的快规则依赖它。需实测：上报停止 3 分钟时 `time() - timestamp(x)` 是否返回 180 | **实施前必验** |
| OC-ING-10 | push 场景下 `instance` 标签值的命名约定 | 建议 `push-<seq>`，与 pull 型的 `<type>-<seq>` 区分，便于查询集标注适用性 | 待定 |

### 6.3 对其他文档的修订要求汇总

| 文档 | 修订内容 |
|------|----------|
| `instance-management.md` | §3.1 生命周期：push 的 `testing` 改为首包验收；§3.2 类型表增 `ingest_mode` 与 push 类型；§3.3 快速测试：push 的替换说明；§3.4 标签优先级新增「平台注入」为最高级；§4.1 `instance` 表增 `ingest_mode` / `push_policy`，`ip_address` 放宽 nullable |
| `query-gateway.md` | §3.2 路由引擎增 external datasource 联邦；§6.1 决策记录修订（方案 B 部分实现）；新增 access_mode 能力矩阵与「proxy 不支持跨源聚合」的明示要求 |
| `rc-rulecheck.md` | §3.5.5 对 push 改写为「心跳 + 成对规则」且为强制项；DEC-RC-06 与 §3.5.3 的 `dedup_key` 判据修订；RC-05 措辞改为「同一规则包仅下发一个 vmalert」；RC-10 可标记为已消解 |
| `alert-management.md` | §3.2.1 判重条件改为「`dedup_key` 相同 AND `source_am` 不同」；新增 `external-alert-bridge` 组件（A8）与其削峰职责；§3.11.2 补充 push 场景的缺失检测差异 |
| `storage.md` | §3.5.1 标签注入规范：移除 `alloy_instance_id` / `node_id`；§3.6.2 去重机制改为事实描述（按完整 label set，无可配置去重键）；§3.8.1 容量公式按 Σ(zone 数) |
| `metric-management.md` | 查询集增 `ingest_mode` 适用性标注；多网区实例图表按 zone 分面的规范；`any_zone` / `quorum` 规则模板 |
| `README.md` | 模块索引增 `data-ingestion.md` / `collection-topology.md` / `credential-management.md`；A 系列组件增 A8 `external-alert-bridge` |
| `decisions-log.md` | 增补 DEC-ING-01~09；修订 DEC-029（判据）、DEC-030（表述滞后，仍以 fingerprint 立论）；RC-10 标记消解 |
