# Headroom 压缩器与内容路由深度调研 —— DSH 插件侧轻量移植评估

> 调研对象：`/media/ict/19BD52556106DE5A/headroom/`（Rust 核心 `crates/headroom-core/src/`，下称 `core/`；生产 Python 层 `headroom/`）。
> 评估目标：dsh-headroom-bridge（现整体外包给 headroom HTTP 代理 `/v1/compress`）插件侧值得做哪些**本地轻量预判/门控**，而非本地压缩。
> 方法：内容检测级联与 freeze 机制由主任务全文精读；SmartCrusher / Log-Diff-Search / simulators 三份由并行子任务全文深读，关键常量（min_items、markers、config defaults、512B 门）另经主任务独立抽查双向核对一致。所有 file:line 相对仓库根。未修改任何被调研文件。
> 版本：HEAD 含 #3380（aebe9895）、#3419（73a6edbe）附近提交。

---

## 0. 现状锚点：bridge 现有门控（供对照）

- 门控链：长度门 `minChars`（默认 500）→ 排除工具（read/glob/grep/edit/write/web_* 等，`src/config.ts:76-89`）→ `protectPathGlobs` → 压缩后收益门 `minSavingsRatio`（默认 0.15；arm-B 0.3）：`savings = max(tokenRatio, charRatio)`，不达标整段回退原文（`src/arm-a.ts:121` profitable 判定）。
- 挂载点 `tools/post-execute` 监听（`src/arm-a.ts:171`）——**工具结果写入历史之前**压缩，provider 首次看到的就是压缩形态（第 5 节 cache 结论的前提）。
- 请求形态：单条 `{role:'tool'}` + `config:{mode:'ccr'}`（`src/proxy-client.ts:64-66`），代理侧无会话状态。
- headroom 侧对应值：`min_chars_for_block_compression=500`（`headroom/transforms/content_router.py:1596`）与 bridge 一致；但 router 收益门默认已放宽到 `min_ratio=1.0`（接受任何缩水，`content_router.py:1606-1617`，缓存风险交给 net-cost policy），bridge 的 0.15 兜底**更严**——正确，因为 bridge 每次白付一次 HTTP 往返。
- **注意端点差异**：本仓库的 Rust `headroom-proxy` 并不暴露独立"压这段内容"端点（只有 `/v1/chat/completions`、`/v1/messages` 等代理路由，proxy.rs:157-283）。bridge 打的是 Python headroom 服务的 `/v1/compress`；两者对压缩器是同一份 byte-parity 规范（`core/transforms/diff_compressor.rs:15-18` 自述与 Python 字节等价），因此下述常量对 bridge 的代理同样成立。

---

## 1. 内容检测级联：判据、阈值、可移植性

### 1.1 生产级级联（ContentRouter 实际执行顺序，四层）

入口 `_detect_content`（`headroom/transforms/content_router.py:919-1044`）：

0. **信封剥离（仅检测用）**：整串恰为 `<returncode>N</returncode><output|stdout|stderr|tool_result|result>…</tag>` 时取内层再检测（`:893-916`）——防止工具输出包装标签把 grep/log 误判成 HTML 被文章抽取器毁掉；压缩仍作用于原文。
1. **Tier 1 Magika（ONNX ML）**（`core/transforms/magika_detector.rs`）：全量字节 `identify_content_sync`（`:417-433`），**无置信度阈值、无字节窗口**；label→枚举显式映射表（`:449-484`）：`json|jsonl→JsonArray`、`diff→GitDiff`、`html|xml→Html`、约 34 个代码 label→SourceCode、其余（markdown/rst/txt/unknown）→PlainText。AVX2 缺失/ORT 版本不符/init 超时 → 报错降级不崩（`:54-82,364-409`）。Rust 链 `core/transforms/detection.rs:55-103`：magika 报 PlainText 或出错都落到 Tier 2。
2. **Tier 2 unidiff 语法验真**（`core/transforms/unidiff_detector.rs:57-107`）：需按序 `--- ` → `+++ ` → `@@ -a,b +c,d @@`（`:83-127`），再 `PatchSet::parse` 且至少一个非空文件含 ≥1 hunk；`catch_unwind` 包 known panic（unidiff 0.4.0 对孤立 `+++ ` 会 unwrap None，`:66-70`）。已知盲区：`@@@` 合并 diff 不解析（`:33-38`）。
3. **误路由护栏**：magika 报 HTML → `_try_detect_log/_try_detect_search` 正判则覆写（`content_router.py:1022-1025`）；报 SourceCode → 结构化 config 检测 conf≥0.7 则覆写（`:1031-1034`）。
4. **Tier 3 正则/Python 启发式**（magika 给 PlainText 时复验，`content_router.py:1036-1039`）。顺序与阈值（Rust 镜像 `core/transforms/content_detector.rs:221-255`；Python 权威版 `headroom/transforms/content_detector.py:163-230` 多 tabular/config 两级）：

   | 顺序 | 类型 | 认领条件 | 置信度公式 | 门槛 | 采样窗口 |
   |---|---|---|---|---|---|
   | 1 | JSON | parse 成功且为数组（Rust 版还要求前导 `[`；全元素是对象 conf=1.0 否则 0.8）。Python 版更宽：任何 parse 成功即 JSON，且把空格分隔的拼接对象 `{…} {…}` 归一化成数组喂 SmartCrusher（`content_detector.py:243-282`） | — | 直接认领 | 全文 |
   | 2 | GitDiff | header 命中≥1（`diff --git\|--combined\|--cc\|--- a/\|@@…@@\|@@@…`）| `0.5+0.2·headers+0.05·changes` cap 1 | ≥0.7 | 前 500 行 |
   | 3 | HTML | doctype ∨ `<html` ∨ 结构标签≥3 | 0.5(doctype)+0.3+0.1+0.1+0.03·tags(cap .3) | ≥0.7 | 前 3000 字节 |
   | 4 | Search | `^[^\s:]+:\d+:` 非空行占比 ≥0.3 | `0.4+ratio·0.6` | ≥0.6 | 前 100 行 |
   | 5 | Log/Build | 10 组 pattern（ERROR 族 / WARN 族 / INFO·DEBUG·TRACE / `^\d{4}-\d{2}-\d{2}` / `[hh:mm:ss]` / `====`/`----` / PASSED·FAILED·SKIPPED / `npm ERR!`/`yarn error`/`cargo error` / `Traceback (most recent call last)` / `^\s+at pkg.Class(`）行占比 ≥0.1（每行记一次，前 2 组算 error 加权 +0.05）| `0.3+ratio·0.5+0.05·errors` | ≥0.5 | 前 200 行 |
   | 6 | Tabular（Python only）| markdown 表头+分隔行→0.95；或 CSV/TSV：首行含分隔符、众数列数一致性 `,;|`=0.85 / tab=0.7、列数≥2、且非散文（≥半数行句末标点、或平均单元格>3 词即否决）| `min(0.95, 0.5+consistency·0.3+min(ncols,5)·0.03)` | ≥0.6 | 50 非空行/样 20 |
   | 7 | Config YAML/TOML/INI（Python only）| 行型计数（`[section]`/`#;`注释/`key:`）；TOML/INI 用真 parser 二选一裁决（`:656-689`）| — | ≥0.6（覆写 SourceCode 需 ≥0.7）| 前 200 行 |
   | 8 | SourceCode | 6 语言各 2-4 条正则逐行打分，best≥3；并列取先插入者（复刻 Python dict 语义，`content_detector.rs:465-514`）| `0.4+ratio·0.4+0.02·score` | ≥0.5 | 前 100 行 |
   | 9 | PlainText | 兜底 conf=0.5 | — | — | — |

   混合内容预拆段：5 指标（代码围栏/JSON 块/文包 JSON/散文词组>5/file:line）**任意 ≥2** 判 mixed，先 `split_into_sections` 再分段路由（`headroom/transforms/mixed_content.py:31-50,92+`）。
