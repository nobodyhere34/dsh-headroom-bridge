# Headroom 子系统深读 → DSH / dsh-headroom-bridge 接入评估

调研对象：`/media/ict/19BD52556106DE5A/headroom/`（Python + Rust 混合仓库）
评估目标：哪些设计值得接入 DSH 主线或 `dsh-headroom-bridge` 插件
调研方式：只读源码 + 文档 + 现场部署观测，未修改任何 headroom 文件
日期：2026-09-15

---

## 0. 结论速览

| 子系统 | headroom 的真实强度 | 对 DSH 的可抄度 | 一句话结论 |
|---|---|---|---|
| savings 记账 | ★★★★★ | **直接可抄（换皮即用）** | append-only 事件账本 + 写入时定价 + 分层计价 + 未知模型兜底，DSH 侧目前完全没有这一层（连价格表都不存在） |
| token 计数 | ★★★★☆ | 高（且 DSH 现有估算有明确缺陷） | 内容感知 chars/token（JSON 3.2 / 代码 3.5 / CJK 1.5）；DSH `dsh-token-meter` 是裸 chars/4 |
| pricing | ★★★★☆ | 中（依赖 litellm） | 价格表外包给 litellm 社区库 + 别名映射 + 30 天陈旧度告警，本地只需维护 4 个桶的计价函数 |
| CacheAligner（volatile 检测） | ★★★☆☆ | 中-高（算法 60 行） | 纯检测器（永不改写），只输出 `stable_prefix_hash` + 4 类结构化 volatile 命中；真正的缓存保护在 `prefix_tracker` |
| prefix_tracker / cache-miss 归因 | ★★★★★ | 中（DSH 缺观测输入） | `ttl_expiry / prefix_change / cold_start / unknown` 四分归因 + "压缩收益 > 缓存折扣才动前缀"的经济学门 |
| CCR context_tracker 主动展开 | ★★★★☆ | 中-高（可裁剪为本地版） | 阈值 0.3 + 年龄衰减 ×(1−age/max·0.5) + 每轮 ≤2 + workspace 硬隔离 fail-closed；配 retrieval-rate 负反馈闭环 |
| metrics / dashboard | ★★★★★ | 高（指标词表 + 基数纪律 + 测量诚实性） | "must stay 0" 哨兵告警、per-strategy×content_type 压缩率、measured/estimated/modelled 三态标签 |
| relevance（BM25+embedding, dynamic α, Otsu） | ★★★★☆ | 高（BM25 + Otsu 纯移植，embedding 留给代理侧） | 最有价值的反而是 Otsu 自适应阈值和"先 BM25 服务、后台预热 embedding 再原子换"这两条 |

**最重要的单条结论**：DSH 主线至今没有任何"成本/省钱"概念（`@deepseek-ai/*` 全部包的 `lib/` 里 grep 不到 `input_cost_per` / `costUsd` / `pricePerMillion`），但**已经有** provider-reported usage 的 durable fold（含 `cacheReadTokens` / `cacheWriteTokens`，见 `dsh-token-meter/lib/index.js:338-466`）。也就是说 DSH 有权威分母、没有分子与定价——补一层"事件账本 + 价格表"就能拿到 headroom 80% 的可观测性收益。

---

## 1. Savings 记账模型

### 1.1 两条记账路径，一个事件账本

headroom 有**两套**并存的记账：

1. **`savings_ledger.py`（跨进程持久账本）** —— 面向 `headroom savings` CLI，是"durable 真相源"。
2. **`proxy/savings_tracker.py`（代理侧状态文件 `proxy_savings.json`）** —— 面向 `/stats`、`/stats-history`、dashboard。

设计动机写在 `savings_ledger.py:1-16`：MCP server 是**多进程**的（主 agent + 每个 subagent 各起一个），代理又是独立进程，内存态 `SessionStats` 和 2 小时窗口都会丢/竞态，所以选择"append-only + 文件锁 JSONL + 读时聚合"。

**事件 schema**（`savings_ledger.py:156-167`）：

```
{v, ts, before, after, saved, cost_usd, model, client, source, pid}
```

**写入**：`record_savings_event()`（`savings_ledger.py:119-185`），`saved<=0` 直接不记（`:143-145`），全程 `try/except` 返回 bool，**永不抛**（`:181-182`）；`fcntl.flock(LOCK_EX)` 保护 append（`:173-180`），读用 `LOCK_SH`（`:201-222`），Windows 无 fcntl 时降级为"尽力而为"（`:38-46`）。

**聚合**（`aggregate_savings`，`:288-353`）：

- 时间窗：`today`（**本地日历日**零点起，`:302-305`）/ `last_7_days`（滚动 168h）/ `last_30_days`（保留期即 30 天硬上限，所以它同时充当 lifetime，`:297-310`）。
- 维度桶：`by_model`、`by_client`（各 `_Bucket{tokens_saved, tokens_before, cost_usd, calls}`，`:228-255`），排序键 `(cost_usd, tokens_saved)` 逆序（`:279-285`），`savings_percent = saved/before*100`。
- 自愈：文件 >1MB 时按保留期压缩（`:59-62, 356-394`）；读时也再过一遍 cutoff，所以"准确性不依赖压缩是否跑过"（`:51-53` 注释）。

**注意维度里没有"内容类型"**。内容类型维度在别处（见 §4 的 `proxy_compression_ratio_by_strategy{strategy,content_type}`、waste signals）。ledger 的维度刻意保持极小：**model / client / source / pid + 时间**。代理侧状态文件则多出 `provider`、`project`（`savings_tracker.py:749-771, 1034-1074`）。

### 1.2 用什么 token 计数

| 路径 | 计数来源 |
|---|---|
| 代理侧（真实流量） | provider 响应的 usage（真实 token），`record_request` 的 `input_tokens` 等入参（`savings_tracker.py:749-771`） |
| SDK / MCP 工具侧 | `EstimatingTokenCounter`（`headroom/client.py:403` 用它构造 tokenizer） |

估算器的实现值得逐条抄（`tokenizers/estimator.py`）：

- 分类比率：英文 4.0、代码 3.5、JSON 3.2、**CJK/假名/谚文 1.5**（`:43-52`）
- 自动判定：JSON 用 `json.loads` 试解析，代码用模式命中密度 `> len/500`（`:155-177`）
- CJK 单独按 1.5 计、其余按检测到的比率（`:129-134`）；provider 校准计数器（Anthropic 3.5 / Google 4.0 / Cohere 4.0 / Moonshot 3.1）**也必须**做 CJK 修正，否则中文低估 2-4×（`:111-124`）
- 特殊开销：URL 每个 `/ ? &` 加 1 token、每个 UUID 加 2（`:179-203`）
- 结果 LRU 缓存（`:104-109`）

