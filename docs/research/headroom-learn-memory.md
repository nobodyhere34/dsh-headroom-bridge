# Headroom 三子系统深度调研报告：learn / memory / shared_context / hooks

> 调研对象：`/media/ict/19BD52556106DE5A/headroom/`（Python + crates + plugins）
> 目标：评估哪些功能/设计值得接入 DSH（TypeScript/cordis 插件化 AI agent harness）。
> 所有论断附 `file:line` 证据（相对于 headroom 仓库根）。未修改任何 headroom 文件。

---

## 1. `headroom learn` —— 离线失败学习

### 1.1 完整流水线

```
Scanner(各 agent 的会话日志) → 归一化 SessionData/ToolCall/SessionEvent
  → detect_loops(纯规则, 无 LLM)
  → Digest Builder(把会话压缩成 ≤80K token 文本摘要, 注入 prior patterns + loops)
  → LLM 分析(结构化 JSON 输出)
  → loop 加权排序
  → Writer(写入各 agent 的上下文文件, 默认 dry-run, --apply 才落盘)
```

- 总体定位与文档：`docs/content/docs/failure-learning.mdx:6`（"分析过去的会话，找到出错原因，关联最终修复它的行为，写出项目级学习"）。
- 适配器三件套架构：Scanner / Analyzer / Writer 解耦，"要支持新 agent（如 Cursor），只需写它的 Scanner 和写 `.cursorrules` 的 Writer，分析器不变"：`failure-learning.mdx:121-129`。
- 插件化：`LearnPlugin` ABC 捆绑 identity/detect/scan/create_writer（`headroom/learn/base.py:35-70`）；内置插件从 `headroom.learn.plugins.*` 自动发现，外部包通过 `headroom.learn_plugin` entry point 注册、同名可覆盖内置（`headroom/learn/registry.py:22-64`，外部覆盖在 `:57`）。已有 claude/codex/gemini/grok/opencode 五个插件。
- 分析器是纯 LLM 驱动："No regex patterns, no static lookback windows, no hardcoded heuristics"（`headroom/learn/analyzer.py:1-7` 的模块 docstring）。主流程 `analyze()`：先 `detect_loops`（:185）→ 建 digest（:191）→ 解析模型（:194，LiteLLM 100+ 后端）→ 调 LLM（:198）→ `apply_loop_weighting`（:201）→ 按 estimated_tokens_saved 降序排（:202）。LLM 失败时保留统计但记 `analysis_error`，不让 CLI 把失败报成空成功（:204-208）。

### 1.2 "失败"的判定信号（多层）

1. **显式错误标志**：Claude Code JSONL 的 `tool_result.is_error`（`headroom/learn/plugins/claude.py:288-292`）。
2. **启发式内容嗅探** `is_error_content()`：首 1KB 内的 `"Error:"/"ENOENT"/"Traceback"/"FAILED"/"auto-denied"/"timed out"` 等指示词 + 非零退出码正则（`headroom/learn/_shared.py:96-120`）。特别修过一个误报：agent harness 会给每条成功命令追加 "exit code 0"，裸 "exit code" 子串会虚报失败率，故只匹配非零码（`_shared.py:88-93` 注释 + `_NONZERO_EXIT_RE` :93）。
3. **错误分类** `classify_error()`：15 个有序正则类别（FILE_NOT_FOUND / MODULE_NOT_FOUND / COMMAND_NOT_FOUND / PERMISSION_DENIED / FILE_TOO_LARGE / IS_DIRECTORY / SYNTAX / RUNTIME / TIMEOUT / CONNECTION / NO_MATCHES / USER_REJECTED / SIBLING_ERROR / EXIT_CODE / BUILD_FAILURE），first-match-wins，只查前 2KB（`_shared.py:34-85`）。注释里记录了顺序 bug 的教训：通用 `Error:` 模式必须排在 Timeout/Connection 之后否则专属类不可达（:54-59）。
4. **超越工具调用的会话事件**：`SessionEvent.type ∈ {tool_call, user_message, interruption, agent_summary}`（`headroom/learn/models.py:80-103`）。
   - `interruption`：用户打断文本包含 `"[Request interrupted by user"`（`plugins/claude.py:352-366`）。
   - `user_message`：用户原文（截 500 字符，`plugins/claude.py:329-346`）——支撑"用户偏好挖掘"（如"user rejected gradle 18 次"，`failure-learning.mdx:73`）。
   - `agent_summary`：从 `toolUseResult` 元数据挖 subagent 的 agentId/工具数/总 token/耗时/prompt（`plugins/claude.py:311-325`）。
   - subagent/workflow 嵌套 transcript 也扫（`<project>/<uuid>/subagents/**`），并按路径打 `source=main|subagent|workflow` 标签（`plugins/claude.py:137-150,178-185`）。
