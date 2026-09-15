# dsh-headroom-bridge 初步洞察与规划（2026-08-31 落盘）

> 工作文档：记录三轮审查（本仓库代码×dsh 仓库交叉验证、会话存储、headroom/DSH 调研）的
> 事实与规划。**后续会话在此基础上增量更新**，完成一项勾一项。
> 图例：[ ] 待办 · [x] 完成 · [!] 阻塞 · [?] 待用户决策

---

## 0. 环境与部署事实（速查）

| 项 | 值 |
|---|---|
| 本仓库 | 独立部署形态 `@dsh-external/dsh-headroom-bridge` v0.1.0（commit 0d49840，已推 GitHub `nobodyhere34/dsh-headroom-bridge`，**无 tag/无 release**） |
| 官方主线包 | `/media/ict/19BD52556106DE5A/deepseek-harness`（detached **dsh-v0.1.1-rc.2** b150a551b8）内 `packages/compaction/headroom-bridge`——**untracked 未合入**；dsh-base 装配改动（M cordis.patch.yml + M package.json）亦未提交 |
| 线上注入部署 | `~/.dsh/profiles/web/node_modules/@dsh-external/dsh-headroom-bridge` → 本仓库（symlink），config `{mode:'live', baseUrl:'http://127.0.0.1:8787'}`（super-injector 通道，**未经 bundle patch 路径**） |
| headroom 代理 | docker `hb-headroom`，`--network host`，CMD `headroom proxy --host 0.0.0.0 --port 8787`（默认镜像 env HEADROOM_HOST=127.0.0.1），`HEADROOM_CCR_BACKEND=sqlite`，实测 **0.36.5 healthy** |
| DSH 官方 release | rc.7(8-17)→rc.8(8-19)→rc.1(8-21)→**rc.2(8-21)**→alpha.1(8-27)→**alpha.2(8-30 最新)** |
| 研究报告 | `/media/ict/19BD52556106DE5A/headroom/RESEARCH-REPORT.md` **已损坏**：仅存 §1–§5+§18 空节（436 行），**§6–§17、§18.1、§19 丢失**（前会话写操作截断事故）；需从会话历史/三份子报告重建 |
| 构建 | `DSH_CHECKOUT=/media/ict/19BD52556106DE5A/deepseek-harness bash scripts/build.sh`（host tsc）+ `pnpm run build:client`（tsdown+CSS 内联）；lib/ 为提交产物 |
| 台账/存储 | `~/.dsh/storages/dsh-headroom-bridge-ccr.json`（全局内容寻址，条目带 sessionId；无按会话清理） |

---

## 1. 仓库审查洞察（全量 24 src + lib，逐项对照 dsh 仓库核实）

### 1.1 代码缺陷（4 处——文档承诺的安装路径实际不可用）

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| A1 | `src/config.ts:11` | `import z from 'schemastery'`（bare）。真实包名 **`@deepseek-ai/schemastery`**（vendor，3.18.1）；本机靠 build.sh:50 建的 node_modules 开发 symlink 才能解析，**全新安装运行时 ERR_MODULE_NOT_FOUND** | 改 scoped；build.sh:50 的 `link_pkg schemastery` 同步改 `link_pkg @deepseek-ai/schemastery` |
| A2 | `src/{api,arm-a,arm-b,index,settings,tools}.ts` | 6 处 `import type { Context } from 'cordis'`——真实包名 `@deepseek-ai/cordis`（4.0.1）。type-only 无运行时影响，但全新 clone typecheck 失败 | 6 处改 scoped |
| A3 | `cordis.patch.yml:6` | `name: dsh-headroom-bridge` 不可解析：loader entry `name` 是**模块说明符**（vendor/loader entry.ts），profile node_modules 里只有 scoped 名 → **bundle 安装（dsh plugin add + 重启）必失败**；未暴露是因为线上走注入器通道 | `name: '@dsh-external/dsh-headroom-bridge'`（id 可保留） |
| A4 | `lib/`（提交产物） | `lib/config.js:10` 含 A1 坏导入；修完 src 必须重建 host+client 并提交 | 重建 + 提交 |

### 1.2 README.md / README.en.md 描述错误（17 处，两文件镜像同步修）

