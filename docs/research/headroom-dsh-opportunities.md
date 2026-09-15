# Headroom 上游研究：值得接入 DSH 的功能与设计

> **对象**：`/media/ict/19BD52556106DE5A/headroom`（headroomlabs-ai/headroom，v0.37.0，2026-09-04）
> **基线**：dsh-headroom-bridge v0.1.1（停在 0.36.5-code 镜像验证）；仓库内 `RESEARCH-REPORT.md`（2026-08-26，bridge 立项依据）只覆盖到 0.36.x，其 §2–§5 结论（压缩器原理、CCR 机制、dynamic alpha、context_tracker 参数）仍然有效，本文只写**增量**。
> **方法**：4 个子智能体分片深读（proxy / learn+memory / 记账+可观测 / 压缩器）+ 主控对全部关键论断源码交叉验证。论断标注 file:line；标「子报告」的为子智能体产出、主控未逐行复核。
> **日期**：2026-09-15

---

## 0. 优先级总表

| 级别 | 项 | 一句话 | 成本 |
|---|---|---|---|
| **P0·止损** | bash 路径门 token 级匹配（§7 已实锤） | 整条命令取 basename 致 protectPathGlobs 对 bash 全面失效，台账 88 条 bash 绝大多数本不该压 | 低 |
| **P0·止损** | excludeTools 不可清空 + 卡片热改重编译 | `[] ??` 语义允许静默清空排除表；ArmAState 构造期编译不随配置刷新 | 低 |
| **P0** | Read 生命周期回收（stale/superseded） | 文件被编辑后旧 Read 是**证明为错**的内容，75% Read 字节可安全替换——比内容压缩更便宜、更安全 | 中 |
| **P0** | 跨轮逐字去重（prefix-monotonic） | 同一文件被 cat/sed/diff 反复展示，跨工具输出折叠逐字重复段，字节级不破坏 KV 前缀 | 中 |
| **P0** | 升级 0.37.0 + 验证 #3286 | 子代理混合输出乱码修复 + `/v1/compress` 契约向后兼容确认，bridge 硬依赖版本跟进 | 低 |
| **P1** | 台账可观测性三件套 | miss 原因展示 / RetrievalEvent 赎回追踪 / 「新内容相对节省率」诚实口径 | 低 |
| **P1** | CCR 台账 SQLite 化 | 上游 1000 条 / TTL 1800s / sqlite 后端已验证，bridge 的 JSON 文件 + FIFO-2000 在重负载下驱逐过狠（见 §6 dogfooding 实证） | 低 |
| **P1** | 主动展开（provenance-tagged proactive expansion） | 压缩后模型不问就漏答；上游用相关性打分在提问前展开，配 `<headroom_proactive_expansion>` 溯源标签防归属污染 | 高 |
| **P1** | BM25-lite 相关性打分（dynamic alpha） | 插件侧零依赖 TS 实现，供主动展开/语义检索共用 | 中 |
| **P1** | 零 LLM loop 检测器（error loop + re-fetch loop） | 签名归一化（剥分页/limit、裸整数→N）+≥3 次阈值+实测浪费 token；re-fetch loop 是"失败分析看不见"的盲区（`loops.py:88-158`，纯规则 ~200 行 TS） | 低 |
| **P1** | `headroom learn` 等价物（失败会话挖掘→AGENTS.md 修正） | 15 类错误签名 + 复现阈值 + marker 块字节级 merge + prior patterns 回喂防重复学习 | 中-高 |
| **P2** | 冷缓存策略（cold-prefix DROP/SINK） | 确认 KV 缓存已死时才做激进重写——bridge 目前对 KV 代价只有静态声明，没有 TTL 感知 | 中 |
| **P2** | 输出侧诚实记账（三档：估计/实测/直接浪费） | signed deltas + 会话稳定 A/B holdout + echo ratio；可移植到任何"效果宣称" | 中 |
| **P2** | 成本感知模型路由（opt-in 规则表） | 上游 #1706 模式：按输入大小/工具有无改写上游模型，首条命中，malformed fail-open，决策带 reason | 高 |
| **P2** | verbosity 行为学习 | 从打断/快读信号推断输出长度偏好（用户从不口头说） | 中 |
| **不建议** | 图像压缩 / 跨代理 memory / MCP OAuth2 / License 门 / Web Dashboard / magika 客户端化 | 理由见 §5 | — |

---

## 1. 最大发现：比"压内容"更便宜的是"证明内容已死"

