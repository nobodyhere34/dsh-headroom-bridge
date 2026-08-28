# dsh-headroom-bridge

[English](README.en.md) | 中文

把 [Headroom](https://github.com/headroomlabs-ai/headroom) 的内容感知压缩引擎接入 DeepSeek Harness（dsh）的桥梁插件：**压缩工具结果、保留可赎回原文**。不修改 dsh 核心代码，走官方插件机制装配；所有失败路径 fail-open（压缩不了就原样保留），`audit` 模式下对模型可见内容零改动。

> 该插件是官方主线包 `@deepseek-ai/dsh-headroom-bridge`（`packages/compaction/headroom-bridge`）的独立部署形态，与其源码逐字一致；双通道部署（官方 dsh-base 包 + 独立插件）见下文安装与「官方主线通道」备注。

---

## 谁在看这份文档

- **你是 headroom 老用户**（用过 `headroom proxy` / headroom-ai SDK / MCP 服务）——直接看「[Headroom 老用户速览](#headroom-老用户速览)：它和 headroom 的关系、原生能力映射、我能不能接我现有的代理」。
- **你是 dsh 用户、第一次接触 headroom**——看「[dsh 新用户上手](#dsh-新用户上手)：dsh 概念、配置分层、它装载了什么、数据流、常见问题」。

---

## Headroom 老用户速览

### 它和 headroom 的关系

桥**不打包 headroom**——它调用你既有的本地 headroom 压缩代理的三个端点：

| 端点 | 用途 |
|---|---|
| `POST /v1/compress` | 压缩请求：`{ messages: [{role:'tool', tool_call_id, content}], model, config: { mode: 'ccr' } }`——**单条工具消息 + ccr 模式** |
| `POST /v1/retrieve` | 按 hash 从代理 CCR store 取回原文（`{ hash } → { original_content }`） |
| `GET /health` | 健康检查（设置卡「Proxy 健康」） |

也就是说：**压缩器、内容路由、CCR sqlite 全在代理侧**，桥只负责"什么时候压、压谁、压完怎么交代"。版本以官方 `ghcr.io/headroomlabs-ai/headroom:0.36.5-code` 验证（0.36.x 系该三端点契约）。

### 原生能力 ↔ 桥能力映射

| headroom 原生 | dsh-headroom-bridge |
|---|---|
| 代理模式（`headroom wrap claude/codex`，整会话压缩） | dsh 流水线钩子：**只压缩工具结果**——新结果 = 主臂 A（`tools/post-execute`），旧超长结果 = 辅臂 B（`agent/pre-step` 影子价回收） |
| MCP `headroom_compress` | 不需要：钩子自动压缩，不暴露 compress 工具 |
| MCP `headroom_retrieve` | dsh 模型工具 `headroom_retrieve`（本地台账优先 → 代理 `/v1/retrieve` 兜底） |
| MCP `headroom_stats` | dsh 工具 `headroom_stats` + 设置卡实时统计 |
| CCR 存储（代理侧 sqlite，TTL/容量由代理配置） | 桥**另持**本地内容寻址台账（`sha256[:24]`、原子写、`ccr.ttlMs/c.maxEntries` 可配、路径 `<DSH_HOME>/storages/dsh-headroom-bridge-ccr.json`）——代理侧行被驱逐/过期也能从本地赎回 |
| 原生压缩标记（`Retrieve more: hash=…`、`<<ccr:(hash)>>`） | 桥标记：`[headroom-bridge: 38403->6175 chars offloaded. Retrieve the exact original with headroom_retrieve hash=<hash>]` |
| `bypass_header` / `mode=passthrough` | `audit` 模式 + 保护门（工具排除表 / 路径参数 glob / 错误输出保护） |
| 压缩器/技术路由（代理端配置决定） | 桥不干预：请求只带 `config:{mode:'ccr'}`，压缩器选择完全归代理 |

### 我能不能直接接我现有的代理？

**能**。`baseUrl` 指向你已有的 headroom 代理即可（默认 `http://127.0.0.1:8787`）。两点注意：

1. **桥的请求不带 bypass/模式请求头**——它发的是标准 OpenAI 风格消息 + `config.mode=ccr`。依赖请求头做 bypass 的代理配置不会触发；桥侧对应的"别压缩"职责由保护门承担（`excludeTools` / `protectPathGlobs` / `protectErrorOutputs` / `audit`）。
2. **原生标记也能赎**：`headroom_retrieve` 接受 8–64 位 hex 的 hash；如果模型手里有原生标记里的 hash，走代理 `/v1/retrieve` 兜底同样能取回（代理侧没有该行则返回 `found:false` + 详情）。

### 我想自定义压缩策略

在**代理端**配：压缩器选择、内容路由、CCR 策略都是代理的职责（官方 `ProxyConfig` / 内容路由）。桥端你能调的只有"什么时候压、压多少、哪些不压"（`minChars` / `minSavingsRatio` / 保护门 / 频率门 `maxInflight`）。

---

## dsh 新用户上手

### 四个概念先对齐

- **profile**：一个 dsh 实例（如 `web`），`dsh plugin --profile web add …` 就是把插件装进这个实例；装完**要重启 `dsh web`**。
- **插件**：一个 npm 包形态（此包 + 官方主线包），通过 profile 的 plugin/bundle 通道加载；host 半（节点服务）+ client 半（浏览器 bundle）两部分。
- **入口配置（entry config）**：装配插件时给的 config（bundle patch / 插件管理 UI），是设置的**基底层**。
- **设置分层**：schema 默认值 → 入口配置（base）→ 用户层（`settings.yaml` / 设置卡片写入）；卡片上显示「已覆盖」= 用户层有这条目；「恢复默认」= 清除用户层回到 base。

### 它装载了什么（装完后 dsh 里多了什么）

| 位置 | 内容 |
|---|---|
| 钩子 | `tools/post-execute`（主臂 A，压新结果）、`agent/pre-step`（辅臂 B，回收旧超长节点） |
| 模型工具 | `headroom_retrieve`、`headroom_stats` |
| 设置 | `headroom` 命名空间 → 设置 → 插件 → 插件配置 →「Headroom 压缩」卡片（禁用时不出现在页面） |
| HTTP | `/headroom-bridge/api`（stats / health / ledger/recent，卡片消费；仅本机 web 使用） |
| 持久化 | `<DSH_HOME>/storages/dsh-headroom-bridge-ccr.json`（内容寻址原文台账，原子写；`ccr.*` 重启语义） |

### 配置在哪改（三层）

1. **入口/插件层**：`dsh plugin --profile web add` 时的 config，或 profile patch（官方主线包通道）——基底层；
2. **用户层**：`~/.dsh/settings.yaml` 的 `headroom` 段，或直接改设置卡片——优先级最高、热生效（`mode`/`enabled`/`baseUrl`/`timeoutMs`/`minChars`/`minSavingsRatio`/`protectErrorOutputs`/`maxInflight` 与 B 臂门）；
3. **重启语义**：`ccr.*`（台账路径/TTL/容量）在 fiber 构建时固定，改完要重启。

### 数据流与隐私（一次压缩发生了什么）

工具执行完成 → 保护门（工具名/路径/错误输出）→ 最小长度门 → **把结果文本 POST 给本机 headroom 代理**（`mode=ccr`）→ 收益门（`minSavingsRatio` + 严格收缩）→ `live`：原文写入本地台账、模型看到压缩文本 + 检索标记；`audit`：只计数不改内容。**没有额外模型调用**；代理必须在场（默认本机 8787），内容不离开你机器（除非你把 `baseUrl` 指到远程——请自担）。

### 与 dsh 其他压缩机制的关系

- `compaction-basic` / `command-compact`：**历史消息摘要**（会话长了概括旧轮次）——与本插件互不替代；
- `compaction-tool-result-pruner`：工具结果**裁剪**（丢细节保留要点）——本插件是内容感知**压缩**（可赎回、保真）；
- 本插件定位：**工具返回清洗器**——新结果物化前压缩 + 旧超长节点影子价回收，原文本地可赎回。

---

## 功能

- **主臂 A｜新结果压缩**：`tools/post-execute` 瀑布监听器，在工具结果物化进会话日志**之前**压缩超长纯文本结果——`audit` 只记录潜在节省；`live` 存原文入台账、把压缩文本 + 检索标记交给模型
- **辅臂 B｜旧结果回收**：`agent/pre-step` 兜底扫描旧的高阶 `tool/result` 表面节点（A 臂漏掉的：代理宕机/瞬时跳过/模式切换），按**影子价协议**回收——日志保留原文（`sourceEventSeqs`），同时 `compaction/prune` 计量 + `tool/result` 表面替换引用被遮蔽节点
- **模型工具**：`headroom_retrieve`（本地台账优先、代理 CCR 兜底；miss 是正常返回不是异常）、`headroom_stats`
- **Web 设置卡片**：实时状态 + 最近压缩台账 + 热编辑核心字段（暂存草稿、一次「保存」提交）
- **本地 CCR 台账**：内容寻址（`sha256[:24]`）+ 原子持久化 + TTL/容量驱逐
- **保护门**：失败结果/强错误提示、源码/配置路径参数、读取类工具、`headroom_retrieve` 自身——统统不压缩
- **双语言界面**（跟随页面语言）

## 前提：Headroom 代理

桥把压缩完全委托给本地 Headroom 压缩代理（`/v1/compress`，`mode=ccr`）。官方镜像（代理只服务 loopback，需要 host 网络或等价回环路由）：

```bash
docker run -d --name headroom --network host ghcr.io/headroomlabs-ai/headroom:0.36.5-code
```

任何兼容该三端点契约的实现都可用（`baseUrl` 配置）。代理不可用时桥保持 fail-open：结果原样进入日志，设置卡「Proxy 健康」显示不健康。

## 安装

### 从本地目录

```sh
dsh plugin --profile web add /absolute/path/to/dsh-headroom-bridge
```

### 从 GitHub（发布后）

```sh
dsh plugin --profile web add 'github:<owner>/dsh-headroom-bridge#v0.1.0'
```

### 从 tarball

```sh
pnpm pack
dsh plugin --profile web add /absolute/path/to/dsh-headroom-bridge-0.1.0.tgz
```

安装完成后**重启** `dsh web`（host 插件与客户端 bundle 需要重启加载）。

> **官方主线通道**：官方 `@deepseek-ai/dsh-headroom-bridge` 随 `dsh-base` 提供（默认 disabled），在 profile patch 启用，见主线包 README 的 Usage。

## 快速开始

1. 启动 Headroom 代理（见上）
2. 安装并重启 `dsh web`
3. **设置 → 插件 → 插件配置 → Headroom 压缩**
4. 默认 `mode=audit`：先看「尝试/失败」「节省字符」确认代理健康、压缩确实有收益
5. 把「模式」切到 `live`、点「保存」——新结果开始压缩；旧结果由 B 臂在 step 边界回收
6. 需要用原文时让模型调 `headroom_retrieve`（或事后在卡片对账）

## 使用

### 设置卡片：「Headroom 压缩」

- **状态块**：运行模式、总开关、Proxy 地址、尝试/失败、已采纳、节省字符、台账条目、Proxy 健康（实时）
- **字段**：模式、启用压缩、Proxy 地址、请求超时（毫秒）、最小字符数、最低节省比例、保护错误输出——「已覆盖」徽章 + 恢复默认，暂存后一次保存；只读部署显示提示
- **最近压缩**：台账条目（哈希 / 工具 / 字符变化 / 节省百分比）

### 模型看到的压缩结果（主臂 A）

`live` 模式被采纳的结果替换为代理压缩文本 + 一行检索标记：

```
[headroom-bridge: 38403->6175 chars offloaded. Retrieve the exact original with headroom_retrieve hash=<hash>]
```

规范值（canonical value）不被改动，仅渲染内容被替换；需要精确字节的下游调用可用 `headroom_retrieve` 赎回。

### 工具

- **headroom_retrieve `{hash}`**：赎回精确原文（本地台账 → 代理 `/v1/retrieve`），返回 `{id, found, content?, toolName?, charsBefore?, charsAfter?, source?, detail?}`
- **headroom_stats `{}`**：`mode/attempts/failures/adopted/savedChars/ledgerEntries`

## 工作原理

| 层 | 实现 |
|---|---|
| Host | `src/index.ts`：A 臂（`tools/post-execute`）、B 臂（`agent/pre-step`）、两个工具、`headroom` 设置命名空间、`/headroom-bridge/api`、CCR 台账 |
| Client | `src/client/index.ts`：官方 `settings.plugin.item` 插槽（keyed `headroom`）注册卡片；`CardForm` 暂存/单次保存/宿主读回 |
| 代理客户端 | `proxy-client.ts`：`POST /v1/compress`（`mode=ccr`）、`POST /v1/retrieve`、`GET /health`；超时/非 2xx/解析失败全部 fail-open |
| 保护门 | 工具名排除 → 路径参数保护 → 错误输出保护 → 最小长度门 → 收益门（+严格收缩校验） |
| 影子价 | B 臂替换旧节点：先 `compaction/prune` 计量，再 `tool/result` 表面替换引用被遮蔽 seq；原文在日志（`sourceEventSeqs`），回放/分叉可重建两种视图 |

压缩发生在物化之前、无额外模型调用。**KV 缓存**：`live` 替换渲染内容从第一个被改 token 起失效缓存（任何工具结果重写的固有代价）；`audit` 零改动，与基线完全一致。

## 常见问题（FAQ）

**Q：设置卡「Proxy 健康」显示不健康 / 大量失败？**
A：先 `curl http://127.0.0.1:8787/health` 与 `curl -X POST http://127.0.0.1:8787/v1/compress -H 'content-type: application/json' -d '{"messages":[{"role":"tool","tool_call_id":"t1","content":"你的长文本"}],"model":"test","config":{"mode":"ccr"}}'` 验证代理；确认 `baseUrl`、`timeoutMs`（默认 30s，代理慢可加大）；代理不可达时桥自动 fail-open，不影响会话。

**Q：压缩了但没生效 / 没看到标记？**
A：逐门排查——`enabled`（总开关）、`mode`（audit 只记录）、`minChars`（默认 500 字符以上才压）、`minSavingsRatio`（0.15，节省不足不采纳）、工具排除表（读取类默认排除）、`protectPathGlobs`（源码/配置路径不压）、`maxInflight`（并发满则跳过）。设置卡「尝试/失败/已采纳」与 `headroom_stats` 直接看每一门的结果。

**Q：想完全关闭？**
A：卡片把「启用压缩」关掉再保存（`enabled=false`，连工具都不注册）；或配置层 `enabled: false`；或卸载（见下）。关闭后已有标记仍可通过 `headroom_retrieve` 赎回。

**Q：卸载 / 升级？**
A：`dsh plugin --profile web remove dsh-headroom-bridge`（以实际插件 id 为准）并重启；升级 = 重新 `add` 新版本再重启。**台账文件不会自动删除**——需要彻底清理时手动删 `<DSH_HOME>/storages/dsh-headroom-bridge-ccr.json`（先想好是否还有标记要赎）。

**Q：`headroom_retrieve` 返回 `found:false`？**
A：本地台账无该 hash（可能被 `ccr.maxEntries` 驱逐或 `ccr.ttlMs` 过期）且代理 `/v1/retrieve` 也无（代理侧行被驱逐/代理未运行/hash 不属于本代理的输出）。返回值自带 `detail`（如 `proxy returned no content`、`invalid hash format`）；hash 须为 8–64 位 hex（含原生标记的 hash）。

**Q：会不会破坏会话日志/回放/分叉？**
A：不会——会话事件词汇不变；A 臂只替换渲染内容（canonical 不变）；B 臂按影子价协议在日志保留原文并引用被遮蔽 seq。需要精确原文时 `headroom_retrieve` 回调即可。

**Q：会影响 KV 缓存 / token 计费吗？**
A：无额外模型调用、无额外 token（代理独立进程）。`live` 模式下替换渲染内容会使 KV 缓存从第一个被改 token 起失效（任何工具结果重写的固有代价）；`audit` 模式与基线完全一致。

**Q：台账文件在哪、有多大？**
A：`<DSH_HOME>/storages/dsh-headroom-bridge-ccr.json`；容量受 `ccr.maxEntries`（默认 2000）/ `ccr.ttlMs`（默认 24h）约束，最旧先驱逐；`ccr.path` 可改路径（重启语义）。

**Q：headroom 原生标记能在这个插件里用吗？**
A：`headroom_retrieve` 按 hash 取回（本地 → 代理兜底），对标记格式不敏感——原生标记里的 hash 只要在代理 CCR store 里就能取回；但**桥不会识别/翻译原生标记**（模型侧仍应使用桥的输出标记调 `headroom_retrieve`）。

## 限制

- **代理是外部依赖**：不可达即 fail-open；`/v1/compress` 只服务 loopback；压缩器/路由归代理端
- `ccr.*` 重启语义；其余核心字段热生效
- `audit` 为默认模式——真正省 token 请切 `live`
- 读取类工具与源码/配置路径参数默认受保护，字节敏感场景不压缩
- B 臂回收的是"旧的高阶 `tool/result` 表面节点"，会话日志事件词汇不变

## 兼容性

当前版本适配 DSH `0.1.1-rc.2`（依赖 `tools/post-execute`、`agent/pre-step` 钩子、`settings.plugin.item` 插槽与 `ctx.settings` / `ctx.webServer` / `ctx.tools` 服务）；headroom 代理以官方 `0.36.5-code` 验证（`/v1/compress` + `/v1/retrieve` + `/health`）。任一侧升级后如 API 变化，需同步适配。

## 开发

```sh
# 构建（DSH_CHECKOUT 自动探测或显式指定）
DSH_CHECKOUT=/path/to/deepseek-harness bash scripts/build.sh   # src → lib（host 半）
pnpm run build:client                                            # src/client → lib/client.js
pnpm run typecheck
pnpm run check                                                   # 以上全部
```

`lib/` 为提交的构建产物；修改源码后必须重新构建并提交，再重启 `dsh web`（或在本地开发流程中用你习惯的热装配方式验证）。