| # | 位置 | 错误 → 更正 |
|---|---|---|
| B1 | L5–7 | “源码逐字一致”→ 假：host 14 文件中 13 个与主线不同（仅 stats.ts 一致；差异=导入/PKG_NAME/防御式写法漂移）；client 10 文件逐字一致。改为“host 派自主线（v0.1.0 快照）+ 独立打包适配；client 逐字一致” |
| B2 | L80 | 热生效列表含 `enabled` → 错：enabled 是**装载期门**（apply() early return；arm-a 运行时门硬编码 `enabled:true`；arm-b 只查 armB.enabled）。运行时切 enabled=false 零效果 |
| B3 | L81 | 重启语义只列 ccr.* → 不完整：`enabled/excludeTools/protectPathGlobs` 也是重启（arm A 一次性编译 glob）。热生效全集=mode/baseUrl/timeoutMs/minChars/minSavingsRatio/protectErrorOutputs/maxInflight/armB.* |
| B4 | L73 | “禁用时不出现在页面”→ 机制=宿主 describe 了 headroom 命名空间才渲染（装载期安装）；运行时关 enabled 卡片仍在 |
| B5 | FAQ 完全关闭 | “卡片关掉连工具都不注册”→ 运行时不会注销（工具仍注册可调用）；重启后才注销。立即停用=mode=audit |
| B6 | 同条 | “关闭后标记仍可赎回”→ 错：enabled=false 重启后工具不存在，**不可赎回**（需先重启用）；保赎回能力=enabled+audit |
| B7 | FAQ 卸载 | remove 参数是 pnpm 依赖名：`@dsh-external/dsh-headroom-bridge`（无 scope 删不到） |
| B8 | 兼容性节 | 无 `ctx.settings` 服务（inject=['tools','webServer']；设置经 dsh-settings installSettingsSection 助手） |
| B9 | 官方主线通道注 | “随 dsh-base 提供（默认 disabled）”→ 当前只在未合入工作区成立（rc.2 发布物无此包）。改为“随 PR 合入后提供” |
| B10 | 安装 GitHub | `<owner>`+#v0.1.0：仓库已公开（nobodyhere34）但**远端无 tag**，#v0.1.0 装不了。填真实 owner+可用引用（#main）并注明 release 待建 |
| B11 | 工作原理+FAQ KV | “live 替换从第一个被改 token 起失效缓存”高估 A 臂：arm A 在结果**首次出现前**替换（模型从未见过原文）→ 零 KV 影响；只有 arm B 回收旧节点才失效 |
| B12 | 功能节 | “读取类工具”→ 默认排除表=文件**读写**类(read/glob/grep/edit/write/multiedit/notebook_edit/str_replace_editor)+web 类(web_search/web_fetch)+view/todo_write+headroom_retrieve 自身 |
| B13 | 前提+限制节 | “只服务 loopback”→ 精确为：镜像默认 env HEADROOM_HOST=127.0.0.1（裸 docker run 即回环态）；LAN 需 `--host 0.0.0.0` 覆盖（本机容器即此） |
| B14 | 四个概念 | “插件管理 UI”→ “本包 cordis.patch.yml bundle patch / 注入器入口配置” |
| B15 | locales.ts | enabledHint “双臂总开关”→ 补“装载时生效；立即停用用 模式=audit”（双语，需重建 client bundle） |
| B16 | FAQ 压缩没生效 | 首门 enabled 加注“（装载期；先查 mode）” |
| B17 | 数据流 | “本机代理”→ “baseUrl 处（默认本机 8787）” |

### 1.3 元数据
- C1 `package.json` description 语法破损 “bridge dsh:” → “for dsh:”
- C2 `tests/`（6 个 node:test 对照 lib）未接线：无 test script；建议 ``"test": "node --test tests/"`` 并随 D4 同步主线 14-spec vitest 套件

