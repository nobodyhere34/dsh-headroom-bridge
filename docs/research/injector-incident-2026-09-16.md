# 注入器自重载事故与卡片丢失修复（2026-09-16，进行中）

## 问题
设置→插件→插件配置里 Headroom 卡片消失。

## 根因链（全部有证据）
1. **client 表行丢失 = 重启时序 bug**：注入插件的 UI 行由注入器 `refreshClientRow` → client-modules
   `processOne` 注册；重启后 `autoRestore` 跑得太早（clientModules 未就绪时 `ctx.get` 拿不到就静默放弃），
   今晨 08:52 重启后卡片即丢（dsh web = pts/0 前台 `pnpm dsh web`，08:52 启动）。
2. **注入器 self-heal 一直是 no-op**：`pkgMeta` 缓存键是 `${baseUrl}\0${loaderName}` 复合 sourceKey
   （client-modules `src/index.ts:854`），注入器用裸包名 `delete` 永不命中；且只处理自己一个包。
3. **`processOne(name, onError)` 双参签名**，注入器单参调用，reconcile 抛错炸穿外层 catch 静默吞掉。
4. 尝试修复注入器（`/home/ict/dsh-super-injector/lib/index.js`，三处：复合键失效+重试、registry 全量 heal、
   `dev_client_refix` 工具）→ **自重载 reboot-failed**：apply 报
   `Cannot read properties of undefined (reading 'render')`（嫌疑 = 新工具定义缺 `output` 字段，
   cordis tools.register 校验 `tool.output.render`；与"18 个 safeRegister/25 处 output"的既有形态差异待精确复现）。
   3 次 heal 耗尽（loader 残留 failed entry 挡住官方重装配）→ 注入器 fiber 死亡，dev_* 工具全部消失。
   运行时无热装配通道（touch patch / settings.yaml 语义变更均无法让 runtime 重建已 dispose 的 entry）。

## 当前状态
- `lib/index.js` 已回滚到修改前工作版（`index.js.bak-113452`，今晨验证可启动）。
- 被拒的新代码留存于 `lib/index.js.rejected-refix`；rebooter/heal 已放弃，注入器目前离线。
- profile 已补：dependencies 加注入器 link（bundles 原本就有）→ 重启后官方装配必带注入器。
- headroom bridge：host 完全正常（`/headroom-bridge/api/stats` 200，live 模式，v0.1.2 代码），仅缺 client 卡片行。

## 需要人工介入（唯一未试的非重启通道已排除）
**重启 dsh web**：在跑 `pnpm dsh web` 的终端 Ctrl+C 后重跑。本会话日志持久化，重启后可继续。

## 重启后的修复顺序
1. 确认注入器回来了（dev_plugin_status）；确认 headroom host 插件在。
2. **把 bridge 从注入形态迁到官方装配（根治卡片丢失）**：
   `dev_uninject_plugin` → `dev_install_package`（写 profile dependencies+bundles、junction、
   loader.create 热装配）；官方 bundles 路径由 client-modules 原生扫描注册 client 行，
   不再依赖注入器时序（usage-stats 走此路有卡为证）。验证 `/plugins/<entry-id>/client.js` 200。
3. 重做注入器修复（小步验证）：先只加 `invalidatePkgMeta`+重试（不加新工具），reload 验证能起；
   `dev_client_refix` 工具补上 `output: { schema: {...}, render: ... }` 完整形态后单独加，再 reload 验证。
   每步 `node --check` + reload precheck（注入器自带 precheck 拒绝起不来的代码）。
4. 恢复 `settings.yaml` 里临时的 touch 注释行（两条 `# touch...` 注释可删可留，无语义影响）。

## 卡片临时替代（重启前可用）
命令行等价：`curl http://127.0.0.1:3080/headroom-bridge/api/{stats,health}` +
`headroom_stats` / `headroom_retrieve` 模型工具；改配置直接编辑 `~/.dsh/settings.yaml` headroom 段。

## 根因终审（同日，结案）
上面的注入器假设被最终证伪。**卡片消失的真正根因是 bridge 0.1.2 自引入的回归**：

1. 0.1.2 为堵 `[] ?? fallback` 静默清空洞，给 `resolveConfig` 加了
   `stringArrayNonEmpty`：`excludeTools/protectPathGlobs` 为 `[]` 时直接 throw。
2. schemastery 解析 settings scope 时会把**未声明的数组字段物化为 `[]`**
   （resolved 值恒含 `excludeTools: []`、`protectPathGlobs: []`、`armB: {}`、`ccr: {}`）。
3. `installSection` 在注册 ns 后**同步调用 `onChange()`** → `source.setRaw(current())`
   → `resolveConfig(物化[])` → **throw** → inject fiber FAILED（state 3）→
   ns 注册被回滚 → 插件配置卡片消失，且运行态永远停在 entry 基线（mode=audit）。
4. 官方 bundles 路径 / 注入路径 / 重启与否全部无关——0.1.2 起每次装载必炸。

诊断路径（全部经 dev_stage 后侧工具，零 schema 污染）：clientModules 表键 →
`settings.describe()` ns 缺席 → bridge fiber ctx `reflect._getImpl('settings')` FOUND →
`registry.values()` 扫到 FAILED fiber，`_error` 直指 `stringArrayNonEmpty`。

修复（本次提交）：`stringArrayOrDefault`——空数组回退内置默认（保护门永不为空、
但绝不 throw），非法条目类型照旧强校验；测试语义同步更新（38 全绿）。
热重载 `dev_reload_package` 验证：ns 注册 ✓、用户层 `mode: live` 获胜 ✓、
运行态 stats mode=live ✓。

顺带结论（对生态有用，非本次事故必需）：
- 任何插件把 resolveConfig 类校验接进 installSection 的 onChange 时，**必须容忍
  schemastery 物化的容器默认值**（`[]` / `{}`），否则 boot 必炸卡片。
- `installSection` 语义：`setSource` → `onChange` 同步执行在注册之后；onChange 抛错
  = ns 注册作废 + inject fiber 死亡，且**没有**自愈重试。
