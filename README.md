# dsh-tts

DSH（DeepSeek Harness）工具插件：把文本合成为音频文件，并返回该文件的绝对路径。

它只负责“文本 → 音频文件”：不播放音频、不做语音转写、不做音色克隆，也不做音频后处理。

## 安装

前置条件：

- Node.js ≥ 22
- Python 3
- Edge-TTS Python CLI：

  ```bash
  pip install edge-tts
  edge-tts --version
  ```

安装插件：

```bash
# 从 GitHub 直接安装（仓库已包含 dist/ 编译产物，无需先构建）
dsh plugin add github:LeiBoss/dsh-tts

# 如果该包已发布到 npm
dsh plugin add dsh-tts
```

`package.json` 中的 `dsh.bundle.patch` 指向仓库根目录的 `cordis.patch.yml`，安装器拉取仓库后会直接解析并挂载插件。修改 `src/` 后需要重新执行 `npm run build`，因为仓库里的 `dist/` 是提交过的编译产物。

## 验证安装

1. 在 DSH 对话中问模型：“你有 `tts_generate` 工具吗？”
2. 或直接调用 `tts_self_check`，期望 `edgeTtsAvailable`、`spawnAllowed`、`outputDirWritable` 三个布尔字段均为 `true`，且 `dshHome` 非空。
3. 最小对话示例：“把‘你好’合成语音”。工具会返回：

   ```json
   { "filePath": "/absolute/path/$DSH_HOME/tts-output/2026-11-11/<hash>-<timestamp>.mp3", "format": "mp3" }
   ```

   模型只拿到文件路径与可选的播放地址，不感知音频内容。

   当 DSH Web 宿主提供 `httpServer` 时，返回值还会包含 `browserUrl`（同源、带签名与
   有效期、支持 HTTP Range 206 的 GET 路由），浏览器可直接打开播放。非 Web 运行模式
   下只返回 `filePath`。使用降级引擎时还会包含 `engine`；宿主端无法产出文件时会返回
   `fallback: "speechSynthesis"`，由调用方使用浏览器语音合成。

## 配置

以下配置项均可通过 DSH 配置层（插件 config）覆盖，插件不会自行读写 profile 的 `cordis.patch.yml`：

| 配置项 | 默认值 | 作用 | 覆盖方式 |
| --- | --- | --- | --- |
| `outputDir` | `$DSH_HOME/tts-output` | 音频输出根目录，实际文件写入其下的 `<YYYY-MM-DD>/` 子目录 | 在插件 config 中设置 `outputDir` |
| `defaultVoice` | `zh-CN-XiaoxiaoNeural` | 调用 `tts_generate` 未传 `voice` 时使用的音色 | 在插件 config 中设置 `defaultVoice` |
| `timeoutMs` | `30000` | 单个 Edge-TTS 子进程超时，超时后终止并报错 | 在插件 config 中设置 `timeoutMs` |
| `edgeTtsBinary` | `edge-tts` | Edge-TTS CLI 名称或可执行文件路径 | 在插件 config 中设置 `edgeTtsBinary` |
| `chunkSize` | `1200` | 超过该字符数的文本按句子边界分块，串行合成后拼接为单个 MP3 | 在插件 config 中设置 `chunkSize` |
| `chunkingEnabled` | `true` | 是否启用长文本分块；关闭后长文本一次性交给 Edge-TTS | 在插件 config 中设置 `chunkingEnabled` |
| `fallbackEnabled` | `true` | Edge-TTS 失败后是否尝试降级链 | 在插件 config 中设置 `fallbackEnabled` |
| `fallbackOrder` | `['edge-tts', 'sapi', 'speechSynthesis']` | 降级链顺序；未知引擎名会被忽略 | 在插件 config 中设置 `fallbackOrder` |

示例（仅覆盖默认值，不修改代码）：

```yaml
- insert:
    - id: dsh-tts
      name: 'dsh-tts'
      config:
        defaultVoice: en-US-AriaNeural
        timeoutMs: 45000
```

未设置 `DSH_HOME` 且未配置 `outputDir` 时，`tts_generate` 会返回 `DSH_HOME_NOT_SET`。

## 错误码

| 错误码 | 触发条件 | 处理建议 |
| --- | --- | --- |
| `EDGE_TTS_NOT_FOUND` | 找不到 `edge-tts` 可执行文件（`spawn ENOENT`） | 执行 `pip install edge-tts`，或通过 `edgeTtsBinary` 指定可执行文件路径 |
| `SPAWN_EPERM` | 沙箱拒绝创建子进程（`spawn EPERM`） | 检查 DSH 沙箱文件/进程策略并提升允许范围；这不是输出目录的文件系统权限问题 |
| `SYNTHESIS_TIMEOUT` | Edge-TTS 子进程超过 `timeoutMs` 未结束 | 增大 `timeoutMs`，并检查到 Edge-TTS 服务的网络连接 |
| `EDGE_TTS_FAILED` | Edge-TTS 子进程非零退出 | 查看错误信息中的退出码与 stderr；检查音色名、语速和网络 |
| `EMPTY_TEXT` | `text` 为纯空白 | 传入非空文本 |
| `ALL_FALLBACKS_FAILED` | 降级链中的所有宿主端引擎都失败（且链中没有 `speechSynthesis`） | 查看错误信息中列出的引擎链与各引擎原因；恢复 Edge-TTS 或把 `speechSynthesis` 加入 `fallbackOrder` |
| `SPEECH_SYNTHESIS_REQUIRED` | 宿主端无法产出音频，返回值标记 `fallback: "speechSynthesis"` | 由调用方使用浏览器 `speechSynthesis` API 朗读原文 |

错误对象包含机器可读的 `code`、人类可读的 `message`，以及可选的 `suggestion`。

## 已知限制

- 需要联网访问 Edge-TTS 服务，网络不通时会出现 `SYNTHESIS_TIMEOUT` 或 `EDGE_TTS_FAILED`。
- 首次使用前必须安装 `edge-tts` Python 包，否则报 `EDGE_TTS_NOT_FOUND`。
- 沙箱环境可能以 `EPERM` 拒绝子进程，此时报 `SPAWN_EPERM`，需要调整 DSH 沙箱策略。
- 降级仅在 Edge-TTS 引擎失败（子进程非零退出、超时、空音频、无法启动）时触发；参数校验失败与缓存命中不会降级。
- SAPI 降级仅限 Windows，通过 `powershell.exe` 合成 WAV，再要求 `ffmpeg` 转换为 MP3；缺少 `ffmpeg` 时继续降级到 `speechSynthesis`。SAPI 使用系统默认语音，不映射 Edge 的 `voice` 参数。
- 宿主端无法产出文件且链中包含 `speechSynthesis` 时，返回 `filePath` 为空字符串的标记值，需要调用方配合朗读。
- 当前不解析音频容器时长，返回值的可选字段 `durationMs` 会省略。

## 开发与测试

```bash
npm install
npm run build            # 类型检查并生成 dist/
npm test                 # node --test，不联网、不依赖真实 edge-tts
npm run test:integration # 需真实 edge-tts 与可用网络
```

缓存：相同 `(text, voice, rate)` 会命中已存在的非空音频文件，直接返回路径，不启动子进程。