### 1.4 行为事实（审查确认，功能设计的依据）
- `live + ccr.enabled=false` = **零采纳**（put no-op → assertRetrievable 必抛 → fail-open 保留原文）
- 任一非 text 块存在 → `flattenPlainText` undefined → **整个结果永不压缩**（多模态缺口）
- `store.flush()` 写 tmpdir 再 rename → 跨文件系统 EXDEV → **静默降级内存**（仅 warn）
- 台账退出机制仅 TTL(24h)/容量(2000)/手删；**无按会话清理**
- arm A 的 `$exec.name==='tool_call'` 解包是防御死分支（dsh core rc.2/alpha.1 均无该字面量，PTC 改名无风险，已核）

---

## 2. 会话删除 × 存储洞察

**dsh “删除”（dsh-session-manager）= 软删除**：归档（workspace.json archivedSessionIds）+ 移会话目录至 `~/.dsh/dsh-delete-session-trash/<id>/` + 记账 `~/.dsh/storages/dsh_delete_session.json`（上限 10 条，超出最旧**自动 purge**）。**真正删除=purge**（回收站手动 / 溢出自动 / 手删）。

| 存储 | 位置 | purge 后 |
|---|---|---|
| 会话日志 | `~/.dsh/sessions/<cwd-slug>/session-<id>/session.jsonl.zstd` | 删 ✅ |
| 回收站 manifest | `storages/dsh_delete_session.json` | 删条目 ✅ |
| 归档标记 | `storages/workspace.json` | **残留**（无害） |
| 投影缓存 | `storages/session_projcache.json` tables.sessions[<id>] | **残留** |
| **桥 CCR 台账** | `storages/dsh-headroom-bridge-ccr.json` | **残留（原文！最长 24h 且可赎回）** |
| 附件对象 | `~/.dsh/attachments/v1/objects/`（内容寻址，无反向索引） | **残留孤儿** |
| 子代理子会话 | 同 cwd-slug 下独立目录 | **不随父删** |

- 手删命令模板见**附录 A**；改 storages 域文件后需重启 dsh web 防内存回写覆盖
- **本机实例（删除不彻底）**：`session-5c13f26a-6bb8-40a5-b5cf-008e4d55721e`（sjjtsgdzzs-python）有 manifest 条目(8-28 17:24)+在归档名单，但**日志目录未移走**（31KB 仍在 sessions/，trash 为空）——部署版 v0.2.0 流程失败残留 [ ] 清理
- → 必要功能：**会话删除感知的台账清理**（父删→子会话+台账条目级联），升级 P0

---

## 3. headroom 0.36.5-code 功能项（tag v0.36.5 + 活体实测）

- **镜像定性**：`-code` = bake `runtime-code`，`HEADROOM_EXTRAS=proxy,code,bedrock`（proxy+Kompress ONNX+Bedrock，nonroot）。0.36.5(8-22) 为补丁版，基线=0.36.x
- **四形态**：Python 库 / TS 包 / HTTP 代理 / MCP server（同一管线）
- **代理 HTTP 面 × 桥使用**：