对照 DSH：`@deepseek-ai/dsh-token-meter/lib/index.js:16` `CHARS_PER_TOKEN = 4`，`:27,39,63,83` 全部是 `ceil(len/4) + overhead`。中文工具结果会被系统性低估约 2.7×。这是**可直接给主线提 PR 的具体缺陷**。

### 1.3 价格表如何维护

- **不自建表**：直接用 litellm 社区维护的 `model_prices_and_context_window.json`（`pricing/litellm_pricing.py:1-7`）；导入 litellm 时**快照并回滚 `os.environ`**，阻止它 `load_dotenv()` 把项目 `.env` 泄进进程（`:20-40`）——这个副作用防御细节本身值得抄。
- **模型名归一**：`_resolve_litellm_model`（`savings_tracker.py:185-243`）= 共享别名解析 + `HEADROOM_MODEL_ALIAS_MAP` 网关别名（`litellm_pricing.py:46-58`）+ `claude-→anthropic/`、`gpt-→openai/` 等裸前缀试探 + **有界 LRU(256)**（注释 `:169-183` 明确说明"不能让调用方用任意 model 字符串免费撑爆缓存"）。
- **陈旧度**：`PricingRegistry.STALENESS_THRESHOLD_DAYS = 30` + `staleness_warning()` 带官方价格页 URL（`pricing/registry.py:40, 70-92`）；`estimate_cost` 返回 `breakdown`（input/output/cached/batch 各自 tokens+rate+cost）并带 `is_stale`/`warning`（`:94-188`）。
- **免费模型陷阱修复**：判断用 `is None` 而不是 `if not value`，否则 `input_cost_per_token == 0.0` 的真·免费模型会被按 $3/M 兜底计费，产出**幻影省钱额**（`savings_tracker.py:256-266, 283-293`；`savings_ledger.py:105-116` 同样强调）。

### 1.4 如何换算省钱额：四个互不相加/不可混的桶

`estimate_request_savings_usd`（`savings_tracker.py:332-359`）把一次请求的收益拆成

| 桶 | 定价方式 | 出处 |
|---|---|---|
| `compression` | 省下的 **input** token × input 价 | `:246-266` |
| `tool_schema` | 同上（被推迟的 tool schema，从未进过模型） | `:246-266` |
| `output_shaping` | 省下的 **output** token × output 价 | `:269-293` |
| `provider_cache` | `input_cost − cache_read_cost` 的**折扣差** × cache-read token | `:296-329` |

刻意不合并的理由写在 `:340-345`：provider-cache 收益不是压缩造成的；扩展归因（attribution）可能只是解释性的而非可加。前端进一步把 provider cache 折扣**排除在"Headroom 省的钱"之外**，单列一行 `+ $X provider cache discount`，注释直说"折扣是 provider 原生的，不算 Headroom 的功劳"（`dashboard/templates/dashboard.html:265-267`）。

另一处极有价值的口径修复：`tool_search_saved` 与 `tokens_saved` 是**互斥**（disjoint）的（`:755-760`），历史上 `record_request` 只读 3 个桶、把 `tool_schema` 丢掉，导致"Cost saved 明显低于 token savings %"（`:789-798`，附真实流量比例 2.7M/11.2M）。以及 per-model `savings_percent` 的分母定义："被推迟的 tool schema 从未进模型，所以 pre-Headroom 分母 = 发出的 + 拦下的"，并且该字段命名 `headline_tokens_saved` 以避免和 lifetime 的 `total_tokens_saved` 同文件两义（`:1125-1153`）。

**rollup 实现对比**：代理侧历史是"累计 checkpoint"，dashboard 的 hourly/daily/weekly/monthly 序列用**相邻 checkpoint 差分**重建增量（`:1663-1742`，`delta = max(cur − prev, 0)`）；ledger 侧则是直接对事件流做窗口聚合（`:288-353`）。DSH 侧没有历史包袱，**应选后者**。

### 1.5 与"每插件自计计数器"的差距（DSH 现状）

bridge 现状（`dsh-headroom-bridge/src/stats.ts` 全文 18 行）：`{attempts, failures, adopted, savedChars}` 四个内存字段，插件 fiber 重载即归零。差距：

| headroom 有的 | 插件计数器缺的 | 后果 |
|---|---|---|
| 落盘 + 跨进程锁 | 重启/热重载即丢 | 无法回答"上周省了多少"；多会话/多子代理并发写同一份内存 |
| 写入时定价（USD） | 只有字符数 | 字符 ≠ token ≠ 钱；模型不可知，无法与账单对齐 |
| 事件级历史（可任意重算窗口） | 只有累计值 | 无法出时间序列、无法事后加维度、无法审计单次 |
| `unknown` sentinel + 维度桶上限/淘汰 | 无 | 有界性与"老数据不丢"两者都能兼顾（`:1066-1074` 按 (tokens_saved, last_activity) 淘汰最小最旧） |
| 30 天保留 + 自动压缩 | 无 | 长期运行不可控增长 |
| measured/estimated 标签 | 无 | 无法区分"真替换省下的"与"audit 试压测出的" |

`audit` 模式其实是 headroom 没有的**优势**（它给了"estimated savings"的天然数据源），只要账本能区分 `mode` 即可。

---

## 2. CacheAligner：volatile content 检测

### 2.1 定位：检测器，不是修复器

`headroom/transforms/cache_aligner.py:1-24` 与 `docs/content/docs/cache-optimization.mdx:8-10` 双重声明：曾经是"抽出动态内容挪到上下文块"的改写器，因违反不变量 I2（缓存热区不得被改动）而**删掉改写路径**，现在 `apply()` 只填 `warnings` 与 `cache_metrics`，`transforms_applied` 恒空（`:362-371`），`result.messages` 与输入字节相等（`:301-311`）。代理里**硬关**：`proxy/server.py:964` 传 `CacheAlignerConfig(enabled=False)`。

### 2.2 具体检测什么

对 **system 消息**（跳过 `frozen_message_count` 之前的消息）做空白切 token、剥标点（`:205-220`），逐 token 结构化分类，**不用 regex**：

