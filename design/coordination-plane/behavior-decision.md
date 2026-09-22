# 行为决策

> **版本：v2.0** | **日期：2026-09-22** | **状态：大幅简化**

---

## 一、变更说明（v1.0 → v2.0）

原 v1.0 设计了独立的行为决策模块，包含集中式重平衡计划、驱逐/接管协调、三层抑制机制、扩缩容建议等复杂流程，依赖 Coordinator 和多数派投票。

**v2.0 变更：** Rendezvous Hashing + Gossip 协议使绝大多数行为决策自动化，独立行为决策模块不再必要。

### 功能迁移映射

| 原 v1.0 功能 | v2.0 归属 | 说明 |
|-------------|----------|------|
| 重平衡（RebalancePlan + 三层抑制） | Scheduler 本地 | Rendezvous Hashing 自动重算 |
| 驱逐（EvictionPlan） | Scheduler 本地 | Gossip + 哈希重算 |
| 接管（TakeoverPlan + 多数派确认） | Scheduler 本地 | Gossip + 哈希重算 |
| 隔离（Quarantine） | Scheduler 本地 | 本地处理 |
| 扩缩容建议（ScalingRecommendation） | 控制面直接判断 | 不再经协调层中转 |
| 迁移执行监控 | Scheduler 本地 | 哈希重算即结果 |

## 二、当前行为决策机制

### 2.1 重平衡 → Rendezvous Hashing 自动重算

节点增减后，所有 Scheduler 独立重新计算 `hash(target_id, member_list)`，结果自动收敛。无需集中式重平衡计划。

- 新节点加入 → Gossip 传播 → 所有节点成员列表更新 → 哈希重算 → 部分 target 自动归属新节点
- 节点故障 → Gossip 标记 dead → 哈希重算 → target 自动归属存活节点

### 2.2 驱逐与接管 → Gossip + 哈希重算

不再区分"驱逐"和"接管"。节点状态变更通过 Gossip 传播后，每个 Scheduler 独立重算哈希，target 自然迁移到新的 owner。

- 优雅下线：节点先标记自己为 "draining"（Gossip 传播），其他节点感知后重算哈希
- 故障下线：Gossip 标记 dead 后，所有节点重算哈希

### 2.3 三层防抖

防抖机制保留，但实现完全在 Scheduler 内部，详见 [job-scheduler.md §3.5](../data-plane/job-scheduler.md)：

1. **稳定窗口**（9s）：拓扑变更需持续 9s 才触发重算
2. **迁移速率限制**（10%/周期）：每个周期最多迁移 10% 的 target
3. **冷却期**（5min）：两次重算间隔不少于 5 分钟

### 2.4 隔离 → 本地处理

Scheduler 本地检测到异常节点（如反复 flapping），可将其从成员列表中移除（不参与哈希计算）。无需协调层介入。

### 2.5 扩缩容 → 控制面直接判断

控制面基于 Scheduler 上报的负载数据直接判断扩缩容，不再经协调层中转建议。

## 三、已废弃机制

| 已废弃数据模型 | 替代 |
|--------------|------|
| RebalancePlan | 不需要，哈希自动重算 |
| SlotMigration | 不需要，无 slot 概念 |
| InhibitionState | 三层防抖内化到 Scheduler |
| TakeoverPlan | 不需要，Gossip + 哈希 |
| EvictionPlan | 不需要，Gossip + 哈希 |
| ScalingRecommendation | 控制面直接判断 |

## 四、设计决策

**DEC-020：双态采集决策**

- **决策**：`actual_scrape = enabled（协调层下发）AND healthy（本地检测）`
- **原因**：协调层控制管理意图（enabled/disabled），Scheduler 控制运行状态（healthy/unhealthy），两层独立，互不干扰
- **效果**：协调层不可达时，Scheduler 按最后已知状态继续运行

**DEC-021：Scheduler 代理服务**

- **决策**：Scheduler 提供 Proxy 服务，Agent 通过 Scheduler 代理与协调层通信
- **原因**：简化防火墙规则（N×M → N×1），Scheduler 作为区内唯一出口
