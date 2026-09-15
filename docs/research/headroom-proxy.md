# Headroom Proxy 子系统深度调研报告（面向 DSH 接入评估）

- 调研对象：`/media/ict/19BD52556106DE5A/headroom/`（git 主分支，含 v0.36.5 / v0.37.0 两个 tag）
- Python 侧：`headroom/proxy/`（含 `handlers/`、`session_engine.py` 等）+ `headroom/cache/`、`headroom/ccr/`、`headroom/transforms/`
- Rust 侧：`crates/headroom-proxy/`（约 4,000 行的前置反向代理，非压缩主体）
- 文档：`docs/content/docs/` 下 proxy / agent-orchestration / local-llm-prefill / runtime-rollouts / codex-recovery 五篇
- 参照客户端：`dsh-headroom-bridge/src/proxy-client.ts`（只用 `POST /v1/compress mode:'ccr'`、`POST /v1/retrieve`、`GET /health`，停在 0.36.5-code 镜像）
- 所有 file:line 均以本仓库当前 checkout（v0.37.0 之后的 main，v0.37.0 契约相关代码与 tag 一致）为准；跨版本对比处另有 `git show v0.36.5:...` 标注。

---

## 1. 0.37.0 的 `/v1/compress` 契约变化 —— 对三个旧端点是否破坏？

**结论：全部是纯增量（additive）变化。bridge 使用的三个端点在 0.37.0 上行为逐字节不变，可安全升级。**

### 1.1 版本区间的官方条目（CHANGELOG.md）

- `CHANGELOG.md:287-312`：0.37.0（2026-08-27）发布段。与 `/v1/compress` 直接相关的三个 Feature：
  - `#3270` session-aware `/v1/compress`（sidecar mode）+ `/v1/usage` relay（`CHANGELOG.md:292`，commit `4fa8802`）
  - `#3261` compression-cache registry 自限内存（`CHANGELOG.md:293`，commit `826b600`）
  - `#3271` proxy 与 sidecar 统一到一个 session engine（`CHANGELOG.md:294`，commit `d12ea50`）
- 相关 Bugfix：`#3286` 子代理输出乱码（`CHANGELOG.md:308`，见第 2 节）、`#3238` Responses 路径文件读取保护（`CHANGELOG.md:307`）、`#3305` WebSocket 握手强制 `HEADROOM_PROXY_TOKEN`（`CHANGELOG.md:305`）、`#3231` output-savings 原子落盘（`CHANGELOG.md:306`）。
- 0.36.5（`CHANGELOG.md:314-320`）到 0.37.0 之间没有任何针对 `/v1/compress`/`/v1/retrieve`/`/health` 的破坏性条目。

### 1.2 新增的请求字段（全部可选，不传 = 旧行为）

实现：`headroom/proxy/handlers/openai.py` `handle_compress`（`openai.py:9594` 起，docstring `9595-9620`）。

| 新字段 | 证据 | 不传时的行为 |
|---|---|---|
| `config.session_id`（string ≤256，非空） | `openai.py:9778`（读取）、`9790-9804`（校验，非法值 400） | 走 `_run_stateless`（`openai.py:9905-9913`），与 0.36.5 完全同路径 |
| header `x-headroom-session-id` 被 compress 端点识别 | 仅当 `HEADROOM_COMPRESS_SESSION_FROM_HEADER=1` 时生效（`openai.py:9783-9789`）——默认关闭，防止网关给全部流量盖了该 header 时在升级瞬间把无状态调用者"翻转"进 session 模式（注释 `9779-9784` 明确举例 Claude Code 子代理共享 header 值会把不相干会话混成一份 replay 状态） | 默认不读 header |
| `config.session_id` + `config.compress_user_messages` 组合 | 直接 400 拒绝（`openai.py:9805-9822`）：user 消息改写无法内容寻址回放，会在 TTL 窗口内必炸前缀缓存 | 不受影响 |

### 1.3 新增的响应字段与端点

