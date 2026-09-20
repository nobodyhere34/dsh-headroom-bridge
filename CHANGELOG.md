# 更新日志 (Changelog)

## v0.2.1 (2026-09-17)

### 修复

- **npm 安装后加载失败（`Cannot find package 'schemastery'`）**：`src/config.ts` 用了裸导入 `from 'schemastery'`，开发机被 `node_modules/schemastery` 便利软链掩盖；用户侧按声明安装的却是 **scoped** 的 `@deepseek-ai/schemastery`（registry 真实包名，与官方 settings 包同款姿势），运行时 `lib/config.js` 找裸名必然 ERR_MODULE_NOT_FOUND、整棵插件树拒载。现导入改 scoped、build.sh 链接同步改 scoped 并删除裸链（杜绝再被掩盖）、`dependencies` 声明本就正确不动。已全面审计 lib 产物：零裸运行时导入（node: 与 @deepseek-ai/* 之外无一例外）

## v0.2.0 (2026-09-16)

主题：**轨迹完整性三件套**——压缩从"只有一行 marker"变成全程可见、可审计、可回溯。

### 新增

- **CCR 台账 SQLite 化**（`node:sqlite` 内置，零外部依赖，WAL）：每条带 `session_id`/`call_id` 血缘与压缩类型（代理 `transforms_applied` 链）；旧的 `dsh-headroom-bridge-ccr.json` 首次启动自动导入并改名 `.imported`
- **有界保留 + 生命周期联动**：`ccr.maxBytes`（默认 64 MiB）原文预算、`ccr.auditKeep`、`ccr.gcIntervalMs`（默认 60s）；超预算/过新鲜窗（`ttlMs` 默认 24h）时**原文降级为元数据**（血缘/类型/前后字符数保留，全文不再可取），按最久未访问优先。`compaction/summary`/`compaction/prune` 事件触发即时回收（模型取回需求只发生在窗口内，出窗原文让位预算）
- **会话删除级联**：与 dsh-session-manager 联动——监听 `dsh_delete_session` 域写入，会话进回收站即清掉其全部台账行；另有每小时与 `sessionPersistence.list()` 对账扫孤儿（session-query-sqlite 同款先例）
- **attempt 审计**：adopted/not-adopted（below-min-savings / mode-audit）/skipped（protected-path / error-output / already-compressed）/empty-response/inflight-cap/failed 全量落 `audit` 表（环形保留 `ccr.auditKeep` 条）——"为什么没压"从此有据可查
- **设置卡片"近期操作"面板**：台账+审计合并流（`GET /headroom-bridge/api/ledger/activity`），逐条展开对比压缩前原文（`GET /ledger/entry`）/压缩类型/字节数，带来源会话跳转（`uiWorkspace.openSession` 深链，无工作区 UI 时自动隐藏）
- **轨迹压缩 chip（双视图）**：①聊天视图——被压缩轮末尾（`conversation.chat.turnTail` 链槽）出现 headroom chip（事件投影同步判定，与 deliverables 同款机制、链序在其之后互不抢占）；②轨迹视图（试用反馈驱动新增）——ui-trajectory 无插件扩展位，按生态 direct-DOM 先例（dsh-session-manager 同款机制）给被压缩的工具行挂同款气泡：**行按身份匹配**（`data-trajectory-row-key` 的 `kind\0call\0callId` 对台账 callId，绝不按文本扫——摘要列可能截断 marker），数据源即本会话台账（`GET /ledger/activity?session=`，降级条目仍显示并标注原文过期）
- API 面：`/ledger/activity`（含 `?session=` **查询下推**过滤，繁忙全局流不再挤掉本会话行）、`/ledger/entry`、stats 增 `demoted`/`bytesLive`
- **降级行的诚实赎回**：`headroom_retrieve` 对已降级/出窗的 hash 不再报"从未存在"，detail 引述保留的血缘（工具名、前后字符、压缩类型）并跳过对桥自造 hash 的无谓代理一跳；API/工具/UI 三视图对同一行的可赎回判定统一为单一判据（degraded 或过期或无文本），永不互相打架

### 变更

- `ccr.path` 默认值改为 `…-ccr.db`；`flush()` 变 no-op（SQLite 即时提交，1 秒防抖窗口连同"kill 丢 1 秒条目"的问题一起消失）；EXDEV 降级路径不再存在
- 台账超限时从"整条驱逐"改为"原文降级、条目留存"：轨迹账本无损，有界的只是原文体积

- **`↗` 深链直达轨迹锚点（试用反馈驱动）**：双路径。**冷挂载**：打开会话前预写 ui-conversation 的持久化偏好（`dsh.conversation.<sessionId>` 整值 JSON：`view:'trajectory'` + `viewRequest{focus:callId}`），store 首挂载即水合、走 TrajectoryView 官方 inspect-focus（自动展开历史直到该工具调用）。**热挂载**（该会话本轮浏览器已挂载过、store 缓存不再读偏好）：直接 DOM——点视图 tab（`role=tab`/`aria-selected` 定位，标签匹配 zh/en + 双 tab 兜底）+ 按编码行键 `tool%00call%00<callId>` 把目标行 `scrollIntoView` 并绿框闪烁；3 秒重试覆盖异步挂载，与冷路径幂等共存（已在轨迹视图则不重复点 tab）。折叠出渲染窗口的老行可能未挂载，此时切视图生效、逐轮气泡承接手动滚动；无痕模式静默降级为普通打开
- **会话删除级联（v0.2.0 内修订）**：从"首事件 priming + 差集"改为**每个 `domain/changed` 事件无条件对回收站快照全量级联**（幂等：未知 id 是廉价 no-op，集合受回收站上限约束）——消除"重启后第一个删除错过即时级联"的缺口；已做活火验证（ghost 台账行 → 直发域事件 → 监听器即时清除 ✓，启动对账清孤儿亦活体复现 ✓）

### 验证

- 52 个单元测试全绿（store SQLite 10 例含损坏文件不抛/预算降级/级联删除/审计环形/legacy 导入；lifecycle 假 ctx 覆盖域事件级联（首事件即级联）/对账扫孤儿/压缩触发降级；turn-projection 4 例真实事件形状回放；tools 3 例赎回语义（实时/降级血缘+代理零跳/非法 hash）；`scripts/client-smoke.mjs` 打包挂载冒烟并入 `npm run check`）
- 热重载回归 + 活体端点全 200；legacy JSON 50 条自动迁移实测 ✓
- Node ≥ 22.5 要求已写入兼容性一节
- **headroom 代理 0.37.0-code 契约回归通过**：桥请求形状兼容、#3286 混合输出无乱码、JSON 36%/日志 12% 实测压缩、活体桥在 0.37 下采纳计数增长且 failures 归零；代理侧 `--no-ccr` 要求与 kompress 模型预热步骤已写入 README（中英文）

## v0.1.3 (2026-09-16)

### 修复（回归止损）

- **v0.1.2 的"空数组拒绝"回归导致设置卡片消失**：schemastery 解析 settings scope 时会把未设置的数组字段物化为 `[]`（`excludeTools: []`、`protectPathGlobs: []`），而 `installSection` 注册命名空间后会同步调用 `onChange` → `resolveConfig(物化[])` 撞上 v0.1.2 新加的强校验直接 throw → settings 注入 fiber 崩死、`headroom` 命名空间注册作废 → 插件配置卡片在**每次启动**都不出现，且运行态永远停在 entry 基线（mode 卡在 audit）。语义改为：**空数组回退内置默认列表**——保护门依然永不为空（安全意图不变），但不再 throw；非法条目类型（非字符串/空白/带首尾空格）照旧强报错。中和某项请使用占位名（如 `["__none__"]`）
- 事故全程诊断与结案报告见 `docs/research/injector-incident-2026-09-16.md`（含给全生态的教训：接入 `installSection.onChange` 的配置校验必须容忍 schemastery 物化的容器默认值 `[]` / `{}`，否则启动必炸卡片）

### 验证

- 38 个单元测试全绿（`protection lists fall back to defaults on empty arrays` 用例改为直接喂 schemastery 物化形状做回归）
- 运行态热重载回归：`headroom` 命名空间注册 ✓、用户层 `mode: live` 覆盖 entry 基线 ✓、`/headroom-bridge/api/stats` 报 live ✓

## v0.1.2 (2026-09-15)

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