| 类别 | 判据 | 行号 |
|---|---|---|
| `uuid` | 长度必须 36 + 恰好 4 个 `-` + `uuid.UUID()` 解析成功；**故意不接受 32 位无横线形式**（那必然是 hex hash） | `:105-122, 79-82` |
| `jwt` | 恰好 3 段 base64url、每段 ≥4 字节、可解码；不验签 | `:144-165, 84-88` |
| `iso8601` | 长度 ≥8 且含 `T` 或 `-`，`Z`→`+00:00` 后 `datetime.fromisoformat` 成功 | `:125-141` |
| `hex_hash` | 长度 ∈ {32,40,64} 且 `int(token,16)` 成功 | `:168-181, 74-77` |

判定顺序 uuid → jwt → iso8601 → hex_hash（先特后泛，防误分类，`:184-202`）。
输出时**永不记录全量原文**：>16 字符的样本一律 `token[:8] + "..." + token[-4:]`（`:236-239`）。

### 2.3 输出形态

```
CacheAligner: detected volatile content in system prompt (iso8601=2, uuid=1);
cache prefix unstable. Move dynamic values out of the system prompt to recover cache hits.
```

即 `warnings[str]`（按 label 计数 + 一句可执行建议，`:328-339`）。同时产出 `CachePrefixMetrics`（`config.py:864-876`）：

- `stable_prefix_bytes` / `stable_prefix_tokens_est`
- `stable_prefix_hash`：作用域 = 冻结前缀 + 冻结之后的 system 消息，经 `json.dumps(sort_keys=True, ensure_ascii=False, separators=(",",":"))` 规范化后的短 hash（`:46-71, 341-351`）
- `prefix_changed` / `previous_hash`：与**上一轮**比较（`:347-349`）
- `markers_inserted += ["stable_prefix_hash:<hash>"]`（`:370`）
- 另有一个纯展示用的 `get_alignment_score()`：`100 − 10×findings`，clamp [0,100]，注释明说"粗信号，不改变行为"（`:373-389`）

### 2.4 agent 侧如何消费

关键：**agent 侧不消费改写，只消费心跳**。消费方是三处 provider 分析器——

- `cache/anthropic.py:168-171`：把 `prefix_hash` 填进 `stable_prefix_hash`，并用 `not cache_hit` 反填 `prefix_changed_from_previous`
- `cache/openai.py:111, 296-301`：`if not metrics.prefix_changed_from_previous` 才认为自动前缀缓存仍有效（OpenAI 无显式 cache_control，"prefix 是否变了"是唯一信号，见 `cache-optimization.mdx:46-55`）
- `cache/google.py:29, 204, 458`：CachedContent 的 content_hash 直接用它

即 **provider 侧的经济学（Anthropic 读折扣 90%/写罚 25%/TTL 5min、OpenAI 50%/≥1024 token、Gemini 75%/≥32768 token，`cache-optimization.mdx:35-67`）+ 一个 hash 心跳 = 全部闭环**。

### 2.5 同目录的第二个检测器（更强的那个）

`cache/dynamic_detector.py` 是另一套东西，只被 OpenAI 缓存优化器用（`cache/openai.py:57, 136-149`），设计哲学写在 `:9-19`：**不写 locale 特定 pattern**（不匹配月份名），改为三条通用判据：

1. **结构标签**："Label: value" 中 **LABEL 提示 VALUE 是动态的**（`dynamic_labels` 词表：date/time/timestamp/updated/expires/now/id/uuid/session/request/trace/token/key/user/email/… `:135-150`，用户可扩展）
2. **熵**：高熵 = 动态（UUID/token/hash → `IDENTIFIER`）
3. **通用格式**：ISO 8601 / UUID / Unix 时间戳

分级：Tier1 regex ~0ms / Tier2 NER(spacy) 5-10ms（person/money/org/location）/ Tier3 semantic(sentence-transformers) 20-50ms（`volatile`/`realtime`）（`:15-18, 52-78`）。产物是 `DynamicSpan{text,start,end,category,tier,confidence,metadata}` + `static_content`/`dynamic_content`（`:81-126`），即**带位置的 span 列表**，比 CacheAligner 的"只有 label 计数"更可用于展示与定位。

DSH 侧启示：CacheAligner 的四类结构检测 + dynamic_labels 词表思路 = 可判定"DSH 的 system prompt / 工具 schema 序列化里哪一段造成每轮漂移"，且输出必须是 span（可定位）而不是一句 warning。

---

## 3. CCR context_tracker：主动展开

`headroom/ccr/context_tracker.py`。目的（`:1-19`）：压缩过的东西在后续轮次变成"上下文失忆"，与其等模型调 retrieve，不如在**它回答之前**按相关性主动回填。

### 3.1 触发条件与打分

配置默认（`ContextTrackerConfig`，`:102-123`）：

| 参数 | 默认 | 作用 |
|---|---|---|
| `max_tracked_contexts` | 100 | LRU 上限（`:215-218`） |
| `relevance_threshold` | **0.3** | 过阈值才推荐 |
| `max_context_age_seconds` | **300s** | 超龄直接跳过（`:281-283`） |
| `proactive_expansion` | true | 总开关 |
| `max_proactive_expansions` | **2** | 每轮回填条数上限 |

**年龄折扣**：`relevance *= 1 − (age/max_age)×0.5`（`:286-288`）→ 最老仍可保留一半分数（不做硬断崖）。

**相关性打分**（`_calculate_relevance`，`:306-357`，纯启发式，无模型）：

- 采样内容关键词重叠：`|overlap|/|query_words| × 0.5`
- 长度 ≥4 的 query 词作为**子串**命中 sample：每个 +0.2
- 压缩发生时的 `query_context` 重叠：`× 0.3`
- 工具名先验：工具名含 find/glob/search/grep/ls 且 query 含 file/where/find/show/list → +0.1
- clamp 到 1.0；关键词抽取用 `re.findall` + 约 100 词停用表（`:359-437`）

**硬门（比打分更重要）**：

1. `workspace_key` **必填且不等则跳过**（`:247-262, 276-280`）；空 workspace → **fail-closed 返回空**（`:255-262`）。注释写明这是 2026-05-26 的跨项目泄漏事故复盘：模块级单例 tracker 让 A 项目的 Python 文件出现在 B 项目的 Ruby 会话里（`:69-79, 567-590`，生产代理把 tracker 挂在 server 对象上，`proxy/server.py`；`get_context_tracker()` 被降级为 **TEST-ONLY**）。
2. **Claude Code `/compact` 续接摘要不追踪**（`looks_like_claude_code_compact_summary`，`:34-63`，判据刻意窄）；否则会把旧会话状态反复重新注入。
3. 展开**永远是全量按 hash 取回**，没有"部分展开/搜索式展开"（`:462-493`）。

