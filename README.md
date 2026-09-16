# dsh-headroom-bridge

[English](README.en.md) | 中文

一个 dsh 插件：把**工具结果**文本发给本地 [Headroom](https://github.com/headroomlabs-ai/headroom) 压缩代理，让模型看到压缩版，原文存在本地台账里、随时可按 hash 赎回。不改 dsh 核心代码，不打包 headroom。任何失败都保持原文不动（fail-open）。默认 `audit` 模式：只计数，零内容改动。

## 它做了什么

| 部件 | 说明 |
|---|---|
| 主钩子 A（`tools/post-execute`） | 工具执行完、结果进入会话日志之前：够长的纯文本结果发给代理压缩；收益达标且 `live` 模式时，替换模型看到的内容 |
| 次钩子 B（`agent/pre-step`） | 每步开始前，回收 A 当时漏掉的旧长结果（代理宕机/并发跳过/模式切换）。走 dsh 自带的「替换旧内容」机制：先记 prune 计量事件、再替换节点表面，原文保留在日志里，回放/分叉可还原两种视图 |
| `headroom_retrieve {hash}` | 按 hash 赎回原文：先查本地台账，查不到问代理 |
| `headroom_stats {}` | 看本插件的压缩计数与台账规模 |
| 设置卡片 | 设置 → 插件 →「Headroom 压缩」：实时状态、近期操作（台账+尝试审计合并流，可展开原文对比、跳转来源会话）、7 个字段可编辑 |
| 轨迹 chip | 有压缩的那轮对话末尾出现 headroom chip：本轮压缩 N 处、before→after 字节数、逐条展开看原文与压缩类型（压缩后形态就是上方工具行） |
| 本地台账 | `<DSH_HOME>/storages/dsh-headroom-bridge-ccr.db`（SQLite，零外部依赖），原文按内容寻址（sha256 前 24 位）存储，带 session/callId 血缘与压缩类型；默认新鲜窗 24h、原文预算 64 MiB，超限先降级为元数据（血缘不丢） |

`audit` vs `live`：audit 会真实调用代理测压缩效果，但不改任何内容（用来确认值不值得开）；live 才真正替换。

## 前提

本地跑一个 headroom 压缩代理（默认 `http://127.0.0.1:8787`，官方镜像 0.36.5-code / 0.37.0-code 验证过）：

```bash
# 0.37 推荐形态：--no-ccr 关闭代理侧 CCR（桥自带台账），HF_HOME 挂卷预热 kompress 模型
docker run -d --name headroom --network host -e HF_HOME=/root/.headroom/hf-cache \
  -v ~/.dsh/headroom-proxy/headroom-dotdir:/root/.headroom \
  ghcr.io/headroomlabs-ai/headroom:0.37.0-code \
  --host 0.0.0.0 --port 8787 --no-ccr
```

桥只用三个端点：`POST /v1/compress`（单条工具消息，`mode: 'ccr'`）、`POST /v1/retrieve`、`GET /health`。任何兼容该契约的实现都行（`baseUrl` 指向它即可）；压缩器、内容路由策略在代理端配。代理只服务 loopback，所以容器要 host 网络或等价回环路由。

## 安装

```sh
dsh plugin --profile web add /path/to/dsh-headroom-bridge                 # 本地目录
dsh plugin --profile web add 'github:nobodyhere34/dsh-headroom-bridge#v0.2.0'  # GitHub tag
pnpm pack && dsh plugin --profile web add ./dsh-headroom-bridge-0.1.3.tgz # tarball
```

然后**重启 `dsh web`**。

> 主线曾规划一个功能对齐的官方包（`packages/compaction/headroom-bridge`），但截至 dsh 0.1.5-rc.2 **从未合入任何发布版本**，当前主线树中也不存在该包。本仓库是唯一安装通道。

## 快速开始

1. 启动代理（见上）
2. 装插件，重启 dsh web
3. 打开 设置 → 插件 → Headroom 压缩：确认「Proxy 健康」✓、跑几个长工具结果看计数变化
4. 模式切 `live`，保存——新结果开始压缩；旧的超长结果由钩子 B 逐步回收
5. 需要原文时：让模型拿标记里的 hash 调 `headroom_retrieve`，或在卡片「近期操作」/轨迹 chip 里展开对比

live 采纳后模型看到的是压缩文本 + 一行标记：

```
[headroom-bridge: 38403->6175 chars offloaded. Retrieve the exact original with headroom_retrieve hash=<hash>]
```

## 配置

三层：schema 默认值 → 入口配置（`cordis.patch.yml` 的 `config:` 段，包内默认 `mode: audit` + 默认代理地址）→ 用户层（设置卡片或 `~/.dsh/settings.yaml` 的 `headroom` 段）。用户层优先。

卡片可编辑的 7 个字段（保存后立即生效）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `audit` | audit / live |
| `enabled` | `true` | 总开关，**只在插件装载时读一次**（运行中改要重载插件才生效） |
| `baseUrl` | `http://127.0.0.1:8787` | 代理地址 |
| `timeoutMs` | 30000 | 单次请求超时 |
| `minChars` | 500 | 短于这个长度（Unicode 码点）不压 |
| `minSavingsRatio` | 0.15 | 节省比例低于这个值不采纳 |
| `protectErrorOutputs` | `true` | 错误输出不压 |

卡片没有暴露的字段：`excludeTools`（默认排除 read/grep/glob/edit 等 12 个工具）、`protectPathGlobs`（默认工具参数命中源码/配置路径就不压）、`maxInflight`（并发上限，默认 2）、`armB.*`、`ccr.*`——改入口配置或 `settings.yaml`。**全字段、默认值、热生效/重载语义、门的完整规则：[docs/CONFIG.md](docs/CONFIG.md)。**

## 一个结果会不会被压（主钩子 A，按序判断）

1. 工具是 `headroom_retrieve` 本身 → 不压
2. 工具在 `excludeTools` 里 → 不压
3. 结果是错误输出（isError，或带强错误标记且 ≤8000 字符）且 `protectErrorOutputs` 开着 → 不压
4. 内容含非文本块（图片等）→ 整条不压
5. 长度 < `minChars` → 不压
6. 已带压缩标记（含 headroom 原生标记）→ 不压（防二次压缩）
7. 工具参数命中 `protectPathGlobs` → 不压
8. 同一次调用已经尝试过 → 不再试
9. 并发代理请求已达 `maxInflight` → 跳过（计一次失败）

全过之后才调代理；返回的节省比例 ≥ `minSavingsRatio`、且比原文严格短、模式是 `live` → **先把原文写进台账**，再把「压缩文本 + 标记」交给模型。dsh 内部记录的值（canonical）不动，只换模型看到的内容。

## 子智能体

- 进程内的 `subagent` / `subagent_fork` 子会话和父会话在同一个插件实例里：子代理的工具结果同样会被压，原文进同一份台账
- 子代理的最终报告以 `subagent` 工具结果的形式回到父会话；默认排除列表**不含** `subagent`，所以报告同样可能被压（策略待定，见 docs/PLAN.md D2）
- 外部 claude-code/codex/ACP 子进程：父会话只看得见最终报告

## 存储与清理

- 台账：`<DSH_HOME>/storages/dsh-headroom-bridge-ccr.db`（`DSH_HOME` 缺省 `~/.dsh`），SQLite（WAL），跨会话全局共享、按内容去重。旧的 `.json` 首次启动自动导入并改名 `.imported`
- 有界保留：`ccr.maxBytes`（默认 64 MiB）/ `ccr.maxEntries`（默认 2000）/ `ccr.ttlMs`（默认 24h 新鲜窗）。超预算或过期时**原文降级为元数据**（`degraded`）——条目的血缘/压缩类型/前后字符数保留，只是全文取不回；按最久未访问优先降级
- 生命周期联动：压缩出窗（compaction）触发即时回收；`ccr.gcIntervalMs` 定期回收；**会话删除级联**（与 dsh-session-manager 联动，会话进回收站即清掉其台账行）
- 卸载**不会**删台账。彻底清理手动删文件（先确认没有还要赎回的标记）

## 同类插件

同做「工具结果压缩 + CCR 赎回」的开源 dsh 插件还有两个，架构选择不同：

| 插件 | 压缩执行位置 | 与本项目的主要差异 |
|---|---|---|
| [lifeodyssey/dsh-compressor](https://github.com/lifeodyssey/dsh-compressor) | 插件内（Rust 原生件） | 不依赖外部代理；主打不动已发前缀（KV 缓存友好）；无设置卡/审计模式 |
| [giter00/dsh-headroom](https://github.com/giter00/dsh-headroom) | 插件内（JS + ONNX 打分器） | 内容路由专用压缩器（JSON/表格/日志各一路）；本项目把压缩策略整体委托给代理端 |

本项目的取舍：压缩器/内容路由/CCR 存储全在代理侧（可换实现、可升级不改插件），插件只做「何时压、压什么、怎么记账」；代价是代理是硬依赖。

## 已知限制

- 代理是硬依赖：挂了全部 fail-open，结果原样通过（会话不受影响，卡片显示不健康）
- 默认 `audit`；要真正省 token 必须切 `live`
- `enabled` 是装载期开关：装载时 false → 插件什么都不挂（无钩子、无工具、无卡片）；卡片里关掉不影响当前运行中的实例
- `ccr.*` 改了要重载插件；`excludeTools` / `protectPathGlobs` 热改即时生效（A/B 两臂每候选同步）。**空数组 `[]` 一律回退内置默认列表**（保护门永远不会被清空；要中和某项就换成用不到的占位名），非法条目类型仍会报错
- `live` + `ccr.enabled: false` = 零采纳（采纳前断言原文已入台账，台账关了必失败）——别这么配
- 读取类工具和源码/配置路径的结果默认不压（字节敏感场景不压）
- KV 缓存：`live` 替换会从第一个被改 token 起失效缓存（任何工具结果重写的共性代价）；`audit` 无影响
- 代理请求会携带工具结果全文：`baseUrl` 指到远程 = 内容离开本机，责任自负
- 还没有 CI；测试是 9 个单元套件 52 例（mock 代理/会话/临时 SQLite 台账/假 ctx 生命周期/真实事件流投影回放）+ `pnpm run smoke` 打包产物挂载冒烟；级联/对账/端点另有活体验证（docs 见 CHANGELOG）

## 兼容性

- **Node**：台账用 `node:sqlite`（Node **≥ 22.5** 内置，零外部依赖；22.x 会有 ExperimentalWarning，无碍）。更低版本上插件装载即失败（模块不存在），别装
- DSH：当前代码在主线 **dsh-v0.1.5-rc.2** 上适配并验证（typecheck + 52 个单元测试全绿）。适配用了 rc.2 才有的接口形态（`SessionSeq`/`snapshotEvents()`/`eventAt()`、`surfaceOp: {op:'replace', startSeq, endSeq}`、`ctx.settings.installSection`、`@deepseek-ai/cordis` 包名），**不再兼容 0.1.2-rc.1 及更早**——旧版上这些调用点会直接报错
- headroom 代理：官方 `0.36.5-code` 与 `0.37.0-code` **均验证过**。0.37 有三点要注意：① `/v1/compress` 的桥请求形状（单条 tool 消息）兼容不变，#3286 混合子代理输出乱码已修复（实测中文/代码围栏/JSON 键全保留）；② 独立端点不再产生代理侧 CCR（`ccr_hashes` 恒空，代理侧赎回兜底失效——桥的本地台账本就是权威赎回路径，不受影响）；③ 路由器新增「可逆性强制」会把无法挂代理标记的有损压缩整条跳过——**必须带 `--no-ccr` 起代理**（桥自带台账与标记，代理无需管赎回）。另 0.37 的散文压缩改用 kompress 神经模型（需 HuggingFace 联网预热 `chopratejas/kompress-v2-base` 与 `answerdotai/ModernBERT-base`，不通则散文/日志类恒等透传）
- 本仓库当前 0.2.0（GitHub tag `v0.2.0`）；0.1.0 是无 tag 的初始形态，请勿用其 peer 声明判断兼容性

## FAQ

**Q：想压没压、看不到标记？**
A：按「一个结果会不会被压」的 9 步逐条查；卡片「尝试/失败/已采纳」和 `headroom_stats` 能看出停在哪步。另外：`audit` 模式永远不产生标记；含图片等非文本块的结果永远不压；钩子 B 的长度门是 `armB.thresholdChars`（默认 16384），比 A 高得多。

**Q：`headroom_retrieve` 返回 found:false？**
A：返回值带 `detail` 说明原因，三种情形分开：**原文已出保留窗/超预算降级**（detail 会给出保留的血缘：工具名、前后字符数、压缩类型——行还在台账里，只是全文取不回）；**会话已删除级联清理**（整段血缘都没了）；**hash 从未入台账**（回落查代理：代理侧行被驱逐/代理没开/hash 不属于这个代理）。hash 要 8–64 位 hex。

**Q：想彻底关？**
A：卸载，或装载配置里 `enabled: false`（卡片里关也行，但要下次装载生效）。之前产生的标记在台账还有条目时仍可赎回。

**Q：会破坏日志/回放/分叉吗？**
A：不会。A 只换模型可见内容，dsh 记录值不变；B 在日志里保留原文并引用它，回放/分叉能还原两种视图。

## 开发

构建、测试、热装配、发版流程见 [docs/DEV.md](docs/DEV.md)。速查：

```sh
DSH_CHECKOUT=/path/to/deepseek-harness bash scripts/build.sh   # src → lib（host 半）
pnpm run build:client                                           # src/client → lib/client.js
pnpm run typecheck
node --test tests/*.test.js                                     # 单元测试套件（或 npm test）
```

`lib/` 是**提交的构建产物**：改源码后必须重建并把 lib 一起提交。

## 许可证

[MIT](LICENSE)

本项目的压缩思路参考 [Headroom](https://github.com/headroomlabs-ai/headroom)（Apache-2.0），但不包含、也不移植 Headroom 的任何源码——压缩全部由外部 Headroom 兼容代理经 HTTP 执行，插件只决定何时压、压什么、怎么记账。归属声明见 [NOTICE](NOTICE)。

## 致谢

设计思路与压缩策略参考 [Headroom](https://github.com/headroomlabs-ai/headroom)（Apache-2.0）。
