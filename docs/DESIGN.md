# dsh-voiceover 设计方案

版本：v0.1 设计稿 · 日期：2026-11-11
主线：A（有声内容流水线）· 卖点：C（受限网络可用性）· 第二出口：D（本地 daemon / MCP）

---

## 0. 结论摘要

| 问题 | 结论 |
|---|---|
| 做给谁 | 要把「长文」变成「可发布音频」的人：课程/专栏作者、自媒体、播客、内部培训、有声书试做 |
| 卖什么 | 章节化成品（MP3 + SRT + manifest），不是「一句话朗读」 |
| 凭什么赢 | 分块 / 缓存 / 并发 / 断点续跑是这件事的刚需，而竞品都在做即时朗读；再叠加「断网也能生产」 |
| 怎么变现 | 免费 3 章 / 专业版无限章 + 字幕 + 批量导出；引擎层与 daemon 永久免费（做渠道） |
| 最大风险 | ① 平台出 TTS seam ② Edge 端点限流 ③ 提示词改写质量不稳 ④ 「有声化」需求被低估 |
| 止损线 | 60 天内没有 10 个用户跑完 ≥ 8 章的项目 → 回退到「单章 + 字幕」的窄工具 |

---

## 1. 定位与边界

**定位**：DSH 里的「有声内容生产线」。输入一份长文档，输出一套可直接发布/分发的音频资产。

**边界（明确不做，防止又滑回通用 TTS）**

| 不做 | 原因 |
|---|---|
| 实时流式朗读 / 逐条朗读按钮 | 这是 `@goodandready/dsh-tts`、`@memef1f1y/dsh-plugin-tts`、`dsh-xiaomi-tts` 的战场，进去就是拼 UI 和供应商数量 |
| 音色克隆 | 本地模型重（Qwen3-TTS / GSV），`dsh-gsv-tts`、`dsh-tts-speakout` 已占位 |
| 语音转写 | 平台自己有 `dsh-experimental-speech-to-text` |
| 音频后期（降噪/配乐/母带） | 不是 TTS 问题，交给 ffmpeg 生态 |
| 在线托管分发 | `browserUrl` 只对本机会话有效，对外分享发文件 |

**与现有 `@leiboss/dsh-tts` 的关系**：不改名、不推翻。它降级为**引擎层**（0.3.x），新包 `@leiboss/dsh-voiceover` 是产品层（0.1.x）。上一轮指出的「没有 `ctx.tts` service、provider 只有类型」在引擎层补齐，产品层只依赖服务接口。

---

## 2. 用户与场景

### 2.1 三个 persona

| Persona | 现状做法 | 痛点 | 我们的钩子 |
|---|---|---|---|
| **课程/专栏作者**（知识付费） | 手动复制粘贴到在线 TTS，逐段下载再拼 | 分段质量不稳、拼接口音、字幕要另做、改一个字要重来 | 一次跑完 + 改稿只重跑该章 |
| **企业内部培训/合规**（内网、代理） | 外包配音或不做 | 网络出不去 Edge、外包贵、内容常改 | 断网可生产 + 本地引擎降级 + 可重复构建 |
| **播客/有声书试做** | 找配音或自己录 | 试听成本高、想先出 demo 验证选题 | 1 万字 15 分钟出 8 章样带 |

### 2.2 JTBD（用户真正要完成的事）

> 当我有一篇已经定稿的长文，我要在**不逐段操作**的前提下拿到**成套的音频和字幕**，并且**改稿后只重做改动部分**，这样我才能把它发布出去而不被流程拖住。

关键动词是「成套」「可增量」「可交付」。这三件事决定了架构：**章节化 + 内容哈希 + 清单**。

### 2.3 反场景（不要接的需求）

- 「帮我把这句话读出来」→ 引导去 `tts_generate`（短句、即时、无项目概念）。
- 「边生成边播放」→ 不做流式，明说。
- 「给我配个背景音乐」→ 不做。

---

## 3. 产品形态与包结构