### 3.2 实际数据流（proxy 侧）

`headroom/proxy/handlers/anthropic.py`：

1. `:2485` 每请求解析一次 `(ccr_workspace_key, ccr_workspace_label)`，track 与 analyze 共用同一身份
2. `:2487-2519` 本轮有压缩内容且 workspace 已解析 → 逐 hash 从 store 取元数据 → `track_compression(turn_number, tool_name, original/compressed count, query_context, sample_content = compressed_content[:500])`；未解析 → **记一条 info 日志并跳过**（`:2520-2525`）
3. `:2534-2546` query = **倒序找到的最后一条 user 消息**的 text block（不是全部历史，也不是工具结果）
4. `:2549-2555` `analyze_query` → `execute_expansions`（store 按 hash 全量取回）
5. `:2560-2580` `format_expansions_for_context` 包成

```
<headroom_proactive_expansion>
[Proactive Context Expansion - relevant to your query | workspace: <label>]
--- Expanded from earlier (from Bash, 100 items compressed in turn 3, high relevance to current query) ---
<原文>
[End Proactive Expansion]
</headroom_proactive_expansion>
```

   并**追加到最后一条"非冻结"的 user 轮**（`_append_context_to_latest_non_frozen_user_turn(..., frozen_message_count=...)`），把 payload 里残留的 `</headroom_proactive_expansion>` 转义防止边界伪造（`:525-531`），header 里显式声明 provenance（与 memory 注入块对称，`:537-548` 注释 + GH #462）
6. `:2568-2572` **cache 模式下直接跳过注入**："为保住下一轮的前缀稳定性" —— 主动展开与 KV cache 天然冲突，headroom 选择让 cache 赢。

### 3.3 闭环：retrieval 率就是过度压缩的度量

- `cache/compression_strategy_outcomes.py:8-45`：按 **strategy** 分别记 `compressions` / `retrievals`，`retrieval_rate = retrievals/compressions`，`best_strategy()` 取最低率，`minimum_samples_for_recommendation=3`，策略数上限 50。
- `cache/compression_feedback.py:1-26`：核心论断（引 ACON）——**压缩导致更多取回 = 压得太狠**；据此反馈 `max_items`、需保留字段等提示。
- `config.py:831-835`：waste signal `reread_compressed_tokens` = "首服被压缩掉、随后又被重读"的 token，专门归因**过度压缩**（#899），并因与 `reread_tokens` 重叠而**不计入 total()**。

这三件合起来就是"压缩类插件的自评估回路"，而且实现成本极低（两个计数器 + 一个比率）。

---

## 4. Dashboard / metrics：压缩类插件可观测性的通用件

### 4.1 三层出口

| 出口 | 内容 | 出处 |
|---|---|---|
| `/health` | status/version/uptime | `metrics.mdx:148-160` |
| `/stats` | `persistent_savings.lifetime` + requests{total,cached,rate_limited,failed} + tokens{input,output,saved,savings_percent} + cost{total_cost_usd,total_savings_usd} + cache{entries,total_hits} + `otel.status` | `metrics.mdx:10-47, 122` |
| `/stats-history` | hourly/daily/weekly/monthly rollup，`?format=csv&series=daily` 导出 | `:49-60` |
| `/metrics` | Prometheus 文本；**无 histogram buckets**，只能 `sum/count` 求均值，分位数走 `headroom perf` CLI | `:62-89` |
| OTLP/HTTP | `headroom.*` 计数器推到任意 OTLP collector | `:91-124` |

OTel 仪器命名/类型全表在 `observability/metrics.py:198-398`，与压缩直接相关的：

- `headroom.proxy.tokens.saved` = 消息压缩 + tool-schema 推迟的**总和**，分量单列 `headroom.proxy.tokens.tool_schema_saved`，管道分量 `headroom.compression.tokens.saved`（`metrics.mdx:116-120`）
- `headroom.proxy.tokens.attempted_input` / `output_saved`（尝试量与产出塑形）
- `headroom.proxy.cache.read_tokens / write_tokens / write_ttl_tokens / uncached_input_tokens / busts / bust_tokens_lost`
- `headroom.proxy.request.duration` / `overhead.duration` / `ttfb.duration`（三个 histogram）
- `headroom.compression.runs / failures / tokens.input / tokens.output / pipeline.duration / stage.duration / transforms`
- `headroom.compression.waste.tokens`、`headroom.savings.attribution.events / attributed.tokens / attributed.usd`（up-down）
- 订阅窗口 observable gauge（5h/7d 利用率、重置倒计时、overage）

标签词表（`metrics.py:441-473`）：`provider, model, cached, headroom.project, headroom.client`，外加 savings 上的 `source`（截断 64）+ `estimated: true`（`:485-491`）。

### 4.2 三条工程纪律（最值得抄到 DSH）

1. **名字集中一处**：所有 metric 名与 label key 是常量文件 `crates/headroom-proxy/src/observability/metric_names.rs`，改名只碰一个文件（`docs/observability.md:8-10`）。
2. **基数纪律 = label 词表由代码枚举，客户输入一律进 `other`**：`service_tier` 走 `validate()` 六值枚举 + `"other"` 哨兵并 warn；Python 侧 client-supplied `model` 用 `MAX_DISTINCT_MODELS` 封顶后同样进 `other` + 一次性 warning（`observability.md:230-265`，含"没有任何路径能让恶意客户端把 label 基数推到无界"的断言）。
3. **"必须恒为 0"的哨兵告警指标**：`proxy_passthrough_bytes_modified_total{path}` —— 在 dispatcher 判定 NoCompression/Passthrough 后比较前后字节长度，任何 delta 都计数（`observability.md:32-44`）。它把"我不该改内容"这条不变量**指标化**了。bridge 有同类不变量（`src/invariant.ts` 的 `assertReplacementSmaller` / `assertRetrievable`）但只抛错、不成指标。

Rust 侧目录：`proxy_cache_hit_rate_per_session{provider}` 被标为 **Phase H canary gate**、`proxy_compression_ratio_by_strategy{strategy,content_type}`（每策略自身 before/after，H1 修复前是同一聚合值重复打点）、`proxy_compression_rejected_by_token_check_total{strategy}`（跑了但没真变小 → 原样保留）（`observability.md:26-30, 115-128`）。

### 4.3 面板展示的指标维度（`headroom/dashboard/templates/dashboard.html`，2877 行，htmx+alpine+tailwind，数据全走 `stats.*`）