### 1.1 Read 生命周期（`headroom/transforms/read_lifecycle.py`，主控全文验证）

模块头给了真实流量测量：**Read 工具输出字节的 75% 属于两类可证明安全替换的状态**——

- **STALE**（67%）：Read 之后文件又被编辑/写入 → 上下文里的内容是**事实性错误**，不是"压缩后可能丢信息"；
- **SUPERSEDED**（12%）：同文件后来被重新 Read → 旧副本纯冗余；
- **FRESH**（20%）：从不触碰。

替换成 compact marker + CCR hash（bridge 已有同款机制）。判定只需要扫描会话里的 `(read|edit|write, file_path)` 事件序列——DSH 会话日志里全是这个信息，且 bridge 的 Arm B（`agent/pre-step`）正是干"回收旧节点"的位置。

对 bridge 的直接修正：现在 `read` 在 `excludeTools` 里**永远不压**（字节敏感立场）。但 stale/superseded 的 Read 结果**不字节敏感——它是错的/冗余的**，压缩零信息损失。上游还记录了一个反面教训：first-sight repeat-Read 去重（DEDUP_REPEAT）做了之后用 `headroom audit-reads` 实测真实流量里逐字重复只有 0.1%，**于是删掉了该机制**（源码注释明说，实现在 git 历史）。→ 设计哲学：**先测量再上钩子**，DSH 侧对应 `mode: audit` 的扩展用法。

### 1.2 跨轮逐字去重（`headroom/transforms/cross_turn_dedup.py`，主控全文验证）

解决 per-block 压缩器的盲区：**冗余在块与块之间**（`cat foo.py` → `sed -n 75,100p foo.py` → `git diff` → 再 `cat foo.py`）。两条生产级不变量：

1. **前缀单调性**（`is_prefix_monotonic` 强制断言）：块 k 只匹配**严格更早**块的内容，重写后 0..k 字节与 k+1 是否存在无关——追加新轮永不改写旧轮，provider prompt cache 前缀字节稳定。引用用绝对块序号，冻结指针文本永不变化。
2. **信息不出窗**：只回指早期块里**逐字已出现**的跨度；最早 occurrence 永不重写（keep-earliest）；只折叠"大且非平凡"的连续段。

纯 stdlib、确定性、任何错误原样返回。这是**可直接移植 TypeScript 的算法**（几十到一百多行），且与 bridge 的 KV 缓存顾虑正面兼容——它甚至是 cache-friendly 的（只影响新后缀）。DSH 生态里 bash/read 重放极多，收益模型与上游同构。

### 1.3 冷缓存重写（`headroom/transforms/cold_prefix.py`，主控读头部）

缓存感知的两档策略：**热轮**（缓存命中在 TTL 内）冻结旧前缀字节只处理新内容；**冷轮**（idle 超 TTL / 缓存不可用模型如 GLM/DeepSeek-R1）才执行激进 DROP / SINK superseded-reads——"缓存已死时重写不 bust 任何东西，冷轮反而把更小的前缀重新缓存，惠及后续热轮"。同文件对推理模型 reasoning 思考块**原样透传**（opaque handle 计费豁免，动它省不了钱还有风险）。

bridge 现状对照：README 只静态声明"live 替换从第一个被改 token 起失效缓存"，没有任何 TTL 感知。DSH 若路由层能拿到 cache hit/miss 反馈（上游新 `/v1/usage` relay 正是这个信号面），bridge 可以只在"该节点确定已出缓存"时才做高收益重写。

---

## 2. bridge 直接可吃：升级与契约（低成本）

### 2.1 `/v1/compress` 契约向后兼容——已确认（主控源码验证）

`headroom/proxy/handlers/openai.py:9594` docstring：`{messages, model, config}` 不变；`config.mode` 现为 unset（marker-free）/ `ccr` / 新增 `lossy_inline`（先 lossless 折叠再 Kompress，别名 `lossless_then_lossy`），非法值 400。新增可选 `config.frozen_message_count`：前 N 条消息**逐字节冻结返回**（跨消息变换仍可见），给"重放增长会话"的调用方防缓存击穿——bridge 单条工具消息压缩暂用不到，但**将来做整段会话回收（Arm B 走代理）时是必备参数**。`x-headroom-bypass: true` 契约保留（server.py:5433 起，bypass 优先于一切，曾因 Gemini 三 handler 漏判出真实 bug）。路由同文件新增 `/v1/usage`（sidecar 模式的 provider 计费回传，与 `/v1/compress` 同一访问策略构成一个契约）。GET `/v1/retrieve/{hash}` + `/v1/retrieve/stats`（loopback-only）不变。**结论：0.36.5→0.37.0 bridge 三端点无破坏。**

