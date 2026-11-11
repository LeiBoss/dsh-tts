# dsh-tts

npm 包名为 `@leiboss/dsh-tts`。

[![npm](https://img.shields.io/npm/v/@leiboss/dsh-tts.svg)](https://www.npmjs.com/package/@leiboss/dsh-tts)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![CI](https://github.com/leiboss/dsh-tts/actions/workflows/ci.yml/badge.svg)](https://github.com/leiboss/dsh-tts/actions/workflows/ci.yml)

> **For plugin authors:** a reliable TTS backend with concurrency control, layered
> error codes, and provider fallback — designed to be depended on, not just clicked.
>
> **For end users:** returns playable audio files with browser-accessible URLs.
> Bring your own player, or use a reader plugin that calls this backend.

**Install:** `dsh plugin --profile web add @leiboss/dsh-tts`

## 简介

`@leiboss/dsh-tts` 是一个 DSH 工具插件：把文本合成为音频文件，返回本地路径与可选的同源播放地址。它不是播放器，不做语音转写，也不做音色克隆。

核心特性：

- 稳定的 Edge-TTS 合成与 `(text, voice, rate)` 缓存，重复请求不启动子进程。
- DSH Web 内可直接播放的 `browserUrl`，支持 HTTP Range 206 与签名 token。
- 长文本按句子边界分块、串行合成、拼接为单个 MP3。
- Edge-TTS 失败后按可配置链降级：SAPI（仅 Windows）或浏览器 `speechSynthesis`。
- 并发上限、等待队列与 `TTS_BUSY` 背压；缓存命中不占槽位。
- `tts_self_check` 一次性报告运行环境与静态音色清单。

## 工作原理

| DSH 能力 | 用途 |
| --- | --- |
| `ctx.tools.register` | 注册 `tts_generate` 与 `tts_self_check`；注册随插件 fiber 注销，支持热更新 |
| `ctx.inject(['webServer'])` | 可选依赖宿主 Web 路由；旧宿主回退 `ctx.get('httpServer')`，都不存在时只返回 `filePath` |
| `webServer.register` | 注册 `prefix` 路由 `/dsh-tts/audio`，返回音频字节并处理 Range |
| `ctx.connection.requestRejection` | 宿主 Host/Origin 与浏览器会话校验；链接与当前 DSH 浏览器会话绑定，不带会话 cookie 的请求返回 401/403 |
| `ctx.get('connection')` | 读取 `allowsRemoteAuthorities`，远程访问时放宽 Host 校验 |
| DSH 配置层（`Config` + `apply` 的 config） | 读取 13 项配置；插件不自行读写 `cordis.patch.yml` |
| `child_process.spawn` | 调用 `edge-tts`；降级时调用 `powershell.exe` 与 `ffmpeg` |
| `node:child_process` / `node:fs` | 直接调用 CLI 并写文件，不经 `ctx.subprocess` / 文件服务；见「能力接缝与沙箱」 |
| 文件系统 | 写入 `$DSH_HOME/tts-output/<YYYY-MM-DD>/<hash>-<timestamp>.mp3` |

一次请求的路径：参数校验 → 缓存查找（命中直接返回）→ 同 key 在途请求合并 → 并发槽位 → 分块或一次性合成 → 失败时降级 → 落盘 → 生成签名播放 URL。

## Reliability semantics

This plugin is designed to be called by other plugins and agents, not just by
end users. The following behaviors are part of its contract:

| Behavior | Guarantee | Error code / field |
|---|---|---|
| Concurrency | At most `maxConcurrent` synthesis tasks run simultaneously; excess requests queue up to `queueSize`, then fail fast | `TTS_BUSY` (includes current running count and queue length) |
| Sandbox rejection | `spawn` blocked by the sandbox is distinguished from upstream failure | `SPAWN_EPERM` (points to sandbox policy, not filesystem) |
| Upstream failure | Edge-TTS non-zero exit or network timeout | `EDGE_TTS_FAILED` / `SYNTHESIS_TIMEOUT` |
| Fallback | On Edge-TTS failure, tries engines in `fallbackOrder`; the response marks the engine actually used | `engine` / `fallback` fields |
| Engine health | Unhealthy engines are skipped during cooldown; a half-open probe recovers them on success. Protocol drift (403 / handshake rejection) opens the circuit with a longer cooldown than transient failures. | `engineHealth` in `tts_self_check` and `tts_generate` |
| Cache semantics | Cache key is fixed to `(text, voice, rate)`; `pitch`/`volume` are excluded for predictable cache behavior | See “Known limitations” |
| Lifecycle | Tools, routes, and config listeners are effect-registered and cleaned up on dispose; HMR-safe | — |

These are not feature claims. They are behaviors callers can rely on when
deciding whether to depend on this plugin.

## 工具一览

| 工具 | 参数 | 返回 | 何时调用 |
| --- | --- | --- | --- |
| `tts_generate` | `text`（必填）、`voice`、`rate`、`pitch`、`volume` | `{ filePath, format, browserUrl?, engine?, fallback?, text?, voice?, rate?, fallbackReason? }` | 用户要求把文字读出来、生成配音或音频文件时 |
| `tts_self_check` | 无 | `{ edgeTtsAvailable, edgeTtsVersion?, spawnAllowed, outputDirWritable, dshHome, proxyConfigured, availableVoices }` | 安装后自检，或 `tts_generate` 报环境类错误时 |
| `tts_probe_network` | `timeoutMs`（可选，默认 1500，上限 5000） | `{ host, port, reachable, elapsedMs, proxyConfigured }` | 怀疑网络到 Edge-TTS 端点不通时显式调用；会发起一次 TCP 连接，不合成音频、不消耗配额 |

`tts_generate` 不播放音频、不转录音频、不克隆或修改音色、不做音频后处理，也不生成音乐。`filePath` 与 `format` 在正常合成时存在；当返回 `fallback: "speechSynthesis"` 时只返回 `text`、`voice`、`rate`，以及可选的 `fallbackReason`（各引擎失败原因摘要），由调用方朗读。当前不提供音频时长。

默认值：`voice = zh-CN-XiaoxiaoNeural`，`rate = +0%`，`pitch = +0Hz`，`volume = +0%`。

## 安装

环境要求：

- Node.js ≥ 22.18
- DSH ≥ 0.2.2
- Python 3
- `pip install edge-tts`
- Windows 上使用 SAPI 降级时还需要 `ffmpeg` 在 PATH 中（用于 WAV → MP3）

首选 npm（包发布后可用）：

```bash
dsh plugin --profile web add @leiboss/dsh-tts        # 发布后
dsh plugin --profile web add github:leiboss/dsh-tts  # 发布前/备用
```

从旧版本迁移：旧依赖目录名是 `dsh-tts`，与新的 scoped 包名不匹配，必须先移除再安装，否则会残留 `Cannot find module 'dsh-tts'` 或工具重名：

```bash
dsh plugin --profile web remove dsh-tts
dsh plugin --profile web add @leiboss/dsh-tts
```

仓库包含编译产物 `dist/`。如果从源码工作，先执行：

```bash
npm install
npm run build
```

从本地目录安装（`dsh plugin add <目录>`）走的是 link，不会为该目录安装依赖；请先在仓库里执行 `npm ci`，否则激活时会报 `Cannot find package '@deepseek-ai/schemastery'`。从 npm 或 GitHub 安装不受影响，依赖由 pnpm 正常安装。

安装后在 DSH 对话中确认工具存在：

```text
你有 tts_generate 工具吗
```

或直接调用 `tts_self_check`，期望 `edgeTtsAvailable`、`spawnAllowed`、`outputDirWritable` 为 `true`，且 `availableVoices` 非空。

最小示例：

```text
把“你好”合成语音
```

## For plugin authors

If you are building a reader plugin, a notification plugin, or an agent that needs
reliable audio synthesis, you can call `tts_generate` as a tool, or depend on the
`TTSProvider` interface directly.

**Option A: call the tool** (recommended for agents)

```typescript
const result = await ctx.tools.call('tts_generate', {
  text: 'Build completed',
  voice: 'zh-CN-YunxiNeural',
})
// result: { filePath, format, browserUrl?, engine?, fallback? }
```

**Option B: import the provider** (for plugins that want to own the playback UX)

```typescript
import type { TTSProvider, SynthesizeResult } from '@leiboss/dsh-tts/provider'

// Resolve a provider instance from the DSH service registry,
// or construct the Edge-TTS provider directly if you are embedding it.
```

**Error handling contract**

Treat these error codes differently — the distinction is the point:

| Code | Meaning | Recommended handling |
|---|---|---|
| `TTS_BUSY` | Concurrency limit or queue full | Retry after a short delay |
| `SPAWN_EPERM` | Sandbox blocked subprocess creation | Surface to user as environment issue; do not retry |
| `EDGE_TTS_FAILED` | Upstream Edge-TTS failure | Trigger your own fallback, or rely on this plugin's fallback chain |
| `SYNTHESIS_TIMEOUT` | Synthesis exceeded timeout | Retry with shorter text or larger `timeoutMs` |
| `ALL_FALLBACKS_FAILED` | All engines in `fallbackOrder` failed | Surface to user; do not retry without environment change |

Do not treat all errors as equivalent. A caller that retries `SPAWN_EPERM` will
loop forever; a caller that does not retry `TTS_BUSY` will drop work unnecessarily.

## 配置

所有配置都通过 DSH 配置层覆盖，不在工具参数里传入。

| 配置项 | 默认值 | 作用 | 覆盖方式 |
| --- | --- | --- | --- |
| `outputDir` | `$DSH_HOME/tts-output` | 音频输出根目录；未设 `DSH_HOME` 时回退 `~/.dsh/tts-output` | 插件 config 的 `outputDir` |
| `defaultVoice` | `zh-CN-XiaoxiaoNeural` | 未传 `voice` 时使用的音色 | 插件 config 的 `defaultVoice` |
| `timeoutMs` | `30000` | 单个 Edge-TTS 子进程（或单个分块）的超时 | 插件 config 的 `timeoutMs` |
| `edgeTtsBinary` | `edge-tts` | Edge-TTS CLI 名称或绝对路径 | 插件 config 的 `edgeTtsBinary` |
| `chunkSize` | `1200` | 超过该字符数时按句子边界分块 | 插件 config 的 `chunkSize` |
| `chunkingEnabled` | `true` | 是否启用长文本分块 | 插件 config 的 `chunkingEnabled` |
| `fallbackEnabled` | `true` | Edge-TTS 失败后是否尝试降级链 | 插件 config 的 `fallbackEnabled` |
| `fallbackOrder` | `['edge-tts', 'sapi', 'speechSynthesis']` | 降级顺序；未知引擎名会被忽略 | 插件 config 的 `fallbackOrder` |
| `maxConcurrent` | `2` | 同时运行的完整合成任务数 | 插件 config 的 `maxConcurrent` |
| `queueSize` | `4` | 等待槽位的请求上限 | 插件 config 的 `queueSize` |
| `queueTimeoutMs` | `10000` | 排队等待上限，超时返回 `TTS_BUSY` | 插件 config 的 `queueTimeoutMs` |
| `totalTimeoutMs` | `180000` | 一次 `tts_generate` 的总预算，覆盖所有分块与块间延迟 | 插件 config 的 `totalTimeoutMs` |
| `trustedHosts` | `[]` | 反向代理场景的额外 Host 白名单；非空时跳过端口钉死 | 插件 config 的 `trustedHosts` |
| `proxy` | `undefined` | 为 Edge-TTS 子进程配置 HTTP 代理，透传为 `--proxy`；留空则不追加参数 | 插件 config 的 `proxy` |
| `engineHealth.enabled` | `true` | 是否启用引擎健康状态机；关闭后每个引擎总是被尝试 | 插件 config 的 `engineHealth.enabled` |
| `engineHealth.failureThreshold` | `3` | 连续普通失败达到该次数后打开熔断 | 插件 config 的 `engineHealth.failureThreshold` |
| `engineHealth.driftCooldownMs` | `300000` | 协议漂移（403 / 握手失败）触发的冷却期 | 插件 config 的 `engineHealth.driftCooldownMs` |
| `engineHealth.transientCooldownMs` | `60000` | 普通失败达到阈值后触发的冷却期 | 插件 config 的 `engineHealth.transientCooldownMs` |
| `engineHealth.maxCooldownMs` | `600000` | 半开探测失败后冷却时长翻倍的上限 | 插件 config 的 `engineHealth.maxCooldownMs` |

## 使用

默认音色：

```text
把“欢迎使用 DSH，这是一段语音合成示例”合成语音。
```

指定音色：

```text
用 zh-CN-YunyangNeural 把这段新闻稿合成音频文件。
```

长文本：

```text
把下面这篇文章合成语音（直接粘贴 2000 字以上的正文）。
```

调整音调与音量：

```text
用 pitch +10Hz、volume -20% 把这段话合成语音。
```

返回值示例（Web 运行模式）：

```json
{
  "filePath": "/home/user/.dsh/tts-output/2026-11-11/4f2c9a1b3d5e6f70-1770000000000.mp3",
  "format": "mp3",
  "browserUrl": "/dsh-tts/audio/eyJleHAiOjE3NzAwMDM2MDB9..."
}
```

`browserUrl` 是同源相对地址，链接与当前 DSH 浏览器会话绑定：在浏览器里打开可以播放，但**不适合对外分享**。它带有效期与签名；签名密钥持久化在输出目录的 `.audio-route-secret`，插件重载后旧链接仍可用；删除该文件会轮换全部链接。需要分享时请直接发送音频文件。

DSH Web 中，本插件还声明了客户端入口（`dsh.client`，`exports["./client"]`）：`tts_generate` 的工具结果里只要有 `browserUrl`，就会在对话中渲染一个原生 `<audio controls preload="none">` 播放器，点击即可播放。播放器不自动播放，URL 缺失（headless、路由未注册、`speechSynthesis` 降级）时不渲染任何内容。宿主 `ToolResultNode` 不暴露结构化返回值，客户端因此从结果的渲染文本里取同源 `/dsh-tts/audio/...` 路径。

工具结果的 `render` 在拿到宿主 `webServer.getOrigin()` 时还会把 `browserUrl` 拼成绝对地址，输出 `[▶ 播放](...)`。**这是 Markdown 文本**，DSH 的工具结果按纯文本展示，不会自动渲染成链接；可点击的播放入口是上面的内联播放器，或在回复正文里重新引用该地址。JSON 返回值里的 `browserUrl` 仍是相对路径。拿不到 origin（例如 headless 或 `file://`）时不猜 `localhost`，退回相对 `Playback URL` 文本。

当所有宿主引擎都不可用时，返回（`fallbackReason` 为各引擎失败原因摘要，见「错误码」）：

```json
{
  "fallback": "speechSynthesis",
  "text": "原文",
  "voice": "zh-CN-XiaoxiaoNeural",
  "rate": "+0%",
  "fallbackReason": "edge-tts: SYNTHESIS_TIMEOUT; sapi: ffmpeg exited with code -22"
}
```

## 可用音色

音色清单静态维护在 `src/voices.ts`，`tts_self_check.availableVoices` 返回同样内容，不会联网查询。该清单不是白名单：`tts_generate` 仍接受 Edge-TTS 支持的其他音色名。

| 音色名 | 性别 | 语言/方言 | 适用场景 |
| --- | --- | --- | --- |
| `zh-CN-XiaoxiaoNeural` | 女 | 中文（普通话） | 默认女声，自然通用 |
| `zh-CN-YunxiNeural` | 男 | 中文（普通话） | 年轻自然男声 |
| `zh-CN-XiaoyiNeural` | 女 | 中文（普通话） | 活泼女声 |
| `zh-CN-YunyangNeural` | 男 | 中文（普通话） | 播音腔 |
| `zh-CN-YunjianNeural` | 男 | 中文（普通话） | 沉稳男声 |
| `zh-CN-liaoning-XiaobeiNeural` | 女 | 中文（东北话） | 方言 |
| `zh-CN-shaanxi-XiaoniNeural` | 女 | 中文（陕西话） | 方言 |
| `en-US-AriaNeural` | 女 | 英文（美式） | 默认英文女声 |
| `en-US-GuyNeural` | 男 | 英文（美式） | 英文男声 |
| `en-US-JennyNeural` | 女 | 英文（美式） | 对话感英文女声 |

## 验证

### 已验证（Windows 11 + DSH 0.2.2-rc.1）

- 从 GitHub 安装：`dsh plugin --profile web add github:leiboss/dsh-tts`，插件正常激活。
- `tts_self_check`：`edgeTtsAvailable` / `spawnAllowed` / `outputDirWritable` 均为 `true`。
- `tts_generate`：返回文件路径与 `[▶ 播放](http://127.0.0.1:3080/dsh-tts/audio/...)` 文本；文件写入 `~/.dsh/tts-output/<date>/`。
- 播放路由：无浏览器会话的 `curl` 返回 401（`connection.requestRejection` 生效，属预期行为），带会话的浏览器可正常取到音频。

### 未验证

- 内联播放器在浏览器中的实际渲染与点击播放（客户端入口只做了静态检查与 `extractAudioUrls` 单测）。
- 在浏览器中点击 Markdown 形式的 `[▶ 播放](...)`、拖动进度条。
- SAPI 降级（本机无 `ffmpeg`）。
- 反向代理场景（`trustedHosts`）。

### 本地自测

```bash
npm run build
npm test          # 离线单元测试，子进程已注入替身
npm run check:engines
```

长文本分块、缓存、并发、降级链与路由 Range 均有离线用例覆盖。

端到端（需要真实 `edge-tts` 与网络）：

```bash
npm run test:integration
```

期望：生成一个非空 MP3 文件；终端输出包含文件路径；重复执行命中缓存且不再启动子进程。

## 能力接缝与沙箱

插件用 `node:child_process.spawn` 调用 `edge-tts`（降级时 `powershell.exe`、`ffmpeg`），用 `node:fs` 直接读写输出目录，不经过 `ctx.subprocess` 与宿主文件服务。TTS 是一次性 sidecar CLI，直连让行为在 Web / headless / Electron(`file://`) 下一致，也不把可执行文件解析、终端环境等宿主细节耦合进插件。

代价是沙箱策略按进程级生效，错误必须按来源区分：

| 错误码 | 含义 | 修法 |
| --- | --- | --- |
| `SPAWN_EPERM` | 创建子进程被策略拒绝，不是文件不可写 | 调整 DSH 沙箱的进程策略 |
| `OUTPUT_DIR_NOT_WRITABLE` | 子进程正常，但写文件被拒绝 | 检查输出目录权限与文件策略 |

两者混为一谈会让人去改错的地方，这是最常见的误判。文件权限跟随 Host 进程用户；输出目录默认 `$DSH_HOME/tts-output`，未设置时回退 `~/.dsh/tts-output`。

## 已知限制

- **需要联网访问 Edge-TTS**：离线时子进程超时或非零退出。缓解：配置 `fallbackEnabled` 与 `fallbackOrder`，Windows 可降级到 SAPI。
- **需要 Python 的 `edge-tts` 包**：未安装时报 `EDGE_TTS_NOT_FOUND`。缓解：`pip install edge-tts`，或用 `edgeTtsBinary` 指向可执行文件。
- **沙箱可能拒绝子进程**：报 `SPAWN_EPERM`，这是进程创建被策略拦截，不是文件不可写。缓解：调整 DSH 沙箱进程策略，或接受 `speechSynthesis` 标记由客户端朗读。
- **`pitch`/`volume` 不参与缓存键**：相同文本、音色、语速的第二次调用会返回首次生成的文件，即使本次指定了不同的 pitch/volume。缓解：更换 `voice` 或 `rate`，或手动删除对应缓存文件。
- **非 Windows 没有 SAPI 降级**：Linux/macOS 上会跳过 SAPI。缓解：保证 Edge-TTS 可用，或将 `speechSynthesis` 保留在降级链中。
- **内联播放器只在 DSH Web 生效**：客户端入口注册的是 keyed `tool.call.toolview`，只在工具结果里出现 `browserUrl` 时渲染原生 `<audio>`；headless、`file://`、未加载客户端插件的宿主不会显示播放器。若播放器不可用，回退到在回复正文里引用 `browserUrl` 或直接使用返回的 `filePath`。
- **来源校验交给宿主**：路由优先调用 `ctx.connection.requestRejection`（Host/Origin + 浏览器会话校验）。链接与当前 DSH 浏览器会话绑定：不带会话 cookie 的请求（包括 `curl`）会返回 401/403，因此不要把 `browserUrl` 当作可对外分享的公开链接，需要分享时请直接发送音频文件。旧宿主没有 `connection` 时回退为内置 Host 端口 + `Origin`/`Host` 同源校验，并保留签名 token 作为第二道防线。
- **反向代理需要 `trustedHosts`**：代理常改端口，配置 `trustedHosts` 后跳过端口钉死；留空则要求 Host 端口与监听端口一致。
- **签名密钥可轮换**：密钥存于 `<outputDir>/.audio-route-secret`，删除即让已发出的全部链接失效；文件读取/写入失败时回退内存密钥并只影响本次进程。
- **分块是字节拼接**：MP3 直接按字节拼接，不重新编码。缓解：长文本仍产出一个可播放文件；若播放器兼容性异常，可关闭分块或改用外部工具后处理。
- **不提供音频时长**：输出 schema 不再声明 `durationMs`，需要时长请用外部工具探测。
- **环境变量代理对 Edge-TTS 无效**：edge-tts 的 WSS 连接不读取 `HTTPS_PROXY` / `https_proxy`，设置环境变量不会生效；必须通过本插件的 `proxy` 配置项透传 `--proxy`。
- **端点单一，无自动迁移**：edge-tts 7.3.1 只有一个端点 `speech.platform.bing.com`。如果该端点在当前网络不可达，只能通过 `proxy` 或降级到 SAPI / `speechSynthesis`；可用 `tts_probe_network` 做一次 TCP 可达性判断。
- **引擎健康状态仅存在于内存**：插件重启后重置为 `healthy`。它反映的是最近一次尝试的结果，不是实时探测。如需确认当前网络可达性，请使用 `tts_probe_network`。

## 错误码

| 错误码 | 触发条件 | 处理建议 |
| --- | --- | --- |
| `EMPTY_TEXT` | `text` 为空白 | 传入非空文本 |
| `INVALID_VOICE` | `voice` 不符合 Edge-TTS 命名格式 | 使用如 `zh-CN-XiaoxiaoNeural` 的音色名 |
| `INVALID_RATE` | `rate` 不是 `+N%` / `-N%` | 使用 `+0%`、`-10%` 这类值 |
| `INVALID_PITCH` | `pitch` 不是 `+NHz` / `-NHz`（1–3 位数字） | 使用 `+0Hz`、`+10Hz` 这类值 |
| `INVALID_VOLUME` | `volume` 不是 `+N%` / `-N%`（1–3 位数字） | 使用 `+0%`、`-20%` 这类值 |
| `INVALID_CONFIG` | 配置值非法（如 `timeoutMs`、`totalTimeoutMs`、`chunkSize`、`maxConcurrent`、`queueSize`） | 按默认值范围修正配置 |
| `DSH_HOME_NOT_SET` | 未设置 `DSH_HOME` 且未配置 `outputDir` | 设置 `DSH_HOME` 或 `outputDir` |
| `OUTPUT_DIR_NOT_WRITABLE` | 输出目录无法写入（参见「能力接缝与沙箱」） | 检查沙箱文件策略与目录权限 |
| `EDGE_TTS_NOT_FOUND` | 找不到 `edge-tts` | `pip install edge-tts` 或设置 `edgeTtsBinary` |
| `SPAWN_EPERM` | 沙箱拒绝创建子进程（参见「能力接缝与沙箱」） | 调整 DSH 沙箱进程策略，不是文件权限问题 |
| `SPAWN_FAILED` | 其他子进程创建失败 | 检查 `edgeTtsBinary` 是否可执行 |
| `EDGE_TTS_FAILED` | Edge-TTS 非零退出 | 查看错误中的退出码与 stderr，检查网络与音色；持续失败时先运行 `tts_probe_network`，若不可达请配置 `proxy`（环境变量对 WSS 无效） |
| `SYNTHESIS_TIMEOUT` | 单个子进程超过 `timeoutMs`，或整次调用超过 `totalTimeoutMs` | 增大对应超时、缩短文本；若网络正常但仍超时，运行 `tts_probe_network` 并用 `proxy` 配置项透传 `--proxy` |
| `EMPTY_AUDIO` | Edge-TTS 退出成功但音频为空 | 重试；仍失败时运行 `tts_self_check` |
| `ABORTED` | 调用被取消 | 无需处理；调用方已取消 |
| `TTS_BUSY` | 队列满或排队超时 | 稍后重试，或增大 `maxConcurrent` / `queueSize` / `queueTimeoutMs` |
| `ALL_FALLBACKS_FAILED` | 降级链全部失败且链中无 `speechSynthesis` | 恢复 Edge-TTS，或把 `speechSynthesis` 加入 `fallbackOrder` |
| `SPEECH_SYNTHESIS_REQUIRED` | 宿主无法产出音频，返回 `fallback: "speechSynthesis"` | 由调用方朗读返回的 `text`；`fallbackReason` 给出各引擎失败原因，如需文件请安装/修复 edge-tts 后重试 |

## 开发与测试

```bash
npm run build
npm test
npm run test:integration
```

- `npm run build`：TypeScript 编译到 `dist/`。
- `npm test`：离线单元测试，使用注入的子进程替身，不依赖网络与真实 Edge-TTS。
- `npm run test:integration`：真实端到端链路，需要 `edge-tts` 与网络。

`engines.dsh` 必须能匹配当前运行的 DSH 版本；预发布版本（如 `0.2.2-rc.1`）低于同号正式版，写 `>=0.2.2` 会排除它。升级 DSH 后先确认该范围仍然成立。