- 响应仅在 session 模式下多一个可选顶层字段 `session: {id, frozen_message_count, cached_prefix_replayed}`（`openai.py:9999-10003`、`10071-10073`）；无状态响应 payload（`_payload`，`openai.py:10059-10071`）字段与 0.36.5 相同（`messages/tokens_*/compression_ratio/transforms_applied/transforms_summary/ccr_hashes`）。
- 新端点 `POST /v1/usage`（`server.py:5432-5435`；实现 `handle_compress_usage`，`openai.py:10182`，请求体 `{"session_id": ..., "usage": ...}`，`openai.py:10186`）：sidecar 调用方把 provider 返回的 usage 块转发回来，让冻结决策变为"provider 已确认"（commit `4fa8802` 消息："Optional — skipping it degrades freeze decisions"）。与 `/v1/compress` 共用同一暴露策略依赖 `_compress_dependencies`（`server.py:5419-5423`）。
- session 模式超时语义刻意不同：**返回 503 而不是 fail-open**（`openai.py:10076-10096`）——超时的 worker 无法取消、仍可能把结果记成"上次返回"，若此时把原文交给调用方会造成下一轮 replay 状态失同步；503 让网关重试并落在一致的旧状态上。无状态超时仍是 200+`compression_skipped`（`docs/content/docs/proxy.mdx:526`）。

### 1.4 逐项核对 bridge 的三个端点（v0.36.5 ↔ v0.37.0）

- **`POST /v1/compress` mode:'ccr'**：`COMPRESS_MODES = ("ccr","lossy_inline","lossless_then_lossy")` 与 `_ccr_pipeline()` 派生管线在 0.36.5 已存在（`git show v0.36.5:...openai.py` 的 `1594`、`9616-9627`，与 0.37.0 的 `9824-9852` 逐行相同）。0.37.0 只是把原流程包进 `_run_stateless` 闭包并加 session 分支。bridge 发的 `{messages:[{role:'tool',...}], model, config:{mode:'ccr'}}`（`dsh-headroom-bridge/src/proxy-client.ts:62-68`）行为不变。
- **`POST /v1/retrieve`**：路由 `server.py:4922-4923`（`_require_loopback` + `_require_same_origin`），`git diff v0.36.5..v0.37.0` 对该路由无任何 hunk（仅行号平移）。GET 版 `/v1/retrieve/{hash_key}`（`server.py:5270`）同样不变。
- **`GET /health`**：`server.py:3673-3686`，两 tag 间无 diff；仍在 `_AUTH_EXEMPT_PATHS`（`server.py:3562`）中免 token。
- 唯一"客户端可感知但非破坏"的行为变化来自 `#3286`：短文本（<64 词）不再被 lossy 逐词丢弃（见第 2 节），即 **短工具结果的压缩率略降、乱码归零**——对 bridge 是纯收益。

### 1.5 附带发现：文档滞后

`config.session_id` sidecar 模式**尚未写入** `docs/content/docs/proxy.mdx`（全文 grep 无 `config.session_id`/`/v1/usage`，仅 `438`、`310` 行有旧有的 loopback/`HEADROOM_COMPRESS_ALLOW_REMOTE` 说明）。契约的权威来源目前只有 `handle_compress` docstring 与 commit message——bridge 侧接入 session 模式时要以此为准，不要等文档。

---

## 2. #3286「子代理输出乱码」修复：问题本质与对 bridge 的影响

**一句话：这不是"压缩太狠"，而是分类器把不可解析的伪 JSON 喂给了错误的 lossy 压缩器，再叠加 `ensure_ascii=True` 的编码边界，产出对模型不可读的产物。bridge 正是最容易命中该链路的客户端形态。**

### 2.1 根因链（commit `8884d87` 消息 + 代码，`CHANGELOG.md:308`）

