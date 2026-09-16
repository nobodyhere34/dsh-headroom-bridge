# 开发与发布指南

日常开发、验证、发版流程。

## 仓库布局

```text
src/            host 半源码（tsc → lib/）
  index.ts      入口：挂两臂/两工具/设置/路由/台账；enabled=false 装载时零挂载
  arm-a.ts      tools/post-execute 主臂
  arm-b.ts      agent/pre-step 次臂
  protect.ts    保护门（纯函数，可单测）
  store.ts      本地台账
  proxy-client.ts  代理三端点 HTTP 客户端
  settings.ts   设置命名空间 + 可变配置源
  api.ts        /headroom-bridge/api 路由
  config.ts     字段/默认值/校验（唯一配置面）
src/client/     client 半源码（tsdown → lib/client.js 单文件 bundle）
lib/            **提交的构建产物**（host + client.js + 类型声明）
tests/          6 个 node --test 套件（mock 代理/会话，不需要 dsh 运行时）
scripts/build.sh  host 半构建
market-submission/  插件市场提交 yml（占位待补）
docs/           本指南 / 配置参考 / 调研规划
cordis.patch.yml  插件入口（id/name/config = 设置 base 层）
```

## 环境要求

- Node 24、npm/pnpm
- 一份 dsh 源码 checkout（编译用的 tsc 和依赖都来自它），本机在 /media/ict/19BD52556106DE5A/deepseek-harness（当前 detached 在 dsh-v0.1.5-rc.2）
- 功能验证时需要本地 headroom 代理（默认 http://127.0.0.1:8787）

## 构建

```sh
DSH_CHECKOUT=/path/to/deepseek-harness bash scripts/build.sh   # src → lib（host 半，tsc）
pnpm run build:client                                           # src/client → lib/client.js
pnpm run typecheck
pnpm run smoke                                                  # 打包产物挂载冒烟：假 loader/ctx 驱动 apply，验注册形状
pnpm run check                                                  # 上面全部
```

build.sh 做三件事：探测 DSH_CHECKOUT（env → $HOME/dsh-harness → $HOME/dsh → $HOME/.dsh/dsh-harness）；在 node_modules/ 建指向 checkout 的 symlink（vendor/cordis、vendor/cosmokit、vendor/schemastery、core 包、llm/compaction/settings/host 包、@types/node 等）——编译期依赖全部来自 checkout，不做网络安装；tsc 产出 lib/。

**lib/ 是提交物。** 改了 src/（含 src/client/）必须两个半都重建，并把 lib/ 一起提交。部署侧直接读 lib/：源码和 lib 不一致 = 线上行为与仓库不符。

## 测试

```sh
node --test tests/
```

覆盖：配置解析/校验（含非法值拒绝）、台账（TTL/驱逐/原子写/损坏容错）、glob 匹配与标记识别、保护门全链、A/B 臂行为（桩代理 + 桩会话）。单元级，跑得快；**没有 CI**，端到端行为（钩子时序、设置卡、KV 影响）要在真实部署里按 README 快速开始走一遍。

## 验证（两种部署形态）

### 标准插件装配（用户侧）

```sh
dsh plugin --profile web add /absolute/path/to/dsh-headroom-bridge
# 重启 dsh web
```

看：卡片出现 → Proxy 健康 ✓ → audit 下计数增长 → 切 live → 新结果出标记 → headroom_retrieve 赎回成功。

### 超级注入器（开发侧，本机已装 dsh-super-injector）

```text
dev_plugin_status                                        # 看已装配插件
dev_inject_plugin { dir: '<本仓库绝对路径>' }             # 运行时注入，免重启
dev_reload_package { packageName: 'dsh-headroom-bridge' }  # 改 lib 后热重载
dev_uninject_plugin { match: 'dsh-headroom-bridge' }      # 卸载
```

本机 profile 的 node_modules 对本仓库是 symlink 部署：改 lib/ → 热重载即换线上行为，不用重启 dsh web（client 半改了要 build:client + 重载/刷新页面）。

日常循环：

```text
改 src → build.sh + build:client → node --test tests/ → dev_reload_package → 页面验证
```

## 发版

1. package.json 的 version 递增（契约变更 minor，修复/文档 patch）
2. CHANGELOG.md 加分节：## v0.x.y (日期) + 新增/优化/修复（中文，沿用现有体例）
3. 重建 + typecheck + node --test tests/ 全绿
4. pnpm pack（files 字段已限定打哪些文件）
5. git 提交（含 lib/）→ git tag v0.x.y → 推送（用 gh CLI 身份，不改环境 git config）
6. gh release create v0.x.y <tgz>（notes 用 CHANGELOG 对应分节）
7. 上架市场的话：补齐 market-submission/dsh-headroom-bridge.yml 的占位（owner/url/category/描述）

## 待办（指针 → docs/PLAN.md）

- **D0（已完成，待 v0.1.1 发版）**：bare 导入修正（cordis/schemastery → `@deepseek-ai/`）、`ctx.settings.installSection` 迁移、arm-B 会话接口（`SessionSeq`/`snapshotEvents`/`surfaceOp.startSeq`）与 client 半（`dsh-client-store`/`dsh-client-ui-settings`）适配 dsh-v0.1.5-rc.2、lib 重建——余下 v0.1.1 发版动作
- **D1**：主线基线决策（已按 rc.2 单基线适配，0.1.2-rc.1 兼容放弃；矩阵若恢复再评）
- **D2**：子智能体策略（外部报告默认策略、级联删除、父子统计）
- **D3**：设置卡扩面（代理侧 stats/TOIN）、代理 0.37.x 升级评估
- **D4**：主线 PR（官方包仍未合并）+ 压缩 backlog（运行期总开关、台账按会话清理、live+ccr=false 死锁、多模态、跨 FS 原子写、CI）

发现明细（代码缺陷 A1–A4、文档纠错 B1–B17、行为事实清单）见 docs/PLAN.md 第 1 节。

## 排障速查

| 症状 | 先看 |
|---|---|
| build.sh 报找不到 dsh checkout | DSH_CHECKOUT 没设、探测路径也不对；显式 DSH_CHECKOUT=… 再跑 |
| 改了 src 线上没变化 | 忘了重建 lib/（或忘了热重载/重启） |
| 装载即崩、Cannot find module 'schemastery' | node_modules symlink 缺失 → 重跑 build.sh（最终靠 D0 的导入修正） |
| 设置卡不出现 | 装载时 enabled=false；client 半没构建/没刷新；命名空间未被提供 |
| 卡片保存失败 | 值没过校验（规则见 CONFIG.md）；草稿保留供修正 |
| 台账不持久 | warn 日志：EXDEV（tmp 与 DSH_HOME 跨文件系统）或目录不可写；临时表现为内存态 |
| 代理健康但全失败 | timeoutMs 太小（冷启动/大文本）；或代理端 CCR 模式未开 |
| 热重载后路由/卡片残留 | dev_clear_routes { prefix: '/headroom-bridge' } |