5. **跨 agent 归一化**：`normalize_tool_name()` 把 shell/run_shell_command/read_file/... 映射到统一 Bash/Read/Write/Edit/Glob/Grep schema（`_shared.py:129-177`），使分析器对任意 agent 复用。

### 1.3 核心创新点：成功关联 + 循环检测

- **Success Correlation**："不编目失败（'Read 失败 5 次'），而是找模型最终用什么修好了它" → 产出具体到路径的更正规则（`failure-learning.mdx:27-35`）。这一步交给 LLM 在 digest 上做，不硬编码。
- **Loop 检测**（`headroom/learn/loops.py`，纯规则零成本）：
  - 两类循环：error loop（同调用反复失败）与 **re-fetch loop**（`grep foo | head -50` 输出不够 → 换 `head -100` 重跑；每次 `is_error=False`，失败分析完全看不见——`loops.py:9-15`）。
  - 签名归一化：剥掉分页/limit 片段（`| head -N`、`-n N`、`LIMIT/OFFSET` 等，:47-58）+ 把所有裸整数替换为 `N`（:62,96-98），使变体折叠成一个签名（:88-100）。
  - 阈值：≥3 次重复才算 loop（比"2+ 证据"更严一档，避免把一次重试误标为循环，:32-37）。
  - **浪费是实测不是 LLM 猜**：error loop 全部 N 次都算浪费（有前置知识根本不会跑），refetch loop 扣掉第一次合法调用；bytes/4 估 token（:103-106,135-144）。
  - **加权回填**：规则文本与 loop 签名做多数词重叠匹配（:216-218），命中则把 `estimated_tokens_saved` 抬到实测浪费以上并打 `is_loop_guardrail` 标（:196-224）——修正"LLM 对 loop 类规则权重给不够"的系统性偏差。`Recommendation` 模型自带这两个字段（`models.py:162-165`）。
  - digest 里 loop 段标记 "HIGHEST PRIORITY"，system prompt 规定"Detected Loops 里的每条 loop 必须产出一条 guardrail，且 estimated_tokens_saved ≥ 实测浪费"（:161-187；`analyzer.py:440-442`）。

### 1.4 产出格式与落盘

- 双目标文件路由（`failure-learning.mdx:86-99`）：稳定环境事实（环境/路径修正/搜索范围/命令模式/大文件）→ **CLAUDE.local.md**（个人、gitignore 默认）；易变/agent 专属（缺路径、重试模式、权限）→ **MEMORY.md**。system prompt 里有对应的 CONTEXT_FILE/MEMORY_FILE 分流指令（`analyzer.py:446-448`）。
- **Marker 块管理**：`<!-- headroom:learn:start/end -->` 包裹的自动生成段，重跑只替换 marker 之间内容，用户内容原样保留（`failure-learning.mdx:107-119`；`writer.py:22-26,184-193`）。每段带 `*~N tokens/session saved*` 注解（:101-102），可被反向解析回来（:111-115,125-158）。
- 各 agent 的 Writer：Claude→CLAUDE.local.md+MEMORY.md（`writer.py:212-285`）、Codex→AGENTS.md+instructions.md（:349-381）、Gemini→GEMINI.md（:388-409）、Grok→GROK.md（:418-439）。
- **历史迁移**：旧版本把块写进了团队共享 CLAUDE.md 的，下次 `--apply` 自动搬家到 CLAUDE.local.md 并给 warning；若 CLAUDE.md 只剩这个块则整个删除（`writer.py:287-336`；`failure-learning.mdx:101-105`）。动机见 issue #1072：机器专属事实不该污染团队文件（`writer.py:215-224`）。
- 编码容错：读旧文件先严格 UTF-8、失败则 `errors="replace"` 保留合法字节，配合 UTF-8 写回实现自愈（避免 cp1252 全文回退把真正的 UTF-8 em-dash 变成 mojibake）（`writer.py:30-45`）。

### 1.5 去重 / 老化（跨 run 的记忆一致性）

这是 learn 最容易被忽视但设计最扎实的部分：

1. **Section 级 union 合并**：新一轮 LLM 输出按 section 覆盖同名旧 section（新分析权威），**未被重新提出的旧 section 自动 carry forward**——重跑不会悄悄丢掉历史学习，除非手动删块重跑（`writer.py:162-181`）。
2. **Prior Patterns 回喂**：digest 里附"Prior Learned Patterns"段（读两个目标文件的 marker 块原文，`analyzer.py:217-253`），system prompt 规定合并契约："重发某 section = 整段替换，必须把仍然准确的旧 bullet 抄写续期、新证据细化就 merge、被明确矛盾才 drop；不要产生引用了不存在兄弟条目的 bullet"（`analyzer.py:443-469`）。即：**老化决策交给 LLM，但用合同约束它不许丢、不许重**。
3. **证据门槛**：只允许 2+ 次出现或用户明示的规则；禁止同义反复规则（"use python3 not python3"）；单次瞬态错误不出规则（`analyzer.py:443,450-451`）。confidence 是写死的先验（context 0.9 / memory 0.7，`analyzer.py:896,914`），排序完全靠 estimated_tokens_saved（含 loop 实测加权）。
4. **在线侧的老化**（TrafficLearner，见 §2.5）：error_recovery 段渲染时 cap 15 条、半衰期 5 天、21 天硬下限淘汰（`headroom/memory/traffic_learner.py:50-56`），A→B/B→A 双向矛盾规则直接丢弃（:628-632）。

