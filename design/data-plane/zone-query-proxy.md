# Zone Query Proxy 区查询代理

> 版本：v2.0 | 日期：2026-09-23
> 状态：**已废弃** — DC 侧 Proxy 概念已移除

---

## 废弃说明

**废弃日期**：2026-09-23

**废弃原因**：

1. **存储层独立**：存储成为独立的一等公民，Worker（Alloy）直接 remote_write 到存储，不再需要中间代理层
2. **查询聚合上移**：查询聚合由控制面板的 vmselect 统一处理（fan-out 到所有 vmstorage），不再需要 DC 侧的 Zone Query Proxy
3. **架构简化**：移除 DC 侧 Proxy 进一步简化 DC 节点，DC 进程数降为 1（仅 Alloy）

**替代方案**：

- 查询聚合 → DC 网关内置 vmselect，fan-out 到所有网区 vmstorage
- 参见 `control-plane/query-gateway.md` 和 `cross-plane/decisions-log.md` DEC-PROXY-01

---

## 以下为原始文档（保留供参考）

> 版本：v1.0 | 日期：2026-09-21
> 状态：~~设计中~~ 已废弃

原始设计描述了一个部署在每个网区内的查询聚合组件（Zone Query Proxy），负责接收来自 Query Gateway 的查询请求，fan-out 到本区存储后端，合并去重后返回。

该职责现在由 DC 网关中的 vmselect 承担。vmselect 挂载所有网区的 vmstorage 后端，执行原生 fan-out + 聚合 + 去重。