5. **弹性防线**：native 检测跑在 watchdog 线程上限时，卡死一次即全进程熔断降级纯 Python（`content_router.py:851-882,951-1005`）；Python 吞 native panic 降级（#1123）。

### 1.2 定位差异（决定移植方式）

代理侧检测的目的是"**路由到哪个压缩器**"；bridge 只需要一个标量："**这次请求预计收益高不高**"。所以不必复刻级联，只取 §6 的信号→预期收益映射。magika 与 unidiff 验真不必移植（unidiff npm 版有同类 panic bug，需 try/catch）。

---

## 2. SmartCrusher（JSON）：保留策略、哨兵、收益预估可行性

架构事实（框定 Q2）：SmartCrusher **不是**加权重要性打分器；KEEP 集是**独立探测器布尔并集 + 预算内 stride 补位**（`core/transforms/smart_crusher/planning.rs:169-229`、`orchestration.rs:152-230`）。唯一连续分数是 query 相关的 RelevanceScorer（Hybrid BM25+embedding，`core/relevance/hybrid.rs:69`），阈值 0.3（`smart_crusher/config.rs:150`）。（Python 侧已退役、Rust 经 PyO3 单源，`git log c765c53b`。）

### 2.1 KEEP/FOLD 信号（默认值 `smart_crusher/config.rs:129-161`）

- **位置锚点**（dict 数组）：slot 预算 `clamp(max_items·0.25, 3, 12)`；前/中/后权重按内容形态 Generic .5/.1/.4、SearchResults .75/.1/.15、Logs .15/.1/.75、TimeSeries .45/.1/.45；query 关键词（"latest/recent/…" ↔ "first/oldest/…"）把前后权重 ±0.15（钳 [0.1,0.8]）（`core/transforms/anchor_selector.rs:49,81-96,543-629`）。
- **边界**（标量/对象 crush）：`k_first=max(1,round(k·0.3))`、`k_last=max(1,round(k·0.15))`（`smart_crusher/crushers.rs:76-100`）；超预算剪枝恒保**前 3 + 后 2**（`orchestration.rs:199-214`）。
- **error 关键词**：仅 **12 词**——`error, exception, failed, failure, critical, fatal, crash, panic, abort, timeout, denied, rejected`——对 item JSON 小写子串匹配（`smart_crusher/error_keywords.rs:17-30`；检测 `outliers.rs:250-283`；接成 `KeepErrorsConstraint` `constraints.rs:42-50`）。
- **数值离群**：按字段 `|x−μ| > 2.0σ`（样本标准差）；字符串长度同理（`planning.rs:606-638`、`crushers.rs:141-156`）。
- **变点**：滑窗 5、|窗均差|>2.0·全局 σ，贪心去重间隔>5，SmartSample 保 ±1 邻域（`analyzer.rs:282-317`、`planning.rs:205-217`）。
- **结构稀有性**：罕见字段（key 出现率 <20%）命中项保留；常见字段（≥80% 出现）上稀有值（cardinality 2..=50、Pareto 最小 top-K 覆盖 80% 且仅当 K≤5 时启用）（`outliers.rs:61-235`）。
- **query 锚点**（确定性正则，deprecated-but-live）：UUID、≥4 位数字、hostname（带 e.g. 等黑名单）、引号串（≥2 字符）、email，对 item 的 repr 做子串匹配（`smart_crusher/anchors.rs:31-112`）。
- **相关性**：Hybrid 分 ≥0.3 保留；自适应 α∈[0.3,0.9]，UUID/数字 ID/hostname/email 类 query 抬高地板 0.85/0.75/0.65/0.6；命中词≥1 地板 0.3、≥2 +0.2（`relevance/hybrid.rs:128-161`、`planning.rs:501-521`）。
- **多样性/去冗余**：内容 hash（sort_keys JSON 的 MD5[:16]）去重、最低 index 存活；预算内 stride 补位；ClusterSample 按 `md5(前 50 字符)[:8]` 分组每组留 2 代表；message 字段=唯一率最高的字符串字段且 unique_ratio>0.3（`orchestration.rs:49-136`、`planning.rs:368-406`）。
- **字段检测驱动策略选择**：ID 字段门槛 unique_ratio≥0.9（UUID>80%→conf .95、熵>0.7∧uniq>0.95→.8、sequential→.9…）；score 字段（值域 [0,1]/[0,10]/[0,100] 加分、拒 sequential、>70% 降序加分，conf≥0.4 判 score）`field_detect.rs:36-204`；temporal（ISO>50% 或 epoch 1e9..2e9）+变点→TimeSeries；logs/search_results→ClusterSample/TopN；默认 SmartSample（`analyzer.rs:322-413,649-696`）。

