# dsh-restart-button

**给 DeepSeek Harness 桌面版加一个一键重启**——侧栏品牌行「DeepSeek Harness」字样右侧一个刷新按钮，
外加一条 HTTP 接口，让 Agent（或脚本）可以自己重启应用。

[English](README.md)

---

## 为什么需要它

打包发布的 DeepSeek Harness 桌面版**没有任何重启入口**：

| 你以为会有入口的地方 | 实际情况 |
|---|---|
| 托盘右键菜单 | 只有「打开应用」和「退出应用」 |
| 应用菜单 | 代码里确实有 `Restart App and Host`，但它被 `const development = !app.isPackaged` 挡着，**只在开发模式出现** |
| 关闭窗口 | 缩到托盘，不会退出 |

于是每次装插件或改配置需要新进程时，都得*托盘退出 → 找图标 → 再启动*。这个插件补上那个按钮。

## 环境要求

| | |
|---|---|
| **系统** | Windows（树外 worker 依赖 WMI、`wscript.exe` 和 Win32 取前台） |
| **宿主** | DeepSeek Harness `0.2.0-rc.2` 桌面版 |
| **profile 补丁** | **必需**——一条 `disabled: true`，见下面的第 1 步。不加这条，插件能装但按钮不会出现。 |

## 安装

### 1. 先加 profile 补丁（必需）

侧栏的 7 个渲染位几乎都是 `single` 槽，而 slot 注册表对 `single` 槽的**第二次注册会直接抛错**
（`dsh-client-ui-slots`：`single slot "<name>" already has a registration`）。品牌行归随附的
`@deepseek-ai/dsh-client-ui-brand-official` 所有，所以它必须让位。侧栏自己的文档把这件事写成受支持的用法——
*"部署可以替换品牌标记或名称"*——而本插件会重新渲染官方 wordmark，标题看起来不变。

在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 末尾追加：

```yaml
- id: ui-brand-official
  name: "@deepseek-ai/dsh-client-ui-brand-official"
  disabled: true
```

（`ui-brand-official` 是 `@deepseek-ai/dsh-web-app/cordis.patch.yml` 里声明的行 id。）

### 2. 安装 bundle

DSH 插件就是一个普通的 profile bundle，两种方式都行：

```powershell
# 从本仓库安装
dsh plugin --profile desktop add git+https://github.com/FIZMIE/dsh-restart-button.git

# 或从本地目录安装
dsh plugin --profile desktop add C:\path\to\dsh-restart-button
```

### 3. 刷新页面

浏览器半区的变化由 `dsh-client-modules` 增量扫描，不需要重启进程——刷新一下即可。
按钮会出现在「DeepSeek Harness」字样右侧。

## 你会得到

- **品牌行按钮**——「DeepSeek Harness」字样右侧的刷新图标。点击 → 确认 → 整个应用重启：窗口消失、
  自己回来、被切到前台、页面自动刷新。
- **给 Agent / 脚本的通道**——`POST /dsh-restart-button/restart`，Agent 可以自己重启，不用你动手。

## HTTP 接口

全部挂在宿主 web server 的 `/dsh-restart-button` 下：

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/status` | 进程身份、解析出的可执行文件、是否可重启 |
| `GET` | `/health` | `bootId` + 运行时长；浏览器半区靠它发现新进程 |
| `POST` | `/restart` | 安排重启，在应用消失前先返回 `202` |

`POST /restart` 只接受环回来源，且要求请求要么带应用自身的 origin，要么带本机令牌
（写在 `$DSH_HOME/.dsh-restart-button/token`）。令牌就是给 Agent 用的通道：

```powershell
$token = (Get-Content "$env:DSH_HOME\.dsh-restart-button\token" -Raw).Trim()
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:19387/dsh-restart-button/restart" `
  -Headers @{ 'X-DSH-Restart-Token' = $token }