### 1.6 LLM 接入的工程细节（值得抄的防御）

- 模型自动探测链：API key（Anthropic→OpenAI→Gemini 顺序）→ `HEADROOM_LEARN_CLI` 显式指定 → 自动探测装有 claude/gemini/codex CLI 走订阅制 CLI（无 API key 也能用）→ 否则报错给全套 setup 指引（`analyzer.py:44-48,126-156`）。
- prompt 走 stdin 而非 argv，规避 ARG_MAX 与注入（:582-583）。
- `claude -p --output-format stream-json` 走流式 + **双超时看门狗**：idle 60s 无输出杀（抓真挂起）、hard 300s 杀（放任慢但活着），双阈值可用 env 覆盖（:67-73,667-768）。
- 非零退出的报错同时带 stderr 与 stdout 尾部/最终 `result` 事件——claude CLI 把 API 限额等原因只写进 stdout 的 result 事件，只看 stderr 会得到裸 "failed (exit 1):"（:544-575 注释）。
- LLM JSON 输出三级容错解析：markdown fence 内 → 裸文本 → 首 `{` 到末 `}` 切片（:493-541）。
- digest 预算 80K token 近似（按字符/4 折半，:50,307-316）；错误预览保头保尾防 traceback 根因被截掉（:376-393）。

### 1.7 附赠子系统：verbosity 行为学习

`headroom learn --verbosity`：用户几乎不会明说要多简洁，但会用行为展示——打断长回答、在"读完所需时间"的一小截内就回复下一条（fast-skip）。用阅读速度 250 wpm 做长度自适应阈值而非固定秒数（`headroom/learn/verbosity.py:1-24,44-49`），产出 verbosity level 档案写入 workspace `verbosity.json`，热激活到运行中的代理输出整形器（`headroom/cli/learn.py:404-453,549-569`）。还顺带建立 per-stratum token 基线，用于量化该设置的实际节省（合成对照）。

---

## 2. 跨代理 Memory 子系统

### 2.1 存什么 —— 数据模型

`Memory`（`headroom/memory/models.py:66-105`）：
- **层级作用域**：user_id 必填，session_id/agent_id/turn_id 逐级收窄，scope_level 由字段推导（USER/SESSION/AGENT/TURN，:57-63,107-116）。文档语义：User=长期偏好身份、Session=当前任务、Agent=agent 内、Turn=瞬态工作记忆（`docs/content/docs/memory.mdx:47-57`）。
- **时间维度**：`valid_from/valid_until`（None=当前有效），`is_current = valid_until is None`（:80-83,118-121）。
- **谱系**：`supersedes/superseded_by`（时间性版本链）+ `promoted_from/promotion_chain`（低层记忆"冒泡"到高层）（:89-92）。
- **访问统计**：access_count/last_accessed（喂排序）；`entity_refs` 供图谱关联；`embedding`；自由 `metadata`（无强制 category 字段，category 是 metadata 约定，`memory.mdx:87-103`）。
- **数据卫生**：entity_refs 加载时归一化历史脏行（有人把 dict 塞进 list[str] 导致整条 search 崩溃，#2947——修法是解包 dict、丢无名字段而不是 stringify 污染图谱）（:17-54,175-177）。

### 2.2 存储介质与检索

- **SQLite（CRUD/过滤）+ HNSW（向量）+ FTS5（全文）** 三合一内嵌索引，无外部服务（`memory.mdx:235-249`；实现 `headroom/memory/adapters/{sqlite,sqlite_vector,hnsw,fts5,graph,sqlite_graph}.py`）。Embedder 后端 ONNX（int8 ~30MB，默认推荐）/OpenAI/Ollama，Apple MPS 可选且自动回退（`memory.mdx:176-233`）。
- 检索：`search()` 带 `min_similarity` 语义搜索（`core.py:355-405`）；MCP 侧 over-fetch 3×top_k → 过滤 superseded（且对 HNSW 内内存可能过期的行**回查 store 双检**）→ 截回 top_k → record_access 失败只 warn 不让检索失败（fail-open）（`mcp_server.py:271-331`）。
- **重排序**：纯 cosine 会被 6 个月前的陈旧"高分"占坑；插件化 `MemoryRanker` 协议 + 内置 `RecencyBoostRanker`（importance×recency×access 思路，纯函数、无 I/O、亚微秒级）（`headroom/proxy/memory_ranker.py:1-56`；writer 侧同款 score 公式 `writers/base.py:49-56`）。
- **超时会话/超代失效**：`supersede()` 建链且**显式失效 search 缓存**，否则陈旧版本会从缓存里反复复活（`core.py:529-588`，:587 注释）。