- **顶部 KPI**：Lifetime Compression Savings / Lifetime Tokens Saved / Cost Saved / Savings % / Efficiency / Token Usage / Throughput / Latency / TTFB Range / Request Health / Active Requests / Retention / Active Days
- **口径对照**：`Cost with Headroom` vs `Expected cost without Headroom`、`Before`/`After`、`Tokens Sent`/`Tokens Removed`/`Saved by Compression`/`Saved by Headroom`、`Attempted Input`
- **缓存面板**：`Cache Efficiency`、`Hit Rate`、`Cache Miss Attribution`（含 `Total Misses` / `TTL Expiry` / `Prefix Change` / `Unknown`）、`Cache Busts`、`Lost to Cache Busts`、`Cache Reads`/`Cache Writes`/`Read / write`、`Compression vs Cache`、`TTL 1h / 5m`、`Cumulative proxy compression savings`、`Lost to Cache Busts`
- **浪费面板**：`Waste Signals` / `Waste Detected` / `What Headroom Removed` / `Tokens Removed`，taxonomy 就是 `config.py:821-860` 的 `WasteSignals`：`json_bloat / html_noise / base64 / whitespace / dynamic_date / repetition / reread / reread_compressed`
- **时间序列**：`Savings Over Time`、`Daily Savings`、`Weekly Savings`、`Historical Savings Trend`、`Recent Historical Checkpoints`、`Average Saved / Day`、`Average Saved / Week`
- **维度排行**：`Model`、`Agent Usage`、`Savings Attribution`、`Exact tokens saved per model`、`Bucket Mix`、`Stacks`
- **实时**：`Live Activity`、`Recent Requests`、`Completed/Failed/Cached/Queued`
- **反事实与置信**：`Output Tokens Saved` 卡片把方法标注为 **measured / estimated / modelled** 三色，并区分 `95% CI` 与 `range`（注释："一个 modelled band 是两个基准模型之间的跨度、不是抽样置信区间，叫它 CI 就是在撒谎" `:289-291`），还提示 `HEADROOM_OUTPUT_HOLDOUT=0.05` 才能真测（`:296-301`）；`Holdout` 是路由 A/B 对照组列（`:979, 1006`）

**对"压缩类插件"通用可抄的 8 件**（不含 provider 专有）：

1. before/after 双值 + 百分比 + **绝对 token**（不要只给百分比）
2. lifetime / today / 7d / 30d 四窗 + 每窗独立 `tokens_before` 分母（`savings_ledger.py:228-245`）
3. 每维度排行（model / client / project / strategy）+ 排行键 = (钱, token) 双键
4. **retrieval 率 / reread 信号**（= 压缩质量的负向指标，§3.3）
5. **cache 冲突面板**：bust 数 + bust 损失 token + miss 归因四分（`prefix_tracker.py:96-120, 1027-1110`）
6. 时延三件套：total / **插件自身 overhead** / TTFB —— overhead 是"压缩插件值不值"的判决指标
7. 拒绝计数：跑了但没过 shrink check 的次数（`observability.md:30`）—— 就是 bridge 的 `minSavingsRatio` 拒绝率
8. **测量方法标注** measured/estimated/modelled + CI-vs-band 的诚实标注

---

## 5. Relevance 打分（hybrid BM25 + embedding + dynamic α）

### 5.1 组成

`headroom/relevance/`，统一协议 `RelevanceScorer.score(item, context) -> RelevanceScore{score, reason, matched_terms}`（`base.py`），默认 hybrid（`__init__.py:20-30`，理由："漏掉关键条目是灾难性的；BM25 单词命中只有 0.07；语义能连 'errors'→'failed'；5-10ms 延迟可接受"）。

- **BM25Scorer**（零依赖，`bm25.py:1-16`）：token pattern 特化为 **UUID | ≥4 位数字 ID | 字母数字**（`:52-56`），标准 k1=1.5/b 公式（`:31-41, 160-170`），`normalize_score` 用 `/max_score` 再 clamp，**任何命中再 +0.3 保底**、≥2 命中再 +0.2（`:190-199`，`score_batch` 同构 `:236-268`）——这个"命中即保底"是它能与 embedding 融合的前提。
- **EmbeddingScorer**：默认模型 `BAAI/bge-small-en-v1.5`（`embedding.py:61`），默认模型有**钉死的 HF revision**（`:72-79`），cosine 夹到 [0,1]（`:84-103`），`is_available()` 用 `find_spec` 不 import（`:144`，避免启动代价）。
- **HybridScorer**（`hybrid.py`）：`combined = α·BM25 + (1−α)·emb`（`:191`）；`_compute_alpha` 自适应：query 含 UUID → α=max(α,0.85)；≥2 个数字 ID → 0.75；1 个 → 0.65；含 hostname/email → 0.6；clamp [0.3,0.9]（`:115-151`）。embedding 不可用时降级为"BM25 加保底"分支（`:166-182`）。引用 Hsu et al. 2025 dynamic-alpha +2~7.5%（`:11`）。

### 5.2 工程模式（比算法更值得抄）

- **永不阻塞热路径**：`content_router.py:4021-4046` —— hybrid 配置下**先返回 BM25**，`_start_relevance_prewarm` 起一个 daemon 线程下载/加载并 `score_batch(["warmup"],"warmup")`，成功后 `self._relevance_scorer = scorer`（GIL 原子引用替换）；失败就永远停在 BM25。注释明说"请求绝不能为 ~30MB 下载而阻塞"。
- **自适应阈值用 Otsu，不用常量**：`transforms/relevance_split.py:119-131` —— 对本次输出自身的分数分布找"自然断点"（Otsu 类间方差最大化，`:100-116`），**floor 才是配置的 threshold**（全不相关就整块丢弃；分数全相等无断点则 floor 决定）→ KEEP 比例随内容 0~100% 浮动，不是固定配额（`:134-174`）。
- **延迟护栏**：分段数 > `max_records` 直接不做 split（`:162`）。
- **失败即降级**：split 任何异常 → `return None` 回退普通压缩（`:4102-4104`）。
- 另有 `transforms/adaptive_sizer.py`（`compute_optimal_k`：n/unique/diversity/knee/bias 决定"保留几条"），是"保几条"这一维的同类自适应件。

### 5.3 DSH 场景可复用性与形态建议