### 2.2 哨兵 marker（原文全量入 CCR store）

- 行折叠 marker：`<<ccr:{12位SHA-256前缀hex} {N}_rows_offloaded>>`（`crusher.rs:940`），hash=原始数组完整 JSON 字节，存储字节与 hash 一致；作为数组**末元素** `{"_ccr_dropped": "<<ccr:…>>"}` 附加以保持对象数组形状（`crusher.rs:552-576`）。→ **含检索 hash + 折叠计数**。
- 不透明块（stringified JSON/base64/HTML）：`<<ccr:{hash},{kind},{size}>>`（如 `<<ccr:ab12cd34ef56,base64,4.5KB>>`；`compaction/walker.rs:175-208`）。
- 无损渲染时数组节点整体替换为字符串：`[N]{字段:类型,…}` schema 行 + CSV 行（`compaction/formatter.rs:216-290`）——注意这是**类型改变**（数组→字符串），下游要能消化。
- 已含 `<<ccr:` 的字符串永不二次 offload（`compaction/classifier.rs:28,107-109`）。

### 2.3 返回原文的门（全部可复刻）

- 不可 parse→原样；递归深度≤50（`crusher.rs:442-460`）。
- dict 数组路由需 `n≥min_items_to_analyze=5`（`crusher.rs:495`、`config.rs:136`）；`adaptive_k=compute_optimal_k(min_k=3, max_k=15)`，`n≤adaptive_k` → `"none:adaptive_at_limit"` 零收益（`crusher.rs:793-811`）。
- `compute_optimal_k`（`core/transforms/adaptive_sizer.rs:54-104`）：`n≤8→k=n`；SimHash(64bit,Hamming≤3) 聚簇后唯一簇 ≤3→k=3；Kneedle 拐点作用于 unique-bigram 覆盖率曲线（需离对角线>0.05）；无拐点→`n·(0.3+0.7·diversity)`；bias 乘子 `floor(knee·bias)`；zlib(level=1) 校验：全文≥200B 且全量/子集压缩比差>0.15 → k×1.2。
- 标量/混合数组 `n≤8` 必透传（`crushers.rs:119-124,225-227`、`crusher.rs:979-981`）。
- 对象：≥5 键才压（`crusher.rs:634`）；`n≤8` 或 token 估算 `<min_tokens_to_crush=200`（估式 `len(value)/4+len(key)/4+2`）或 `k_total≥n` → passthrough（`crushers.rs:384-400,423-425`）。⚠️ `min_tokens_to_crush` **只作用于对象**，dict 数组路径不查此门（grep 唯一使用点 crushers.rs:398）。
- **crushability 拒绝**（不压不写 CCR，`crusher.rs:888-905`、`analyzer.rs:580-645`）：高唯一度(>0.8)+ID 字段+无其他信号 → 不可压（"唯一实体清单"）；低唯一度+ID 字段 → 高可压。
- 无损优先阶段：`new()` 路径先跑；上线条件 = 压过 **且** 字节收益 ≥ `lossless_min_savings_ratio=0.15`（`crusher.rs:820-845`；doc 里 0.30 是过期注释）。压缩前提：≥2 项全对象；"核心字段"=出现率≥0.8；<60% 键为核心→按 discriminator 分桶（`compactor.rs:131-159`）；不透明单元 offload 门槛 string>256B、base64≥64B∧≥95% 字母表（`classifier.rs:56-78`）。
- `lossless_only=true` 永不折行；`enable_ccr_marker=false` 折了但无 marker/store（静默丢数据模式，`crusher.rs:917-947`）。

### 2.4 不变量

- **输出只含原 item 克隆**，无包装/生成文本/元数据键（`crusher.rs:324-342`；例外：`_ccr_dropped` 末元素、默认关的 `_constant_fields`）。
- **valid JSON** 恒成立（从已 parse 的 Value 树再序列化）；无损胜出的数组→字符串替换除外（类型变、仍合法）。
- **error 行永不丢**：超预算时 error+结构离群+数值异常**全部保留、可越过 effective_max**（文档化行为，`orchestration.rs:144-196`，测试 :437-449）；对象里 error 值的键恒留（`crushers.rs:427-436`）。
- 但 `crush_object` 在 ≥5 键且 ≥200 token 时**真的丢键**（error 值、≤12 token 小值、首尾边界、stride 补位之外全折）——顶层对象 schema 不保。
- 确定性：BTree 集合、最低 index 存活去重（`orchestration.rs:49-68`）。

### 2.5 收益预估：headroom 自己有没有，客户端怎么估

- `estimate_reduction`（`analyzer.rs:700-730`）：基础值 time_series 0.7 / cluster 0.8 / top_n 0.6 / smart_sample 0.5 / 其他 0.3，`+constant_ratio·0.2` cap 0.95——但它是 **item 数**估计且**算了没人消费**（grep 只产不读）。不存在事前字节收益函数；无损阶段也是**渲染后**才量收益（`crusher.rs:825-833`）。
- 客户端可靠的预测器（每条都映射到服务端真实代码路径）：
  1. `n≤8` 标量/混合数组 → 必透传；
  2. dict 数组 `k_est = min(15, max(3, floor(n·(0.3+0.7·diversity))))`（diversity≈内容去重率，SimHash 聚簇代理），`k_est≥n` → 零收益（`crusher.rs:800-811`、`adaptive_sizer.rs:78-89`）；
  3. 近全冗余是大胜局：唯一簇≤3→k=3（`adaptive_sizer.rs:63-68`）；同质重复对象数组→拐点早→高收益；
  4. 无损表收益≈**重复键名字节占比**：`union(keys) 序列化字节 × (n−1)/n ÷ 总字节`；schema 同构（≥60% 键达 ≥80% 行）→ 预估高；异构唯一实体清单 → 服务端 crushability 自己会拒 → 0（`analyzer.rs:605-613`）；
  5. 零收益镜像：首元素非对象（`analyzer.rs:62-73`）、总字节≲200、高字段唯一度+ID 样字段+无 error/异常/score/变点信号。
  实践：bridge 加 `predictSavings()` —— 用 (n vs k_est)、重复键名份额、SimHash 式近似重复簇三条打分，命中"高重复同质"再发请求；UUID 主键的唯一实体清单直接 skip。注意服务端 bias 是调用方给的，客户端估 k 时按 bias=1.0。

