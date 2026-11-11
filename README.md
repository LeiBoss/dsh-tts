# dsh-tts

> 安装：`dsh plugin add dsh-tts`（未发布 npm 时使用 `dsh plugin add github:LeiBoss/dsh-tts`）
>
> 问题反馈：https://github.com/LeiBoss/dsh-tts/issues

## 简介

`dsh-tts` 是一个 DSH 工具插件：把文本合成为音频文件，返回本地路径与可选的同源播放地址。它不是播放器，不做语音转写，也不做音色克隆。

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
| `ctx.inject(['httpServer'])` | 可选依赖宿主 HTTP 路由；非 Web 运行模式自动跳过 |
| `ctx.httpServer.register` | 注册 `prefix` 路由 `/dsh-tts/audio`，返回音频字节并处理 Range |
| DSH 配置层（`Config` + `apply` 的 config） | 读取 11 项配置；插件不自行读写 `cordis.patch.yml` |
| `child_process.spawn` | 调用 `edge-tts`；降级时调用 `powershell.exe` 与 `ffmpeg` |
| 文件系统 | 写入 `$DSH_HOME/tts-output/<YYYY-MM-DD>/<hash>-<timestamp>.mp3` |

一次请求的路径：参数校验 → 缓存查找（命中直接返回）→ 同 key 在途请求合并 → 并发槽位 → 分块或一次性合成 → 失败时降级 → 落盘 → 生成签名播放 URL。

## 工具一览

| 工具 | 参数 | 返回 | 何时调用 |
| --- | --- | --- | --- |
| `tts_generate` | `text`（必填）、`voice`、`rate`、`pitch`、`volume` | `{ filePath, format, durationMs?, browserUrl?, engine?, fallback? }` | 用户要求把文字读出来、生成配音或音频文件时 |
| `tts_self_check` | 无 | `{ edgeTtsAvailable, edgeTtsVersion?, spawnAllowed, outputDirWritable, dshHome, availableVoices }` | 安装后自检，或 `tts_generate` 报环境类错误时 |

`tts_generate` 不播放音频、不转录音频、不克隆或修改音色、不做音频后处理，也不生成音乐。`durationMs` 当前不会返回，保留为后续扩展字段。

默认值：`voice = zh-CN-XiaoxiaoNeural`，`rate = +0%`，`pitch = +0Hz`，`volume = +0%`。

## 安装

环境要求：

- Node.js ≥ 22
- Python 3
- `pip install edge-tts`
- Windows 上使用 SAPI 降级时还需要 `ffmpeg` 在 PATH 中（用于 WAV → MP3）

首选 npm（包发布后可用）：

```bash
dsh plugin add dsh-tts
```

GitHub 备选：

```bash
dsh plugin add github:LeiBoss/dsh-tts
```

仓库包含编译产物 `dist/`。如果从源码工作，先执行：

```bash
npm install
npm run build
```

安装后在 DSH 对话中确认工具存在：

```text
你有 tts_generate 工具吗
```

或直接调用 `tts_self_check`，期望 `edgeTtsAvailable`、`spawnAllowed`、`outputDirWritable` 为 `true`，且 `availableVoices` 非空。

最小示例：

```text
把“你好”合成语音
```

## 配置

所有配置都通过 DSH 配置层覆盖，不在工具参数里传入。

| 配置项 | 默认值 | 作用 | 覆盖方式 |
| --- | --- | --- | --- |
| `outputDir` | `$DSH_HOME/tts-output` | 音频输出根目录，文件写入其下日期子目录 | 插件 config 的 `outputDir` |
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

`browserUrl` 是同源相对地址，可在浏览器地址栏直接打开播放；它带有效期与签名，不能跨源复用。

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

已在本地验证：

- `npm run build` 无类型错误。
- `npm test` 全部通过（含路由 Range 200/206/416、签名 token、分块拼接、降级链、并发与 HMR）。
- 路由处理器通过真实 HTTP socket 验证：同源 `Range` 返回 206，跨源请求返回 403。

离线可验（不依赖网络与真实 Edge-TTS）：

```bash
npm test
```

端到端（需要真实 `edge-tts` 与网络）：

```bash
npm run test:integration
```

期望：生成一个非空 MP3 文件；终端的输出包含文件路径；重复执行命中缓存且不再启动子进程。

需在真实环境验证：

- DSH Web 中的 `browserUrl` 播放与进度条拖动（本仓库无宿主环境）。
- Windows 上的 SAPI 降级（需要 `powershell.exe` 与 `ffmpeg`）。

## 已知限制