```
┌──────────────────────────────────────────────────────────────┐
│ 交付层  voiceover serve --http --mcp        （D 线，第二出口）│
│         POST /v1/voiceover · /v1/tts · MCP tools              │
├──────────────────────────────────────────────────────────────┤
│ 产品层  @leiboss/dsh-voiceover                                │
│         tools: voiceover_create / status / export / rerun     │
│         pipeline: outline → adapt → prosody → tts → timeline  │
│         artifacts: manifest / srt / chapter meta              │
├──────────────────────────────────────────────────────────────┤
│ 引擎层  @leiboss/dsh-tts                                      │
│         service: ctx.tts（provider 链 / 缓存 / 并发 / 路由）   │
│         tools: tts_generate / tts_self_check / tts_probe      │
└──────────────────────────────────────────────────────────────┘
```

**为什么分两个包**

1. 引擎层的正确性（并发、错误分层、缓存）已经有测试资产，不该被产品逻辑污染；
2. D 线要求「DSH 之外的进程也能用」——引擎层必须能在没有 DSH 的 Node 进程里独立跑；
3. 版本节奏不同：引擎层求稳（0.3.x 只修 bug），产品层求快（0.1.x 每周迭代）；
4. 上一轮那个「被依赖」的幻想，只有拆出来才有可能成立——`ctx.tts` 是稳定接口，产品只是第一个消费者。

**DSH 内入口**：4 个工具 + 1 个进度面板（client 插件），无独立页面。

---

## 4. 端到端流程

### 4.1 阶段

```
source ──① 归一化──▶ normalized.md
                      │
                      ├─② 分块摘要（P0a，按 6000 字/块）
                      ├─③ 大纲合并（P0b）──▶ outline.json
                      │
              ┌───────┴──────── 每章独立、可并行 ────────┐
              ▼                                          ▼
   ④ 口播化改写（P1）                       ⑤ 节奏标注（P2）
              │                                          │
              └──────────────┬───────────────────────────┘
                             ▼
                    ⑥ 质检（P4）── 有 high ──▶ 回 ④（带 issues）
                             │ pass
                             ▼
                    ⑦ 合成（引擎 + 并发 + 缓存）
                             │
                    ⑧ 时间轴 / 字幕（P3 + 引擎 WordBoundary 或帧扫描）
                             │
                    ⑨ 落盘 + manifest + 原生播放器
```

### 4.2 状态机（每章）

```
queued → adapted → marked → audited ─┬─▶ synthesized → timed → done
        ▲                            │
        └──── retry(P1+issues) ◀─────┘  (high severity)
                           
任意状态 → failed(code) ──▶ 可重试(backoff) / 不可重试(报错终止)
```

- 状态与哈希写入 `state.json`，每步完成即持久化（崩溃可续）。
- **不可重试**：`INVALID_CONFIG`、`SPAWN_EPERM`、`OUTPUT_DIR_NOT_WRITABLE`、`NO_ENGINE_AVAILABLE`。
- **可重试**：`TTS_BUSY`、`SYNTHESIS_TIMEOUT`、`EDGE_TTS_FAILED`、`LLM_RATE_LIMIT`、`LLM_SCHEMA_INVALID`。
- 重试预算：每章 ≤ 3 次，退避 2s/8s/30s；整项目 wall clock 上限默认 2h。

### 4.3 交互（DSH 对话内）

```
用户：把 D:\docs\ai-engineering.md 做成有声书，女声，每章带字幕
agent：[voiceover_create] → {projectId, chapters: 8, estMinutes: 9}
agent：[voiceover_status] → 进度：3/8 章完成（第 3 章合成中）
       （面板同步显示章节列表，可单章重跑 / 试听 / 导出）
agent：[voiceover_export format=m4b|zip|srt]
```

---

## 5. 产物契约（这是产品的底盘，先定契约再写码）

### 5.1 目录结构