---

## 3. Log / Diff / Search 压缩器：对 DSH bash/grep/read 的直接启发

（Rust 为权威实现、Python 为 parity 壳。**三个压缩器 token 收益门默认 0——无收益也返回压缩版**，靠 marker 可逆性兜底；这与 bridge 0.15 门哲学不同。`pipeline/orchestrator.rs:39`。）

### 3.1 LogCompressor（`core/transforms/log_compressor.rs`，1795 行）

- **门**：`<50 行 → 字节级原样返回`（`:934-949`，测试 `:1552-1559`；`min_lines_for_ccr=50` 是误导名，实为"最小动手尺寸"）；内部再检 `min_log_lines=3`。
- **手段=行选择**（不是时间折叠/直方图聚合）：13 级优先级分层 + 全局自适应上限 `compute_optimal_k(min_k=10, max=max_total_lines=100)`。Error/FAIL 各 cap **10**（首+尾钉住，其余按分选）、WARN cap 5 且按模板归一化先去重（冒号/= 后 `0x…`→ADDR、数字→N、路径→/PATH/）、堆栈 cap 3 各截 20 行且 runtime/stdlib 帧折成 `[... N frames collapsed]`、SUMMARY/HEADER/URL 恒选、幸存者 ±3 上下文、INFO/DEBUG 补位。被删行以脚注直方图披露：`[N lines omitted: X ERROR, Y FAIL, Z WARN, W INFO]`（`:1272-1293`）。
- **不变量——没有"ERROR/FATAL 逐字保留"承诺**：FATAL 归 Error 级（`:343`）、error 分 1.0 且首尾钉住先选，但 >10 条 error 只留 10 条，其余**只剩直方图计数**；全局上限还会再剪（地板 10 行）。真正保证的是：①<50 行逐字；②幸存行=原文逐字且原序；③省略必披露；④char-ratio≥0.5 不给 CCR，<0.5 且挂了 store 才存原文+追加 `[N lines compressed to M. Retrieve more: hash=<md5[:24]>]`（`:960-983`）。
- 宣称比率：头注释 "Typical compression: 10-50×"（万行构建日志场景，`:4-6`）；测试不断言比率。
- 模板直方图化（RLE `[Template T1: …] (Nx)`）是**另一条无损 reformat**（`core/transforms/pipeline/reformats/log_template.rs`，min_run=3），不在 LogCompressor 内。

### 3.2 DiffCompressor（`core/transforms/diff_compressor.rs`，1775 行）

- **门**：diff <50 行整体透传（`:291-303`，`min_lines_for_ccr=50` 同族误导名 `:99-105`）；解析不出任何 diff 段 → 透传（`:320-332`）。
- **不变量（三家中最强）**：被保留 hunk 内每个 `+`/`-` 行恒留（context 修剪只动空格行，`:1032-1043`；`always_keep_additions/deletions` 是文档化保留位——因为无条件保留，`:91-95`）；hunk `@@` 头逐字重发不重编号（`:1131-1132`）；`\ No newline at end of file` 恒留（`:1045-1055`）；rename/similarity 标记行、commit 头/Author/`format-patch` 邮件头原样重发（`:669-676,1096-1111`）。
- **有损点**（有侧车 stats 披露）：context 3→2（`:1002-1081`）；每文件 hunk cap 10（首+尾+新增密度 top 分中插回原位，`:921-983`）；跨文件 cap 20 按变更量排序，**被丢文件在输出中整体消失（连文件名都不上线，只进 stats.files_dropped）**（`:341-352`）；parity 怪癖：`new/deleted file mode` 重发硬编码 `100644`（执行位丢）、`Binary files a/x b/x differ` 简化成 `Binary files differ`（`:1113-1122`）。
- 格式面：`diff --git` + merge 形 `diff --combined/--cc` + `@@@/@@@@` 联合 hunk 都解析（`:599-652`）；5+ 父 octopus 透传带警告。锁文件/.min. 过滤**不在这里**——那是新版 pipeline 的 DiffNoise offload（§3.5）。
- 实测证据：合成 8 文件 fixture 177→129 行（ratio 0.729，测试 `:1299-1313,1429-1449`）；CCR marker 仅在 >20% 行收益时给（`:471-481`）。
- 相关性通道：`context` 用户查询词 +0.2/词（len>2 子串，含 CJK 双字元）、变更密度基 0.03/行 cap 0.3、error/security 优先组 +0.3，总 cap 1.0（`:47-72,831-915`）。

### 3.3 SearchCompressor（`core/transforms/search_compressor.rs`，1357 行）

- **无最小尺寸门**：≥1 行可解析就压（`:303-317` 只在 0 可解析时透传）。解析分层 Colon→Dash→Permissive（rg 上下文形 `file-line-content` 也算匹配、与真匹配行竞争预算；Windows 盘符/日期路径特判；负行号拒）。
- **cap**：文件按 Σ 匹配分排序留 `max_files=15`；全局 `compute_optimal_k(min_k=5, max=30)`（min_k=5 是硬地板，30 是软帽）；每文件 ≤5 匹配（首+尾恒留 + 高分补位），幸存按行序还原；文件尾部 `[... and N more matches in FILE]` 披露；`group_by_file`（rg --heading 形）只省路径重复（注释算 ~250 token，`:173-179`）。
- **不变量**：保留的匹配逐字 `file:line:content` 原序；省略必披露；不可解析输入永不改写；但**可解析 blob 里的不可解析行会被丢弃**（计入 `lines_unparsed`）——对不合规混合 blob 是隐性信息损失（`:381-389`）。
- **CCR 门槛**：≥10 匹配 **且** 字节比 <0.8 才存原文给 marker（`:332-352,183-199`）→ **<10 匹配或收益不够的 grep 结果是不可逆折叠**。
- 宣称比率：头注释 "5-10×"（`:4-5`）。打分：匹配行含 query 词 +0.3（含 CJK）、error 关键词 +0.5/0.4/0.3（`core/signals/keyword_detector.rs:43-110`）、config 关键词 +0.4，cap 1.0（`:394-447`）。
- **注册状态关键**：pipeline 里 `SearchOffload` 默认**不接线**（"modern agents scope rg/grep sensibly"，`core/transforms/pipeline/offloads/search_offload.rs:3-12`）——headroom 自己也认为 grep 结果通常不该动。

