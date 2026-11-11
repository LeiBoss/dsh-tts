# dsh-tts

DSH（DeepSeek Harness）工具插件：给定文本，用 Edge-TTS 合成音频并落盘，返回音频文件的绝对路径。

它只做“文本 → 音频文件”这一件事：不播放音频、不做 ASR、不做音色克隆、不做音频后处理、不做多 Provider 路由。

## 工具

### `tts_generate`

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `text` | string | 是 | — | 要朗读的文本，不能是纯空白 |
| `voice` | string | 否 | 配置项 `defaultVoice` | Edge-TTS 音色名，如 `zh-CN-XiaoxiaoNeural` |
| `rate` | string | 否 | `+0%` | 语速百分比，如 `-10%` |

返回值严格匹配 `output.schema`，没有额外字段：

```json
{ "filePath": "/abs/path/$DSH_HOME/tts-output/2026-11-11/2f4a...-1762833600000.mp3", "format": "mp3" }
```

`durationMs` 是可选字段；当前实现不解析音频容器，因此不会返回。
模型只拿到路径，不感知音频内容。

### `tts_self_check`

无参数，不合成音频。返回：

```json
{
  "edgeTtsAvailable": true,
  "edgeTtsVersion": "7.0.2",
  "spawnAllowed": true,
  "outputDirWritable": true,
  "dshHome": "/home/user/.dsh"
}
```

- `edgeTtsAvailable`：`edge-tts` 进程能否启动；命令存在但 `--version` 不被支持时仍为 `true`，此时 `edgeTtsVersion` 省略。
- `spawnAllowed`：沙箱是否允许创建子进程。`spawn EPERM` 时为 `false`；可执行文件不存在（`ENOENT`）时仍为 `true`。
- `outputDirWritable`：输出目录能否创建并通过 `W_OK` 检查。
- `dshHome`：`DSH_HOME` 的值，未设置时为空字符串。

## 环境要求

- Node.js ≥ 22（构建产物为 ESM）。
- Python 包 `edge-tts`：
  ```bash
  pip install edge-tts
  edge-tts --version
  ```
- 运行 DSH 时设置 `DSH_HOME`（插件默认把音频写到 `$DSH_HOME/tts-output`）。
- DSH 沙箱必须允许创建子进程。默认策略若拒绝 `spawn`，`tts_generate` 会返回 `SPAWN_EPERM`。

## 安装与挂载

`package.json` 已声明：

```json
{
  "type": "module",
  "exports": { ".": "./dist/index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "files": ["dist", "cordis.patch.yml"]
}
```

`cordis.patch.yml` 通过包名引用，安装方可以拿到该配置层：

```yaml
- insert:
    - id: dsh-tts
      name: 'dsh-tts'
      config: {}
```

安装与验包：

```bash
npm install
npm run build
npm pack --dry-run   # 确认包内包含 dist/ 与 cordis.patch.yml
```

在 DSH 中通过 `--patch` 加载（具体参数以当前 DSH CLI 为准），或把上面的 `insert` 条目放进 profile 配置。

## 配置

四项配置都可以通过 DSH 配置层覆盖，插件只读取 Cordis 传入的 config，不自行读写 profile 的 `cordis.patch.yml`：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `outputDir` | `$DSH_HOME/tts-output` | 输出根目录；显式设置时可以是任意绝对/相对路径（会解析为绝对路径） |
| `defaultVoice` | `zh-CN-XiaoxiaoNeural` | 调用未传 `voice` 时使用 |
| `timeoutMs` | `30000` | 单次子进程超时，超时后发送 `SIGTERM` 并抛 `SYNTHESIS_TIMEOUT` |
| `edgeTtsBinary` | `edge-tts` | CLI 名称或绝对路径 |

示例：

```yaml
- insert:
    - id: dsh-tts
      name: 'dsh-tts'
      config:
        defaultVoice: en-US-AriaNeural
        timeoutMs: 45000
        edgeTtsBinary: /opt/venv/bin/edge-tts
```

未设置 `DSH_HOME` 且未配置 `outputDir` 时，`tts_generate` 返回 `DSH_HOME_NOT_SET`；`tts_self_check` 仍可正常运行并把 `dshHome` 报告为空字符串。

## 缓存与去重

- 合成前对 `(text, voice, rate)` 计算 SHA-256，取前 16 个十六进制字符作为 key。
- 文件路径：`<outputDir>/<YYYY-MM-DD>/<hash>-<epochMs>.mp3`。
- 命中规则：在日期目录中查找 `<hash>-*.mp3` 且大小 > 0 的文件；命中时直接返回，不启动子进程、不访问网络。
- 新文件先写到同目录的 `.partial`，成功后再原子 rename，避免并发/中断产生被当成缓存的半成品。

## 错误码

| code | 含义 | 建议动作 |
| --- | --- | --- |
| `EMPTY_TEXT` | `text` 为纯空白 | 传入非空文本 |
| `INVALID_VOICE` | 音色名不符合 Edge-TTS 命名格式 | 用 `zh-CN-XiaoxiaoNeural` 这类名称，`edge-tts --list-voices` 查看 |
| `INVALID_RATE` | 语速不是 `+0%` / `-10%` 形式 | 使用带符号的百分比 |
| `INVALID_CONFIG` | `timeoutMs` 非正数 | 修正插件配置 |
| `DSH_HOME_NOT_SET` | 没有可用的输出目录 | 设置 `DSH_HOME` 或配置 `outputDir` |
| `EDGE_TTS_NOT_FOUND` | 找不到 CLI | `pip install edge-tts`，或设置 `edgeTtsBinary` |
| `SPAWN_EPERM` | 沙箱拒绝创建子进程 | 提升 DSH 沙箱进程/文件策略；这不是输出目录不可写 |
| `SPAWN_FAILED` | 其他 spawn 失败 | 检查 `edgeTtsBinary` 是否可执行 |
| `EDGE_TTS_FAILED` | 子进程非零退出 | 查看错误中的退出码与 stderr；检查音色、语速、网络 |
| `SYNTHESIS_TIMEOUT` | 超过 `timeoutMs` | 增大超时或检查网络 |
| `EMPTY_AUDIO` | 进程成功但没有音频字节 | 重试并运行 `tts_self_check` |
| `OUTPUT_DIR_NOT_WRITABLE` | 输出目录创建/写入/rename 失败 | 检查沙箱文件策略与目录权限 |
| `ABORTED` | 调用被取消 | 无需处理 |

每个错误都带 `code`、人类可读 `message` 和可选 `suggestion`；`suggestion` 同时拼进 `message`，模型能直接读到操作建议。

## 测试

```bash
npm run build   # 类型检查 + 产出 dist/
npm test        # node --test，全部使用注入的假子进程，不联网、不依赖真实 edge-tts
```

覆盖内容：

- 空文本、非法 voice / rate；
- 缓存命中：第二次调用不 spawn；
- `spawn` 同步/异步 `EPERM`、`ENOENT`、非零退出、超时、空音频、取消；
- canonical 返回值只含 `filePath` / `format`；
- `tts_self_check` 在缺失 CLI、被拒绝 spawn、目录不可写时的布尔值；
- `defaultVoice` 配置覆盖。

真实环境端到端（需已安装 edge-tts 且允许联网）：

```bash
DSH_HOME=/tmp/dsh-tts-integration npm run test:integration
```

## 非目标

- 不实现 UI 卡片、播放器、波形图。
- 不播放音频、不做转写、不做音色克隆或语音修改。
- 不引入 OpenAI TTS / Piper 等其他 Provider。
- 不解析音频时长；`durationMs` 当前省略。
