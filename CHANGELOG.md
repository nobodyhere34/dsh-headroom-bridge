# 更新日志 (Changelog)

## 未发布（主线适配 dsh 0.1.5-rc.2）

### 变更

- **适配 dsh 主线 0.1.5-rc.2**：`cordis` → `@deepseek-ai/cordis`；`installSettingsSection`/`settingsNamespace` 助手 → `ctx.settings.installSection`；arm-B 回收改用 rc.2 会话接口（`SessionSeq`/`snapshotEvents()`/`eventAt()`、`surfaceOp: {op:'replace', startSeq, endSeq}`）；client 半 `dsh-client-runtime/client` → `dsh-client-store` + `dsh-client-ui-settings/client`；包名 scope `@dsh-external/` → `@nobodyhere34/`
- **不再兼容 dsh 0.1.2-rc.1 及更早**（上述接口在旧版不存在）

### 验证

- typecheck + 33 个单元测试全绿；client bundle 构建通过（宿主 checkout detached 在 dsh-v0.1.5-rc.2）

## v0.1.0 (2026-08-28)

### 新增

- **独立部署形态**：完整插件包（README 双语 + CHANGELOG + LICENSE + cordis.patch.yml + `dsh plugin --profile web add` 三种安装方式），会话管理同款文档/部署格式
- **主线化**：与官方主线包 `@deepseek-ai/dsh-headroom-bridge`（packages/compaction/headroom-bridge）源码一致，双通道部署（官方 dsh-base 包 + 独立插件）

### 优化

- **UI 收束**：设置卡片使用官方插件卡片同款（PluginCard 披露式卡片壳 + 分阶段字段 + 覆盖徽章/恢复默认 + 单次保存/放弃修改），与「终端 / Agent 循环 / 网页搜索」视觉一致
- 状态块 + 最近压缩台账并入卡片体；保存失败保留草稿；只读部署提示

### 修复

- 客户端 bundle 纯净门禁合规（跨包协作走 cordis 服务，无跨包值导入）
- 样式注入为 idempotent + fiber 生命周期（设置分区重载不再丢失卡片样式）

## v0.0.1 (2026-08-27)

### 新增（原型）

- **主臂 A**：`tools/post-execute` 压缩新工具结果（audit/live）
- **辅臂 B**：`agent/pre-step` 影子价回收旧超长结果
- **模型工具**：`headroom_retrieve` / `headroom_stats`
- **本地 CCR 台账**：内容寻址 + 原子持久化 + TTL/容量驱逐
- **保护门**：工具排除 / 路径参数 / 错误输出 / 最小长度 / 收益门
- **Web 设置卡片**：实时状态 + 热编辑核心字段
- `/headroom-bridge/api`：stats / health / ledger/recent