### 3.4 代理/请求层真实门（bridge 作为客户真正会撞上的）

`core/transforms/live_zone.rs`：只动 **latest user message 内**的 block（live zone，`:40-43`）；**所有内容类型统一 512 字节门槛**，低于连压缩器都不进（`:151-171`）；接受门 = 目标模型 tokenizer 实测 `compressed_tokens < original_tokens`、**且把 ~6-token CCR marker 成本计入**（`:871-901`）；CCR key=BLAKE3[:24]、marker `\n<<ccr:HASH>>`（`core/ccr/mod.rs:86-99`）；路由 **JsonArray→SmartCrusher、BuildOutput→Log、Search→Search、Diff→Diff、SourceCode/PlainText/Html→no-op**（`:1330-1389`）——**代码/纯文本/HTML 在 Rust live-zone 路径压了也白压**；一切异常 fall back 原样（"Compression must NEVER break a request"，proxy/src/compression/mod.rs:26-29）。
- **EMPTY_QUERY 硬编码**：live-zone dispatcher 尚未把用户最新 prompt 传给相关性打分（"PR-F3 will"，`live_zone.rs:123-129`），proxy 也没有构造 CompressionContext——**当前部署路径 diff/search/JSON 的相关性排序实际是 query-less 的**。
- 新版 pipeline 层补充（`config/pipeline.toml`）：reformat 早停 ratio≤0.5；offload 触发=bloat≥0.5 或（reformat 后仍 >0.85 且有 bloat）；bloat 估计器：log=重复度+稀释度（50 行下为 0）、diff=context 占比映射（50 行下 0）、search=平均匹配/文件 (avg−1)/10（10 匹配下 0）、json=`},{`行数/50（5 行下 0）；**DiffNoise**：30 行以下不动，丢弃 **lockfile**（Cargo.lock/package-lock.json/yarn.lock/pnpm-lock.yaml/poetry.lock/Pipfile.lock/Gemfile.lock/go.sum/composer.lock）与 **whitespace-only** hunk 换成 `[diff_noise: …]`（`pipeline/offloads/diff_noise.rs:81-210`）。

### 3.5 对 DSH 工具结果策略的直接结论

1. **bash 输出**（主要是 log 形态）：<50 行发过去必字节回传——bridge 的 500 字符长度门放行的大量中小 bash 结果如果不足 50 行且非 JSON/diff，多半白付往返。本地加"行数门"纯赚。
2. **别指望 FATAL 逐字保全**：>10 error 会被剪成首尾+直方图，且 char-ratio≥0.5 时连 CCR 都没有——bridge 现有"错误输出保护"应保留并**对齐 headroom 的 12 词表**（而不是自造表）；想更聪明可只对"强 error 指标 + 短输出"跳过（见 §6 #5）。
3. **git diff 是低风险高收益品类**：±行/hunk 头/EOF marker 恒留，删的只是第 3 行起的 context 与超 cap hunk——行数≥50 即值得发；但要**客户端自己拦 lockfile/go.sum diff**（DiffNoise 只在新 pipeline，live-zone 路径没有；且被丢文件连名字都不上线）。
4. **grep 维持排除**：headroom 自己都不默认接线 SearchOffload；其改写破坏 `path:line:` 下游解析、<10 匹配不可逆。DSH `grep` 在 excludeTools 是双重正确。
5. **query 信号是客户端可加而服务端忽略的**：代理相关性通道存在但 live-zone 传 EMPTY_QUERY——bridge 若做本地预筛/预钉（把含最近 user prompt 关键词/UUID/路径的行优先保留）是在给系统加服务端当下没有的排序信号；但要克制，避免与代理 cap 双层叠加剪枝。
6. **纯 prose/代码形态**：Rust live-zone 对 SourceCode/PlainText/Html 是 no-op（Python `/v1/compress` 有 Kompress 文字压缩，行为不同——以 bridge 实际打的服务为准），本地预判可把"高散文占比 + 高熵"内容直接 skip 省一次往返。

### 3.6 实测旁证

本会话中 DSH harness 自身的 bridge 对子代理 bash 输出：91 行列表 → 457 项 + `(from 91 source lines)` + retrieve hash；2343→1824 chars（-22%）。log/list 形态收益真实，marker 带计数可校验；retrieve 有过期（实测 404，TTL≈30min）。

---

## 4. headroom-simulators 是什么 + 可迁移的评测方法

**结论先行：它不是压缩评测模拟器，是确定性 mock LLM provider**（假上游 HTTP 服务，喂 proxy 测试，永不打真 API，`crates/headroom-simulators/README.md:3-4`、`src/lib.rs:3-4`）。

- 域类型没有 episode/scenario/metric 词汇：`ProviderPath` 路径分类（Anthropic/OpenAI/Responses/Bedrock/Vertex/会话 CRUD，`src/domain.rs:9-25`）、`RequestFacts`、罐头 `SimulatedResponse`（固定 usage `{12,4}`，`:211-225`）+ SSE 脚本 + Bedrock eventstream 手编帧（`:403-434`）；CLI `--listen` axum 服务（`src/main.rs:10-37`）或 cargo test tower oneshot。
- 通过判据=普通结构断言（`tests/simulator_http.rs:62,95-100,116-117,138-139`；`application.rs:133`），无比率/阈值。
- 唯一可抄机制：**声明式 stub 规则**——JSONL `stubs:[{when:{method,path,body_contains,body_json_pointer{pointer,equals}}, response:{status,headers,json|sse}}]` 首条命中（`src/config.rs:11-53`、`src/application.rs:17,41-67`）。给 TS 侧 mock `/v1/compress` 响应做门控回归，100 行内可复刻。