```
$DSH_HOME/voiceover/<projectId>/
  project.json          # 输入指纹、配置快照、提示词版本
  source/
    raw.<ext>           # 原文件（copy 一份，禁止引用外部路径）
    normalized.md       # 归一化正文（去页眉页脚/脚注编号/排版符号）
  plan/
    outline.json        # 章节大纲（schema 见 schemas/outline.schema.json）
    blocks/block-003.json  # P0a 的分块结果（可审计、可复算）
  script/
    ch-01.md            # 口播稿（改写后）
    ch-01.marks.json    # 标注统计（插了多少 break / prosody）
  audio/
    ch-01.mp3
    ch-01.srt
    ch-01.meta.json     # 时长、字节、timingQuality、engine、hash
  export/
    <title>.m4b         # 可选（需要 ffmpeg；缺失则跳过并 warning）
    <title>.zip
  state/
    state.json          # 每章状态、尝试次数、哈希
    run-20261111T1430.jsonl  # 结构化日志（不带正文，便于排障与分享）
  manifest.json
```

### 5.2 manifest 关键字段

完整 schema：`schemas/manifest.schema.json`。要点：

```jsonc
{
  "schemaVersion": 1,
  "projectId": "8f3c1a9d2b04",
  "createdAt": "2026-11-11T14:30:00+08:00",
  "title": "AI 工程实践",
  "capability": {
    "llm": true,              // 改写是否可用
    "network": true,          // Edge 端点可达
    "wordBoundaries": true,   // 引擎是否返回词边界
    "timingQuality": "exact"  // exact | estimated
  },
  "engine": { "name": "edge-js", "version": "1.2.12", "voice": "zh-CN-XiaoxiaoNeural", "rate": "+0%" },
  "promptVersion": "p1.3",
  "source": { "path": "source/normalized.md", "hash": "sha256:…", "chars": 10342 },
  "chapters": [
    {
      "id": "ch-01", "order": 1, "title": "为什么是插件",
      "sourceRange": [0, 1280], "chars": 1280,
      "audio": { "path": "audio/ch-01.mp3", "bytes": 412_331, "durationMs": 168_400, "timingQuality": "exact" },
      "subtitles": { "path": "audio/ch-01.srt", "units": 142 },
      "status": "done"
    }
  ],
  "totals": { "chapters": 8, "chars": 10342, "audioMs": 1_284_000, "bytes": 3_208_112 },
  "warnings": ["m4b export skipped: ffmpeg not found"]
}
```

**契约硬规则**

1. `manifest.json` 必须是**纯 JSON**、稳定字段序、`schemaVersion` 单调递增；
2. 所有路径相对项目根，禁止绝对路径（可整目录搬到别处）；
3. `capability` 必须如实反映，不允许在 `timingQuality=estimated` 时对外宣称帧级准确；
4. 任何降级（无 LLM、无网络、无 ffmpeg）必须写进 `warnings`，不允许静默降级。

### 5.3 字幕规则（SRT）

| 规则 | 值 | 理由 |
|---|---|---|
| 每行字数 | ≤ 18 个汉字 | 手机竖屏可读 |
| 每屏行数 | 1–2 行 | 超过要拆 |
| 最短停留 | 0.8s | 低于此读不完 |
| 相邻间隙 | 0.05s | 避免闪烁 |
| 断句 | 按语义单元，禁止跨句合并 | 用 P3 的 `units`，而不是机械按标点切 |
| 时间来源 | 引擎 WordBoundary（exact）或帧扫描 + 字数比例（estimated） | 见 §7.3 |

`estimated` 模式必须在 `meta.json` 与 manifest 里标注，导出时在文件名加 `.est` 后缀（例如 `ch-01.est.srt`），避免用户以为是准的。

### 5.4 时长获取（无 ffmpeg 依赖）

1. **首选**：引擎返回词边界 → 末词 offset + 时长，直接得到精确时长与字幕时间；
2. **次选**：纯 JS 解析 MP3 帧（跳过 ID3v2，读 Xing/Info 帧计数或累加帧数 × 1152 / 采样率）；
3. **兜底**：按字数 / 语速估算（`rate` 参与），标 `estimated`。

三级实现都在 `timeline/` 下，同一接口 `measure(audio: Buffer): { durationMs, quality }`，可单测（构造已知帧数的假 MP3）。

---

## 6. 技术架构

### 6.1 引擎层（`@leiboss/dsh-tts` 0.3.x）补齐的三件事