### 2.3 去重机制（三层）

1. **文件↔DB 同步层**：内容 sha256 前 16 位为 `content_hash`，sync import 时对照 DB 里既有 hash 集合跳过（`sync.py:60-74,166,240-260`；`SyncResult.skipped_dedup` :54）。
2. **流量学习层**：error_recovery 类不按字面 hash 而去重"恢复意图"——Read 类按 `(失败路径 basename, 成功路径 basename)` 组 key，Bash 类剥掉分页/管道等易变后缀并截断在第一个 `|`/`&&` 前（`traffic_learner.py:58-63,161-190`）。其余类别保持原文 hash（向后兼容）。
3. **语义近似层**：靠 embedding search 在检索端合并近似项 + `supersede` 取代"改写覆盖"（事实变化不删旧行，建版本链，可审计可回滚，`memory.mdx:135-174`）。

### 2.4 跨 Claude/Codex/Gemini/Grok 共享的介质 = **中心 SQLite DB + 双向同步适配器/写手 + MCP server**

Headroom 的答案不是某种统一格式文件，而是**星型结构**：

- **中心**：per-user（实际是 **per-project** 物理隔离，见下）的 SQLite DB。
- **入向**（agent → DB）：`AgentMemoryAdapter` 读各 agent 原生记忆文件。Claude Code 适配器读 `~/.claude/projects/<sanitized>/memory/` 的 MEMORY.md 索引（前 200 行必进上下文）+ 每主题一文件（YAML frontmatter: name/description/type），并**回写 `headroom_id` 交叉引用与 `source_agent` 血统字段**实现跨轮对齐（`sync_adapters/claude_code.py:1-13`；`sync.py:1-20`：`sync() = import + export`，指纹比对快速 no-op）。`bridge.py` 是通用 markdown↔memory 桥（Claude MEMORY.md、ChatGPT facts 等格式，hash 变更检测，`bridge.py:1-27`），`bridge_parsers.py` 有 472 行各家方言解析。
- **出向**（DB → agent）：`writers/` 按 agent 原生格式渲染：Claude→MEMORY.md 分类 bullet（默认预算 2000 token=前 200 行，`writers/claude_writer.py:1-10,23`）、Codex→AGENTS.md + `~/.codex/AGENTS.override.md`（`writers/codex_writer.py:1-5`）、Cursor→rules、Generic→GEMINI.md 等（`writers/generic_writer.py:5`）。同样用 marker 块（`<!-- headroom:memory:start/end -->`）与 learn 的写手同构（`writers/base.py:20-24`），写入前按 score（importance×recency×access）排名再截预算。
- **实时面**（proxy）：代理转发每个请求时 `TrafficLearner.on_tool_result/on_messages` 挂在 anthropic handler 上（`headroom/proxy/handlers/anthropic.py:2583-2607`），server 生命周期启停（`proxy/server.py:1366-1371,2882-2883,2955-2957`）。
- **MCP 面**：stdio MCP server 暴露 `memory_search` / `memory_save` 两个工具（`mcp_server.py:3,249-265`）——任何支持 MCP 的 agent（Claude/Codex/Gemini/Grok 都支持）注册这一个 server 即共享同一 DB；MCP 握手 list_tools 时就后台预热 backend（:249-255），冷启动不卡首次调用。
- **项目隔离**：`storage_router` 默认 PROJECT 模式——按请求头或从 Claude/Codex 的 `<env>` 块解析工作目录，解析到哪个项目就只开哪个物理 DB 文件，"跨项目记忆渗漏在结构上不可能"（修的是 GH #462）；USER/GLOBAL 模式保留兼容。`BackendRouter` 按路径 LRU 缓存已开 backend（`storage_router.py:1-27`）。

### 2.5 读写时机

**读（注入）**：
- SDK 包装路径：`with_memory()` 每次 chat 调用前语义搜索相关记忆 **prepend 到 user message**，并往 system prompt 追加提取指令，响应后解析 `<memory>` 块并剥离再返回（`memory.mdx:34-45`）。
- 代理路径：per-request `MemoryDecision.decide(...)` 统一门控是否注入 + 注入模式（`proxy/handlers/anthropic.py:1301-1316`），检索结果过 ranker 后注入。
- Agent 主动：MCP `memory_search`（带 over-fetch/过滤/记录访问）。