**真正的压缩质量评测在仓库他处**（回归测试该抄这些）：
1. **`tests/fixtures/fidelity_golden/` + `tests/test_compression_fidelity_regression.py` —— 与 bridge 回归需求几乎完美对口**：fixture `{id, question, content_type, compress:{…}, answer_evidence:[关键串], supporting_facts:[软探针], content:[真实工具输出]}`（如 `logs_oom`：心跳噪音里埋 "OOM killed worker 3"）；`baseline.json` `{aggregate_recall:0.9167, tolerance:0.02}`；硬门 `recall(answer_evidence)==1.0` 否则报 FIDELITY REGRESSION+丢失清单，软门 平均 recall ≥ baseline−tolerance（`:38-79`）；纯 stdlib 无模型无网络、阻塞 PR。
2. `headroom/evals/`：`EvalCase{id,context,query,ground_truth}` JSONL；LLM-in-loop 判据 verbatim（`core.py:334-341`）"F1>0.8 OR semantic_sim>0.9 OR contains ground truth"（runner 变体 0.7/0.85，`runners/before_after.py:354-358`；judge ≥3/5 `:403-420`）；**零模型指标 `compute_information_recall`（`metrics.py:270-312`）**：probe_facts 子串存活率+facts_lost——20 行 TS 可移植。聚合卡 `accuracy_preservation_rate/avg_compression_ratio/total_tokens_saved`（`core.py:125-193`）。
3. 硬承诺可写成断言：SmartCrusher 文档保证 100% 保留 error/异常(>2σ)/查询相关项（`tests/test_quality_retention.py:1-8,26`）。
4. 基准侧：`run_benchmarks.py:20-23` baseline-diff（`--compare baseline.json`）；`real_world_agent_benchmark.py:17-22` 强制 seed 纪律（"引用的任何数字必须报 seed"）；`scenarios/tool_outputs.py` 生成器注入 "UUID 针 + error 行"。
5. 端点级 pass 模板（`tests/e2e_real_compression.py:7-17`）：每端点至少一例 `tokens_saved>0`；"fresh user prompt 被刻意跳过，0 savings 是设计不是 bug"——对应 bridge audit/not-adopted 语义。
6. `e2e/` 目录不是质量评测（CLI 安装 e2e，`assert_exit/stdout_contains` 骨架，形状可抄主题无关）。

**bridge 回归设计（综合）**：JSONL fixtures（真实 DSH 工具结果形态 bash/diff/grep/read + 注入探针）→ 两级门（决策硬门 compress/skip 金标 + recall 硬/软门）→ `--compare` 对比 committed baseline JSON → 报告卡仿 `EvalSuiteResult.summary()`。

---

## 5. freeze / cached-prefix（#3380）：代理如何保 KV 缓存，bridge 该配合什么

### 5.1 机制（有状态 proxy 模式）

- 问题：客户端自管前缀缓存；代理改写已缓存前缀 = 把 90%(Anthropic)/50%(OpenAI) 读折扣换成 25% 写惩罚（`headroom/cache/prefix_tracker.py:1-15,33-45`；TTL 默认 300s `:55-60`）。
- **冻结计数**：响应后按 `cache_read+cache_write` tokens 沿消息累计 walk 出冻结消息数，下轮 pipeline 只压 `index ≥ frozen_count`（`update_from_response :932-978`、`get_frozen_message_count :919-930`，激活门槛 `min_cached_tokens=1024` `:68`）。Anthropic `cache_control` 标记同折 floor（Rust `cache_control.rs:109-133`：floor=最后 marker 的 i+1；system/tools 上的不抬——无条件 cache-hot）。
- **live-zone 模型**：只动 `[frozen_count, 最新 user 消息]`；区间外字节用 byte-range surgery 拼接、永不重序列化，保前后缀 SHA-256 逐字节不变（`core/transforms/live_zone.rs:3-79`）。
- **字节回放**：本轮若是上轮 append-only 扩展（规范化比较吸收移动 cache_control/传输噪音：`_strip_cache_control :124-137`、`_canonicalize_for_prefix_compare :191`），把**上轮实际转发字节**（=provider 哈希过的字节）叠回前缀，只压 delta（`extract_cache_stable_delta :411-443`、`overlay_cached_prefix :446-520`）。
- **#3380（commit aebe9895）核心**：#3052 的"非膨胀尺寸界"在后台压缩产出**更小**形态时拒绝回放 → 转发字节中途变 → 每 1-2 请求重写 160-210k token 缓存（实测 cache-hit 90%→52%、计费输入 2.2x，#3379）。修复：`overlay_cached_prefix(confirmed_frozen_count)` —— **provider 已确认缓存的 floor 内无条件字节回放**（"膨胀"回放按 ~0.1x 缓存读计费，仍远比 bust 便宜）；floor 外尺寸界继续仲裁（收缩回放修 freeze drift #1850，膨胀拒绝让新压缩上线）；TTL 过期/冷缓存 floor 塌缩→积累改进一次性落地（自然 re-baselining #3026）。OpenAI chat 路径同带 floor（缓存按第一处改动字节 bust，机制与 Anthropic 相同）。
- 同族修复史：#1850 freeze 必须字节相同转发；#1852 cache_control 有界稳定；#2085 会话内按"历史是上轮前缀的扩展"拆 lineage（并发子代理共享 fallback session-id 交叉污染 freeze 态，`max_lineages_per_session=32` `:81`）；#2178/#2718 把 `frozen_message_count` 暴露进 `CompressConfig`（`headroom/compress.py:118-125`）与 `/v1/compress` —— **library 模式（bridge 这类自管对话的调用方）被显式支持**。

### 5.2 bridge 侧结论

1. **"写入前压缩"模型 = 免费的最大缓存安全**。bridge 在 `tools/post-execute` 压完才进历史，provider 首见即压缩形态，不存在"先缓存原文再改写"窗口。freeze/回放机器解决的是"代理看到已缓存历史再压"的问题——bridge 当前形态天然免疫。**不要改成批量重压历史**（那会把 #1850/#3052/#3380 三代坑重踩一遍）。
2. 若未来做"历史整理/再压缩"：必须带 `frozen_message_count`（`/v1/compress` 已支持，#2718；语义=上一请求已发出且已被缓存的消息数），floor 内一个字节不改。
3. **append-only 纪律**：代理 delta 机靠"本轮=上轮的原样扩展"识别可回放前缀，改写历史=退化为全量透传（`prefix_tracker.py:433-438`）。DSH 的 todo/system-reminder 类注入应恒加在尾部；插改旧消息既 bust 自家 KV 也废掉代理 freeze（headroom 已为 `<system-reminder>` 混入 system 轮导致 session-id 轮转踩过雷，#2085）。
4. **session 标识**：升到多消息请求时发 `x-headroom-session-id`，否则 fallback id（hash model+system）会被并发子代理共享、交叉污染 freeze 态（#2085/#188）。
5. **CCR TTL**：实测 1800s 后 retrieve 404——DSH 的 retrieve 工具要容忍 404 提示"原文已过期"；bridge 做 marker 校验时别把可检索性当无限承诺。