### 2.2 #3286 子代理输出乱码修复——确认存在且相关

`CHANGELOG.md:308`：**"transforms: stop compression garbling mixed subagent output (#3286)"**（0.37.0）。一个子报告曾质疑"#3286 与子代理无关"——**不成立**，CHANGELOG 原文即证。对 bridge 的含义：DSH 子代理报告是混合文本（中文/代码/嵌套标记），0.36.5 代理有乱码风险；这是**升级的直接理由**，本次会话也实证了子代理报告压缩有损（见 §6）。

### 2.3 并行子代理的 KV 缓存踩踏教训（#2085，CHANGELOG Unreleased，主控读原文）

上游实测事故：共享 session id 下并行子代理历史交错污染同一个 frozen-prefix tracker，转发前缀字节不稳定，**prompt cache 反复被重写而非命中，实测 4.4x cache 创建膨胀、2.5–3x 净成本上升**。修复：session id 内按会话血缘（lineage）解析 tracker，客户端历史 append-only 即延续血缘，分叉/压缩重写即开新血缘，每 session 上限 32 条。→ 对 DSH 的含义：**任何"重写旧内容"的机制（bridge Arm B 同理）在 fan-out 会话里要按会话血缘隔离缓存假设**；dsh 的回放/分叉语义天然携带 lineage 信息，是优势。

### 2.4 stats 诚实性设计（`/stats` 新字段，CHANGELOG Unreleased + `output_savings.py` 头，主控验证）

- **`new_input_tokens` / `new_input_savings_percent`**：全请求比率在长会话里把 200 轮历史重复计入分母，百万上下文会话永远稀释成 ~0%；上游改为只对**本轮新进入内容**（uncached + cache-write tokens）算节省。bridge 的 `headroom_stats` 现在只有"节省比例"单一口径，应跟进区分"本次压缩自身比率"与"对新输入总盘比率"两档。
- **三档诚实记账**（`headroom/proxy/output_savings.py` 模块头，主控全文读）：输出侧削减不可观测（counterfactual），上游分三档——①**估计**：按层（stratum）合成控制基线，`Σ(baseline−observed)` 且 **signed 永不 clamp**（clamp 会系统性偏高）；②**实测**：只认会话稳定（conversation-stable，整场会话同一臂，混臂既污染对比又 bust 前缀缓存）的 A/B holdout；③**直接浪费**：echo ratio（响应与已给上下文的 n-gram 重叠）无 counterfactual、可单独诚实宣称。分层特征只用**请求时刻可观测**的字段。这套方法论对 DSH 任何"效果宣称"（包括未来官方 compaction 指标包）都值得立为口径规范。

### 2.5 CCR 台账运行参数（主仓 `RESEARCH-REPORT.md` §5 复核 + 本次实证）

上游 Python 侧默认 **SQLite**（`ccr_store.db`），max_entries=1000，**TTL 1800s**；miss 有操作员可读原因（expired+年龄 / not found，`format_retrieval_miss_detail`）；工具注入前 `verify_ownership`（hash 不在 store 就不注入 retrieve 工具，避免模型拿到不可赎回 marker）。bridge 对应改进：①台账 JSON → SQLite；②`headroom_retrieve` 的 found:false 返回统一带 reason+age（已有 detail，可补 age）；③（可选）装载/运行期 health 信号里暴露"本会话 marker 尚全部可赎回"位。

---

## 3. 主动展开：CCR 的闭环缺角（P1，高价值）

上游 context_tracker（RESEARCH-REPORT §5 + 子报告 C + 主控 CHANGELOG 验证）：按 `workspace_key` 追踪本会话压缩过的 hash，新查询来了先做相关性打分（阈值 0.3），**在模型开口要之前**主动展开最相关的 ≤2 条（`max_proactive_expansions=2`，年龄上限 300s）；`workspace_key` 缺失 **fail-closed**（防跨项目泄露）；0.37.0 起展开块包 `<headroom_proactive_expansion>` XML 标签，给下游"机器可读溯源边界，防多 agent 线程归属污染"。

场景实证：第 1 轮 500 文件列表压成 15，第 5 轮问 "auth middleware" → 先展开再答。**不做这步，压缩类插件的真实风险是静默漏答**——bridge 目前完全依赖模型主动调 `headroom_retrieve`，而模型不知道自己没看过什么，不会问。