**写（提取）**：
- **Inline 提取（零额外延迟）**：Letta/MemGPT 式——在 system prompt 里要求模型在回答尾部输出 `<memory>{"memories":[...]}</memory>` JSON 块，代理解析后入库、把块从返回中剥离；指令自带"该记/不该记"清单（问候、一次性问题、已知信息不记；空也要输出空数组）（`inline_extractor.py:1-12,27-56`）。零额外 API 成本、LLM 带全上下文提取质量更高、模型自主过滤。
- **流量规则提取（零 LLM）**：TrafficLearner 四类目 error_recovery/environment/preference/architecture 从代理已见流量里正则抽取（`traffic_learner.py:1-16,115-120`），后台 dirty-flag worker 每 ≥10s 防抖 flush（`FLUSH_DEBOUNCE_SECONDS=10`，:42-44,576-592）。
- **flush 的三重质量门**：evidence_count ≥ 门槛（一次性单例是噪声不是信号）→ 丢弃 A→B/B→A 矛盾对 → 必须能锚定到绝对路径对应的项目（无锚点 v1 直接丢），然后委托 learn 插件的 Writer 写进对应项目的 CLAUDE.md/MEMORY.md（:594-680）。写的是 **learn 的同一批目标文件**——在线学习与离线学习共享同一注入面。
- 手动：`memory_save` MCP / `memory.add()` / `memory.supersede()`。

---

## 3. SharedContext —— 压缩型代理间上下文交接

### 3.1 解决什么问题

多 agent 工作流（CrewAI/LangGraph/Agents SDK handoff）里，A 的大输出在 handoff 时被**全量重放**进 B 的上下文。SharedContext 让 A 存原文、B 默认拿压缩版（典型省 ~80% token），需要细节时按 key 取全文（`shared-context.mdx:5-45`）。本质是把 Headroom 的 **CCR（Compress-Cache-Retrieve）**架构从"工具结果缓存"推广成"命名键的跨 agent KV"。

### 3.2 数据结构与同步机制（`headroom/shared_context.py`，仅 228 行，极简是特点）

- `ContextEntry`：key + **original 与 compressed 双份全文** + original_tokens/compressed_tokens + agent 标签 + timestamp + transforms 审计链（:36-53）。
- `put()`：把 content 包成 `[{role:"tool"}]` 喂给 `headroom.compress()` 同一条压缩管线（JSON→SmartCrusher、代码→CodeCompressor、文本→Kompress/直通，`shared-context.mdx:219-227`），返回带节省统计的 entry（:91-142）。
- `get(key, full=False)`：默认压缩版，`full=True` 原文；过期即删返 None（:144-179）。
- **同步机制就是"共享同一个进程内对象"**：`dict + threading.Lock`（TS 版 async 单线程），TTL 默认 3600s，max_entries 100 满了 evict 最旧（:79-89,209-228）。**没有跨进程/持久化同步**——框架把同一个 SharedContext 实例递给各 agent 节点即可（LangGraph 示例 :191-200）；过期是读时惰性删除。
- 修过的坑值得记录：写**已存在的 key**（更新）时不该触发 evict 杀邻居——map 根本没变大（:209-227 注释，同款缺陷 #2094 在 SemanticCache 也修过）。
- `stats()` 聚合 active 条目的节省量（:187-202）；`keys()/clear()`（:181-207）。

**评估**：作为库很简单（甚至可说是 naive——进程本地、无命名空间、无 ACL），但**接口语义**（put 即压缩、get 默认摘要、full 逃生门、savings 审计）是 handoff 场景的好抽象。

---

## 4. hooks.py 与 agent hooks 插件的事件模型

Headroom 的 hook 面有**四个正交表面**，分层非常清楚：

### 4.1 管线内压缩钩子（`headroom/hooks.py`）

三个钩子 + 一个事件流（:1-30）：
1. `pre_compress(messages, ctx)`：**可改**消息（跨轮去重、记忆注入、预过滤、阶段检测）（:80-100）。
2. `compute_biases(messages, ctx) -> {index: bias}`：给每条消息设压缩激进度系数（>1 多保留），支持位置感知（中部注意力最弱压狠些）、相位感知、**per-tool 学习到的偏置（TOIN）**（:102-129）——这个"钩子返回的是数值决策而非改写文本"的形态很独特。
3. `post_compress(event)`：**只观察**——学习/分析/告警/AB 测试，签名返回 None（:131-143）。`CompressEvent` 带 before/after/ratio/transforms/ccr_hashes/query 全量指标（:56-70）。
- 基类全部 no-op，"不覆盖就不改变 OSS 行为"——钩子是纯扩展点非拦截器（:73-78）。同步调用，无 async/超时概念（进程内方法）。

### 4.2 规范生命周期事件（`headroom/pipeline.py`）