1. Claude Code harness 在子代理输出前拼一个括号包裹的 banner（`[harness: ...]`，恰好 33 个空格分隔词），并把 `<` 中和为 `<\`——这破坏了 JSON 语义但保留了"看起来像 JSON"的括号平衡。
2. Headroom 的 mixed-content 分块器只看括号平衡、不做解析验证，就把 banner 判成 `JSON_ARRAY` → SmartCrusher（表格 JSON 压缩器）解析失败 → fallback 链把它喂给 lossy 的 Kompress → Kompress 逐词丢弃把 banner 33→25 词，并把原文塞进 CCR store。模型调 `headroom_retrieve` 取回的只是 banner，于是判定"输出乱码不可用"。
3. 同时，表格类段落被渲染成引号包裹的 JSON 字符串 blob（`\n` 变两字符转义），且 `ensure_ascii=True` 的边界把输出里的 unicode（`→ └ ✓`）变成 `\uXXXX` soup。

### 2.2 五项修复及代码落点

| 修复 | 位置 |
|---|---|
| `split_into_sections` 判 `JSON_ARRAY` 前先做真 JSON 验证（与 mixed-content gate 同一验证器），并新增 `isolate=` 参数、连续 prose 片段重组（不再把 `\n\n` 双写） | `headroom/transforms/mixed_content.py:92`（签名）、`101`、`165`（"JSON typing is validated"注释） |
| Kompress 真实下限 `min_input_words = 64`（可配，钳制历史值 10；in-process/batch/apply/remote 全路径生效）。低于它 lossy 净亏——仅 retrieval marker 本身就约 20 词，短块又偏偏像指令 | `headroom/transforms/kompress_compressor.py:1271`（默认值）、`1530`/`1936`/`2243`（floor 应用点） |
| mixed 路径解开 SmartCrusher 整数组 CSV 渲染的引号 blob，直接拼回可读行 | commit stat 中 `content_router.py`（+26 行）、`smart_crusher.py`（+13 行） |
| 模型可见边界一律 `ensure_ascii=False`（与 Rust serde_json 行为对齐） | `headroom/ccr/mcp_server.py:714`、`738`、`779`、`841` |
| marker 诚实化：Kompress 标记写 `N words compressed to M`（共享 `ccr_retrieval_marker` helper），`store_kompress_in_ccr` 不再把词数写进 store 的 *item count* 字段（token 数已表达体量） | commit stat `kompress_compressor.py` |

回归锚：`tests/test_garbled_compression_fixes.py`（12 个测试，含端到端 fixture 断言 banner 逐字节存活、无 `\uXXXX`）。

### 2.3 对"把工具结果发过去压缩"型客户端（bridge）的影响

- **上游触发器不在 Headroom 手里**（harness 的 `<`→`<\` 中和），但 0.37.0 起 banner 逐字节透传、lossy 不碰短文本——bridge 转发 DSH 工具结果（常含 harness 前缀、表格、unicode 树形缩进）时同类乱码被上游根治。**升级到 0.37.0 镜像本身就是乱码修复**，bridge 代码零改动。
- 短工具结果（<64 词）现在只走 lossless（SmartCrusher 折叠失败即原样返回），`tokens_saved` 会更少但 marker 不再撒谎（词数字段语义修正）。bridge 的 `CompressResponse` 解析（`proxy-client.ts:12-18`）不受影响。
- 教训对 bridge 自己的 marker 包装同样适用：**任何"压缩产物 + 检索指针"的形态，先验证内容类型再选压缩策略；短内容宁可不压**。DSH bridge 目前对单条 `role:'tool'` 消息整体送压，正是 2.1 那条链路的理想靶子。

---

## 3. 会话感知：sidecar session 模式与相关状态体系

Headroom 的会话感知分三层：**会话身份**（session id 怎么来）、**缓存管理**（freeze/swap/replay）、**内容溯源**（workspace key / CCR context tracker）。

### 3.1 会话身份：`compute_session_id`

`headroom/cache/prefix_tracker.py:1499-1544`（`SessionTrackerStore.compute_session_id`）：

1. 优先 `x-headroom-session-id` 显式 header（`prefix_tracker.py:1530-1532`）；
2. 否则 `md5(model + 前导 role:"system" 消息序列)` 前 16 位（`1534-1544`）。**只用前导 system 游程**：agentic 客户端（Claude Code）会把 system 提醒轮插进历史中段，全量哈希会导致会话 id 中途轮换、前缀 tracker 被孤儿化（docstring `1516-1524`，对应 issue #2085）。Anthropic 的顶层 `system` 字段由 handler 合成为前置 system 消息再进来（`1513-1515`），否则同模型全部会话坍缩成一个 id。

**sidecar（`/v1/compress`）的 session id 由调用方直接给**：`config.session_id`（`openai.py:9778`），服务端把它加命名空间 `compress\x00{session_id}`（NUL 分隔，`openai.py:9896`、`10260`）——NUL 不能出现在 HTTP header 值里，所以 proxy 路径上任何调用方伪造 `x-headroom-session-id` 都不可能污染 sidecar 会话的 tracker/replay 缓存（注释明说纯字符串前缀 `"compress:"` 是可伪造的）。

### 3.2 会话引擎：一次 turn 的"三步舞"

`headroom/proxy/session_engine.py`（0.37.0 新增，#3271 的产物）：

1. **prepare_turn**（`session_engine.py:107-145`）：决定冻结前缀数 → `mark_stable_from_messages` → `apply_cached` 把上一轮已算好的压缩字节按内容哈希换入（"Zone 1"字节交换，`headroom/cache/compression_cache.py:332-353`）。
2. 跑压缩管线（调用方拥有）。
3. **finalize_turn**（`session_engine.py:148-200`）：用上一轮实际发出/返回的字节覆盖本轮管线的漂移（`overlay_cached_prefix` 自带位置对齐、append-only、non-inflation 三重自guard，`session_engine.py:159-169`）。

两种**刻意的**冻结策略差异（`session_engine.py:28-52`）：

- `FREEZE_POLICY_CONFIRMED_CLAMP = min(tracker_frozen, cache_count)`：proxy 路径用——它看得见 provider 响应里的 `cache_read_input_tokens`，冻结不超过"provider 已确认缓存"，也不超过"本地能逐字节回放"（冻结一条缓存条目已被逐出的消息会把**原文**转发上去）。
- `FREEZE_POLICY_REPLAYABLE = max(cache_count, explicit_frozen)`：sidecar 路径用——**endpoint 上次返回的字节本身就是 provider 的缓存契约**，重压已返回消息（即使压得更小）也是 bust；测试确实抓到过"重压变小 → overlay 的 non-inflation guard 无法修复"的漂移（commit `4fa8802`）。过冻只损失尾部压缩机会，永不 bust。

`record_returned`（`prefix_tracker.py:1001-1020`）是 proxy 模式 `update_from_response` 的 sidecar 等价物：在返回时刻记录"原始 ↔ 返回"两份快照；冻结计数**不动**，等 `/v1/usage` 上报后才推进。

底层支撑：`CompressionCache.compute_frozen_count`（`compression_cache.py:293-330`，tool_result 内容哈希命中才算稳定，且**永远预留最后一条消息做 live zone**——否则 prose 形客户端全量冻结、压缩率恒零，2026-05-07 Cline+DeepSeek 实例）；`session_turn_lock` 串行化同会话并发 turn（`compression_cache.py:131`；acquire 带超时，超时映射 503 重试路径，`openai.py:9930-9947`）。

### 3.3 注册表自限内存（#3261）

`server.py:1607-1668`：per-session `CompressionCache` 的 registry 改为 OrderedDict LRU + idle-TTL 清扫（`COMPRESSION_CACHE_TTL_SECONDS` 默认 3900s ≈ 1 小时，`headroom/proxy/helpers.py:1291-1293`；`COMPRESSION_CACHE_MAX_ENTRIES` 默认 10000，`helpers.py:1303-1307`）。清扫**挂在 `_get_compression_cache` 的懒路径上、60s 节流**（`server.py:1607-1653`），无后台 timer——"全空闲进程没有值得定时的内存压力"（commit `826b600`）。清扫跳过 `session_turn_lock.locked()` 的在飞会话。`/v1/usage` 用 `_peek_compression_cache`（`server.py:1655-1663`）——未知会话返回 None，绝不为查询分配空缓存。

### 3.4 客户端要配合什么（sidecar 模式契约）

来自 commit `4fa8802` 与设计代码：

1. **每轮重发 RAW 会话 + 同一个 `config.session_id`**（≤256 字符）；
2. **逐字节转发返回的 `messages`**（返回即契约，不许自己再加工）；
3. 可选 **`POST /v1/usage`** 中继 provider 的 usage 块 → 冻结决策升级为已确认（还影响 `classify_cache_miss` 归因）；
4. 不要配 `compress_user_messages`（400，见 1.2）；
5. 无 session id 时的一切行为 = 旧无状态契约。

### 3.5 workspace key 与 CCR context tracker（跨轮主动展开）

- `headroom/ccr/context_tracker.py:1-20`：跟踪全会话所有压缩哈希，新 query 到来时检测相关性并**主动展开**相关压缩块，防"上下文失忆"（Turn1 搜出 100 文件→压缩成 10；Turn5 问 auth middleware → tracker 发现可能在 hash=abc123 里 → 先展开再让 LLM 答）。
- `workspace_key` **必填**（`context_tracker.py:63-80`、`90`）：真实事故——共享内存 tracker 无溯源键，tamag0 的 Python 文件泄漏进 daphni-rails 的 Ruby 会话（2026-05-26）。生产 proxy 解析不出 workspace 时 **fail-closed 不 track**（`handlers/anthropic.py:2520-2524`）。
- 解析优先级：`x-headroom-project-id` → `x-headroom-cwd` → CLI override → system prompt 里的 `cwd:` 行（`handlers/anthropic.py:347-360`）；另有 `X-Headroom-Project` header（wrap 注入）用于 savings 归因，入 contextvar 前 sanitize（`headroom/proxy/project_context.py:1-16, 33-40`）。
- 细节：Claude Code `/compact` 续会话摘要被专门识别并排除在主动展开之外，防把陈旧会话状态重新加回（`context_tracker.py:33-63`）。

---

## 4. CompressionDecision / bypass header / background compression：可搬到 DSH 的思想

### 4.1 `CompressionDecision`——把"要不要压"收敛成一个可观测的决策值对象

`headroom/proxy/compression_decision.py`（全文 168 行）：

- 动因（docstring `5-20`）：四个 handler 五处内联同一条合取式，Gemini 三处漏了 `not bypass`——显式 `x-headroom-bypass: true` 在 Gemini 路径被静默忽略，是真 bug。工厂化后"分歧在结构上不可能"。
- 优先级（`82-96`）：`bypass_header`（用户的字节稳定契约断言，必须最优先）> `compression_disabled`（操作者 kill switch）> `no_messages`（先于 license，避免空请求报"license denied"误导）> `license_denied`。
- 每个分量布尔都随值暴露（`bypass_header_set/config_optimize_enabled/license_allows/has_messages`，`61-69`），"差点点就压了"这类近失可审计；`passthrough_reason` 经 `apply_to_tags`（`149-168`）盖进 tags，所有下游 RequestOutcome/日志/dashboard 免费继承归因。

### 4.2 bypass header 契约

- 两个触发形态：`x-headroom-bypass: true` 或 `x-headroom-mode: passthrough`（`headroom/proxy/helpers.py:305-318`），HTTP 与 WebSocket 共用同一函数，"transport-neutral policy"（`311` 注释）。
- `/v1/compress` 上的实现：命中即回显原 messages + 全零指标（`openai.py:9625-9643`）；`/v1/responses` 命中则连 body mutation tracker 都禁用（`openai.py` responses handler 内 `_bypass = self._headroom_bypass_enabled(...)`，mutation=disabled 日志）。
- 语义定位（`compression_decision.py:84-88`）：bypass 是**用户对 prefix-cache 稳定性的契约断言**，不是"开关没打开"——操作者必须最优先尊重。

### 4.3 Background compression——冷启动大请求的旁路压缩

`headroom/proxy/background_compression.py`（全文 144 行，#1171 Phase 3）：

- 问题（docstring `4-10`）：冷启动大请求同步跑 ML 压缩会吃满 30s 预算，超时还漏一个不可抢占的 worker → executor 饱和 → 级联。
- 方案：先转发（未压缩/已缓存的）消息，把压缩塞进单进程 async drain 队列，**无请求耦合 deadline**，结果写入会话 `CompressionCache` → **下一轮直接命中缓存字节**。
- 全部 fail-open 且诚实列出局限（`18-24`）：队列内存态、重启丢任务（下轮重新 defer）、满队列/重复 key 丢任务并记 `deferred:dropped`（`enqueue` `67-94`：先占 `_pending` 再入队，dedup 原子）。
- `stats()` 暴露 queued/pending/processed/dropped/errors（`137-144`）。

### 4.4 其他值得搬的机制

| 机制 | 证据 | 一句话本质 |
|---|---|---|
| CPU 压缩全部下 executor + 硬超时 | `openai.py:10010-10025`（#718：内联跑大负载时连 `GET /health` 都会卡死） | 压缩再重要也不过 event loop |
| 字节回放纪律："**保留你转发出去的，不是你发起的**" | `proxy.mdx:530-560`（含反例警告 `560-563`：每轮重压全量原始会话，200+正 savings 但 provider 缓存全炸，响应里没有任何信号） | 缓存属于转发字节 |
| `frozen_message_count` 与 `protect_recent` 的正交分工 | `proxy.mdx:475`、`569`（前者钉最老的已缓存端，后者护最新的，互不替代） | 前缀稳定与新鲜度是两个旋钮 |
| 会话 turn 锁带超时获取 | `openai.py:9930-9947`（无超时 `with lock:` 会让 503 重试潮把 executor worker 全 parked、触发全局压缩隔离，殃及所有流量） | 排队也要 fail-fast |
| 会话命名空间防混淆 | `openai.py:9893-9896`（NUL 分隔键）、`prefix_tracker.py:1516-1524`（session id 只 hash 前导 system 游程） | 会话键是攻击面/事故面 |
| 插件扩展"opt-in + 故障自隔离" | `headroom/proxy/extensions.py:150-185`：entry-point 发现 ≠ 执行；只有 `HEADROOM_PROXY_EXTENSIONS`/`--proxy-extension` 列名才 install；install 抛异常的扩展**只禁用自己**，"one bad extension must not brick the proxy"；licence gate 抛错 → 功能 fail-closed 而非进程 fail | 与 DSH super-injector 语义同构，可直接引用为先例 |
| Runtime rollout：通道分层 + 快照摘要 | `docs/content/docs/runtime-rollouts.mdx:19-77`（stable<beta<canary<dev；显式 disable 永远赢；未知 feature 名 fail-closed）+ `100-155`（`registry_digest`/`snapshot_digest` 让 A/B benchmark 可比对、不导入内部实现） | 行为开关要可命名、可审计、可复现实验 |
| `RequestOutcome` 观测对称 | `compression_decision.py:4`（"CompressionDecision 是 RequestOutcome 的输入侧类比"）、`outcome.py` | 决策与结果各一个规范值对象，dashboard 不重推导 |

---

## 5. 其他与"外部 harness 接入"相关的设计（各一句结论）

- **认证 = loopback 即信任边界**：`HEADROOM_PROXY_TOKEN` 仅对非 loopback 请求强制（bearer，`hmac.compare_digest` 常量时间比较，health 路径豁免以便编排器探活），非 loopback 绑定且无 token 时启动即告警——`server.py:3556-3610`。
- **WS 与 HTTP 一份 token 规则**：`_security_gate` 是 BaseHTTPMiddleware（覆盖不到 websocket scope），同一 token 提取函数 `read_proxy_token` 被 `WebSocketAuthMiddleware` 复用、且置于最外层拒绝未认证握手（`server.py:3625-3645`；0.37.0 才补上，`CHANGELOG.md:305` #3305）。
- **`/health` 分级回显**：loopback 调用者看到 upstream URL/config 块，网络调用者拿到与 `/readyz` 同体（不含运营细节）——外部 scanner 看不见拓扑（`server.py:3673-3686`）。
- **`/v1/retrieve` 的双重守卫**：loopback + same-origin CSRF（`server.py:4922-4923`）；`require_same_origin` 对**无 Origin 的请求放行**（CLI/curl/Node fetch 天然通过，`headroom/proxy/loopback_guard.py:219-248`）——这解释了 bridge 的 Node fetch 为什么今天能通。
- **`/v1/compress` 的暴露开关**：默认 404 隐身（不是 403，"对外部扫描器表现为路由不存在"），`HEADROOM_COMPRESS_ALLOW_REMOTE=1` 只为这一条路由摘 loopback，token 仍生效（`server.py:5409-5423`；`proxy.mdx:310,438`）。
- **内部 header 卫生**：`x-headroom-*` 在读完 tag/记忆后统一 strip 不转发上游（PR-A5，`handlers/openai.py` responses handler `_strip_internal_headers` 调用点）；项目名 header 入 contextvar 前 sanitize（`project_context.py:4,33-40`）。
- **多 provider 路由是声明式机制不是黑盒**：`model_router.py:1-30`——操作者声明有序规则（条件全 AND，首个命中），决策带人类可读 reason 落观测面；默认关闭时行为逐字节不变。另有 per-request `x-headroom-base-url` 覆写（Anthropic 路由 0.37-Unreleased 才补齐，`CHANGELOG.md:282` #1760）。
- **caller-supplied upstream 全部校验**：SSRF 面逐路径收口（`CHANGELOG.md:329` #3195、`310` #3304 Vertex location 校验）。
- **SSE 必须字节级成帧**：Rust 前置代理的核心动因文档——Python 旧实现对每个 TCP chunk `errors="ignore"` 解码，多字节码点跨 chunk 边界就丢字节，9 天生产遥测 1946 次解析失败；Rust framer 攒 `BytesMut` 找 `\n\n`，**完整事件才做一次 UTF-8 解码**（`crates/headroom-proxy/src/sse/framing.rs:1-16`）。
- **未知内容块必须透传而非炸流**：`server_tool_use` 等未识别 Anthropic 块曾让整段生成完成后 502、客户端重跑整轮多分钟请求；现在逐字进 `content_block_start`（`CHANGELOG.md:285` #1806）。输出 token 按流文本数、不按线字节数（`CHANGELOG.md:347` #3163）。
- **CCR marker 是一个可内联解析的公开格式**：`<<ccr:HASH,KIND,SIZE>>`（12-24 hex，`headroom/ccr/marker_resolution.py:30-34`）；无 tool-call 回合的跳数（如 LiteLLM guardrail）有 `--ccr-inline-resolve` 兜底，miss 时保留 marker 附 miss reason 而非 raise（`marker_resolution.py:1-13,43-48`）。
- **`/v1/compress` 不碰 `system`/`tools`**：Anthropic 形态这两个是带外字段，端点收下但不压不返回（`proxy.mdx:461-469`）——bridge 若改用多消息会话形态，system prompt 与工具 schema 要自己原样携带；想要 tool-schema compaction 只能走完整 proxy 路径。
- **CacheAligner 是检测器不是修复器**：报告 `stable_prefix_hash`/`prefix_changed`/warnings，漂移修复责任在调用方的组装逻辑（`agent-orchestration.mdx:19-35,121-125`）。
- **指令性内容永不 lossy**：digest 路由表——当前任务/硬约束/验收定义 verbatim，文件/搜索/工具输出才走 CCR-backed 压缩（`agent-orchestration.mdx:76-94`）。
- **本地 LLM 场景压缩依然有价值**：省的不是钱是 prefill（`local-llm-prefill.mdx:6,108-115`），且要求 A/B 基线用 `--no-optimize` 透传态测量、警惕冷启动污染（`117-119`）。
- **codex-recovery.mdx 与 proxy 数据面基本无关**（是 `headroom wrap codex` 旧版临时 CODEX_HOME 的迁移工具），但其"备份-钉源-回滚"的失败处置模板（`codex-recovery.mdx:56-73`）与 DSH 注入器的"卸载即净"目标同族，可作参照。
- **Rust crate 是薄前层**：`crates/headroom-proxy/src/lib.rs:1-3`（"透明反代，挡在 Python proxy 前面"，main+集成测试共用）；`/healthz`+`/healthz/upstream`+`/rollout/status`+`/metrics` 本地拦截不转发（`src/health.rs:1-17`、`src/proxy.rs:158-168`）；`cache_stabilization/` 做结构哈希漂移检测（system/tools/前 3 消息逐维 SHA-256，canonicalize 时剥 `cache_control`——breakpoint 移动不算结构变化，`src/cache_stabilization/drift_detector.rs:1-25`）；live-zone 压缩（`src/compression/live_zone_*.rs`）。DSH 侧无 Python 重依赖时，这是"轻代理 Rust、重压缩 Python"分层的范本。

---

## 6. 对 DSH 插件（dsh-headroom-bridge）的启示清单

按「设计点 → 价值 → 接入位置」排列，标注建议优先级。

1. **【高】升级镜像到 0.37.0 即得乱码根治**（#3286 全链路修复）→ 子代理/混合内容工具结果不再被逐词糟蹋 → 只改 bridge 的镜像/版本钉扎（`docs/CONFIG.md` 与 compose/镜像引用），`src/proxy-client.ts` 零改动（1.4 已证三端点无破坏）。
2. **【高】sidecar session 模式**：把 bridge 从"每次单条 tool 消息送压"升级为"整会话 + `config.session_id` 送压、逐字节转发返回"（`openai.py:9778` 契约）→ 免费拿到 provider 前缀缓存保持 + 免自行维护 `frozen_message_count` → 在 `proxy-client.ts` 增加 sessionId 参数与"保留返回消息"的会话缓存；session id 用 DSH 的 sessionId，保证每个 agent 分支独立（防 headroom 注释里"共享 header 混合会话"事故，`openai.py:9779-9784`）。
3. **【高】`POST /v1/usage` 中继**（可选第二步）：DSH 在收到 provider usage 后回灌 → headroom 冻结决策变 provider-confirmed、cache-miss 可归因 → `proxy-client.ts` 加 `relayUsage()`，挂 DSH 的 turn-finish hook（`server.py:5432`）。
4. **【中】短内容送压门槛**：对齐 Kompress 的 64 词 floor，<64 词（或 <N token）的 tool result 本地直接跳过压缩（`kompress_compressor.py:1271`）→ 省一次 HTTP 往返，且 marker 本身约 20 词、短文本压缩净亏（#3286 的量化结论）→ `proxy-client.ts:compressToolMessage` 前置检查。
5. **【中】压缩决策值对象 + passthrough_reason**：仿 `CompressionDecision.decide`（bypass > 插件开关 > 空输入 > …），把"为什么这次没压"作为一等字段写进 DSH 侧观测/日志（`compression_decision.py:71-168`）→ 排查"压缩没生效"不再靠猜 → bridge 配置系统与诊断端点（`src/api.ts`）。
6. **【中】用户 bypass 契约**：给 DSH 一个 `x-headroom-bypass` 同义开关（配置或会话级），命中即透传并记 reason；语义按 `compression_decision.py:84-88`——用户断言字节稳定性时必须最高优先 → bridge 压缩入口的 header/参数。
7. **【中】background compression 模板**：大 tool result 先放行原文、异步压缩入 per-session 缓存、下一轮由 DSH 组装消息时替换为压缩字节 → 工具链不被压缩阻塞，失败全 fail-open → 在 bridge 增加一个单 drain 小队列（照抄 `background_compression.py` 的 dedup+满丢+stats 语义即可，144 行）。
8. **【中】"保留转发字节"纪律**：若暂不做 session 模式，至少实现 `proxy.mdx:542-556` 的两条规则——保存上一轮**发给 provider 的**消息序列并以其为 `frozen_message_count` 前缀重发 → 防"200+正 savings 但缓存全炸"的隐性成本 → bridge 的会话消息缓存层（新增）。
9. **【中】workspace/project 头**：向 proxy 发 `X-Headroom-Project`（sanitize 后，`project_context.py:33-40`）与（若用完整 proxy 路径）`x-headroom-cwd`/`x-headroom-project-id` → 收益归因分项目 + CCR 主动展开不跨项目泄漏（`anthropic.py:347-360`）→ bridge 所有请求的 header 组装处。
10. **【中】会话注册表自限内存**：bridge 若引入 per-session 状态（session→forwarded、hash→session 索引），用 TTL+LRU+懒清扫而非 timer（`server.py:1607-1653`，TTL 下限取 provider cache TTL+5min 边距 `helpers.py:1291-1293`）→ 长跑进程不涨内存。
11. **【低】扩展故障自隔离先例**：`extensions.py:150-185` 的"发现≠执行、列名才 install、坏扩展自杀不自杀全家"可直接写进 DSH 插件生态文档作为上游同构先例（配合 super-injector 的"卸载即净"）。
12. **【低】marker 格式对齐**：bridge 的 `[headroom-bridge: ... hash=...]` marker 与上游 `<<ccr:HASH,KIND,SIZE>>`（`marker_resolution.py:30-34`）语义等价但格式不同——若未来接入 headroom 自带的 marker 内联解析/工具注入体系（`tool_injection.py`、`response_handler.py`），需评估用上游格式换取"零自研解析"，或维持自有格式（DSH 不注入 retrieve 工具，自有格式更可控；至少把 marker 长度计入压缩收益预算，#3286 已量化 ≈20 词）。
13. **【低】SSE 字节级成帧教训**：bridge 目前不解析 SSE；若未来直连 provider 流式（绕过 DSH 的 LLM 层做输出统计/CCR 标记回写），必须攒字节到完整事件再一次性解码，禁止逐 chunk `TextDecoder({fatal:false})` 式有损解码（`sse/framing.rs:1-16` 的 1946 次/9 天事故）。
14. **【低】认证对齐**：bridge 继续假设 loopback；若支持远程 proxy 地址，须同时支持 `Authorization: Bearer`（`HEADROOM_PROXY_TOKEN`）并知道 `/v1/compress` 远端可达需要服务端 `HEADROOM_COMPRESS_ALLOW_REMOTE=1`、且 404 意味着路由隐身而非宕机（`server.py:5409-5423`）→ `proxy-client.ts` 的 headers 配置。
15. **【低】rollout digest 参与 benchmark**：DSH 侧做压缩 A/B 时，把 proxy `/stats.rollout.registry_digest`/`snapshot_digest` 记入实验元数据（`runtime-rollouts.mdx:121-155`）→ 两臂配置漂移可证伪。
16. **【备忘】不要指望 `/v1/compress` 压 system/tools**：多消息会话化改造后，system prompt 与工具 schema 仍需 DSH 自己携带且享受不到 tool-schema compaction（`proxy.mdx:461-469`）——想要就得走完整 proxy 路径，属于 bridge 的路线选择题而非补丁题。

### 附：升级 checklist（0.36.5 → 0.37.0）

1. 镜像/版本钉扎改 0.37.0（bridge 三个端点已验证无破坏，见 1.4）。
2. 跑一遍 bridge 现有回归（`tests/`），重点看短工具结果压缩率变化（预期：`tokens_saved` 略降、无 `\uXXXX`/banner 损坏）。
3. 若启用 session 模式：新增 sessionId 生成（每 DSH 会话一份）、保存返回消息、可选 usage 中继；**不要在 session 模式开 `compress_user_messages`**（400）。
4. 文档补记：`config.session_id` 无官方 docs，引用 `openai.py:9595-9620` docstring + commit `4fa8802`。