| 补什么 | 现在 | 目标 |
|---|---|---|
| **服务** | 只有 tools，没有 `ctx.tts` | `ctx.provide('tts')` + `ctx.tts = service`；`TTSProvider` 由类型变成真实例；`inject: ['tts']` 可用 |
| **零依赖** | 需要 Python `edge-tts` | `edge-js` provider（`node-edge-tts`，纯 JS、带 `https-proxy-agent`）；Python 仅作兼容后端保留，默认不用 |
| **缓存键** | `(text, voice, rate)`，`pitch/volume` 不进键 | 键改为 `(normalizedText, voice, rate, pitch, volume, engine, ssmlHash)`，修掉已知限制 |

```ts
// 目标接口（产品层只依赖这个）
interface TtsService {
  readonly capabilities: EngineCapabilities;   // { wordBoundaries, formats, offline }
  synthesize(req: {
    text: string;
    ssml?: string;
    voice?: string; rate?: string; pitch?: string; volume?: string;
    signal?: AbortSignal;
  }): Promise<{
    filePath: string; format: 'mp3' | 'wav';
    durationMs?: number; timingQuality: 'exact' | 'estimated';
    words?: { text: string; offsetMs: number; durationMs: number }[];
    engine: string; fallback?: string; browserUrl?: string;
  }>;
  probe(): Promise<ProbeReport>;   // 供 C 线的四象限判断
  doctor(): Promise<DoctorReport>;
}
```

### 6.2 产品层模块

| 模块 | 职责 | 复用现有 | 新增 |
|---|---|---|---|
| `source/` | 归一化：md/txt/pdf → 纯正文，去页眉页脚、脚注编号、图注 | — | ✅ |
| `plan/` | P0a 分块 + P0b 合并 → `outline.json` | `chunker.ts` | ✅ |
| `script/` | P1 改写、P2 标注、P4 质检、P6 修复循环 | — | ✅ |
| `synthesize/` | 调 `ctx.tts`、并发、重试分类 | `concurrency.ts`、`fallback.ts` | 薄封装 |
| `timeline/` | 字幕单元 → 时间轴；时长测量三级 | — | ✅ |
| `artifact/` | `state.json`、manifest、导出（zip / m4b） | `audio-route.ts` | ✅ |
| `tools/` | `voiceover_create/status/rerun/export` | `ctx.tools.register` | ✅ |
| `ui/` | 进度面板（章节列表 / 状态 / 试听 / 单章重跑） | client `tool.call.toolview` | ✅ |

**并发模型**：LLM 与 TTS 各一个闸门（默认 2 / 2），互不抢占；章节级并行度 = `min(llmGate, ttsGate)`；同一章的 P1→P2→P4 必须串行（有依赖）。

**预算**：`llmTokensBudget`（默认 120k）、`ttsCharsBudget`（默认 200k）、`wallClockMs`（默认 2h），任一超限 → 停止新章节、已完成章节照常落盘（部分交付优于全丢）。

### 6.3 DSH 能力接缝用法

| 能力 | 用途 |
|---|---|
| `ctx.provide('tts')` | 引擎层暴露服务，产品层与其他插件共用 |
| `ctx.tools.register` | 4 个产品工具 + 3 个引擎工具，fiber 卸载即注销 |
| `ctx.inject(['webServer'])` | 音频路由 `/voiceover/audio`（Range + 会话绑定，沿用现有实现） |
| `ctx.connection.requestRejection` | 播放地址的 Host/Origin 与会话校验 |
| `ctx.jobs` | 长任务（>60s）走后台 job，工具立即返回 `projectId` |
| client `tool.call.toolview` | 进度面板 + 原生 `<audio>` |
| `ctx.fs` 或 `node:fs` | 项目目录读写（沿用「直连 + 明确错误码」策略） |

**关键决策**：`voiceover_create` 必须**立即返回**（≤2s），后续进度由 `voiceover_status` 与面板推送。否则 15 分钟的任务会撞工具超时。

---

## 7. 引擎策略与 C 线（卖点）

### 7.1 引擎清单