- 12 个稳定阶段：`setup / pre_start / post_start / input_received / input_cached / input_routed / input_compressed / input_remembered / pre_send / post_send / response_received / outcome_observed`（:18-32）。
- `PipelineEvent` 携带 messages/tools/headers/response/OutcomeSnapshot/metadata，扩展可**原地改**或返回替换事件（:101-121）；`PipelineExtension.on_pipeline_event` 协议（:123-127）。
- **扩展发现**：entry point group `headroom.pipeline_extension` + `HEADROOM_PIPELINE_EXTENSIONS` 环境变量白名单（:14-15,129-141）——与压缩钩子并存不互斥（"one stable contract ... without replacing the existing compression hooks"，`hooks.py:9-15`）。
- **Fail-open 实锤**：emit 循环里扩展抛异常 → log warning → continue，管线照常（`pipeline.py:276-289`，注释直接写 "preserve hook fail-open behavior"）。
- `outcome_observed` 阶段 + `OutcomeSnapshot` 意味着"结果观测"是一等公民事件——这正是失败学习需要的信号点。

### 4.3 Agent 侧薄钩子（`plugins/headroom-agent-hooks/`）

对 agent 生命周期只挂**两个点**（`hooks/hooks.json:4-27`）：
- `SessionStart` matcher `startup|resume` → `headroom init hook ensure`（timeout 15s）。
- `PreToolUse` matcher `Bash|PowerShell` → 同一命令。
命令是隐藏 helper："检查有没有匹配的持久化 headroom init 部署，没有就拉起来"（`README.md:5-11`）。**哲学：agent 侧钩子只做 runtime keepalive，重活全在代理转发层（改 BASE_URL）完成，所以钩子零延迟、失败也无所谓（Claude 忽略非零钩子退出码）**。这是与"往每个事件塞逻辑"完全相反的事件模型。

### 4.4 原生插件面（opencode / openclaw）

- opencode 插件注册：`tool.headroom_retrieve`（hash 正则校验 24 hex）、`shell.env` 注入（HEADROOM_ACTIVE/PROXY_URL/PROJECT）、transport 拦截 + `dispose` 清理（`plugins/opencode/src/plugin.ts:29-70`）。
- openclaw 引擎在消息转换处压缩，带**熔断器**："Circuit open — using uncompressed messages" 直通降级（`plugins/openclaw/src/engine.ts:111-117`），外加 Promise.race 超时壳（:16-20）。

### 4.5 与 DSH 的 tools/post-execute、agent/pre-step 对比

| Headroom | DSH 现状 | 差距/可借鉴 |
|---|---|---|
| pre_compress（可改消息） | agent/pre-step 近似 | 基本对齐 |
| post_compress（纯观察 + 全量 before/after 指标） | tools/post-execute 有工具粒度结果 | 缺**请求级聚合快照**（tokens_before/after、transforms 链）这一等观察事件 |
| compute_biases（返回决策表而非改文本） | 无对应 | 独有形态：把"策略决策"与"执行改写"分离，决策可被学习器自动调参 |
| PipelineStage 12 阶段 + env 白名单扩展发现 | 插件监听器 | Headroom 的阶段枚举是跨 SDK/proxy 的稳定契约；DSH 监听器可考虑显式 stage 枚举 |
| 扩展异常 fail-open + 熔断降级 | 插件异常一般隔离 | Headroom 额外有**连续失败熔断→直通**，适合任何在关键路径上的插件 |
| agent 侧 SessionStart/PreToolUse 仅 keepalive | DSH 插件常驻进程内 | DSH 无需 keepalive 钩子，但"**重活在旁路、钩子只保命**"的分层值得记住：钩子里永远不做慢分析 |

---

## 5. DSH 等价物的最小可行设计草图

前提：DSH 已有会话日志（JSONL，含工具调用/结果/时间戳）、回放/分叉、storages（KV 持久化）、插件工具/监听/设置卡片；本 workspace 的 dsh-headroom-bridge 已提供 `headroom_retrieve`/CCR offload。

### 5.1 `dsh-learn`（失败学习插件，ui-panel 或 toolkit 形态）

```
scan:   读 DSH 会话日志目录 → 归一化 ToolCall{name, input, output, is_error,
        error_category, output_bytes}（DSH 工具名与 headroom 的 Bash/Read/Edit
        schema 高度同源，_TOOL_NAME_MAP 可近乎照抄，learn/_shared.py:129-168）
loops:  移植 detect_loops——纯函数 ~150 行 TypeScript，无依赖
        （签名归一化 + min_occurrences=3 + measured wasted tokens，
        loops.py:88-158）——先只做这个，零 LLM 就有价值
digest: 按会话流生成 compact digest（错误预览保头尾，analyzer.py:376-393），
        注入 prior patterns（读回自己写的 marker 块）
llm:    走 harness 自己的模型路由（不需要 LiteLLM/CLI 后端那一层——DSH 天然
        有模型），要求输出 context_rules/memory_rules JSON，fence-strip 解析
write:  marker 块（<!-- dsh:learn:start/end -->）写入目标：① 项目根的
        AGENTS.md/CLAUDE.local.md（照抄 writer.py 的 merge+carry-forward 语义）
        ② DSH 设置卡片（结构化存储 recommendations，UI 里可勾选启停——这是
        Headroom 没有的交互红利：把"do not edit manually"变成一键编辑）
命令:   插件工具 learn_sessions(project, dry_run=true) → 报告；
        设置卡片按钮 = --apply。默认 dry-run（failure-learning.mdx:12-15）
```
关键取舍：抄它的 **marker 合并 + prior 回喂 + section union**（§1.5），这是防"重跑丢学习"的最小充分集；老化先做 evidence_count 门槛 + loop guardrail 加权，暂不做 LLM 合并合同也可以（DSH 回放/分叉可当人工审计面）。

