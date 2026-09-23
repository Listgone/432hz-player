# 432Hz 播放器

把电脑里正在播放的声音实时转成 **432Hz**（A4 440 → 432，−31.77 cent，**保时长**）后送到你的物理声卡。
独立软件，双击图标即用；会自己把系统默认播放设备指向虚拟声卡并开始接管。

---

## 下载

在 **Releases** 页面选一个：

| 文件 | 用途 | 大小 |
|---|---|---|
| `432hz-player-<版本>-setup.exe` | **推荐**：安装版（桌面应用，独立窗口 + 托盘常驻，自动建快捷方式） | ~73 MB |
| `432hz-player-<版本>-portable.exe` | 免安装便携版，双击即跑 | ~73 MB |
| `432hz-player-<版本>-standalone-win-x64.zip` | 单文件版**整包**（含 `tools/`，解压即用，自带运行时、不需要装 Node） | ~33 MB |
| `432hz-player-standalone.exe` | 单文件版单个 exe（**必须与 `tools/` 同目录**，否则报缺少组件） | ~88 MB |
| `SHA256SUMS.txt` | 各文件 SHA-256，下载后校验完整性 | — |

校验：`certutil -hashfile <文件> SHA256`，与 `SHA256SUMS.txt` 对比。

### 下载慢？

在原始下载链接**前面拼接**镜像前缀即可加速，例如安装版：

```text
https://ghproxy.net/https://github.com/Listgone/432hz-player/releases/download/v1.1.0/432hz-player-1.1.0-setup.exe
https://ghfast.top/https://github.com/Listgone/432hz-player/releases/download/v1.1.0/432hz-player-1.1.0-setup.exe
https://gh-proxy.com/https://github.com/Listgone/432hz-player/releases/download/v1.1.0/432hz-player-1.1.0-setup.exe
```

| 镜像 | 实测（HEAD） |
|---|---|
| `ghproxy.net` | 968 ms |
| `ghfast.top` | 1030 ms |
| `gh-proxy.com` | 887 ms |

每次 `npm run release` 会重新探测这三个镜像并把结果写进 Release 说明；某个镜像失效就换另一个。

其它方式：

- **clone 加速**：`git clone https://ghfast.top/https://github.com/Listgone/432hz-player.git`
- **源码 zip**：`https://ghproxy.net/https://github.com/Listgone/432hz-player/archive/refs/heads/main.zip`
- 镜像为第三方服务，可能限速或下线；长期分发建议自建一层反代，并保留直连地址兜底。

---

## 两种分发形态

| 形态 | 文件 | 适合 | 说明 |
|---|---|---|---|
| **桌面版（推荐）** | `release\432hz-player-1.1.0-setup.exe` | 分发给别人 / 长期使用 | 安装包（可自选目录、建桌面与开始菜单快捷方式）。Electron 外壳：独立应用窗口、托盘常驻、单实例、关闭窗口后音频继续 |
| | `release\432hz-player-1.1.0-portable.exe` | 免安装试用 | 便携版，双击即跑，不写注册表 |
| **单文件版** | `432hz-player-standalone.exe`（88 MB） | 最省事 / 拷来就用 | 自带 Node 运行时的单文件程序，**无控制台窗口**；界面由浏览器应用窗口承载 |

三者功能与界面完全一致，共享同一份代码（`server.mjs` + `web/`），也共享同一份配置与日志。

**最小可分发集合（单文件版）**：`432hz-player-standalone.exe` + `tools\AudioEndpoint.exe` + `tools\AudioRender.exe`（界面已内联在 exe 里）。

---

## 停止接管后声音去哪了（重要）

接管时程序会把 **Windows 默认播放设备**指向 `CABLE Input`（这样所有 App 的声音才会被捕获）。
所以停止接管时**必须把默认设备换回物理设备**，否则声音进了虚拟声卡却没人接后段 —— 表现就是"没声音"。

本软件的处理顺序：