| 引擎 | 网络 | 依赖 | 音色 | 用途 |
|---|---|---|---|---|
| `edge-js`（默认） | 需要（WSS 到 `speech.platform.bing.com`） | 纯 JS（`ws` + `https-proxy-agent`） | 全量神经音色 | 主引擎 |
| `edge-py`（兼容） | 同上 | Python + `edge-tts` | 同上 | 旧环境 / 已装用户 |
| `sapi` | **不需要** | Windows 内置（WAV） | 系统音色（机械） | 内网兜底 |
| `speechSynthesis` | 不需要 | 浏览器端 | 系统音色 | 最后兜底（无法产出文件） |

### 7.2 能力探测（启动时一次，结果缓存 10 分钟）

```
probe() →
  { network: { reachable, host, port, elapsedMs, viaProxy },
    engines: [{ name, available, reason }],
    wordBoundaries: bool,
    llm: { available, provider, model } }
```

- 探测结果写进 manifest 的 `capability`，也用于 C 线的「体检报告」；
- 探测失败不等于不可用：`viaProxy=true` 时同样标记 `network=true`。

### 7.3 四象限降级矩阵（C 线的产品化表达）

| LLM | 网络 | 行为 | 产物质量 | 用户提示 |
|---|---|---|---|---|
| ✅ | ✅ | 完整流水线 | 最佳：口播稿 + 精确字幕 | — |
| ✅ | ❌ | 改写照做，合成走 `sapi` | 文稿好、音色机械、字幕 estimated | 「当前网络不可达 Edge，已用系统语音；恢复网络后可一键重跑合成」 |
| ❌ | ✅ | 跳过 P1/P2/P4，正文直读 | 保留原文书面语、字幕 exact | 「未配置模型，已按原文朗读」 |
| ❌ | ❌ | 直读 + `sapi` | 最低：可听、无字幕 | 「离线最简模式」 |

**这是 C 线唯一的正确卖法**：不是「我们支持代理」这种功能点，而是**「任何网络条件下都能交付，且降级是显式的、可恢复的」**。企业内网客户真正怕的是「静默降级 + 事后才发现」，所以 §5.2 的 `warnings` 与 `capability` 是硬契约。

### 7.4 网络与企业内网

| 问题 | 处理 |
|---|---|
| 环境变量 `HTTPS_PROXY` 对 Edge 的 WSS 无效 | `proxy` 配置透传；`edge-js` 用 `https-proxy-agent`，`edge-py` 用 `--proxy` |
| 只允许 PAC / 特定出口 | `proxy` 支持 `http://user:pass@host:port`；`trustedHosts` 处理反代改端口 |
| 端点被墙 / 限流 | 并发默认 2、指数退避、`Retry-After` 尊重；连续 3 次 `EDGE_TTS_FAILED` 自动切 `sapi` 并写 warning |
| 完全离线 | `enginePolicy: 'offline-first'` 直接跳过探测，用 `sapi`，省 30s 超时 |
| 无 ffmpeg | MP3 是原生产物；m4b 导出跳过并 warning（不要为了 m4b 强制装 ffmpeg） |

### 7.5 `voiceover doctor`（诊断即营销）

一条命令输出可粘贴的体检报告：

```
环境：Node 22.19 · DSH 0.2.2 · 平台 win32
引擎：edge-js ✅  edge-py ✗(未安装)  sapi ✅
网络：speech.platform.bing.com:443 ✅ (128ms，直连)
LLM ：✅ deepseek-chat
输出：$DSH_HOME/voiceover 可写 ✅
建议：无需调整
---
离线场景想验证：voiceover doctor --offline
```

失败时给出**唯一动作**（装什么 / 配什么），不给可能性列表。这是上一轮说过的「错误分层」的价值兑现处。

---

## 8. 幂等、缓存、断点续跑与成本

### 8.1 哈希设计

```
sourceHash   = sha256(normalizedText)
configHash   = sha256(voice, rate, pitch, volume, engine, chunkSize, format)
promptVersion= "p1.3"（P0/P1/P2/P4 的版本号合并，任一变更即升）
chapterHash  = sha256(chapterText + configHash + promptVersion)
projectId    = sourceHash[0:8] + configHash[0:4] + promptVersion
```

- 同一篇文章、同一配置、同一提示词版本 → **同一个 projectId**，重跑即续跑；
- 用户改了一章正文 → 只有该章 `chapterHash` 变，其余命中缓存；
- 用户换了音色 → `configHash` 变 → 全部重合成，但**改写结果可复用**（拆成 `scriptHash` 与 `audioHash` 两个层级）。