| DSH 场景 | 复用件 | 形态建议 |
|---|---|---|
| `headroom_retrieve` 之后模型仍要"在哪"——CCR 主动展开的相关性判定 | `_calculate_relevance` 那套加权启发式（零依赖） | **移植 TS**（~80 行），不需要 embedding |
| 工具结果检索 / 历史回放检索（"给我上次那个 grep 结果"） | BM25（含 UUID/数字 ID 特化 tokenizer + 命中保底） | **移植 TS**，纯本地、~120 行、无模型 |
| 语义记忆 / 长期记忆召回 | hybrid + embedding | **外部服务**：DSH 无 embedding provider（`@deepseek-ai/*` 无 embedding 通道），本地 fastembed/sentence-transformers 太重（≈30MB+ 模型，与"不打包 headroom"的定位冲突）→ 让 headroom 代理端承担（bridge 已只依赖 HTTP 契约） |
| 任何"KEEP/DROP 二选一"的截断策略（超长结果预览、diff 摘要） | **Otsu 自适应阈值**（`relevance_split.py:100-131`） | **移植 TS，~30 行，纯函数**，性价比最高 |
| 重型模型/慢依赖的首次加载 | prewarm + 原子换引用（`content_router.py:4048-4070`） | 抄成 DSH 插件通用范式（TS：`let scorer = cheap; void heavy().then(s => scorer = s)`） |

结论：**算法移植（BM25 + Otsu + dynamic-α 判据）优于外部服务调用**；只有需要真语义时才走代理 HTTP，保持 bridge 零重依赖。

---

## 6. 对 DSH / dsh-headroom-bridge 的启示清单

成本口径：**低** = ≤半天、单文件级；**中** = 1-3 天、跨 2-4 文件、需设计；**高** = 需要新子系统或上游改动。