1. **停止接管**：自动还原到「接管前记录的那台设备」；没有快照时回退到你在「设备」页选的那台。
2. **退出软件 / 崩溃 / 被强杀**：走同一条还原路径；快照会落盘（`config.json`），下次启动时若发现默认设备仍指向 CABLE 而引擎没在跑，**启动自愈**会把它换回去。
3. **自动还原失败时**（已知：Windows 11 24H2+ 上 `IPolicyConfig` / WinRT `AudioPolicyConfig` 的切换接口是空实现，部分机器切不动）：
   总览页会出现**红色提示条**，写明「应改回哪台设备」，并给出三个按钮：
   **打开系统声音设置** / **重试自动还原** / **我已在系统设置里改好**。

> 如果你现在就处于"没声音"的状态：打开软件 → 总览页红色提示条 → 点「打开系统声音设置」，
> 把输出设备改回你的扬声器或耳机即可（一次性，之后软件会记住还原目标）。

---

## 输出设备：耳机优先，自动切换

**默认开启**（「设备」页可关）：

| 场景 | 行为 |
|---|---|
| 蓝牙耳机连上 | 约 2 秒内自动把输出切到耳机并重启引擎，**无需手动选** |
| 耳机断开 / 拔线 | 立刻自动切回扬声器，不会出现"设备消失后没声音" |
| 你手动选了某台设备 | 仍享受耳机优先（插上切走、拔了切回）；想彻底锁死就在「设备」页关掉自动切换 |
| 优先级 | 耳机/蓝牙 > 系统默认 > 扬声器（按设备名与适配器名识别，中英文均适用） |

切换时引擎在后台无缝重启（约 1 秒），界面会弹一次提示。

## 为什么接上虚拟声卡后声音会变小（已修复）

`CABLE Input` 这个虚拟端点出厂/被系统设成 **约 50%**，声音进虚拟声卡时先被砍掉一半，
听感就是"接了之后声音小很多"。

修复：**每次开始接管时自动把 CABLE Input 端点音量校正到 100%**，并关闭 Windows 的
「通信活动时降低其它声音」（ducking，会导致音量忽大忽小）。结果在「设备」页可见：

> 已把虚拟声卡音量校正为 100%（原来 51%），声音不再被压低。

若某台机器上校正失败，界面会提示手动把 `CABLE Input` 拉到 100%。

---

## 依赖（必须由用户安装）

| 依赖 | 为什么需要 | 安装 |
|---|---|---|
| **VB-CABLE 虚拟声卡** | 提供 `CABLE Input`（应用往这里播）/ `CABLE Output`（本软件从这里抓） | <https://vb-audio.com/Cable/> → 管理员运行 `VBCABLE_Setup_x64.exe` → **重启电脑** |
| **ffmpeg（含 dshow）** | 捕获与滤镜链（432 移调就在这里做） | `winget install --id Gyan.FFmpeg -e`，或解压后把 `bin` 加入 PATH |

桌面版已自带 Node 运行时与两个音频工具；**不需要**用户装 Node。
装完 VB-CABLE 后系统默认播放设备会变成 `CABLE Input`，这是预期行为（所有声音进入虚拟声卡由本软件处理）。

---

## 工作原理

```
所有 App ──► Windows 默认播放设备 = CABLE Input (VB-CABLE)
              └─► CABLE Output（dshow 捕获 48kHz/2ch）
                    └─► ffmpeg 滤镜链
                          aresample=48000
                          asetrate=48000*432/440     ← 音高 ×0.981818
                          aresample=48000
                          atempo=440/432             ← 还原时长（保时长）
                          alimiter=limit=0.97        ← 防削顶
                          └─► 原始 PCM（stdout 管道）
                                └─► AudioRender.exe（WASAPI 显式端点渲染）
                                      └─► 物理声卡（扬声器/耳机）
```

**输出端为什么不用 ffplay：** ffplay(SDL2) 没有音频设备选择参数，只能跟随系统默认设备；而
Windows 11 24H2+ 切换默认设备的未公开接口已失效（`IPolicyConfig` 新旧 CLSID/IID 都是空实现，
WinRT `AudioPolicyConfig` vtable 不兼容）。`AudioRender.exe` 按**端点 ID** 直接打开 WASAPI 渲染流，
与系统默认设备解耦 —— 所以系统默认可以一直保持 `CABLE Input`（所有 App 都被捕获），
处理后的声音直写物理声卡，**从结构上消除「输出被自己再抓一遍」的自激环**。