**三层缓存**（这是成本控制的全部）

| 层 | 键 | 失效条件 | 省什么 |
|---|---|---|---|
| 大纲 | `sourceHash` | 正文变 | 少一次全量 LLM |
| 口播稿 | `chapterText + promptVersion` | 该章变或提示词升级 | 少一次 P1 |
| 音频 | `script + configHash` | 音色/语速/引擎变 | 少一次合成（最贵的一步） |

### 8.2 成本估算（1 万字 / 8 章）

| 项 | 次 | 单价 | 小计 |
|---|---|---|---|
| P0a 分块摘要 | 2 | ~1.5k in / 0.3k out | 便宜 |
| P1 改写 | 8 | ~1.5k in / 1.2k out | 主要 LLM 成本 |
| P2 标注 | 8 | ~1.2k in / 1.3k out | 可合并进 P1（见 PROMPTS §2.3） |
| P4 质检 | 8 | ~2.5k in / 0.4k out | 建议只抽查 2 章，省 75% |
| 合成 | 8 | 免费（Edge） | — |
| 时长 | — | 本地 | — |

结论：**LLM 是主要成本，音频几乎免费**——所以设计上要「提醒词省成本」：P2 合并进 P1、P4 抽样质检。这也是为什么默认 `maxConcurrent=2`：Edge 免费但不许滥用，被限流一次的成本远高于省下的 30 秒。

### 8.3 断点续跑的用户可见语义

- `voiceover_status` 返回每章状态与「上次中断点」；
- 重跑只做 `status != done` 或 `hash 不匹配` 的章节；
- 支持 `voiceover_rerun chapter=3 --from=script`（只重做合成）与 `--from=source`（连改写一起）；
- 中断原因分类展示：网络 / 配额 / 你的配置 / 我们的 bug。

---

## 9. D 线：本地 daemon 与 MCP（第二出口）

**为什么做**：插件生态的渠道天花板由 DSH 安装量决定；把同一引擎做成「本地音频 API」，让 Claude Code / Cursor / 自研脚本也能用，等于把 DSH 当渠道而不是市场。成本很低——引擎层本来就得能脱离 DSH 运行。

### 9.1 进程形态

```
voiceover serve [--port 7801] [--host 127.0.0.1] [--token <t>] [--mcp stdio|http]
```

- 默认只绑 `127.0.0.1`，`--host 0.0.0.0` 必须显式且要求 `--token`；
- token 从 `--token` 或 `$DSH_VOICEOVER_TOKEN` 读，空则拒绝启动（不允许裸奔）；
- 与 DSH 插件**共享同一引擎与缓存目录**，不重复实现。

### 9.2 HTTP 端点

| 方法 | 路径 | 作用 | 返回 |
|---|---|---|---|
| `POST` | `/v1/tts` | 短句合成（≤2000 字） | `{ filePath, browserUrl, durationMs, timingQuality, engine }` |
| `POST` | `/v1/voiceover` | 建项目（异步） | `202 { projectId, statusUrl }` |
| `GET` | `/v1/projects/:id` | 状态 + 每章状态 | manifest 子集 |
| `GET` | `/v1/projects/:id/manifest` | 完整 manifest | JSON |
| `GET` | `/v1/projects/:id/audio/:ch` | 音频（Range 206） | `audio/mpeg` |
| `GET` | `/v1/projects/:id/subtitles/:ch` | 字幕 | `text/plain; charset=utf-8` |
| `POST` | `/v1/projects/:id/rerun` | 重跑章节 | `202` |
| `GET` | `/healthz` · `/v1/doctor` | 健康 / 体检 | JSON |

约定：`Idempotency-Key` 头对 `POST /v1/voiceover` 去重；错误体固定 `{ code, message, retryable, hint }`（沿用引擎层错误码）；所有时间戳 ISO 8601 带时区。

### 9.3 MCP tools（给非 DSH 的 agent）