DSH 侧最小设计：插件内维护会话级 hash↔摘要索引；`agent/pre-step` 拿最近 user/tool 消息对索引做 BM25-lite 打分；过阈值则经 Arm B 同款 surfaceOp replace 把原文放回表面（带溯源标签）。BM25 零依赖可 TS 实现；上游 dynamic alpha（查询含 UUID/长数字 ID/主机名/邮箱 → 加大 BM25 权重 α∈[0.3,0.9]，纯语义查询回落 0.5）可作为 embedding 缺席时的降级终点——**α 调参思想本身就是零依赖的**。

---

## 4. learn：从会话日志里挖"别再犯"（P1）

`headroom/learn/`（1199 行 analyzer + scanner + writer，插件化 registry；子报告 B 主笔，ErrorCategory 枚举与 verbosity 模块主控验证）：

- **输入**：工具调用记录归一化为 `ToolCallRecord`（含 error/success/user_feedback）；
- **15 类错误分类**（`models.py:21` ErrorCategory 主控验证：file_not_found…exit_code、`user_rejected`、`sibling_error` 级联、`no_matches`）；
- **触发**：同一 (tool_name, error_pattern) **≥3 次复现**（`min_error_count=3`，`repeat_buffer=500` LRU）；
- **签名**：先剥易变细节（行号/hex/UUID/时间戳，否则同错裂成 N 个签名）再 SHA-256[:16]；
- **FPS 指纹**：`{error_hash: {hash, description, correct_usage, tool_name, seen_count, first/last_seen}}`——正是 "Failure Prediction Suggestion" 格式（NeurIPS 2025 Deep Research Bench 出处，子报告）；
- **输出**：按项目写 `CLAUDE.local.md`（gitignored 默认，`CLAUDE_CONFIG_DIR` 已支持），HTML 注释 marker 分区 + **字节级精确 merge** + 原子 temp+rename；`--scan-all` 全项目 + 全局 memory 并集；
- **verbosity 学习**（`verbosity.py:1` 主控验证）：用户从不口头说要多简短，但**行为出卖了他们**——打断长回答、回复速度快于读完答案的可能速度；用长度自适应阈值提取 interrupt rate / fast-skip rate / echo ratio，产出 verbosity level，且直接充当输出削减的**合成控制基线**（与 §2.4 咬合）。

DSH 等价物天然更顺：会话日志结构化（tool call + isError + 用户反馈包）、回放/分叉现成，storages 存 FPS 台账，产出写 `AGENTS.md`（dsh 已读它）。做独立插件（"dsh-learn"）而非塞进 bridge。**成本评估**：扫描器+分类器中等；LLM 判断 pass（错误→"正确用法"一句话）是质量关键，dsh 内 LLM 调用免费顺手。

---

## 5. 评估后不建议接入（一句话理由）

| 项 | 理由 |
|---|---|
| 图像压缩（TextIn/PaddleOCR） | DSH 工具结果多模态处理在核心路径，且 OCR 子进程服务重（子报告 A/D 均标注"不适合插件接入"） |
| 跨代理 memory | 抽取 LLM 成本 + "只增不减"老化 + 跨 harness 场景在 DSH 生态暂不存在；等 dsh 生态真有多 agent 共享记忆需求再说 |
| shared_context / SemanticCache | 依赖 proxy 流量面；dsh 直连 provider 无中间层 |
| MCP OAuth2 / License 计费 | 商业面设施，无关 |
| Web Dashboard | dsh web 设置卡片已是等价物且更贴宿主 |
| magika/ONNX 客户端化 | 体积不成比例；纯 Python 检测级联的**判据**值得抄（子报告 D：unidiff→json→tabular→search→log→source_code→html→config→text 级联，几十行 TS 可近似其中 log/diff/json 三类，作为 bridge 侧"预期收益预估"，注定低收益就不发代理请求） |
| Kompress（ModernBERT）本地跑 | 同 bridge 既有立场：ML 压缩器留代理侧 |

另记：上游已把两个从未接线的 env 调参（`HEADROOM_COMPRESSION_STABLE_AFTER_TURN`/`HEADROOM_STALE_READ_COMPRESS_AFTER_TURNS`）从 banner 删除（CHANGELOG:275）——**"配置面上不存在的开关比没有开关更糟"**，bridge 的"卡片只暴露 7 字段、其余进 settings.yaml"分层恰好是反面教训的对偶，坚持即可。

---

## 6. 本次会话的 dogfooding 实证（给 bridge 的直接证据）