- **需要联网访问 Edge-TTS**：离线时子进程超时或非零退出。缓解：配置 `fallbackEnabled` 与 `fallbackOrder`，Windows 可降级到 SAPI。
- **需要 Python 的 `edge-tts` 包**：未安装时报 `EDGE_TTS_NOT_FOUND`。缓解：`pip install edge-tts`，或用 `edgeTtsBinary` 指向可执行文件。
- **沙箱可能拒绝子进程**：报 `SPAWN_EPERM`，这是进程创建被策略拦截，不是文件不可写。缓解：调整 DSH 沙箱进程策略，或接受 `speechSynthesis` 标记由客户端朗读。
- **`pitch`/`volume` 不参与缓存键**：相同文本、音色、语速的第二次调用会返回首次生成的文件，即使本次指定了不同的 pitch/volume。缓解：更换 `voice` 或 `rate`，或手动删除对应缓存文件。
- **非 Windows 没有 SAPI 降级**：Linux/macOS 上会跳过 SAPI。缓解：保证 Edge-TTS 可用，或将 `speechSynthesis` 保留在降级链中。
- **客户端播放入口缺失**：当前只返回 `browserUrl`，需要用户在浏览器中打开，没有内联 `<audio>` 控件。缓解：后续迭代再提供客户端播放器。
- **来源校验为降级实现**：当前 DSH 版本未提供 `ctx.connection.requestRejection`，路由使用 Host 端口 + `Origin` 与 `Host` 同源校验，并保留签名 token 作为第二道防线。缓解：不要在不可信共享网络中直接暴露 DSH 端口，使用反向代理与网络隔离。
- **分块是字节拼接**：MP3 直接按字节拼接，不重新编码。缓解：长文本仍产出一个可播放文件；若播放器兼容性异常，可关闭分块或改用外部工具后处理。
- **`durationMs` 未实现**：当前不解析音频容器时长，该字段省略。

## 错误码

| 错误码 | 触发条件 | 处理建议 |
| --- | --- | --- |
| `EMPTY_TEXT` | `text` 为空白 | 传入非空文本 |
| `INVALID_VOICE` | `voice` 不符合 Edge-TTS 命名格式 | 使用如 `zh-CN-XiaoxiaoNeural` 的音色名 |
| `INVALID_RATE` | `rate` 不是 `+N%` / `-N%` | 使用 `+0%`、`-10%` 这类值 |
| `INVALID_CONFIG` | 配置值非法（如 `timeoutMs`、`chunkSize`、`maxConcurrent`、`queueSize`） | 按默认值范围修正配置 |
| `DSH_HOME_NOT_SET` | 未设置 `DSH_HOME` 且未配置 `outputDir` | 设置 `DSH_HOME` 或 `outputDir` |
| `OUTPUT_DIR_NOT_WRITABLE` | 输出目录无法写入 | 检查沙箱文件策略与目录权限 |
| `EDGE_TTS_NOT_FOUND` | 找不到 `edge-tts` | `pip install edge-tts` 或设置 `edgeTtsBinary` |
| `SPAWN_EPERM` | 沙箱拒绝创建子进程 | 调整 DSH 沙箱进程策略，不是文件权限问题 |
| `SPAWN_FAILED` | 其他子进程创建失败 | 检查 `edgeTtsBinary` 是否可执行 |
| `EDGE_TTS_FAILED` | Edge-TTS 非零退出 | 查看错误中的退出码与 stderr，检查网络与音色 |
| `SYNTHESIS_TIMEOUT` | 单个子进程超过 `timeoutMs` | 增大 `timeoutMs` 或检查网络 |
| `EMPTY_AUDIO` | Edge-TTS 退出成功但音频为空 | 重试；仍失败时运行 `tts_self_check` |
| `ABORTED` | 调用被取消 | 无需处理；调用方已取消 |
| `TTS_BUSY` | 队列满或排队超时 | 稍后重试，或增大 `maxConcurrent` / `queueSize` / `queueTimeoutMs` |
| `ALL_FALLBACKS_FAILED` | 降级链全部失败且链中无 `speechSynthesis` | 恢复 Edge-TTS，或把 `speechSynthesis` 加入 `fallbackOrder` |
| `SPEECH_SYNTHESIS_REQUIRED` | 宿主无法产出音频，返回 `fallback: "speechSynthesis"` | 由调用方使用浏览器 `speechSynthesis` 朗读原文 |

## 开发与测试

```bash
npm run build
npm test
npm run test:integration
```

- `npm run build`：TypeScript 编译到 `dist/`。
- `npm test`：离线单元测试，使用注入的子进程替身，不依赖网络与真实 Edge-TTS。
- `npm run test:integration`：真实端到端链路，需要 `edge-tts` 与网络。