| tool | 参数 | 说明 |
|---|---|---|
| `tts_speak` | `text, voice?, rate?` | 短句合成，返回路径与时长 |
| `voiceover_create` | `source_path \| source_text, title?, voice?, chapters?` | 建项目，立即返回 id |
| `voiceover_status` | `project_id` | 进度与逐章状态 |
| `voiceover_export` | `project_id, format: 'zip'\|'srt'\|'m4b'` | 导出，返回路径 |
| `audio_doctor` | `offline?: boolean` | 体检报告（C 线） |

**不要把工具做成 12 个**：5 个够用，其余用参数表达。工具越多，agent 选错概率越高（这条也适用于 DSH 内的 4 个工具）。

### 9.4 与 A 的关系

同一份 manifest、同一套缓存、同一套错误码。差别只在「谁发起」：

- DSH 内：人 → agent → 工具（有面板、有会话上下文）；
- DSH 外：脚本/别的 agent → HTTP/MCP（无面板，靠 status 轮询）。

**这意味着 D 线不需要独立产品化**，它只是把 A 的引擎换个门面。这正是上一轮把 D 排第二出口的原因：先有 A 的真实使用，D 才有内容可暴露。

---

## 10. UI（尽量少）

设计目标是一个面板、四块内容：进度、试听、操作、能力条。

**已实现（0.1.0）**：进度块 + 能力条 + 试听。

1. **进度**：标题、`完成/总章数`、进度条、状态词（准备中 / 生成中 · 第 N 章 / 已完成 / 已结束 · N 章失败）、
   逐章状态（排队/改写/标注/质检/合成/对齐/完成/失败）、时长、是否带字幕、列表限高 260px 可滚动；
2. **能力条**：`模型 改写` / `按原文朗读`、`配音 Edge 在线` / `配音 本地声音`、`字幕 精确时间轴` / `估算` / `待生成`；
3. **降级与失败**：warning 转成用户语句并封顶 3 条，失败章节把错误码翻成「原因 + 下一步」；
4. **终态提示**：全部完成时说明「音频 + 字幕已生成，需要路径时运行 voiceover_export」；
5. **新鲜度**：显示 `state.json` 的 mtime，超过 60 秒无写入提示「宿主可能重启过，重新运行续跑」。

数据来源：面板只解析工具结果里的 `projectId`，随后轮询只读路由 `GET /voiceover/panel/<projectId>.json`；
该路由走宿主会话围栏，只返回进度，不返回稿件正文与文件路径。

**试听（已实现，0.1.1）**：宿主注册 `/voiceover/audio` 签名路由（复用引擎的 `AudioRoute`，前缀独立，
带 Range 206 与会话围栏）；面板顶部一个播放器 + 逐章 `▶` 切换，URL 在点击时定格，快照刷新不打断播放。
选单播放器而不是每章一个 `<audio>`：20 章的页面不该挂 20 个音频元素。

**操作（部分实现，0.2.0）**：续跑失败章节——面板按钮与 `voiceover_rerun` 工具共用
`operations.ts` 里的同一个操作，UI 只负责 POST 到 `/voiceover/panel/<id>/rerun`。
导出按钮与单章重跑未实现：导出只能返回本机路径，在浏览器里点一下没有可交付的结果，
不如让 agent 用 `voiceover_export` 把路径念出来。
按钮需要想清楚「UI 动作 → 工具调用」的授权路径（见 `user-actions.md`：同一操作只实现一次，UI 与工具共用宿主方法），
所以放在 daemon/MCP 那一步一起做，而不是先做一个只能看的面板动作。

不做：设置页（配置走 DSH 配置层）、音色选择器（走参数/配置）、波形图（成本高收益低）。

---

## 11. 指标与验收

### 11.1 指标

| 层级 | 指标 | 目标（90 天） |
|---|---|---|
| 北极星 | 每周完成导出的章节数 | ≥ 200 |
| 激活 | 装完到第一个「8 章项目跑完」的转化 | ≥ 15% |
| 体验 | 首次出声时间（创建 → 第一章可听） | ≤ 90s |
| 质量 | 1 万字项目一次跑完成功率 | ≥ 90% |
| 效率 | 改一章后重跑耗时 | ≤ 该章合成时长 × 1.2 |
| 生态 | 声明依赖引擎层的第三方包 | ≥ 1 |

