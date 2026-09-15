# 更新日志 (Changelog)

## Unreleased

### 修复（止损）

- **路径保护门对 bash 整条命令失效**：`protectPathGlobs` 此前把整个 `command` 字符串当一个路径取 basename（`cat /a/x.json | head` 取到 `head`），shell 里 cat/sed 源码/配置文件全部漏保护。改为逐 shell-token 切分（剥引号/管道/分号，整词 + basename 双试），命中即 `protected-path`；>16KB 的超长参数串只保留整串/basename 检查（预算护栏，行为已文档化）。工具参数为内嵌 JSON 字符串（`tool_call` 桥接形态）时也先 parse 再扫。方向性错误一律偏向保护（宁少压、不错压）
- **`excludeTools` / `protectPathGlobs` 不再允许显式清空成 `[]`**（`[] ?? fallback` 会静默放行空表，等于拆掉保护门；现在配置校验直接拒绝，中和某项请用占位名如 `["__none__"]`）
- **A 臂排除/保护正则改为按配置身份惰性重编译**：卡片/配置文件热改这两张表后下一候选即生效（与 B 臂行为一致），不再需要重载插件

### 变更

- `npm test` 脚本新增（`node --test tests/` 目录形态在 Node 22 下不可用，文档统一为 `tests/*.test.js`）

### 验证

- typecheck + 38 个单元测试全绿（新增 5 例：bash token 化命中 × 引号/管道/相对路径/负例、内嵌 JSON 解包、超长预算上限、空数组拒绝、A 臂热重编译）

## v0.1.1 (2026-09-15)

### 变更

- **适配 dsh 主线 0.1.5-rc.2**：`cordis` → `@deepseek-ai/cordis`；`installSettingsSection`/`settingsNamespace` 助手 → `ctx.settings.installSection`；arm-B 回收改用 rc.2 会话接口（`SessionSeq`/`snapshotEvents()`/`eventAt()`、`surfaceOp: {op:'replace', startSeq, endSeq}`）；client 半 `dsh-client-runtime/client` → `dsh-client-store` + `dsh-client-ui-settings/client`；包名 scope `@dsh-external/` → `@nobodyhere34/`
- **许可证 BSD-3-Clause → MIT**：本项目不移植、不打包 Headroom 源码（压缩由外部兼容代理经 HTTP 执行），MIT 与上游合规无冲突；新增 `NOTICE` 记录 Headroom（Apache-2.0）设计归属
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