```

## 实现要点

重启**这个特定的应用**出乎意料地麻烦，代码里到处写着原因。简版如下。

### 进程模型

桌面外壳（`lib/main.js`）是 Electron 主进程。它把 DSH 宿主——**也就是所有插件**——作为**子进程**拉起，
并带上 `ELECTRON_RUN_AS_NODE=1` 与一个 IPC 通道。所以插件里：

- 拿不到 `app` 对象，不能调用 `app.relaunch()`；
- 子 → 父的 IPC 只传 `ready` 事件，没有"请重启"这种消息。

重启只能由另一个进程来完成。

### 树外的 worker

最早的方案是让一个助手杀掉应用再拉起它。它一直工作良好——直到应用死掉的那一刻：**助手跟着一起死了**，
`restart.log` 停在 kill 那一行之后。原因是助手仍是应用的**后代进程**，应用被终结时它的进程树（job object）
被一并清掉。

解法是**根本别待在那棵树里**。助手的第一件事，是通过 WMI 提供程序造一个自己的副本：

```powershell
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '...' }
```

这样创建的进程，父进程是 `WmiPrvSE.exe`（服务进程），并且运行在交互会话里（所以从它启动的 GUI 应用可见）。
这个 worker 之后负责等待旧应用消失、重新拉起、把窗口切到前台。启动链用 `wscript.exe` + `.vbs` 保证全程无窗口，
并且**等待** worker 结束（`Run cmd, 0, True`）——因为实测发现，非 detach 的子进程在父进程立刻退出时**会被杀掉**。

### 四个值得记住的 Windows 坑

| 坑 | 后果 | 本插件的做法 |
|---|---|---|
| 宿主子进程带 `ELECTRON_RUN_AS_NODE=1` | 原样传给 `DeepSeek Harness.exe`，它会以纯 Node 模式启动：弹出控制台窗口、GUI 永不出现，看起来就是"杀掉了但没拉起" | 复制环境变量并删除它 |
| `windowsHide` 实际是 `STARTF_USESHOWWINDOW` + `wShowWindow = SW_HIDE` | GUI 应用的首个 `ShowWindow` 会服从它，窗口被创建却保持隐藏，必须点任务栏才出来 | 拉起应用时**绝不**传 `windowsHide` |
| `detached: true` 与 detach 的 `powershell.exe` | 需要控制台的控制台程序在 detach 下**根本不执行** | 助手（Node 进程）可以 detach；取前台那步的 PowerShell 必须非 detach |
| "进程存在"不等于"窗口可用" | 旧助手报成功时用户还在盯着空气 | 以**端口恢复监听**作为确认信号，并记录真实耗时 |

另外：杀进程用进程号直接 `process.kill()`，不再 spawn `taskkill`（少一个控制台进程，关键路径少约 1.1 秒）；
重新拉起最多 **5 次**；全过程写入 `$DSH_HOME/.dsh-restart-button/restart.log`。

## 要求与限制

- **仅 Windows。** 树外 worker 依赖 WMI、`wscript.exe` 和 Win32 取前台。
- 针对 DeepSeek Harness `0.2.0-rc.2` 开发。它读取 launcher 发布的 `profileContext` 服务，
  除自身文件外不改动任何东西，但确实依赖可能变动的内部实现。
- 重启是**强杀**（`TerminateProcess`），不是优雅退出：进行中的任务会被中断。
  DSH 的会话数据是追加写的 JSONL，落盘数据风险低，但不是零。
- 杀进程按进程号（Electron 主进程 + DSH 宿主子进程），不影响其它进程。
- 重新拉起有上限：最多 5 次，之后放弃并写日志。
- 剩下的等待时间大部分是 DeepSeek Harness 自身的启动成本，不是本插件的——日志里会记
  `app is listening on <port> after <n>ms`，可以把两者区分开。

## 工具

两个小工具，开发时也用它们：

```powershell
# 从 lib/index.js 里的模板重新生成运行时产物，并断言本插件依赖的每一项不变式（10 项）。
node tools/extract-helper.mjs

# 从插件外部重启正在运行的应用——当 lib/index.js 本身被改动时的引导路径，
# 因为宿主侧 JavaScript 只在新进程里生效。
node tools/launch-helper.mjs
```

`npm run check` 会用一次性目录跑前者。

## 许可

MIT — 见 [LICENSE](LICENSE)。