### 11.2 验收清单（M6 结束时逐条打勾）

- [ ] 干净 Windows / macOS 机器，`dsh plugin add` 后**无需 Python、无需 ffmpeg** 能出 MP3
- [ ] 1 万字中文文章 → 8 章 MP3 + SRT + manifest，manifest 通过 schema 校验
- [ ] 断网（阻断 `speech.platform.bing.com`）→ 自动切 `sapi`，manifest `capability.network=false`，warning 可见
- [ ] `kill -9` 中断后重启 → 只重做未完成章节
- [ ] 改第 3 章正文 → 仅第 3 章重跑
- [ ] `timingQuality=estimated` 时字幕文件名带 `.est`
- [ ] `voiceover serve` 起服务，`curl /v1/tts` 返回可用音频（带 token 校验、无 token 401）
- [ ] MCP `voiceover_status` 在 Claude Code 里能正常轮询
- [ ] 所有错误码有唯一「下一步动作」，无「未知错误」

---

## 12. 风险与证伪

| 风险 | 概率 | 影响 | 缓解 | 证伪信号 |
|---|---|---|---|---|
| 平台发官方 TTS seam | 中 | 高 | 引擎层随时可切成该 seam 的 provider；价值锚在流水线不在 seam | DSH 发布 `dsh-experimental-tts` |
| Edge 端点限流/封禁 | 中 | 高 | 并发 2、退避、`sapi` 兜底；预告 `enginePolicy` | 连续 3 天失败率 > 20% |
| 改写质量不稳（口语化跑偏、删信息） | 高 | 中 | 硬约束 + P4 质检 + high 回炉；抽样人工校验 | 质检 high 占比 > 15% |
| 长文切片破坏上下文（跨章引用断裂） | 中 | 中 | P0a 输出 `crossRefs`，P1 注入前后章摘要 | 用户反馈「接不上」≥ 3 例 |
| 需求被高估（用户其实只要读出来） | 中 | 高 | 先做「8 章样带」最小闭环验证，不先做全功能 | 60 天内无人跑完 8 章 |
| 定价（免费生态）难收费 | 高 | 中 | 免费 3 章 + 专业版；先靠 daemon 接企业 | 付费转化 < 1% |

**止损判定**：60 天内（a）无 10 个 ≥8 章项目完成，或（b）质检 high 占比 > 30%，则回退到「单章 + 字幕」的窄工具，放弃章节化。

---

## 13. 90 天里程碑

| 阶段 | 周 | 交付 | 出口标准 |
|---|---|---|---|
| M0 契约 | 1 | 本设计 + 两个 schema + 提示词 v1 | schema 能校验一份手写 manifest |
| M1 服务化 | 1–2 | `ctx.tts` + provider 实现 + `inject:['tts']` 示例 | 第三方插件 5 行代码拿到音频 |
| M2 零依赖 | 2–3 | `edge-js` provider + 代理 + 三级时长测量 | 干净机器 `tts_generate` 成功 |
| M3 流水线 | 4–6 | P0–P4 + 状态机 + 断点续跑 | 1 万字 8 章跑通，可续跑 |
| M4 字幕导出 | 6–7 | SRT + zip + manifest 校验 + `.est` 规则 | 字幕在播放器里对得上 |
| M5 daemon/MCP | 7–8 | `serve` + 5 个 MCP tool | Claude Code 能建项目并取回音频 |
| M6 UI + 上架 | 9–10 | 进度面板 + dshbase/dshmarket 上架 + 演示视频 | 陌生用户 30 分钟内出成品 |
| M7 复盘 | 11–12 | 指标看板 + 定价实验 | 北极星 ≥ 200 章/周，或触发止损 |

---

## 14. 商业化（一句话版）

免费：≤3 章、单音色、无批量导出。专业版（¥49/月 或 ¥299 买断）：无限章、批量、字幕、m4b、daemon 企业授权。企业版：内网部署 + 私有引擎 + 合规审计日志（`run-*.jsonl` 正好是审计素材）。

不靠插件市场抽成，靠「内网 + 批量」这两个竞品不愿做的场景收钱。