### 5.2 `dsh-memory`（跨会话记忆插件）

```
存储:   单文件 SQLite（node:sqlite）：memories(id, content, content_hash,
        scope(user|session|agent|turn), project, importance, valid_until,
        supersedes, access_count, last_accessed, created_at, metadata)
        + FTS5 虚表。不上 embedding——DSH 场景量级小，FTS5+recency 排序
        （score=importance×recency×access，writers/base.py:49-56 公式）够用；
        检索接口留 search(query,{semantic?}) 位，日后 ONNX 嵌入无痛升级。
去重:   content_hash 跳过（sync.py:240-260）+ supersede 覆盖（不 UPDATE 原文，
        建链+valid_until，core.py:529；默认过滤 superseded，memory.mdx:159-164）
项目隔离: 照抄 storage_router PROJECT 模式=每项目一个物理 DB 文件
        （storage_router.py:1-22——"渗漏结构上不可能"是极低成本的正确答案）
写时机: ① 插件工具 memory_save(facts, importance)（对齐 mcp_server 的
        memory_save 语义）② 可选 inline：agent/pre-step 往 system prompt
        追加 <memory> 指令、tools/post-execute（或 turn-end 监听）解析剥离
        （inline_extractor.py:27-56 的指令文案可直译）③ 会话日志离线扫描
        （与 dsh-learn 共享 scanner）
读时机: agent/pre-step 检索 top-k prepend（带 project 过滤 + ranker）；
        设置卡片列全库/手动 supersede/清理
回放红利: DSH 的 replay/fork + supersession 链天然构成"记忆审计"——
        旧版本→新版本的替换可映射到 fork 点做 diff 展示（Headroom 只有
        get_history 列表，DSH 能做成可视化谱系）
```

### 5.3 `dsh-shared-context`（handoff 压缩 KV）

```
接口:   put(key, content) → {key, originalTokens, compressedTokens,
        savingsPercent}；get(key, {full}) ; keys(); stats()
        （逐一对应 shared_context.py:91-207，语义照抄）
实现:   直接建在现有 headroom-bridge 的 CCR 之上——put 即调现有压缩 offload
        拿 compressed+hash，原文进 storages（LRU + TTL 3600 + maxEntries 100，
        含"更新已有 key 不触发 evict"的修正，shared_context.py:209-227）
挂载:   ① subagent prompt 里约定 key（零工具成本）② 注册一个
        shared_context_get 工具供子代理按 key 取 full（对齐 headroom_retrieve
        的 hash 取回模式）③ fork 会话时自动把父 ctx 的 keys 列表带进子代理
        system prompt（= "共享同一实例"在 DSH 会话模型里的等价物）
差异:   Headroom 是进程内 dict；DSH 跨会话必须走 storages——这反而获得
        持久化+跨重启可查，TTL 语义不变
```

### 5.4 Hook 面增强（不单独立插件）

- 在 DSH 请求管线上定义显式 `PipelineStage` 枚举 + `outcome_observed` 事件（带 tokens_before/after、耗时、失败类目），供 dsh-learn/dsh-memory 订阅——这是 learn/memory 两个子系统共同的数据脐带（对应 `pipeline.py:18-32,101-121`）。
- 关键路径插件加**熔断直通**（openclaw engine.ts:111-117 模式）：连续 N 次异常 → 本会话内跳过该插件。
- `compute_biases` 式"策略决策钩子"：允许插件返回 `{toolName: compressBias}` 表而不是改写文本，为将来 per-tool 学习（TOIN）留形。

---

## 6. 对 DSH 的启示清单