| # | 设计点（headroom 出处） | 价值 | 成本 | 落点 / 做法 |
|---|---|---|---|---|
| 1 | **append-only JSONL + flock 事件账本**（`savings_ledger.py:119-185, 188-225`）取代 4 个内存计数器 | **高**：重启/热重载不丢、多会话并发安全、事后可加维度 | **低** | bridge 新增 `src/ledger.ts`：事件 `{v,ts,before,after,saved,cost_usd,model,tool,mode,arm,source}`，写 `<DSH_HOME>/storages/dsh-headroom-bridge-events.jsonl`；读时聚合 today/7d/30d + 排行 |
| 2 | **成本在写入时结算 + 版本字段**（`:11-15, 127-128`） | 中：历史数字不随价格表变动漂移 | 低 | 事件带 `cost_usd` + `v`；价格表快照另存 `pricingVersion` |
| 3 | **unknown 模型走 blended 兜底、免费模型记 0**（`:105-116`；`savings_tracker.py:256-266`） | 中-高：避免 $0 与幻影省钱两个方向的错账 | 低 | DSH 场景模型名总知得到（`exec.agent.options.model`，`arm-a.ts:203`），兜底只用于路由失败时 |
| 4 | **四桶分层计价 + provider-cache 折扣不算自己功劳**（`savings_tracker.py:332-359`；`dashboard.html:265-267`） | **高**：可信度/可审计，防"把折扣算成功劳" | 中 | bridge stats 拆 `compression / (未来的)tool_schema / provider_cache`；DSH 主线建 `dsh-pricing` 包（DSH 目前**零**价格概念） |
| 5 | **内容感知 token 估算**（JSON 3.2 / 代码 3.5 / **CJK 1.5** / URL & UUID 开销，`tokenizers/estimator.py:43-52, 129-134, 179-203`）vs DSH `dsh-token-meter` 的 chars/4（`lib/index.js:16, 63`） | **高**：中文工具结果当前低估 ~2.7×，直接污染压缩收益与上下文压力判定 | 低 | 短期：bridge 侧自带估算器用于记账；正解：给主线 `dsh-token-meter` 提 PR 加分类比率 |
| 6 | 用 **provider-reported usage** 作为分母（DSH 已有：`dsh-token-meter` usage-projection 的 `uncachedInput/output/cacheRead/cacheWrite`，`lib/index.js:338-466`） | 高：与账单同源的权威数字 | 中 | 账本事件同时记 `estimatedTokens`（本地）与 `reportedUsage`（provider），两者差值本身成指标 |
| 7 | **维度桶封顶 + 淘汰 + unknown sentinel**（`savings_tracker.py:1066-1074, 140-166`）、**30 天保留 + >1MB 自动压缩**（`savings_ledger.py:51-62, 356-394`） | 中：长期运行有界 | 低 | 账本聚合层加 `maxProjects` 与 cutoff；TTL 与 CCR 台账 24h 语义对齐 |
| 8 | **测量诚实性标签** measured/estimated/modelled + `band_is_ci`（`dashboard.html:280-291`） | 高：`audit` 模式天然产出 estimated，live 产出 measured；混淆会误导决策 | 低 | stats 面板 + `headroom_stats` 输出加 `method` 字段 |
| 9 | **指标词表集中一处 + label 基数纪律（枚举 + other 哨兵 + 封顶 + 一次性 warn）**（`observability.md:8-10, 230-265`） | 中-高：bridge 面板/统计走 HTTP 聚合时同样有爆炸风险（tool 名、model 名都可被客户端影响） | 低 | 新建 `src/metric-names.ts` 常量表；tool/model 维度做白名单 + `other` |
| 10 | **"必须恒 0" 哨兵指标**（`proxy_passthrough_bytes_modified_total`，`observability.md:32-44`） | 高：把 fail-open 不变量变成可告警数字 | 低 | bridge 在 `mode!=live`/未采纳路径上累计"被改动的字节数"，恒 0 才是正确；已有 `invariant.ts` 断言的指标化版本 |
| 11 | **retrieval-rate 反馈闭环**（`compression_strategy_outcomes.py:8-45`、`compression_feedback.py:1-26`、waste signal `reread_compressed`，`config.py:831-835`） | **高**：这是"压缩插件自评估"的最小闭环；bridge 台账已有 `strategy` 字段（现场见 `router:config:0.73`） | 低 | `headroom_retrieve` 命中时按 `hash→strategy` 记 retrieval；面板出"策略取回率排行榜"（≥3 样本才排名） |
| 12 | **压缩质量分布**：per-strategy × content_type 的 ratio histogram + `rejected_by_token_check_total`（`observability.md:28-30`） | 中：直接暴露"哪类内容白压"，用于收紧 `minSavingsRatio`/`excludeTools` | 低 | 账本事件已有 `strategy`、`before/after`、拒绝原因 → 聚合即可 |
| 13 | **`stable_prefix_hash` 心跳 + volatile 结构检测**（`cache_aligner.py:105-203, 341-371`）：对 DSH 的 system prompt / tool schema 序列化每步算 canonical hash 并比较 | 高：DSH 每步工具集/提示词一变，provider KV cache 就全废，而 DSH 目前完全无此观测 | 中 | 独立小插件（dsh-cache-aligner）或 bridge 新 hook：输入 = system prompt + tools 序列化（`sort_keys` 等价物），输出 = hash + 漂移计数 + `uuid/iso8601/jwt/hex_hash` 命中计数（TS ~80 行，无 regex） |
| 14 | **cache-miss 归因四分法（TTL 优先于 prefix_change）**（`prefix_tracker.py:96-120, 1027-1110`） | 高：把"为什么没命中"变成可行动结论（该延长 TTL 还是该修拼装） | 中 | DSH 已有 `cacheReadTokens`（token-meter）+ 需要 idle 间隔观测（session 事件时间戳可算）→ 新指标 `cacheMissAttribution{reason}` |
| 15 | **经济学门：`savings_fraction > provider_read_discount` 才允许动已缓存前缀**（`prefix_tracker.py:1135-1157`）+ 表 `_PROVIDER_READ_DISCOUNT/WRITE_PENALTY/TTL`（`:32-60`） | 高：**直接适用于 bridge arm B** —— 它替换旧 tool 结果就是改写已发送历史，等价于 bust prompt cache（Anthropic 90% 读折扣换 25% 写罚） | 中 | arm B 增加 cache 感知：本轮 `cacheReadTokens>0` 且距上次请求 < TTL 时，不替换（或仅替换 ≥某比例且位于尾部 delta 之外）；文档化"armB 与 provider cache 的冲突" |
| 16 | **cache-mode 只压最新 delta + 前缀字节保真转发**（`cache-optimization.mdx:8-10`、`agent_savings.py:171 proxy_mode="cache"`）；主动展开在 cache 模式**直接关闭**（`anthropic.py:2568-2572`） | 高：这是压缩插件与 KV cache 共存的正解：delta-only，不动前缀 | 中 | bridge 的定位应逐步从"arm B 回收旧结果"转向"只处理最新一步"（arm A 已是 delta 语义），把 arm B 降级为"确认缓存冷后才动手" |
| 17 | **冷前缀 TTL 学习的非对称代价论证 + 区间估计**（`ttl_estimator.py:1-27`：命中过的 idle 下界 TTL 的生命、`ttl_expiry` miss 的 idle 上界其死亡；**取上界**，因为低估会 bust 热缓存花钱、高估只是少省；且只在 `provider/model` 粒度估计、绝不 pool） | 中-高（方法论级：任何"学习一个阈值"都应先写这种非对称代价论证） | 高 | DSH 若要自动决定 arm B/冷重压缩时机，按此法：先落 `observations.jsonl`，离线出表，进程内只读（零热路径风险） |
| 18 | **CCR 主动展开的本地版**（`context_tracker.py:220-304`：阈值 0.3、年龄衰减 ×(1−age/300·0.5)、每轮 ≤2、**workspace fail-closed**、compact-summary 排除 `:34-63`） | 中-高：直接治"压缩后失忆→模型重复调用工具"这个 bridge 最大风险 | 中 | bridge 新 `src/context-tracker.ts`：workspace_key = 项目根/`DSH_WORKSPACE`（**必须**非空否则不展开）；sample = 压缩后前 500 字；注入块抄 provenance header + 闭合标签转义（`:495-531`）；DSH 的 compaction summary 不参与追踪 |
| 19 | **注入块 provenance header + 边界伪造防护**（`:509-531`） | 中：DSH 生态里任何"注入额外上下文"的插件（记忆/摘要/loop 反馈）都该有对称设计 | 低 | 写成注入规范：`[<来源> | workspace: X] … [End …]` + payload 内闭合标签转义 |
| 20 | **`protect_reads` 类型门**：coding profile "永不 lossy 压缩文件读取"（`agent_savings.py:173-184`，注释"agent 要打精确字节"）+ cache 模式下 `protect_recent=0`（位置门在 delta 语义下反而挡住唯一可压的东西） | **高**：这正是 bridge 现在缺的那道门（见 §7 现场事故） | 低 | bridge：`read`/`view`/`str_replace_editor` 类**结果一律不压**（配置默认已有 excludeTools，但见 §7 失效）；再加内容级二级保护（内容含 `diff --git` / 多行代码块 → 不压） |
| 21 | **BM25 + Otsu + dynamic-α 移植**（`bm25.py:52-56, 160-199`；`relevance_split.py:100-131`；`hybrid.py:115-151`）；embedding 留代理侧 | 高（Otsu 最高）：把"固定阈值/固定配额"式截断换成数据驱动断点 | 低（BM25 ~120 行、Otsu ~30 行、α 判据 ~20 行，纯 TS） | 先落在 bridge 的 CCR 相关性判定；后续 DSH 语义记忆检索复用同一 TS 模块 |
| 22 | **prewarm + 原子换引用**（`content_router.py:4021-4070`） | 中-高：任何慢依赖（embedding、tokenizer、模型）都不该阻塞首请求 | 低 | 写成插件范式：cheap scorer 先上，后台 warm 完再换引用 |
| 23 | **litellm 导入的 dotenv 副作用回滚**（`litellm_pricing.py:20-40`）+ **模型解析有界 LRU**（`savings_tracker.py:169-183`） | 中：DSH 若引入任何第三方 provider SDK/定价库都会踩同类坑 | 低 | 记入插件规范：引入外部库前先检查 import 副作用 |
| 24 | **价格陈旧度**（`pricing/registry.py:40, 70-92`：30 天 + 带官方页 URL 的 warning） | 中：价格表若自维护，必须自带过期告警 | 低 | DSH `dsh-pricing` 包内置 `lastVerified` + `staleWarning` |
| 25 | **`/stats-history?format=csv` + 窗口 rollup**（`metrics.mdx:49-60`） | 中：面板之外留一条导出通道，便于用户自查（DSH 设置卡片只有实时值） | 低 | bridge 加 `GET /headroom-bridge/api/history?series=daily&format=csv` |
| 26 | **rollup 实现选型**：累计 checkpoint 差分（`savings_tracker.py:1663-1742`）vs 事件流窗口聚合（`savings_ledger.py:288-353`） | 中 | 低 | **选事件流聚合**：DSH 无历史包袱，差分实现更脆（丢一条即整体偏） |

### 6.1 建议落地顺序（性价比排序）

