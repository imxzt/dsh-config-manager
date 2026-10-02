# dsh-config-manager

给 DSH（DeepSeek Harness）用的**配置版本管理 + 健康诊断 + 崩溃恢复 + 会话文件修复**工具。

**外部 Web UI 为主**——因为它必须在 DSH 起不来时仍然可用。

- 零 npm 依赖（只用 Node.js + git）
- 支持 DSH 桌面版（Electron）、Web、CLI 三种启动方式
- 216 个自测断言，含事故成因复刻

## 为什么需要它

两件事催生了这个工具：

1. **profile 重置事故**：装插件时 pnpm 连带删掉了某个包，而它仍在 `dsh.profile.bundles` 里
   → 下次启动 `resolveBundleDir()` 硬失败 → DSH 触发 profile 恢复，把 bundles 重置成 2 个、
   `cordis.patch.yml` 覆盖成模板，**全部插件配置静默丢失**。
2. **`dsh-undo-savepoint` 在桌面版下保护的是错误的 profile**：它只解析 argv 的 `--profile`，
   桌面版由 Electron 启动、没有该参数，于是兜底成 `web`，真正的 `desktop` 配置从未进过它的快照。

本工具针对性地解决这两件事：**崩溃前有还原点，崩溃时能一键回滚，崩溃前还会拦住你**。

## 安装

### 方式一：用 dsh 装（推荐，最简单）

```bash
dsh plugin add github:imxzt/dsh-config-manager --profile desktop
```

`--profile` 是必需的（DSH CLI 不提供默认值）。把 `desktop` 换成你要装的 profile 名。

这一条命令会自动完成三件事（实测验证）：

1. 从 GitHub 拉取仓库到 `<profile>/node_modules/dsh-config-manager`
2. 写入 `dependencies`：`"dsh-config-manager": "github:imxzt/dsh-config-manager"`
3. **自动加入 `dsh.profile.bundles`** —— 这一步是它出现在 Plugins 页、且 boot 合并
   本包 `cordis.patch.yml` 的前提

装完重启 DSH（或 profile 开了 HMR 则自动重组）即可在侧栏看到「配置管理」入口。

> 实测于 DSH 0.2.0-rc.2 + pnpm 11.7.0：安装耗时约 5 秒，落盘为**目录联接**
> （不是实体副本，所以改源码即时生效），BOM、测试、webui 全部完整。

### 方式二：克隆 + 安装脚本（可控性最好）

```bash
git clone https://github.com/imxzt/dsh-config-manager.git ~/.dsh/plugins/dsh-config-manager
cd ~/.dsh/plugins/dsh-config-manager
```

Windows：

```powershell
.\scripts\install.ps1                 # 默认 desktop profile
.\scripts\install.ps1 -Profile web    # 指定 profile
```

这个脚本与方式一的区别：

- **不走 pnpm** —— 只建目录联接 + 改 manifest 两个字段，不动 lockfile、不动其它依赖
- **装前自动打还原点、装后强制预检**，不合格会告诉你用 `recover --yes` 回退
- 适合"我已经有别的插件，不想让 pnpm 动我的依赖树"的场景

macOS / Linux（手动建联接）：

```bash
ln -s "$PWD" ~/.dsh/profiles/desktop/node_modules/dsh-config-manager
# 然后编辑 ~/.dsh/profiles/desktop/package.json：
#   dependencies 加 "dsh-config-manager": "file:../../plugins/dsh-config-manager"
#   dsh.profile.bundles 加 "dsh-config-manager"
```

### 方式三：只要外部 UI（不装插件）

本工具的核心价值**不需要装进 DSH**。克隆下来直接用即可：

```bash
node bin/dcm.mjs health      # 诊断
node bin/dcm.mjs preflight   # 现在能不能重启
node bin/dcm.mjs serve       # 打开 Web UI
```

这正是设计意图：DSH 崩溃时页面内插件加载不了，外部入口才是可靠的那个。

### 卸载

```bash
dsh plugin remove dsh-config-manager --profile desktop
```

或用自带脚本（顺序已固化为「先摘 bundles → 再摘 dependencies → 最后删联接」）：

```powershell
.\scripts\uninstall.ps1
```

