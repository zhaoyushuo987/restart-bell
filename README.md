# restart-bell 重启铃

![version](https://img.shields.io/badge/version-0.4.0-ff69b4)
![license](https://img.shields.io/badge/license-MIT-blue)
![platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-lightgrey)
![DSH](https://img.shields.io/badge/DeepSeek%20Harness-plugin-6f42c1)

> https://github.com/zhaoyushuo987/restart-bell

DeepSeek Harness（DSH）插件：在 Web GUI **顶部**加一个 ⟳ 小按钮（默认左上角，可按住拖动）。**点一下弹出一个小列表**，里头两个按钮：

| 按钮 | 作用 |
| --- | --- |
| 重启 | 强制关闭整个 DSH 并用同一个 exe 原样重新启动（装完插件/改完配置让它立即生效） |
| 关闭 | 只强制关闭整个 DSH，不重新打开（想彻底退出、释放内存时用） |

> v0.4.0：改名为 **restart-bell 重启铃**（原来是 `meow-restart`）。包名、路由（`/api/restart-bell/*`）、DOM id、临时目录都换了；旧版记下的按钮位置会自动迁移过来，功能与 v0.3.1 完全一致。升级方式是卸旧的、装新的、重启一次。
> v0.3.0：把命令行黑窗彻底去掉（助手改用 wscript 跑 VBS，GUI 子系统，结构上不会出现控制台）。
> v0.3.1：修好 v0.3.0「点了重启，DSH 关了但永远不回来」——助手继承了宿主的 `ELECTRON_RUN_AS_NODE=1`，被拉起的 exe 会以 Node 模式空跑后立刻退出（日志却照常写 `relaunching` / `done`，看着像成功）。现在 spawn 助手前和 VBS 里各清一次环境，并核对新进程是否真的活着，起不来就交给 explorer.exe 兜底。

## 安装（源码 link 方式）

```powershell
git clone https://github.com/zhaoyushuo987/restart-bell
```

然后把克隆出来的目录以 link 方式加到你想用的 profile 里，两种情形：

**A. 普通 profile（命令行能管的）**

```powershell
dsh plugin --profile <profile 名> add link:<上面克隆出来的目录>
```

**B. 桌面 App 的 profile（默认叫 `desktop`）**

它由 Electron 应用独占，命令行 add/remove 会被直接拒绝（`profile "desktop" is managed exclusively by the Electron application`）。这时用 App 里的插件管理界面添加，或者手动改：

1. `<用户目录>\.dsh\profiles\desktop\package.json`：`dependencies` 加 `"restart-bell": "link:C:/路径/restart-bell"`，`dsh.profile.bundles` 数组加 `"restart-bell"`；
2. 在 `profiles\desktop\node_modules` 下建 junction 指向源码目录（管理员不需要，PowerShell 普通权限即可）：`New-Item -ItemType Junction -Path .\restart-bell -Target C:\路径\restart-bell`；
3. 重启一次 DSH，左上角就多出那个 ⟳ 小按钮。

### 从旧名 meow-restart 升级

同一个按钮只能有一个主人：先摘掉旧包，再装新的。

```powershell
dsh plugin --profile <profile 名> remove meow-restart   # App 管理的 profile 见上面 B 的手动方式
dsh plugin --profile <profile 名> add link:<restart-bell 目录>
```

旧版记下的按钮位置会从 `meow-restart-pos` 自动迁移到 `restart-bell-pos`，不用重新拖。

## 用法（懒人三步）

1. 装好后 DSH 会自动重启一次（首次让插件生效）。
2. 看 **窗口左上角**（标题栏区域）的 ⟳ 小圆钮：**按住可拖到顶部任意位置**，位置会记住。
3. 单击 ⟳ → 弹出小列表 → 点「重启」或「关闭」。点空白处或按 Esc 收起列表。

## 它是怎么做的（放心点）

- 列表只是前端 DOM（无 React、无应用内部接口），重启/关闭只向本机 GUI 服务发一个 POST（带自定义头 `x-restart-bell`，防误触、防网页跨站触发）：
  - `POST /api/restart-bell/restart`
  - `POST /api/restart-bell/quit`
- 宿主立刻回 200，然后写一个 **VBS 助手**（`%TEMP%\restart-bell\helper-<时间戳>.vbs`）并用 **wscript.exe** 分离运行。wscript 是 GUI 子系统程序，**不可能出现控制台黑窗**——v0.2.x 用 cmd.exe 是必然弹窗的：CreateProcess 的 `CREATE_NO_WINDOW` 与 `DETACHED_PROCESS` 互斥，而分离运行必须后者，于是前者被忽略，cmd 自开一个可见控制台。
- 助手的动作顺序（关键：**先杀主进程，且全程不用 `/T`**）：
  1. 等 `delayMs`（默认 1200ms，让 200 先回到浏览器）；
  2. `taskkill /F /PID <主进程>`——杀之前先用 WMI 核对该 pid 的镜像名，**不是 DSH 就跳过**（ppid 万一取到 launcher/explorer，绝不误杀，日志记 `skip main pid`）；
  3. 300ms 后 `taskkill /F /IM "DeepSeek Harness.exe"` 清掉渲染/宿主/工具子进程；
  4. WMI 轮询直到同名进程为 0（最多 15s，8s 时补杀一次）；
  5. 再等 800ms，放掉单实例锁与端口；
  6. 清掉 `ELECTRON_RUN_AS_NODE`/`ELECTRON_NO_ATTACH_CONSOLE`/`NODE_OPTIONS`/`NODE_ENV`/`DSH_SESSION_ID`/`DSH_SHELL`/`DSH_WEB_URL`，让它是一次全新会话、并且必须按桌面双击的方式当 Electron 启动；
  7. 「重启」用 `WshShell.Run` 拉起**同一个 exe**（工作目录 = exe 所在目录、不带参数，等价于双击快捷方式），随后轮询 WMI 3 秒确认新进程真活着：活着记 `relaunched N process(es)`；没起来就改用 `explorer.exe "<exe>"` 兜底（explorer 用它自己的干净环境启动）并记录兜底结果；「关闭」到此为止。
- **v0.3.0 为什么「关了不回来」**：助手是 DSH 宿主子进程的孩子，环境里带着 `ELECTRON_RUN_AS_NODE=1`（宿主本身就是 Electron-as-Node 在跑）。带着这个变量执行 `DeepSeek Harness.exe`，Electron 会退化成一个裸 Node 运行时——没有脚本、没有窗口，读不到 stdin 就退出，于是重启看起来完全没发生。实测：保留该变量，该 exe 打印 `v24.21.0`（Node 版本）后退出；去掉它，正常走 Chromium 启动。
- **v0.2.x 为什么永远不回来**：助手是宿主 cmd.exe 的后代，`taskkill /T` 会连树一起杀，助手当场毙命（日志永远只有 `start` + `killing`）。现在助手是 `wscript.exe`（映像名不同，`/IM` 也打不到它），并且完全不用 `/T`。
- 为什么是强杀而不是优雅退出：DSH 桌面主进程把宿主子进程的任何「非请求退出」都当成致命故障，会弹「启动失败」恢复对话框；先杀主进程对话框就永远不会出现。会话、用量账本等数据按轮次落盘，重启/关闭都不丢。
- 浏览器打开 GUI 的场景（桌面端点「重启」本窗口会一起死掉，下面是浏览器/远程查看时的行为）：前端必须**先看到 ping 失败一次**，再等到 ping 成功才 `location.reload()`——v0.2.1 是 200 到手就刷新，宿主其实还活着，看起来像「什么都没发生」；10s 内没下线 → 提示「重启没生效：DSH 还在运行，可以再点一次『重启』」；下线后 40s 没回来 → 提示手动打开 DSH（桌面端 `--port 0` 每次随机端口，旧标签页本来就回不来）。点「关闭」仍是 8s 判定。
- 配置项：`delayMs`（触发到强杀的缓冲，默认 1200）、`enabled: false` 可整体停用。

## 排障：看 `%TEMP%\restart-bell\helper.log`

每条动作都带本地时间戳。**关不掉/起不来先看这个日志**：

| 日志停在哪 | 说明 |
| --- | --- |
| 只有 `start` | VBS 没被执行：杀软/组策略禁了 WSH，或 wscript 路径不对（手动跑 `wscript //B //NoLogo 该文件.vbs` 验证） |
| 到 `killing rest` 就没了 | 就是 v0.2.x 的自杀 bug（`/T` 连树杀），升级到 0.3.0 |
| `still-running N` | 同名进程杀不掉（权限/占用），日志记数后仍会尝试拉起 |
| `skip main pid …` | ppid 不是 DSH 主进程（正常保护），只按映像名清场 |
| `relaunch failed: …` | 拉起失败，跟着错误描述查（路径不存在 / 权限不足） |
| `env cleaned: runAsNode=[1] …` | 环境没清掉（WSH 异常），此时拉起的 exe 会当 Node 空跑，等于 v0.3.0 的 bug 复发 |
| `no process after launch; retry via explorer` | 直接拉起的子进程没留住（被杀软拦、单实例锁未释放），已自动换 explorer 兜底，看下一行结果 |
| `explorer relaunch produced nothing either` | 兜底也没起来：多半是杀软拦了「脚本启动 exe」，或 exe 路径/权限有问题 |

自测（**不会碰 DSH**）：`node scripts/selftest-helper.mjs`（15 项断言）。它把 `ping.exe` 复制成 `selfapp.exe` 冒充目标，验证：助手没被自己杀掉、目标被清掉、能重新拉起、错路径会记 `relaunch failed`、非本映像的 pid 被跳过不杀、`wscript.exe` 是 GUI 子系统（subsystem 2）；还会在 `ELECTRON_RUN_AS_NODE=1` 的污染环境里跑一遍，断言助手把它清干净，并单独起子进程 dump 环境，证明 WSH 的 `Remove` 确实传给了子代。

改了 `scripts/helper-template.vbs` 之后必须重新内联进 `lib/index.js`：`node scripts/embed-helper.mjs`（幂等，可反复跑）。

## 独立性

这是一个**完全独立**的插件：没有 `dependencies`、不引用别的插件的代码或接口，只做一件事——在顶部放个 ⟳ 按钮、发三个本机请求、跑一个 VBS 助手。名字也不跟任何命名系列绑定，改名只影响包名/路由/存储键，不影响行为。

装法与其它插件一样，放在 profile 的 node_modules 里随 profile 加载（本机是 junction → 直接指向源码目录，改完源码重启即生效），但**它不需要任何同伴**。

## 手动安装 / 卸载

```
dsh plugin --profile desktop add link:C:\Users\86158\Documents\deepseek-harness\restart-bell
dsh plugin --profile desktop remove restart-bell
```

装完重启一次 DSH 生效。

## 反馈与许可

遇到问题去 [Issues](https://github.com/zhaoyushuo987/restart-bell/issues) 说一声，附上 `%TEMP%\restart-bell\helper.log` 的尾部几行最有帮助。

MIT © zhaoyushuo987