---

## 6. 对 DSH 插件侧的启示清单

**总原则：不做本地压缩，只做本地预判与门控。** 本地重实现压缩=复制数百行调参逻辑还养不起 parity 测试；预判层每命中一次省一整次 HTTP 往返 + 代理算力。

| # | 算法/判据（出处） | 移植价值 | 成本 | 说明 |
|---|---|---|---|---|
| 1 | **信封剥离再判定**（content_router.py:893-916） | 中-高 | 低 | ~15 行正则。DSH 工具输出常带 `<returncode>`/`<output>` 类包装；本地预判前先剥壳，否则形态误判+长度虚高。 |
| 2 | **代理透传门复刻 = "skip 注定零收益请求"规则表**（log/diff 50 行门 log_compressor.rs:934-949 与 diff_compressor.rs:291-303；n≤8 数组门 crushers.rs:119,225/crusher.rs:979；dict 数组 n<5 门 analyzer.rs:656；512B live-zone 门 live_zone.rs:151-171；"no diff grammar"透传 :320-332） | **高** | 低 | 这些全是服务端**必透传**的门，客户端复刻零风险纯赚往返：`<2 行`、`<50 行且非 JSON/diff 形态`、`≤8 项标量/混合数组`、`<5 项数组`、裸 `+/-` 列表（无 diff grammar）→ 本地直接放行。~60-100 行规则表。 |
| 3 | **JSON 收益预估**：k_est 公式（min(15,max(3,⌊n·(0.3+0.7·diversity)⌋))）、近重复簇≤3=大胜局、重复键名字节占比≈无损表收益上界、"高唯一度+ID 字段+无信号=服务端自己会拒"镜像（§2.5） | **高** | 低-中 | 不实现 crush 本体（全家 ~12.8k 行 Rust + TOIN），只算标量决定发不发。diversity 用内容 hash 去重率近似即可（SimHash 可后置）。 |
| 4 | **zlib-deflate 收益探针**（adaptive_sizer.rs 校验同款思想：全量 vs 子集压缩比差 >0.15；`:100,297-333`） | 中 | 低 | Node `zlib.deflateSync(level 1)`，毫秒级。高熵/base64/minified 内容（deflate 比≥0.85）对任何压缩器都低收益 → skip。是 minSavingsRatio 的**事前版**。 |
| 5 | **error 关键词表对齐（12 词）**（error_keywords.rs:17-30；log 词族 content_detector.rs:176-189；keyword_detector.rs:43-110） | 高 | 低 | bridge 现有错误保护改用同一张表防判定漂移；且据 §3.5② **收窄**：只对"强 error 指标 + 短输出"跳过，别一律跳过（grep 无匹配/exit1 是常规）。 |
| 6 | **Log 形态占比预检**（200 行窗、≥10% pattern 命中，content_detector.rs:421-463）+ "低命中高散文占比" skip（live-zone 对 PlainText/SourceCode no-op，`live_zone.rs:1330-1389`；Python 侧走 Kompress 需另测） | 中 | 低 | bash 输出主形态。命中→log 收益可期（50 行以上）；不命中且高熵→省往返。 |
| 7 | **lockfile/噪音 diff 客户端拦截**（DiffNoise 清单 diff_noise.rs:81-210 的 9 种 lockfile + go.sum + whitespace-only hunk） | 中 | 低 | 该 offload 只在新 pipeline，live-zone 路径没有；bridge 直接对 lockfile diff 本地 skip（或未来把"只发非 lockfile 文件段"做客户端裁剪——但注意与代理 cap 叠加）。 |
| 8 | **release-by-content 白名单**：只放 JSON/tabular/build-log/diff/HTML/search 形态，其余 read 结果默认保护（content_router.py:1053-1084 `_RELEASABLE_READ_TYPES` 判据） | 高 | 低 | bridge 现在是工具名级排除（read/glob/grep 全排除）；升级为内容级：`read` 出来是 JSON/diff/log 才选择性放开——这正是拿"保代码字节"换掉的收益，且 headroom 用**同一判据**在保。 |
| 9 | **fidelity_golden 式回归 + 决策金标表**（§4；metrics.py:270-312 信息召回、两级门、baseline diff；stub 规则格式抄 simulators） | **高** | 中 | 把外包黑盒变可回归契约的唯一路径。决策金标：{fixture → expect compress/skip} + savings>0/==0 断言（e2e_real_compression 风格），headroom 有 test_compression_decision.py 先例但没为 bridge 这类 wrapper 测过——差异化价值在 DSH 侧。 |
| 10 | **CCR marker 语义校验**：regex `<<ccr:[0-9a-f]{12}[^>]*>>`、`{"_ccr_dropped":…}`（crusher.rs:940,552-576）、`[… N items omitted …]`/`[N lines compressed to M …hash=…]`/`[... and N more matches in f]`；折叠计数与原文行数自洽 | 中 | 低 | 给 invariant.ts 加守恒断言；顺带处理 404 过期（§5.2⑤）。 |
| 11 | **frozen_message_count / append-only 架构约束固化**（§5.2） | 高（防未来回归） | 低 | 现在无需实现（写前压缩免疫），但应写进 README/DEV：勿重压历史、尾部追加、多消息化时带 session-id+frozen count。 |
| 12 | 客户端预钉 query 相关行（代理 live-zone 传 EMPTY_QUERY，live_zone.rs:123-129；其打分公式 diff :873-915、search :394-447 就是小写词 len>2 子串 + CJK 双字元 +0.2/+0.3） | 中（存疑） | 中 | 服务端当下忽略 query，客户端预筛能补信号；但与代理 cap 双层剪枝会叠加，收益不稳——建议观望 PR-F3（plumb query 落地）再说。 |
| 13 | Magika/ONNX 本体；SmartCrusher/LogCompressor 本体；SearchCompressor 的分组摘要改写 | 无/低/负 | 高 | 分类器有 AVX2/ORT/熔断矩阵；压缩器本体是 parity 陷阱（任何"本地顺手压一下"的冲动）；grep 分组改写破坏下游解析（维持 excludeTools）。 |

