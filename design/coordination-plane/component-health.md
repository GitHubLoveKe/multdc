# 组件健康

> **版本：v2.0** | **日期：2026-09-22** | **状态：已合并**

---

## 一、变更说明（v1.0 → v2.0）

原 v1.0 设计了独立的组件健康模块（K3），包含三源交叉验证、Coordinator 主动探测、9 态节点状态机等复杂机制。

**v2.0 变更：** 该模块功能已合并入 Job Scheduler（DEC-017）。健康检测的结果直接决定采集行为（`actual_scrape = enabled AND healthy`），合并后决策链路最短，无需跨组件通信。

### 功能迁移映射

| 原 v1.0 功能 | v2.0 归属 | 说明 |
|-------------|----------|------|
| 主动探测（Coordinator → 节点） | 已废弃 | Gossip 心跳（3s）替代 15s 主动探测 |
| 自报告收集 | Scheduler 本地 | Agent 在 SyncTasks 中上报自身状态 |
| 对等报告收集 | Gossip 协议 | VRRP 心跳替换为 Gossip 传播 |
| 三源交叉验证 | 已简化 | Gossip 最终一致性 + 本地健康检测 |
| 9 态节点状态机 | 简化为 3 态 | alive / suspect / dead（Gossip 原生状态） |
| 控制面健康上报 | Scheduler 代理 | 通过 Scheduler Proxy 上报观测数据 |

## 二、当前架构

健康检测职责现在完全由 Job Scheduler 承担，详见 [job-scheduler.md §3.7](../data-plane/job-scheduler.md)。

核心职责包括：

- **本地 Agent 健康检测**：Scheduler 直接检测本节点 Agent 的存活与采集状态
- **Peer 健康感知**：通过 Gossip 协议传播节点健康状态（alive / suspect / dead）
- **采集决策整合**：`actual_scrape = enabled（协调层下发）AND healthy（本地检测）`

## 三、Gossip 中的健康状态

v1.0 的 9 态状态机（REGISTER → WARMING → HEALTHY ↔ SUSPECT → EXPIRED → FENCED → DRAINING → OFFLINE → QUARANTINED）已简化为 Gossip 协议原生的 3 态模型：

| 状态 | 含义 | 对应旧状态 |
|------|------|-----------|
| **alive** | 节点正常运行 | HEALTHY, WARMING, REGISTER |
| **suspect** | 疑似故障，观察中 | SUSPECT |
| **dead** | 确认不可用 | EXPIRED, FENCED, OFFLINE |

状态转换由 Gossip 协议自动驱动，无需 Coordinator 参与判定。

## 四、控制面观测

Scheduler 通过 Proxy 服务将健康观测数据上报控制面，仅供仪表盘展示和趋势分析，**不参与任何决策**。

上报内容包括：
- 各节点 Gossip 状态（alive / suspect / dead）
- 本节点 Agent 存活数与采集成功率
- 节点间拓扑收敛状态

## 五、设计决策

**DEC-017：健康检测合并入 Scheduler**

- **决策**：取消独立组件健康模块，健康检测由 Scheduler 本地执行
- **原因**：健康检测的唯一消费者是采集调度决策，合并后消除跨组件通信开销，降低延迟
- **替代**：Gossip 协议 + 本地探针替代 Coordinator 主动探测 + 三源验证