⚠️ **顺序很重要**：如果先删包、后改清单，会出现「`bundles` 声明了但磁盘没有」的
中间状态，此时 DSH 一启动就硬失败，并把整个 profile 重置成模板。详见
[为什么需要它](#为什么需要它)。

### 环境要求

- **Node.js 18+**（DSH 自带运行时，`dcm.bat` / `dcm.sh` 会自动找）
- **git**（配置版本管理必需；其它功能无 git 也能用）
- Windows / macOS / Linux

## 快速开始

```bash
./dcm.sh              # macOS / Linux
.\dcm.bat             # Windows
```

不带参数会打开外部 Web UI（默认端口 14711，带 token 门）。

## 命令行

```powershell
.\dcm.bat status                 # 工作区状态
.\dcm.bat health                 # 健康诊断（7 项）
.\dcm.bat crash                  # 崩溃评估
.\dcm.bat preflight              # 现在能不能重启（退出码 0/1）
.\dcm.bat plugins                # 插件总览
.\dcm.bat neutralize --dry-run   # 试算：会摘除哪些不可解析 bundle
.\dcm.bat recover --yes          # 回滚到最近可用还原点
.\dcm.bat save "说明"             # 建还原点
.\dcm.bat sessions scan          # 会话文件扫描
.\dcm.bat sessions fix           # 修复（自动备份）
.\dcm.bat serve --open           # 启动外部 UI
```

全局选项：`--home <dir>` `--profile <name>` `--json`

## 它做什么

### A. 配置版本管理
基于 `~/.dsh` 下的 git 仓库（与早期的 `dshcfg.ps1` 共用同一个仓库）。

| 能力 | 说明 |
|---|---|
| 建还原点 | `save` —— 暂存全部改动并提交 |
| 查看改动 | `status` / `diff` |
| 回滚 | `restore <ref> [path]`，逐文件、容忍缺失 |
| 任意两点 diff | 不只看对当前，可对比任意两个还原点 |
| 里程碑 tag | `tag <name>` |
| 丢弃改动 | `restore -All` 语义（含未跟踪文件清理） |

**关键设计**：仓库强制 `core.autocrlf=false` + `* -text`，保证 `restore` 与提交时**逐字节一致**
（Windows 默认会把 LF 转 CRLF，那会让配置回退失真）。

### B. profile 健康诊断（7 项）
每项都对应一次真实事故，不是假想检查：

1. **manifest 可读性** —— 含 BOM / 非法 JSON（DSH 在 `JSON.parse` 前就中止）
2. **bundle 可解析性** —— 声明了但磁盘没有 → 下次启动必硬失败。**`@deepseek-ai/*` 被正确
   识别为安装包提供，不误报**（这正是 undo-savepoint 恒误报的根因）
3. **bundles ↔ dependencies 一致性** —— 孤儿声明 / 未启用但可用的包
4. **profile 重置形状** —— 只有模板 2 个 bundle + patch 只剩 DSH 自管条目 → 报错并给出恢复命令
5. **lockfile 同步** —— 声明的依赖是否都在锁文件里
6. **`file:` 依赖联接** —— pnpm install 会把联接换成实体副本，静默破坏「改源码即时生效」
7. **profile patch** —— 悬空 `insert:`、块内重复挂载（顶层重复是 DSH 的合法覆盖机制，不误报）

### D. 插件操作护栏
**不接管装卸本身**——DSH 自带的 `plugin_manager` 已用正确顺序（"removal deselects and
unloads the bundle before pnpm runs"），重造没有收益。护栏的价值在装卸**前后**：

| 能力 | 说明 |
|---|---|
| 插件总览 | bundles / dependencies / 磁盘实况三者对齐，标出风险项 |
| **启动预检门** | `preflight` —— 把健康检查、插件风险、崩溃痕迹合成一个「现在能不能重启」的判据 |
| 变更前还原点 | `beforeChange` —— 任何改动前先存一个还原点 |
| 变更后预检 | `afterChange` —— 强制检查，不合格就警告「不要重启」并给出回滚命令 |
| 一步式护栏 | `guard(ctx, 说明, fn)` —— 打还原点 → 执行 → 预检 |
| 摘除不可解析 bundle | `neutralize` —— 一键修掉事故的直接成因（依赖声明保留不动） |
| 已知有害插件 | 内置 `dsh-conflict-guardian` 与 `dsh-session-recycle-bin` 的风险说明（附实测证据） |

### F. 会话文件扫描与修复
替代已移除的 `undo_scan`。处理两种损坏：

- **单帧布局违规**（legacy）：整个日志压成一帧 → 拆成「header 帧 + 其余帧」
- **synthetic-closer 重叠**：崩溃恢复留下的合成收尾帧造成 seq 重叠 → 删除该帧，循环直到干净

修复前**必定生成 `.bak-<时间戳>` 备份**，且修复后三重校验（文本一致、逐行合法 JSON、重分析 ok）。
产出帧带 checksum（与 DSH 落盘一致——`ZSTD_c_checksumFlag`，注意不是
`Symbol.for('zlib.zstdChecksum')`，后者会被静默忽略）。

## 命令行

```powershell
.\dcm.bat status                 # 工作区状态
.\dcm.bat health                 # 健康诊断（7 项）
.\dcm.bat crash                  # 崩溃评估
.\dcm.bat preflight              # 现在能不能重启（退出码 0/1）
.\dcm.bat plugins                # 插件总览
.\dcm.bat neutralize --dry-run   # 试算：会摘除哪些不可解析 bundle
.\dcm.bat recover --yes          # 回滚到最近可用还原点
.\dcm.bat save "说明"             # 建还原点
.\dcm.bat sessions scan          # 会话文件扫描
.\dcm.bat sessions fix           # 修复（自动备份）
.\dcm.bat serve --open           # 启动外部 UI
```

全局选项：`--home <dir>` `--profile <name>` `--json`

## 架构

```
lib/paths.mjs     路径解析（profile 判定的唯一真源）
lib/git.mjs       git 操作
lib/health.mjs    7 项健康检查
lib/crash.mjs     崩溃检测与恢复
lib/sessions.mjs  会话文件扫描/修复
lib/plugins.mjs   插件护栏（总览/预检门/摘除）
lib/server.mjs    HTTP 服务器（token 门 + JSON API）
webui/            静态页（原生 JS，零构建）
bin/dcm.mjs       CLI 入口
test/             自测（216 个断言）
```

**零 npm 依赖**——只依赖 node 与 git。外部 UI 要在 DSH 崩溃时可用，多一个依赖就多一个坏点。

### profile 判定（与 undo-savepoint 的关键差异）

优先级链：显式 override → `$DSH_PROFILE` → argv `--profile` → **argv 里的 profile 目录位置参数**
→ 唯一存在的 profile 目录 → `desktop`。

最后那两条是关键：桌面宿主把 `<home>/profiles/desktop` 作为位置参数传给
`dsh-desktop-host`，这是桌面版下唯一可靠的线索。`$DSH_PROFILE` 只由 `dsh-shell-env`
注入到模型 shell 子进程，**宿主进程读不到**。

## 页面内插件（可选）

侧栏注册一个「配置管理」面板入口（`sidebar.panellist` + `main` 键控槽），面板内显示健康与预检摘要，并提供「打开完整 UI」按钮。

**方案 1 的取舍**：面板只是摘要，完整 UI 在外部服务器。因为 DSH 崩溃时页面内插件根本加载不了，而崩溃恢复恰恰是那时唯一需要的东西——把完整 UI 写两遍必然漂移。

**安装**（用脚本，**不要**用 `pnpm add`）：

```powershell
.\scripts\install.ps1              # 幂等；装前自动打还原点，装后自动预检
.\scripts\uninstall.ps1            # 幂等；保留数据目录
```

脚本只建目录联接 + 改 manifest 两个字段，**不动 lockfile、不动其它依赖**。`pnpm add` 会把 `file:` 依赖物化成实体副本（破坏改源码即时生效），还可能连带改动依赖树——2026-10-03 的事故就是 pnpm 报告 `+1 -26` 连带删包导致 profile 被重置。

`uninstall.ps1` 的顺序是它存在的全部意义：**先从 bundles 摘声明 → 再从 dependencies 摘 → 最后删联接**。反过来会让「声明了但磁盘没有」存在一段时间，此时 DSH 一启动就把整个 profile 重置。

## 安全

- 外部 UI 只绑 `127.0.0.1`，且要求 token（写在 `plugins/dsh-config-manager/.token`）
- 回环**不是**可信边界——本机任何进程都能访问回环端口，而这个 UI 能改写配置
- 页面打开后 token 从地址栏抹掉（存 sessionStorage），避免被截图/历史记录带走
- 静态文件服务拒绝任何 `..` 路径段
- 破坏性 API 要求 `confirm:true`（`discard` / `recover` / `neutralize`）
- 页面内插件的宿主路由带信任围栏（回环 Host + 非 cross-site + 同 hostname Origin）

## 测试

```powershell
node test\run.mjs
```

（用任意 Node.js 18+ 均可；DSH 内置运行时在 `$env:DSH_HOME\dsh-runtimes\*\dependencies\node\bin\node.exe`。）

216 个断言，覆盖：profile 判定优先级（含桌面版 argv 反推）、git 全操作、
CRLF 逐字节还原、7 项健康检查（含重置形状回归）、崩溃评估与恢复的取证语义、
会话修复的构造损坏样本与真实文件冒烟、插件护栏（含事故成因复刻）。

安装/卸载脚本另有隔离演练：在临时 home 上验证顺序、联接删除安全性、源目录完好。

## 已知限制

- **不接管插件装卸**：DSH 自带的 `plugin_manager` 已用正确顺序（"removal deselects and
  unloads the bundle before pnpm runs"），重造轮子没有收益。本工具的价值在装卸**前后**：
  自动还原点与预检门。
- 页面内插件的面板是**摘要**而非完整 UI（见上）。
- 跨盘符时 `install.ps1` 会显式失败而非静默写错 `file:` 说明（真实部署下 profile 与插件同在 `DSH_HOME`，不会触发）。

## 路线图

- [x] A 配置版本管理
- [x] B profile 健康诊断（7 项）
- [x] C 崩溃检测与恢复
- [x] D 插件操作护栏
- [x] F 会话文件扫描与修复
- [x] 外部 Web UI（5 个页面：总览/健康/插件/版本/会话）
- [x] 页面内插件（侧栏入口 + 摘要面板 + 安装/卸载脚本）

全部完成。