| 分组 | 端点 | 桥 |
|---|---|---|
| LLM 透传 | /v1/chat/completions · /v1/messages · /v1/responses · /v1/batches · /v1/files | ❌（桥是 sidecar，不走透传） |
| 压缩 | /v1/compress（config.mode=ccr） | ✅ 单条工具消息 |
| CCR | /v1/retrieve · **/v1/retrieve/stats** · /v1/retrieve/tool_call | ✅ retrieve；**stats 未用**（实测：sqlite、TTL 1800s、1000 条、tokens 统计、recent_retrievals） |
| 可观测 | /v1/telemetry(默认关) · **/v1/toin/*** · /v1/feedback | ❌（TOIN 实测在工作：285 patterns/463 次压缩/**8 条建议**） |
| 健康 | /health（全量转储） | ✅ |

- **压缩引擎**（RESEARCH-REPORT §2–§5 已核）：ContentRouter 7 级级联 → 10 压缩器（SmartCrusher JSON 70–90% / Log 85–95% / Search / Diff / Text / Tabular / Config 三层 lossless-first / CodeAware 默认关 / HTMLExtractor 无 CCR / Kompress ModernBERT ONNX 兜底）；保护规则（工具排除、skip_user、protect_recent/analysis_context/error_outputs 8000、min_chars 500、output_buffer 8000、assistant/system 不压、空输出守卫）；CCR 不变量（persist-first、verify_ownership、hybrid 检索）；`--mode cache`(默认保前缀缓存)/token；不变量=live-zone-only+可逆优先+fail-open
- **⚠️ 0.37.0（8-27 已发布）**：① **session-aware /v1/compress（sidecar 模式）+统一会话引擎+自限会话状态**——桥正是逐条调 /v1/compress 的 sidecar，0.37.0 可让代理按会话跟踪（跨消息去重/引用），桥当前调用无状态用不上；② **#3286 修复压缩把混合子代理输出压乱**；③ WS token 鉴权 / vertex SSRF / file-read 保护扩展

---

## 4. dsh 官方 release 线

- **rc.2**（桥钉死基线）：release notes 仅 2 条图像项；31 commits 全为**图像/Files 管线统一**（Files API 上传优先+复用、自动缩放/转格式）+1 回滚；**无子代理/压缩变更**。安全但落后主线 9 天
- **alpha.1**（rc.2→alpha.1 共 796 commits）相关项：
  - **子代理模型选择**：authorize selectable child models + **显式 allowlist 门**（`subagent-model-selection` 设置，默认关）+ list_subagent_models + Subagent 设置卡移入插件配置页（排 Agent loop 后，**与桥卡片同页**）
  - **会话存储瘦身 #3048**（seq-ranges/页大小，jsonl+sqlite）
  - 上下文压缩计入图片占用
  - **code-mode→PTC 改名**（core/tools/src/code-mode.ts→ptc.ts；已核：两版 core 均无 'tool_call' 字面量，**桥无风险**）
  - **SessionEvent.ignorable：alpha.1 移除→alpha.2 恢复**（事件词汇 churn，兼容矩阵必查项）
  - 插件 provider 登录配置、第三方语言、ACP 全量会话控制、DeepSeek 适配器增量日志上传(默认关)、会话日志尾部截断自动修复告警
- **alpha.2**：UI/性能 + Node 24.0–24.11.1 HMR 修复 + peer dep 修复 + ignorable 恢复

---

## 5. 子智能体 × 压缩交叉（代码核实）

| 子代理类型 | provider | dsh 工具管线 | 桥覆盖 |
|---|---|---|---|
| in-process spawn/fork | subagent-spawn-in-process / -fork-in-process | ✅ 同 fiber 树同 ToolRuntime | **全量**（台账实测有子会话原始 uuid 条目：80da8cc8-…/15505a2b-…） |
| 外部 claude-code / codex / ACP / dsh-sdk | 各自包 | ❌ 自带 agent loop | **仅最终报告可见**；`subagent` 不在默认排除表 → **报告默认可压缩（策略空白）** |

- 模型选择×压缩链路：桥 per-exec 读 `exec.agent?.options.model ?? 'deepseek-chat'` —— 位置正确 ✓（allowlist 门关闭时走默认模型路径）
- 级联删除缺口（§2）：删父不删子会话、台账不级联
- 代理端 #3286 子代理输出乱码 → 0.37.0 才修（当前 0.36.5 镜像有此风险）
- **子代理故障回退**（前会话遗留：网关病态时子代理钉死故障网关）仍未落地；arm B 只是 backstop

---

## 6. 规划（D0–D4）与执行顺序

| 方向 | 内容 | 量级 |
|---|---|---|
| **D0 扫尾 v0.1.x（前置，现在可做）** | §1 全部代码/文档修复 + 重建 + v0.1.1 + tag + GitHub Release（打通 GitHub 安装路径）+ 提交推送 | 半天 |
| **D1 基线决策 + 契约兼容矩阵（阻塞主线 PR）** | 在 rc.2 与 alpha.2 两基线上各跑桥测试套件；矩阵=tools/post-execute 签名 · agent/pre-step payload · compaction/prune · settings.plugin.item · SessionEvent 词汇 · PTC。结论三选一 | 1 天 |
| **D2 子代理专项** | ① 外部子代理报告策略（默认 verbatim 或 `subagentReports` 配置项）② 级联删除（父删→子会话+台账+projcache）③ 台账/卡片区分父/子统计 | 1–2 天 |
| **D3 代理可观测 + 升级** | ①（低成本先行，与基线无关）`/v1/retrieve/stats`+`/v1/toin/stats` 接入设置卡；TOIN 建议→保护门调优建议 ② 评估镜像 0.36.5-code→0.37.x（子代理乱码修复）③ 若升级：适配 session-aware /v1/compress（传 dsh sessionId/callId 作会话键）——**压缩质量最大可提升项** | ①0.5 天 ③一迭代 |
| **D4 主线 PR + 压缩 backlog** | 主线包 PR（基线随 D1）；运行时总开关(P0) · live+ccr=false 死锁(P1，随 D3 重审) · 按会话台账清理(P0) · 卡片字段扩展/多模态/跨 FS 原子写/CI(P1) · 子代理故障回退 | 随主线节奏 |

**建议顺序**：D0 → D1 → D3① → D2 → D3②③ → D4

---

## 7. 决策点（待用户拍板）

1. **基线**：钉 rc.2 / 双兼容声明 / 迁 alpha.2（影响 D1 之后所有写法）
2. **外部子代理最终报告**：默认可压缩 / 默认 verbatim / 加配置项
3. **代理镜像**：0.36.5-code 保持 / 升 0.37.x（何时；升级牵动桥 sidecar 适配）
4. **本机残留**：是否执行 §2 删除不彻底实例（session-5c13f26a）的手删清理

---

## 附录 A：会话存储手删命令模板

```bash
SID=session-<uuid>
rm -rf ~/.dsh/dsh-delete-session-trash/$SID                      # 回收站残留
rm -rf ~/.dsh/sessions/*/$SID                                    # 会话目录本体
node -e "const f='$DSH_HOME/storages/dsh_delete_session.json',fs=require('fs');const s=JSON.parse(fs.readFileSync(f,'utf8'));s.global.entries=s.global.entries.filter(e=>e.sessionId!=='$SID');fs.writeFileSync(f,JSON.stringify(s,null,1))"
node -e "const f='$DSH_HOME/storages/session_projcache.json',fs=require('fs');const s=JSON.parse(fs.readFileSync(f,'utf8'));delete s.tables.sessions['$SID'];fs.writeFileSync(f,JSON.stringify(s))"
node -e "const f='$DSH_HOME/storages/dsh-headroom-bridge-ccr.json',fs=require('fs');const s=JSON.parse(fs.readFileSync(f,'utf8'));s.entries=s.entries.filter(e=>e.sessionId!=='$SID');fs.writeFileSync(f,JSON.stringify(s,null,1))"
# 改完 storages 域文件后重启 dsh web（防内存态回写覆盖）；附件对象无反向索引，只能整目录清（波及全会话）
```

## 附录 B：关键文件索引

- 桥源码：host 14 模块（index/arm-a/arm-b/config/protect/store/proxy-client/marker/tools/api/settings/stats/util/invariant）+ client 10 模块（index/HeadroomCard/controller/locales/card-form/fields/PluginCard+css）
- 官方主线包：`deepseek-harness/packages/compaction/headroom-bridge`（untracked）；dsh-base 装配：`packages/bundle/base/{package.json,cordis.patch.yml}`（M 未提交，entry id=headroom-bridge disabled）
- dsh 关键包：core/tools（tools/post-execute 瀑布 index.ts:175）· core/agent（agent/pre-step runtime-types.ts:231）· core/session · settings/settings（settingsNamespace/installSettingsSection）· host/webserver（register prefix）· llm/llm（freezeMessage）· compaction/{compaction(compaction/prune),compaction-basic,compaction-tool-result-pruner,command-compact}
- vendor：cordis=@deepseek-ai/cordis 4.0.1 · schemastery=@deepseek-ai/schemastery 3.18.1 · loader（entry name=模块说明符）
- 删除/回收站实现：`/media/ict/19BD52556106DE5A/dsh-session-manager/src/index.ts`（TRASH_LIMIT=10；delete/restore/purge 路由）
- headroom 仓库：tag v0.36.5（代理路由 grep headroom/proxy）· 0.37.0 changelog（session-aware compress/#3286）
- 设置卡片 UI 体系：client/ui-settings-plugins（settings.plugin.item keyed slot；卡片=PluginCard 披露式+staged form；“设置→插件→插件配置”）
