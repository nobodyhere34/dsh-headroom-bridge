# 配置参考

本插件全部字段的默认值、生效时机、以及判断规则。行为以 src/config.ts（字段与默认值）、src/protect.ts（门）为准。

## 配置怎么分层

```text
schema 默认值 → 入口配置（cordis.patch.yml 的 config: 段）→ 用户层（设置卡片 / ~/.dsh/settings.yaml 的 headroom 段）
```

后层覆盖前层。卡片编辑写的是用户层；「已覆盖」= 用户层有这条，「恢复默认」= 删掉用户层这条、回落到入口配置（不是回落到 schema 默认，除非入口配置也没有）。任何一层给出非法值 → 写入被拒绝，不会崩溃。

## 字段总表

| 字段 | 类型 | 默认 | 改动何时生效 | 卡片可编辑 |
|---|---|---|---|---|
| enabled | bool | true | **装载时**（false 时装载：钩子/工具/卡片/路由全不挂） | 可（下次装载生效） |
| mode | audit/live | audit | 立即 | 可 |
| baseUrl | string | http://127.0.0.1:8787 | 立即 | 可 |
| timeoutMs | 正整数 | 30000 | 立即 | 可 |
| minChars | 正整数 | 500 | 立即 | 可 |
| minSavingsRatio | 0..1 | 0.15 | 立即 | 可 |
| excludeTools | string[]（glob） | 见下（12 个） | 立即（A 臂按配置身份惰性重编译，与 B 臂同步） | 不可 |
| protectErrorOutputs | bool | true | 立即 | 可 |
| protectPathGlobs | string[]（glob） | 见下（26 个） | 立即（同上） | 不可 |
| maxInflight | 正整数 | 2 | 立即 | 不可 |
| armB.enabled | bool | true | 立即 | 不可 |
| armB.thresholdChars | 正整数 | 16384 | 立即 | 不可 |
| armB.minSavingsRatio | 0..1 | 0.3 | 立即 | 不可 |
| armB.maxPerStep | 正整数 | 2 | 立即 | 不可 |
| ccr.enabled | bool | true | **重载插件**（台账构建时定型） | 不可 |
| ccr.ttlMs | 正整数 | 86400000（24h） | **重载插件** | 不可 |
| ccr.maxEntries | 正整数 | 2000 | **重载插件** | 不可 |
| ccr.path | string | 空 = <DSH_HOME>/storages/dsh-headroom-bridge-ccr.json | **重载插件**；**必须绝对路径**，相对值被忽略 | 不可 |

「立即」= 保存卡片后对之后的候选生效；「重载插件」= 重新装载插件（重启 dsh web 或注入器热重载）才生效。

`excludeTools` / `protectPathGlobs` **不允许显式清空成 `[]`**（空表等于拆掉保护门，配置校验直接拒绝；要中和某项请换成用不到的占位名，如 `["__none__"]`）。

### 默认 excludeTools

```
read, glob, grep, edit, write, multiedit, notebook_edit,
str_replace_editor, web_search, web_fetch, view, todo_write
```

headroom_retrieve 永远不压，不在此表里。

### 默认 protectPathGlobs

```
*.js, *.mjs, *.cjs, *.ts, *.tsx, *.jsx, *.py, *.pyi,
*.go, *.rs, *.java, *.kt, *.rb, *.php, *.cs, *.c, *.h,
*.cpp, *.hpp, *.sql, *.json, *.yml, *.yaml, *.toml, *.lock
```

匹配规则：\* 不跨目录分隔符，整串匹配；对路径值的完整值和文件名各试一次（所以 /a/b/settings.json 和裸名 settings.json 都能命中）。「路径值」= 工具参数里任何含 / 或反斜杠的字符串，或挂在路径形键（path / file_path / filePath / file / filename / old_path / new_path / src / source / target / dest / destination / directory / dir / root / cwd / folder / notebook_path）下的字符串。