---

## 界面（5 个页面）

- **总览**：状态灯与运行时长、`432.0Hz / −31.77 cent / 0.981818×`、四段信号链、真实 RMS/峰值电平、异常提示条
- **音高与音质**：415–445Hz 圆形表盘（可拖动、方向键可调，432 绿标 / 440 灰标）、预设 432/440/444、按住 A/B 对比、高质量档、链路自检；增益 −12~+12dB、干湿混合、捕获缓冲
- **设备**：输出设备选择（**只列当前可用的物理设备，已排除虚拟声卡**；蓝牙耳机连上后约 2 秒自动出现）、链路设备与渲染时钟
- **运行日志**：软件内查看后台日志（内存 + 落盘合并），可复制、可导出成 `432hz-player.log`、可打开数据目录
- **关于与检测**：依赖逐项状态、界面语言（跟随系统 / 中文 / English）、跟随系统明暗主题、开机自启开关、退出软件

---

## 数值验收（可复现）

界面「音高与音质 → 链路自检」，或 `GET http://127.0.0.1:4399/api/selftest`：

```json
{ "expectedHz": 432, "measuredHz": 431.989, "centsOff": -0.044,
  "durationDeltaPct": 0.0028, "pass": true }
```

真机全链路实测（VB-CABLE 实机）：

| 项 | 实测 | 判据 |
|---|---|---|
| 音高 | 431.989 Hz（−0.044 cent） | <5 cent ✅ |
| 保时长 | +0.0028% | <1% ✅ |
| 输出确达物理设备 | 引擎运行时该端点峰值 **0.0896**；未启动时恒为 **0.0000** | ✅ |
| 无自激 | 处理后不回灌虚拟声卡 | ✅ |
| 实时性 | 渲染端消费 143519 帧 / 3031 ms（受设备时钟节流） | ✅ |
| 启动即用 | 双击图标 → 自动接管；桌面版窗口可见、无控制台 | ✅ |

---

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | 全量状态（引擎、设备、电平、延迟、依赖、界面语言等） |
| GET | `/api/logs?tail=N` | 最近 N 行日志（默认 300，上限 2000） |
| GET | `/api/export-log` | 导出完整日志（text/plain 附件） |
| POST | `/api/start` / `/api/stop` | 开始 / 停止接管 |
| POST | `/api/config` | 改配置（音高/增益/混合/缓冲/输出设备/语言/高质量档…），需要重启引擎的会自动重启 |
| POST | `/api/selftest` | 音高数值自检 |
| POST | `/api/autostart` | 开机自启开关（写/删启动目录快捷方式） |
| POST | `/api/quit` | 退出软件 |

只监听 `127.0.0.1`，外部不可访问。

## 命令行开关

| 参数 | 作用 |
|---|---|
| `--silent` / `--no-open` | 静默启动：只接管音频，不弹窗口（开机自启使用） |
| `--stop` | 请求正在运行的实例退出 |
| `--auto-start on\|off` | 写 / 删开机自启快捷方式 |

## 数据位置

| 路径 | 内容 |
|---|---|
| `%USERPROFILE%\.432hz-player\config.json` | 全部配置 |
| `%USERPROFILE%\.432hz-player\app.log` | 软件日志（带 2MB 轮转，界面里可看/可导出） |
| `%USERPROFILE%\.432hz-player\engine.log` | 引擎（ffmpeg/渲染器）日志 |
| `%USERPROFILE%\.432hz-player\desktop.log` | 桌面版主进程启动诊断 |

---

## 开发与构建

```bash
npm i                        # 安装 electron / electron-builder（.npmrc 已配国内镜像）
npm start                    # 桌面版开发模式（Electron）
npm run server               # 只跑本地服务（浏览器访问 http://127.0.0.1:4399）
npm run build:tools          # 用系统自带 csc.exe 重新编译 tools/*.cs
npm run dist                 # 生成安装包 + 便携版到 release/
node scripts/build-exe.mjs   # 生成单文件版 432hz-player-standalone.exe（含 PE 子系统 3→2 无窗口补丁）
node scripts/check-ui.mjs    # 校验界面脚本语法与 i18n 键完整性
node scripts/make-icon.mjs   # 重新生成图标
npm run release              # 打包 + 发布到 GitHub Release（gh CLI 已登录）
```