1. `#1 + #2 + #3 + #7`（账本一次做完）→ `#8 + #12`（面板口径）→ 立刻得到"压缩插件有没有用"的可信答案
2. `#20`（protect_reads 类型门）+ `#15`（arm B 的 cache 门）——**这两条是止损项**，见 §7
3. `#11`（retrieval-rate 闭环）+ `#21`（Otsu/BM25 移植）
4. `#13 + #14`（prefix hash 心跳与 miss 归因，可独立成新插件）
5. `#4 + #5`（DSH 主线定价 + token 估算，跨团队，收益最大周期最长）
6. `#16 / #17 / #18`（架构级：delta-only 化 + 主动展开）

---

## 7. 附带发现：本次调研现场复现的 live 缺陷（高优先级，建议立即修）

调研过程中，本会话的工具结果被本插件（**live 模式**）有损重写，其中两次破坏了研究保真度：

**证据（现场）**

- 运行态：`GET /headroom-bridge/api/stats` → `{"mode":"live","counters":{"attempts":191,"failures":8,"adopted":45,"savedChars":119582},"ledger":{"entries":91,...}}`；用户层配置 `~/.dsh/settings.yaml:94-97`（`headroom.mode: live`，覆盖入口配置的 `audit`，`cordis.patch.yml`）
- 台账最近 50 条按工具分布：**46 条 `bash` + 4 条 `read`**
- 其中 `read` 条目 hash `ebbc5d05974e2c224b8015dc`（2026-09-15T18:02:12，`charsBefore 21043`）正是本会话 `read` 某 Python 源文件的结果，返回文本已被 headroom 代理**有损**改写（丢词、行号塌缩成一行），并带 `[headroom-bridge: 21043->13664 chars offloaded. Retrieve … hash=…]` 标记；同类事件另有一次（`cat` 一个 YAML 配置，1821→1333）
- 影响放大：子代理会话的可用工具集里**没有 `headroom_retrieve`**，标记里的 hash 对执行者不可赎回 → 等价于不可恢复的内容损坏

**两个可定位的嫌疑点（都在 protect/arm-a 边界）**

1. **路径门对"路径被包在更大字符串里"失效**：`argsHitProtectedPaths` 只把整个字符串当一个路径取 basename（`src/protect.ts:24-40, 49-63`）。`bash` 的 `command` 值是一整条命令行（`cat ~/.dsh/settings.yaml | sed …`），`basename()` 取到的是最后一个 `/` 之后的尾巴（不是 `settings.yaml`）→ `*.yaml` 永不命中；`read` 经 `tool_call` 包装时嵌套 `arguments` 是 JSON 字符串（`arm-a.ts:76-83`）同理失效。修法：对长字符串按 token 切分后逐 token 试匹配（或 `PATH_ARG_KEYS` 命中时先 `JSON.parse` 再走 `collectPathValues`）。
2. **exclude/protect 正则在 fiber 构造期编译一次**（`arm-a.ts:38-47`：`ArmAState` 构造时 `compileGlobs(this.getConfig().excludeTools)`）。设置卡片保存新配置后正则不会重编译；若某次解析到的 `excludeTools` 非默认值（`stringArray` 用 `value ?? fallback`，传 `[]` 即合法地把排除表清空，`config.ts:158-167`），此后**永久**生效。而台账里确有 `toolName:"read"` 条目 → 说明 `matchesAny('read', excludeToolRe)` 在那些时刻为 false。修法：按配置版本号惰性重编译；并让 `excludeTools: []` 显式拒绝或显式警告（默认值应不可被清空，对齐 headroom 的 `protect_reads`，`agent_savings.py:181`）。

**顺带的产品性建议**：arm A 需要"内容形态"二级门（内容像 unified diff / 连续代码块 / 配置文件 → 不压），因为工具名与路径都只是代理信号；headroom 的答案也是双信号（`protect_reads` 类型门 + `protect_analysis_context`，`agent_savings.py:166, 181`）。

---

## 附录 A：本次深读引用到的文件清单

| 主题 | 文件（headroom） |
|---|---|
| 记账 | `headroom/savings_ledger.py`（全 406 行）、`headroom/proxy/savings_tracker.py:140-359, 680-799, 1034-1163, 1663-1742`、`headroom/ccr/mcp_server.py:755-814`、`headroom/cli/savings.py:70`、`docs/content/docs/savings.mdx` |
| 定价 | `headroom/pricing/registry.py`（全 188 行）、`headroom/pricing/litellm_pricing.py:1-60, 88-124`、`headroom/pricing/{anthropic,openai,deepseek}_prices.py`、`cache_ttl.py` |
| Token 计数 | `headroom/tokenizers/estimator.py:43-52, 100-219`、`tokenizers/{tiktoken_counter,huggingface,registry}.py` |
| 策略画像 | `headroom/agent_savings.py:1-55, 145-194`（注意：**不是记账模块**，是压缩策略画像 `coding`/`balanced`/`general`/`agent-90`） |
| 缓存 | `headroom/transforms/cache_aligner.py`（全 413 行）、`headroom/cache/prefix_tracker.py:1-140, 1021-1180`、`headroom/cache/dynamic_detector.py:1-175`、`headroom/cache/{anthropic,openai,google}.py`（hash 消费点）、`headroom/cache/ttl_estimator.py:1-45`、`docs/content/docs/cache-optimization.mdx` |
| CCR | `headroom/ccr/context_tracker.py`（全 636 行）、`headroom/proxy/handlers/anthropic.py:2470-2600`、`headroom/cache/compression_feedback.py:1-55`、`headroom/cache/compression_strategy_outcomes.py:1-45` |
| 可观测性 | `headroom/observability/metrics.py:188-398, 441-510`、`headroom/proxy/prometheus_metrics.py`（waste/attribution 导出）、`headroom/dashboard/templates/dashboard.html`（面板维度）、`docs/observability.md`、`docs/content/docs/metrics.mdx` |
| Relevance | `headroom/relevance/{__init__,base,bm25,embedding,hybrid}.py`、`headroom/transforms/relevance_split.py:100-174`、`headroom/transforms/content_router.py:4021-4115`、`headroom/transforms/adaptive_sizer.py` |
| DSH 侧现状 | `dsh-headroom-bridge/src/{stats,store,protect,arm-a,arm-b,config,api,util}.ts`、`node_modules/@deepseek-ai/dsh-token-meter/lib/index.js:16-90, 338-466`、`node_modules/@deepseek-ai/dsh-compaction/lib/invariant.js:115-151`、运行态 `/headroom-bridge/api/*` |