## 判断顺序（A 臂）

按序检查，命中即整条结果保持原文：

1. 工具是 headroom_retrieve
2. 工具命中 excludeTools
3. 错误输出（isError；或文本 ≤8000 字符且带强错误标记：traceback / uncaught exception / segmentation fault / fatal error / "error: " / "exception: " / panicked at）
4. 含非文本块（图片等）
5. 长度 < minChars（Unicode 码点）
6. 已带压缩标记（本插件标记 + 原生 <<ccr:…>> / "Retrieve (more|original): hash="）
7. 参数命中 protectPathGlobs
8. 该 callId 已尝试过（每个调用最多试一次，LRU 记 512 个）
9. 并发代理请求已达 maxInflight（跳过，计一次失败）

之后：代理返回的节省比例（token 口径和字符口径取大者）≥ minSavingsRatio 且严格更短，且 mode: live → 原文入台账（读回确认成功）→ 替换模型可见内容。audit 或收益不足：打一行日志（含 before/after 字符数、百分比、策略链），不改内容。

## B 臂

候选 = 当前会话表面（模型现在能看到的节点）里的 tool/result，按 seq 顺序。门 = A 臂第 1–7 步（长度门换成 armB.thresholdChars，工具身份从日志里的 tool/call 反查）+ 本会话已尝试过的不重试 + 每步最多 armB.maxPerStep 个 + 收益门 armB.minSavingsRatio + mode: live（audit 只打日志）+ 需要 tokenMeter 服务在场（缺则跳过并 warn）。替换走 dsh 标准机制：先 compaction/prune 计量事件，再表面替换并引用被遮蔽节点；原文保留在日志。

## 容易踩的坑

1. **enabled 不是运行期开关**。装载时读一次：false 装载 = 什么都不挂（连卡片都没有）。运行中在卡片关掉，当前实例继续工作，下次装载才停。
2. **live + ccr.enabled: false = 零采纳**。采纳前断言「原文已可赎回」，台账关闭时这条断言必失败 → 每次尝试都 fail-open 计失败。要压缩就保持台账开（默认就是开的）。
3. **热 / 重载边界**：卡片能改的字段里只有 enabled 是重载语义；excludeTools、protectPathGlobs 卡片改不了，但改配置文件/入口后**立即生效**（A 臂按配置身份惰性重编译，不再需要重载）；只有 ccr.* 改了要重载。
4. **ccr.path 写相对路径会被静默忽略**，回落到默认位置。
5. **台账写入是 1 秒防抖**的（tmp 文件 + rename 原子写）。进程在防抖窗口内被 kill，最近约 1 秒的条目可能丢；正常卸载会立即 flush。
6. **原子写用 os.tmpdir() 中转**：如果 tmp 目录和 DSH_HOME 不在同一文件系统（EXDEV），降级为纯内存台账（有 warn 日志）——重启后台账为空。
7. **台账是全局的**：跨 profile/会话共享，按内容去重，驱逐只看写入时间。
8. **校验失败 = 拒绝写入**：数字要正安全整数、比例要在 0..1、字符串数组元素要非空且无首尾空白。卡片保存失败会保留草稿。

## 示例

```yaml
# ~/.dsh/settings.yaml 用户层（只写要覆盖的字段）
headroom:
  mode: live
  minChars: 800
  maxInflight: 4
  armB:
    thresholdChars: 12000
    maxPerStep: 3
  ccr:
    ttlMs: 604800000            # 7 天
    path: /data/dsh-ccr.json    # 必须绝对路径
```

```yaml
# cordis.patch.yml 入口配置（base 层，插件包内）
- insert:
    - id: dsh-headroom-bridge
      name: '@nobodyhere34/dsh-headroom-bridge'   # 包名，模块说明符
      config:
        mode: audit
        baseUrl: http://127.0.0.1:8787
```

## 相关

[README](../README.md) · [开发指南](DEV.md) · [调研与规划](PLAN.md)