### 优先落地（只做三件事的话）

1. **#2+#4+#5 合成 `predictSavings()` 本地预门**（~150 行）：剥壳 → 形态粗分 → 命中代理透传门即 skip；高熵 deflate 探针过滤；error 表对齐。目标不是精确预估，是砍掉现白付的边缘请求与必透传形态。
2. **#9 回归套件**：fidelity 两级门 + compress/skip 金标 + stub 化 `/v1/compress`。
3. **#11 文档约束**：把 append-only/勿重压历史写成铁律，防未来"历史整理"功能引入 #1850/#3380 系缓存坑。

### 风险与注意

- **版本漂移**：本地门控常量（50 行、n≤8、15×5 cap、512B…）是代理**实现细节**非 API 契约，会随版本动（如 #3419 改 grep-fold/size-weight savings、#3387 AST 熔断）。预判表做成配置 + 用 #9 回归定期验，注明本快照版本。
- 预判只做"跳过"，**永不本地压缩/截断**——破坏 CCR 可逆性与 fidelity 门。
- bridge `minSavingsRatio=0.15` 严于 router 默认 `min_ratio=1.0`（content_router.py:1616）：代理侧门是 token 级（含 marker 成本），bridge 是 char/token 混合估计；调低前重估。
- Python `/v1/compress` 与 Rust live-zone 有行为差（prose 走 Kompress vs no-op；SearchOffload 默认不接线；DiffNoise 仅新 pipeline）——§6 各门以 bridge 实际服务的实测为准，本文 file:line 是 Rust/Python 双侧快照。

---

## 附：关键 file:line 索引（速查）

- **检测级联**：`headroom/transforms/content_router.py:851-882,893-916,919-1044,1053-1084,1596,1606-1617,1765,4217-4244`；`content_detector.py:163-230,243-282,560-689`；`core/transforms/content_detector.rs:86-102,176-189,221-255,283,302-314,386-407,421-463,465-515`；`magika_detector.rs:54-82,364-409,417-433,449-484`；`unidiff_detector.rs:33-38,57-107,83-127`；`detection.rs:55-103`；`mixed_content.py:31-50,92+`
- **SmartCrusher**：`smart_crusher/config.rs:129-161`；`crusher.rs:324-342,442-495,552-576,620-642,672-744,780,793-811,820-863,888-905,917-947,972-1085,1173-1190`；`crushers.rs:76-133,141-161,177-198,225-227,309-312,378-496`；`orchestration.rs:49-136,144-214,234-278`；`planning.rs:96-164,205-217,286-331,368-406,445-455,501-521,606-638`；`analyzer.rs:62-73,250,282-317,322-413,428-556,580-645,656,700-730`；`field_detect.rs:36-204`；`statistics.rs:51-83,158-245,214-256`；`outliers.rs:61-235,250-283`；`error_keywords.rs:17-30`；`anchors.rs:31-112`；`constraints.rs:42-50,64-75`；`compaction/{compactor.rs:131-159,449-499; classifier.rs:28,56-78,107-109; walker.rs:175-208,342-345; formatter.rs:216-290,311-335}`；`anchor_selector.rs:49,81-96,543-552,563-579,600-629,633-712`；`adaptive_sizer.rs:54-104,144-146,265-280,297-333`；`relevance/hybrid.rs:20-21,128-161`；`toin/mod.rs:491`
- **Log/Diff/Search**：`log_compressor.rs:4-6,156-200,243-319,339-397,740-846,934-949,960-983,1071-1072,1109-1152,1160-1195,1210-1216,1239-1255,1272-1293,1552-1559`；`diff_compressor.rs:15-18,47-72,81-121,158-160,246-247,291-332,341-352,471-481,592-652,669-676,831-915,921-983,1002-1081,1096-1122,1131-1148,1299-1313,1429-1449,1653-1680`；`search_compressor.rs:4-5,173-179,303-317,332-352,394-447,458-468,479-480,508-546,591-601,611-873`；`signals/keyword_detector.rs:43-110`；`live_zone.rs:40-43,123-129,151-171,871-901,1267-1298,1330-1389,2297-2299`；`ccr/mod.rs:86-99`；`pipeline/reformats/log_template.rs:236-253`；`pipeline/offloads/{log_offload.rs:101-141; diff_offload.rs:72-128; search_offload.rs:3-12,89-112; json_offload.rs:124-143; diff_noise.rs:81-210}`；`pipeline/orchestrator.rs:39,142-155,210-221`；`config/pipeline.toml:8-13,42-77,114-151`
- **评测**：`crates/headroom-simulators/{README.md:3-4; src/lib.rs:3-4; src/domain.rs:9-25,103-167,211-225,227-307,403-434; src/config.rs:11-53; src/application.rs:17,41-67,133; src/main.rs:10-37; tests/simulator_http.rs:29-48,62,95-100,116-117,138-139}`；`tests/test_compression_fidelity_regression.py:1-10,38-79`；`tests/fixtures/fidelity_golden/{cases.json,baseline.json}`；`headroom/evals/{core.py:21-27,125-193,210-219,300,326-341; metrics.py:47,52-80,203-253,270-312; runners/before_after.py:354-358,403-420; datasets.py:53,374,564,656,862}`；`tests/test_quality_retention.py:1-8,26`；`tests/e2e_real_compression.py:5-17`；`benchmarks/{run_benchmarks.py:20-23; real_world_agent_benchmark.py:17-22; text_crusher_quality_eval.py:31-34; scenarios/tool_outputs.py}`
- **freeze/缓存**：`headroom/cache/prefix_tracker.py:1-15,33-60,63-81,124-137,191,411-443,446-520,873-890,919-930,932-978`；`core/cache_control.rs:109-133`；`core/transforms/live_zone.rs:3-79,603-666`；`headroom/compress.py:111-137`；commit `aebe9895`（#3380，含 #3052 回退背景与 90%→52% 实测）；issue 族 #1850/#1852/#2085/#2178/#2718/#3026/#3379
- **bridge 现状**：`src/config.ts:76-89,191-200`；`src/arm-a.ts:121,171`；`src/proxy-client.ts:64-66`
