# @leiboss/dsh-voiceover

把一篇长文变成一套可发布的有声内容：分章、口播化改写、逐章合成、字幕、manifest，可中断可续跑。

不是「把一句话读出来」——那是 `@leiboss/dsh-tts` 的 `tts_generate`。

## 安装

```bash
dsh plugin --profile <profile> add @leiboss/dsh-voiceover
```

会连带挂载引擎 `@leiboss/dsh-tts`（见 `cordis.patch.yml`）。

配置（DSH 配置层）：

| 项 | 默认 | 说明 |
|---|---|---|
| `outputDir` | `$DSH_HOME/voiceover` | 项目根目录 |
| `defaultVoice` | `zh-CN-XiaoxiaoNeural` | 默认音色 |
| `defaultRate` | `+0%` | 默认语速 |
| `style` | `news` | `lecture` / `news` / `story` / `docs` |
| `auditSample` | `2` | 前 N 章必检；长章（>3000 字）也必检 |
| `llmBaseUrl` | 空 | OpenAI 兼容端点；为空则按原文朗读 |
| `llmApiKey` | 空 | 端点密钥 |
| `llmModel` | `deepseek-chat` | 记录进 manifest |

## 用法

```text
把 D:\docs\ai-engineering.md 做成有声书，女声，每章带字幕
```

1. `voiceover_create` — 立即返回 `projectId`，后台开始跑
2. `voiceover_status` — 轮询逐章进度
3. `voiceover_export` — 拿到音频、字幕、manifest 的绝对路径

## 产物

```
<outputDir>/<projectId>/
  source/normalized.md
  script/ch-01.md
  audio/ch-01.mp3
  audio/ch-01.est.srt      # estimated 时带 .est
  state/state.json          # 断点续跑依据
  manifest.json             # 契约，schema 见 schemas/
```

## 降级矩阵

| 模型 | 网络 | 行为 | 产物 |
|---|---|---|---|
| ✅ | ✅ | 完整流水线 | 口播稿 + 精确/估算字幕 |
| ✅ | ❌ | 改写照做，合成走本地引擎 | 文稿好、音色机械 |
| ❌ | ✅ | 按原文直读 | 书面语，字幕估算 |
| ❌ | ❌ | 最简模式 | 可听、无改写 |

降级都会写进 `manifest.warnings` 与 `capability`，不静默。

## 已知限制

- 只支持 `.md` / `.txt` 输入（PDF/DOCX 待做）
- 运行跟随宿主进程；宿主要求「创建即返回」，所以长任务在后台，进程退出即中断（可用 `voiceover_status` 续跑）
- 字幕质量为 `estimated` 时文件名带 `.est`，不要当帧级精确使用
- 暂无 UI 面板 / daemon / zip 导出
## 对话内进度面板

`voiceover_create` / `voiceover_status` 的结果下方会渲染一个进度面板（仅 DSH Web 宿主）：

- 标题 + `完成/总章数` + 进度条
- 能力条：`模型 改写`／`按原文朗读`、`Edge 可达`／`本地引擎`、`字幕 精确`／`估算`
- 逐章状态（排队/改写/合成/完成/失败）、时长、是否带字幕
- 降级与失败原因（warnings）

面板从工具结果里取 `projectId`，随后轮询宿主只读路由 `GET /voiceover/panel/<projectId>.json`
（同一会话围栏，只返回进度，不返回稿件正文与文件路径）。首章规划期间显示「准备中」，
不再误报接口不可用。

**没有播放按钮**：音频在项目目录里，用 `voiceover_export` 拿路径。要续跑失败的章节，
对同一份源文再执行一次 `voiceover_create` 即可（项目 ID 由内容哈希决定，已完成的章节会跳过）。
