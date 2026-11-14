# 给别人用：安装与上手

这份文档面向"拿到这个插件想用起来的人"，不是插件作者。

## 0. 前提

| 项 | 要求 | 说明 |
|---|---|---|
| DSH | ≥ `0.2.2-rc.1` | `dsh --version` 可查 |
| Node | ≥ 22.18 | 插件与本仓库测试直接跑 TypeScript；DSH 桌面版自带的 Node 24 就够 |
| Python | **不需要** | 默认引擎是纯 JS（`node-edge-tts`），不依赖 `edge-tts` CLI |
| ffmpeg | 可选 | 只有"把字幕封装/烧录进视频"时才需要，插件不会因此失败 |

## 1. 安装

### A. 从 npm（推荐）

```powershell
dsh plugin --profile web add @leiboss/dsh-voiceover
```

一条命令就够：`@leiboss/dsh-voiceover` 的 bundle patch 会同时挂载引擎
`@leiboss/dsh-tts`（两个 patch 复用同一个 id，不会重复挂载）。

想单独用引擎（只要"读一段话"）：

```powershell
dsh plugin --profile web add @leiboss/dsh-tts
```

**刚发布后的两个坑**（都不是包的问题）：

| 报错 | 原因 | 处理 |
|---|---|---|
| `ERR_PNPM_NO_MATCHING_VERSION` | 你的 npm/pnpm 走国内镜像（如 `registry.npmmirror.com`），新版本还没同步 | 加官方源：`dsh plugin --profile web add @leiboss/dsh-voiceover --registry https://registry.npmjs.org/` |
| `ERR_PNPM_FETCH_404 … .tgz` | npm 的发布处理队列，tarball 要几分钟才可下载 | 等几分钟；`scripts/publish.ps1` 会轮询 tarball 而不是只看元数据 |

### B. 从源码（想改代码时）

```powershell
git clone https://github.com/leiboss/dsh-tts.git
cd dsh-tts
npm install
npm run build

# 首次：建一个 web profile（面板需要 Web 宿主）
dsh --profile vo-demo --from-default-profile web --dump-config

dsh plugin --profile vo-demo add .\packages\tts
dsh plugin --profile vo-demo add .\packages\voiceover
dsh vo-demo
```

改源码后重新 `npm run build` 并重启 profile 即可，不需要重新安装。

> 用 `link:` 安装时 pnpm 会提示"linked dependency will not resolve peer dependencies"，
> 这条对本仓库无影响：插件从仓库自己的 `node_modules` 解析 peer。

## 2. 第一次使用

在 Web 界面里说：

> 把 D:\docs\某文.md 做成有声书，女声

1. 工具 `voiceover_create` 立即返回 `projectId`，后台开始跑
2. 章节结果下方出现进度面板：进度条、逐章状态、能力条
3. 跑完点某章 `▶` 试听；播放器下方显示**当前字幕**
4. 失败章节点行尾「重试」，或说「重跑第 3 章」
5. 要文件路径：说「导出」，或让 agent 调 `voiceover_export`

## 3. 配置（都可选）

配置走 DSH 配置层（插件 Config），常用项：

| 键 | 默认 | 作用 |
|---|---|---|
| `outputDir` | `$DSH_HOME/voiceover` | 项目根目录 |
| `defaultVoice` | `zh-CN-XiaoxiaoNeural` | 音色 |
| `defaultRate` | `+0%` | 语速 |
| `style` | `news` | `lecture` / `news` / `story` / `docs` |
| `chapterChars` | `1400` | 无模型时按多少字切一章 |
| `llmBaseUrl` / `llmApiKey` / `llmModel` | 空 | 配置后启用口播化改写与质检；不配则**按原文朗读**，manifest 里 `capability.llm=false` 并留一条 warning |
| `trustedHosts` | 空 | 反代改 Host 时放宽音频路由校验 |

## 4. 产物在哪