| # | 设计点 | 价值 | 成本 |
|---|---|---|---|
| 1 | **Loop 检测器**（error loop + re-fetch loop、签名归一化、实测浪费 token、≥3 次阈值）`loops.py:88-158` | 高——纯规则零 LLM 成本即可量化最大浪费源；re-fetch loop 是"失败分析看不见"的盲区，DSH 现在必然也在交学费 | 低（~200 行 TS 纯函数，输入 DSH 会话日志即可） |
| 2 | **Marker 块 + section union + prior patterns 回喂**的上下文文件写入协议 `writer.py:162-193`、`analyzer.py:443-469` | 高——离线 LLM 学习落盘的"不丢不重"最小充分集；DSH 写 AGENTS.md/项目提示词直接复用 | 低-中 |
| 3 | **dry-run 默认 + 显式 --apply** 的学习产品形态 `failure-learning.mdx:12-15` | 中——配合 DSH 设置卡片可升级为预览 diff + 一键采纳 | 低 |
| 4 | **成功关联**（失败→最终成功的因果对，交给 LLM 在 digest 上挖）`failure-learning.mdx:27-35` | 高——产出"路径修正/命令修正"级别的规则而非泛泛建议；依赖 1 的归一化模型 | 中（digest 构建 + prompt 工程） |
| 5 | **per-project 物理隔离 DB** 的记忆路由 `storage_router.py:1-22` | 高且便宜——"跨项目渗漏结构上不可能"，一个目录约定解决 | 低 |
| 6 | **supersession 链**（覆盖不删除、valid_until、默认过滤、可审计回滚）+ DSH replay/fork 联动的记忆谱系 `core.py:529-588` | 中-高——记忆可审计是 DSH 回放基因的自然延伸，差异化卖点 | 中 |
| 7 | **content_hash 去重 + 意图归一化 hash**（Bash 剥易变后缀/截管道、Read 用 basename 对）`traffic_learner.py:161-190` | 中——不做这个，自动学习的库一周就淹没在重复噪声里 | 低 |
| 8 | **在线老化三件套**：evidence gate、半衰期+硬下限、矛盾对丢弃 `traffic_learner.py:50-56,628-632` | 中-高——让"从流量自动学"敢默认开启的安全带 | 低-中 |
| 9 | **inline `<memory>` 块提取**（system prompt 指令 + 响应解析剥离，零额外调用）`inline_extractor.py:27-56` | 中——最省的记忆写入通道；代价是吃响应 token 且依赖模型服从性，可做成开关 | 低 |
| 10 | **SharedContext 语义**（put 即压缩、get 默认摘要、full 逃生门、TTL/容量、更新不 evict）建在现有 CCR/storages 上 `shared_context.py:91-228` | 中——subagent handoff 省 token；本 bridge 已有 CCR 半成品，边际成本低 | 低-中 |
| 11 | **outcome_observed 一等事件 + 请求级压缩/成本快照** `pipeline.py:18-32`、`hooks.py:56-70` | 高——learn/memory 的共同数据脐带；一次建线，后续插件（分析、告警、AB）全受益 | 中（动 harness 或 core 插件） |
| 12 | **关键路径插件熔断直通** `engine.ts:111-117` | 中——memory/learn 挂进 pre-step 后必须有"坏了就消失"的保底 | 低 |
| 13 | **`compute_biases` 式决策钩子**（返回数值表，不碰文本）`hooks.py:102-129` | 中——为 per-tool 压缩偏置自学习留形；现在没有消费者，先留接口 | 低 |
| 14 | **行为式 verbosity 学习**（打断率/fast-skip/长度自适应阈值，250wpm）`verbosity.py:1-49` | 中——DSH 会话日志同样含时间戳与中断；产出一个可被设置卡片直接暴露的档位 | 中 |
| 15 | **agent 侧薄钩子哲学**：SessionStart/PreToolUse 只做 runtime ensure，重活旁路 `hooks.json:4-27` | 观念性——DSH 插件常驻，对应启示是"监听器/hook 内禁慢 IO，全部进后台 worker + 防抖 flush（10s debounce，traffic_learner.py:42-44）" | — |
| 16 | **跨 agent 记忆互通走"原生文件双向 sync + MCP 双通道"** `sync.py:1-20`、`mcp_server.py:249-265` | 远期——DSH 若要与 Claude Code/Codex 共存，直接实现 headroom 的 memory MCP 协议（memory_search/memory_save 两工具）即可白嫖其全部 sync 生态，比自建格式便宜得多 | 中（若只要 DSH↔外部，注册现成 headroom MCP 甚至近零成本） |

**优先级建议**：1 → 11 → 2/4/5 → 7/8 → 6/10 → 其余。即先做零 LLM 的 loop 分析器（立即可量化收益），同时补 outcome 事件脐带，再上 LLM 学习与 marker 写入，最后做记忆库与 handoff KV。

---

### 附：本次调研未深入的部分（透明性说明）

- `headroom/memory/ports.py`（952 行）、`wrapper_tools.py`、`easy.py`、mem0 后端适配：与主结论正交，未逐行读。
- `bridge_parsers.py` 各家 markdown 方言细节（472 行）：确认了用途与入口未逐一验证。
- Rust crates / proxy 压缩管线本体：属另一次 CCR 调研范围。