本会话四个子智能体的最终报告（各 28k–33k 字符）作为 `subagent` 工具结果进入父会话后被 bridge 压缩，**赎回失败**：本地台账无条目、代理 `/v1/retrieve` 404（`Entry not found (CCR TTL: 1800 seconds)`）。即：

1. 大报告压缩**有损且不可逆**地丢细节（本次实测丢关键结论若干，需要重发子智能体重写）——支持 **PLAN.md D2 尽快定策**：`subagent` 报告至少从 Arm B 排除（Arm B 阈值 16384 恰好命中报告体量），或为"长且有结构的报告类结果"提高 minSavingsRatio 门槛；
2. 三处时限不一致：bridge 台账 24h / 2000 条 FIFO vs 代理 CCR 1800s / 1000 条——**marker 名义可赎回 24h，实际锚在代理的 30 分钟上**（原文未入本地台账的场景，如本次）。建议：bridge 采纳路径强制"原文必入本地台账后才发货"已有，但应确保**代理原生 marker（SmartCrusher 哨兵等）出现时也把原文镜像进本地台账**，或统一以本地台账 hash 为准改写 marker；文档明示 TTL 取两者 min。

---

## 7. 事故核验（主控独立取证，2026-09-15 晚）

savings 子智能体上报「live 模式有损压掉了 read 源码结果」。**取证结论：事故为真，但当前 fiber 门控已复测通过；真正实锤的洞是 bash 路径门。**

**证据链**：
- 台账 92 条：88 bash + 4 read；4 条 read 的 sessionId 全是本会话派出的子智能体（`ebbc…` = savings 读 agent_savings.py 21043→13664，`strategy router:code_aware`）
- 解压 `sessions/…/58a80af3…/session.v3.jsonl.zstd`：seq31 `tool/call name=read arguments={"file_path":"…agent_savings.py"}` → seq33 原文 tool/result 原样落日志 → seq36 同 callId **第二条 tool/result**（压缩版）+ 全文件 8 条 `compaction/prune` = **Arm B 替换签名**，即漏网的是 Arm B 路径（其每轮重编译 glob，不属 ArmAState 构造期嫌疑）
- 活体复测（18:33–18:40，同 fiber）：探针 `/tmp/probe_gate.py`（18.9KB）与 `/tmp/probe_gate2.txt`（21.5KB）经父会话 read、子代理 read（ef48a943）、两步 Arm B 回收窗口——**全部原样、台账无新增**。当前门控正常。事故窗口（18:02）与复测窗口之间 fiber 无重载，差异未定位 → 保留「当时 excludeTools 被瞬时置空」假设（见嫌疑③），不能定论。

**已实锤的独立缺陷（当场 node 复现，与 fiber 无关）**：
1. **protect.ts 路径门对 bash 整条命令失效**：`evaluateGates({toolName:'bash', args:{command:'cat /root/.dsh/settings.yaml | head -50'}, …})` → **null（不保护）**。`collectPathValues` 把整条命令当一个"路径"取 basename（取到 `head -50` 之类尾巴），glob 永不命中。台账 88 条 bash 里 cat/读源码文件类结果全部漏保护——这是最大流量类别的全面失守，也解释了事故报告里"cat yaml 被压"。修法：命令字符串按 token 切分逐 token 试匹配；PATH_ARG_KEYS 命中且是 JSON 字符串时先 parse。
2. `stringArray` 用 `value ?? fallback`：显式 `excludeTools: []` 合法清空排除表且不警告（上游 protect_reads 立场是不可清空）。
3. Arm A `ArmAState` 构造期一次性 compileGlobs，卡片改 excludeTools/protectPathGlobs 后不重编译（Arm B 无此问题）。
4. 子代理工具集无 `headroom_retrieve` → 被压内容对执行者不可赎回，事故影响被放大（产品性缺口，与 PLAN D2 相关）。

**建议**：①②是止损项，优先级高于本报告所有"新能力"；修复后跑 `dev_self_test` + 把 bash-cat-受保护文件 门控用例加进 tests/protect.test.js。

## 附：本次未复核细节的可信度说明

文中「子报告」标签的 file:line（learn analyzer.py:294/460、memory tool.py:67、cache_aligner.py:312 等）来自子智能体深读，方向可信、行号未逐条复核；四份全文分片见同目录 `headroom-proxy.md` / `headroom-learn-memory.md` / `headroom-savings-observability.md` / `headroom-compressors.md`（子智能体回写，可能后补落盘）。