### 镜像（国内必看）

仓库自带 `.npmrc`，clone 后 `npm i` 就会走国内镜像，无需手动设环境变量：

```ini
registry=https://registry.npmmirror.com
electron_mirror=https://registry.npmmirror.com/-/binary/electron/
electron_builder_binaries_mirror=https://registry.npmmirror.com/-/binary/electron-builder-binaries/
```

若在 CI 或其它机器上打包，请显式导出（否则 electron-builder 会去 github.com 取工具链，国内大概率超时）：

```bash
export ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/
export ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/
export CSC_IDENTITY_AUTO_DISCOVERY=false   # 无代码签名证书时跳过签名
```

**注意**：改了 `web/index.html` 后必须重新 `node scripts/build-exe.mjs`，否则单文件版里仍是旧界面（Electron 版直接从 asar 读，无需额外步骤）。

### 发布

```bash
npm run release                # 打包三件套并创建/更新 Release（tag = v<package.json version>）
npm run release:no-build       # 只用现有产物发布
node scripts/release.mjs --tag v1.2.0   # 指定 tag
```

发布脚本会：编译 C# 工具 → 生成图标 → 打 Electron 两个包 → 打单文件版 → `gh release create/upload`
（已存在同名 Release 时更新说明并覆盖附件），并自动生成包含安装前提与校验信息的 Release 说明。

## 目录结构

```
432hz-player/
├── 432hz-player-standalone.exe   单文件版（构建产物，未入库）
├── release/                 安装包与便携版（构建产物，未入库）
├── desktop/                 Electron 主进程 + 预加载
├── server.mjs               音频服务：探测 / 引擎 / HTTP API / 日志
├── web/index.html           界面（原生 JS，中英双语）
├── tools/
│   ├── AudioEndpoint.exe/.cs  端点枚举、默认设备切换、峰值读取
│   └── AudioRender.exe/.cs    WASAPI 显式端点渲染器（stdin 收 PCM）
├── assets/app.ico           应用图标
├── scripts/                 构建 / 自检 / 发布脚本
├── .npmrc                   国内镜像配置
└── LICENSE                  MIT
```

---

## 已知边界

- **独占模式**（ASIO / WASAPI Exclusive）的 App 绕过默认设备，抓不到。
- **DRM 受保护内容**（Netflix 等）loopback 为静音，无法处理。
- **多声道下混**：CABLE 是 2 声道，5.1 会被压成立体声。
- **延迟**：约 200–300ms（捕获缓冲为主），游戏/视频会有音画不同步；可把缓冲降到 50–100ms 试探。
- **设备切换接口**：Windows 11 24H2+ 上 `IPolicyConfig` / WinRT `AudioPolicyConfig` 在部分机器上是空实现，
  此时软件无法自动改默认设备 —— 启动/停止都会给出「打开系统声音设置」的手动降级路径。
- **虚拟声卡识别**：按「设备名或适配器名含 VB-Audio / CABLE」过滤，因此 VB-CABLE A+B 的
  `CABLE In 16ch` 也会被排除在输出列表外（不会误选导致自激）。
- **还原目标失效**：若接管前那台设备已被永久移除（删除蓝牙配对、拔掉声卡），
  还原时会自动改用当前可用的物理设备，并在日志里记录替换过程。
- **自动切换的边界**：只对「从列表里消失/出现」的物理设备生效；若设备仍在列表但被系统静音，
  需要你自己处理。用户关掉自动切换后完全不干预。
- **界面缩放**：字号随窗口等比放大；宽屏（≥1200px）主页自动改双列，全屏时内容铺满宽度。
- **升级时**：单文件版请连 `tools\` 一起替换，别只换 exe。
- **exe 本体图标**：node.exe 带 Authenticode 签名，改 PE 资源会导致无法加载（已实测两种方式均崩溃），
  因此单文件版 exe 用默认图标，自定义图标由快捷方式 / Electron 外壳承载。