```
<outputDir>/<projectId>/
  source/normalized.md     # 归一化正文（去 markdown）
  script/ch-01.md          # 口播稿（无模型时等于原文）
  audio/ch-01.mp3
  audio/ch-01.srt          # 字幕；时间轴估算时文件名带 .est
  manifest.json            # 契约：章节、时长、引擎、能力、warnings
  state/state.json         # 断点续跑依据
```

`projectId` 由「正文 + 音色 + 语速 + 风格 + 提示词版本」哈希而来：同一份文稿同一配置，
再次运行只会重跑未完成的章节。

## 5. 字幕怎么看

`.srt` 是旁挂文件，Windows 自带播放器和浏览器 `<audio>` 都不会加载它。能真正看到字幕的四种方式
（面板内 / VLC / 浏览器 `<track>` / ffmpeg 封装烧录）见
[`packages/voiceover/README.md#字幕怎么看重要`](../packages/voiceover/README.md#字幕怎么看重要)。

## 6. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 没有进度面板 | 当前 profile 不是 Web 宿主（headless/tui） | 用 `web` 模板的 profile；工具本身仍可用 |
| 一直显示「准备中」 | 首章尚未跑完，或宿主重启后 state 未更新 | 等；或让 agent 跑一次 `voiceover_status` 续跑 |
| 音色很机械 | 网络不通 Edge，降级到了系统语音 | 配 `proxy`；manifest 的 `engine` 会显示 `sapi` |
| 收不到改写效果 | 没配模型 | 配 `llmBaseUrl` + `llmApiKey` |
| 报 `429` / 限流 | 上游限流 | 等 `Retry-After`；引擎自身已按 2s/6s/18s 退避重试同一引擎 |
| 报 `SPAWN_EPERM` | 沙箱禁止创建子进程（只影响 Python 引擎） | 用默认的 `edge-js`；或放宽进程策略 |
| 播放器不出现 | 音频路由未挂载（非 Web 宿主） | 同「没有面板」 |
| 系统播放器看不到字幕 | 旁挂 srt 不被 Windows 加载 | 用 VLC，或 ffmpeg 封装/烧录 |

诊断命令：`voiceover doctor`（工具层）或 `GET /v1/doctor`（daemon），它会给出唯一一条下一步动作。

## 7. 卸载

```powershell
dsh plugin --profile vo-demo remove @leiboss/dsh-voiceover
dsh plugin --profile vo-demo remove @leiboss/dsh-tts
```

产物目录（`$DSH_HOME/voiceover`）不会被自动删除，需要自己清理。

---

## 附：发布清单（只有仓库维护者能做）

**用脚本发布**（它自己找 Node ≥22.18 并注入 PATH——直接 `npm publish` 在 Node 20 的 shell 里会失败，
因为 npm 用 `cmd /c node ...` 跑生命周期脚本，只看 PATH）：

```powershell
npm login                                    # 只需一次
powershell -File scripts\publish.ps1 -DryRun # 先演练：构建 + 测试 + 打包，不上传
powershell -File scripts\publish.ps1 -Otp 123456
```

脚本会校验 `voiceover` 的 `@leiboss/dsh-tts` 依赖范围与实际引擎版本一致，再按顺序发布。

发布前必须按顺序完成，否则别人装不上：

1. `npm run build` + 两个包 `npm test` 全绿（Node ≥ 22.18）
2. `powershell -File scripts\publish.ps1` **先发 `@leiboss/dsh-tts`**，再发 `@leiboss/dsh-voiceover`；脚本会轮询 tarball，因为元数据秒回、tarball 要几分钟
   —— 后者依赖前者的 `^0.3.0`，顺序反了会解析失败
3. 验证：干净 profile 里 `dsh plugin add @leiboss/dsh-voiceover` 能装、能跑
4. 上架索引站（dshbase / dshmarketplace / deepseekplugins），条目用 npm 包名
5. 本文件第 1 节改成只保留方式 A
