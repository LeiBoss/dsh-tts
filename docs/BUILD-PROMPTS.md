# 给 AI 编程代理的实现提示词（M0–M6）

> 用法：把「§0 通用约束」拼在每条里程碑提示词前面，一起交给代理。
> 每条都自带验收命令与「不要做什么」，避免代理顺手把项目改造成另一个东西。

---

## §0 通用约束（每条都带上）

```markdown
## 项目背景
仓库：`leiboss/dsh-tts`（将拆成两个包）
- 引擎层 `@leiboss/dsh-tts`：已有 chunker / cache / concurrency / fallback / audio-route / errors / voices，
  用 `node --test test/*.test.ts` 跑离线单测（子进程用注入的 spawn 替身）。
- 产品层 `@leiboss/dsh-voiceover`（新建）：章节流水线。

## 硬约束
1. TypeScript strict，Node ≥ 22.18，ESM，`type: module`。
2. **不引入 Python、ffmpeg、ImageMagick 等外部可执行文件作为必需依赖**。可选能力必须运行时探测，缺失则降级并写 warning。
3. 单测必须离线：网络、子进程、时钟、LLM 全部通过注入（`spawnImpl` / `fetchImpl` / `now`）替身化。
4. 错误一律用现有 `TtsError` + `ErrorCode` 枚举扩展，禁止裸 `throw new Error('...')`。
5. public 工具（`tts_generate` 等）的返回字段只增不改；改签名必须升 minor 并在 CHANGELOG 说明。
6. 每个新增模块在 `test/` 下有对应 `*.test.ts`，覆盖率目标：分支覆盖 ≥ 70%。
7. 不写「TODO 以后再说」的代码；做不完就拆成更小的 PR。
8. 提交信息用 conventional commits（feat/fix/chore/docs/test）。

## 代码风格
- 模块化：一个文件一个职责，导出显式类型；不写 barrel 文件之外的隐式依赖。
- 注释解释「为什么」，不复述「做了什么」。
- 日志只写结构化对象（`{ event, chapterId, ... }`），不写中文散文。
```

---

## M0 · 契约与骨架

```markdown
## 目标
建 `@leiboss/dsh-voiceover` 包骨架，并把设计契约落成类型与 schema 校验。

## 交付
1. `packages/voiceover/package.json`（name、type: module、exports、peerDeps: @leiboss/dsh-tts、engines.dsh）
2. `src/types.ts`：`Outline` / `Chapter` / `Manifest` / `ChapterStatus` / `Capability` / `VoiceoverConfig`，与 `schemas/*.schema.json` 一一对应
3. `src/validate.ts`：不引入 ajv（体积），手写校验器；导出 `validateOutline()` / `validateManifest()`，错误信息带 JSON 路径（如 `/chapters/2/sourceRange`）
4. `test/validate.test.ts`：合法样本、缺字段、类型错、越界、额外字段各一例

## 验收
- `npm test` 全绿
- `node -e "import('./dist/validate.js').then(m=>console.log(m.validateManifest(JSON.parse(require('fs').readFileSync('test/fixtures/manifest.json')))))"` 返回 true
- 校验错误信息形如 `{ path: '/chapters/2/title', message: 'maxLength 14' }`

## 不要做
- 不要写流水线逻辑
- 不要引第三方 schema 库
- 不要改引擎层的任何文件
```

---

## M1 · 引擎服务化（`ctx.tts`）

```markdown
## 目标
把 `@leiboss/dsh-tts` 从「只有 tools」改成「有可注入服务」，provider 从类型变实现。

## 交付
1. `src/service.ts`：
   ```ts
   export class TtsService {
     readonly capabilities: EngineCapabilities
     synthesize(req): Promise<SynthesizeResult>   // 内部复用缓存/并发/降级
     probe(): Promise<ProbeReport>
     doctor(): Promise<DoctorReport>
   }
   ```
2. `index.ts`：`export const inject = []`；`apply()` 里 `ctx.provide('tts')` 后 `ctx.tts = new TtsService(ctx, config)`；
   若宿主无 `provide`，回退 `ctx.set('tts', svc)`；两者都不可用时只注册 tools 并 `logger.warn`（不抛错）
3. `src/provider.ts`：从「types only」改为真实例导出（`EdgeProvider` / `SapiProvider`），保留原类型
4. `test/service.test.ts`：注入 spawn 替身，断言服务可用、并发受控、错误码透传
5. `examples/consumer-plugin/`：一个 20 行的最小插件，`inject: ['tts']` 后合成一句并断言文件存在

## 验收
- `inject: ['tts']` 的消费插件能拿到 `ctx.tts`，不需要 `ctx.tools.call`
- `tts_generate` 行为与返回结构不变（回归测试全绿）
- 卸载插件后服务与工具都被注销（HMR 测试）

## 不要做
- 不要把 service 写成单例全局变量（必须随 fiber 生命周期）
- 不要顺手改缓存键（那是 M2）
```

---

## M2 · 零依赖引擎与三级时长

```markdown
## 目标
默认引擎换成纯 JS，去掉 Python 前置；给出可靠的时长与词边界。

## 交付
1. `src/engines/edge-js.ts`：基于 `node-edge-tts`（依赖 ws + https-proxy-agent）
   - 支持 `proxy` 透传、`voice/rate/pitch/volume`
   - 返回 `{ buffer, words? }`，words 为 `{ text, offsetMs, durationMs }[]`
   - 超时与取消：`AbortSignal` → 断开 ws
2. `src/engines/edge-py.ts`：把现有实现挪进来，标记 `legacy: true`，默认不启用
3. `src/timeline/measure.ts`：三级测量
   - `measureFromWords(words)` → exact
   - `measureFromMp3(buffer)` → exact（解析帧头，跳过 ID3v2，读 Xing/Info 或累加帧数；24kHz 单声道 1152 samples/frame）
   - `estimateByChars(text, rate)` → estimated
   统一返回 `{ durationMs, quality }`，按 exact → exact → estimated 顺序降级
4. `test/mp3-duration.test.ts`：用合成的最小 MP3 帧夹具（CBR 与带 Xing 两种），断言误差为 0
5. 配置项：`engine: 'edge-js' | 'edge-py' | 'sapi'`、`proxy`、`enginePolicy: 'online-first' | 'local-first' | 'offline-only'`

## 验收
- 干净机器（无 Python）`tts_generate` 成功
- 给定带 Xing 头的 MP3，`measureFromMp3` 与真实时长误差 < 20ms
- 无网络时 `enginePolicy: 'offline-only'` 不发起任何 TCP 连接（用注入的连接器断言 0 次）
- 代理配置生效：假代理收到 CONNECT 记录（用本地 ws/https 替身断言）

## 不要做
- 不要为了 m4b 引入 ffmpeg 作为依赖（导出时探测即可）
- 不要把 SAPI 的 WAV 转 MP3 变成必需步骤
- 不要删掉 Python 引擎（保留兼容）；但不得出现在默认路径上
```

---

## M3 · 流水线核心（P0–P4 + 状态机）

```markdown
## 目标
实现「正文 → 大纲 → 逐章改写 → 合成」的主干，可中断、可续跑。

## 交付
1. `src/pipeline/runner.ts`：状态机 `queued→adapted→marked→audited→synthesized→timed→done`，每步后原子写 `state.json`（tmp + rename）
2. `src/pipeline/outline.ts`：P0a/P0b 调用 + `coverage` 断言（首尾相接、覆盖全文、无重叠），不满足则自动重切一次，仍失败则用「按段落均分」兜底并 warning
3. `src/pipeline/script.ts`：P1 调用 + `changes` 落盘；`scriptHash` 计算
4. `src/pipeline/audit.ts`：P4 抽样策略（>3000 字或重试过的章必查，其余抽 2 章）；high 存在时带 issues 回炉 P1 一次，仍 high 则记录并继续（不无限循环）
5. `src/llm/client.ts`：`fetchImpl` 注入、超时、重试（2 次）、JSON 解析失败走 P6 修复一次
6. `src/state.ts`：`chapterHash` / `projectId` 计算（DESIGN §8.1 的公式），并对每条断言
7. 工具 `voiceover_create`：**立即返回** `{ projectId, chapters, estMinutes }`（不 await 全流程），后台跑
8. `test/resume.test.ts`：跑到第 3 章 kill，重启后只跑 3–8 章

## 验收
- 用 3 章假数据（LLM 与 TTS 都替身）跑通，`state.json` 状态转移正确
- 中断恢复：已完成章节的 LLM 调用次数为 0（替身计数断言）
- high issue 回炉只发生 1 次
- 大纲覆盖断言失败时走兜底且 `warnings` 非空

## 不要做
- 不要在工具调用里同步跑完流水线
- 不要用 `Promise.all` 一次性并发所有章节（必须过闸门）
- 不要把 LLM 输出直接落盘（一律先校验）
```

---

## M4 · 字幕、manifest 与导出

```markdown
## 目标
把音频变成「可交付的一套东西」：SRT、manifest、zip、可选 m4b。

## 交付
1. `src/subtitle/srt.ts`：`units + timeline → SRT`，规则见 DESIGN §5.3（≤18 字/行、≤2 行、min 0.8s、gap 0.05s）
2. `src/subtitle/align.ts`：有词边界时按词边界对齐（词级 offset 累加，按字符比例分摊到单元）；无词边界时按字符比例 + `rate` 估算，标 estimated
3. `src/artifact/manifest.ts`：按 schema 生成 manifest；`capability` 从引擎探测结果如实填写；任何降级进 `warnings`
4. `src/export/zip.ts`：纯 JS 打 zip（不引 archiver，手写 store-only zip 或引 `fflate`）
5. `src/export/m4b.ts`：运行时探测 ffmpeg，存在则调用；缺失则 `warning: 'm4b export skipped: ffmpeg not found'` 并返回 zip 兜底
6. `test/srt.test.ts`：断句合规（超长比例 <2%）、时间单调递增、无重叠、时长与音频匹配

## 验收
- SRT 在 VLC / 浏览器 `<track>` 中时间轴正确（人工 1 章）
- manifest 通过 `validateManifest()` 且路径全为相对路径
- estimated 模式下文件名带 `.est`，manifest `timingQuality` 一致
- 无 ffmpeg 环境导出不报错，只有 warning

## 不要做
- 不要在 estimated 模式下声称精确
- 不要为 SRT 引入重型库
- 不要把绝对路径写进任何产物
```

---

## M5 · daemon 与 MCP（D 线）

```markdown
## 目标
同一引擎以 HTTP + MCP 暴露，非 DSH 的 agent 可用。

## 交付
1. `bin/voiceover.mjs` 或 `src/cli/serve.ts`：`serve --port --host --token --mcp stdio|http`
2. `src/http/server.ts`：DESIGN §9.2 的 8 个端点
   - 无 token → 401；`--host 0.0.0.0` 且无 token → 拒绝启动（exit 1）
   - `POST /v1/voiceover` 支持 `Idempotency-Key`（10 分钟内同 key 返回同 projectId）
   - 错误体 `{ code, message, retryable, hint }`
   - 音频端点支持 Range 206
3. `src/mcp/server.ts`：5 个 tool（DESIGN §9.3），用 stdio transport；工具描述必须写明「长文本用 project 而不是 tts」
4. `test/http.test.ts`：用 `node:http` 起临时服务器，断言 401/202/206/幂等
5. README 片段：curl 与 claude mcp add 两种接法

## 验收
- `curl -H "Authorization: Bearer $T" -d '{"text":"你好"}' localhost:7801/v1/tts` 返回 filePath 与 durationMs
- 无 token 的请求全部 401
- 同一 `Idempotency-Key` 两次 POST 返回同一 projectId
- MCP：在 Claude Code 里 `voiceover_status` 能返回进度

## 不要做
- 不要做用户系统 / 计费（那是企业版的事）
- 不要把 HTTP 层写成和 DSH 工具两套逻辑（都调 service）
- 不要默认监听 0.0.0.0
```

---

## M6 · UI 面板与上架

```markdown
## 目标
一个能说服陌生人的界面：进度、试听、重跑、导出、能力条。

## 交付
1. client 插件（`dsh.client` + `tool.call.toolview`）：`voiceover_create` 的结果渲染为面板
   - 章节列表：状态徽标、时长、单章试听（原生 `<audio preload="none">`，URL 走签名路由）
   - 顶部能力条：`LLM ✅ / 网络 ✅ / 字幕 exact`，有 warning 时变黄并展示文案
   - 操作：单章重跑、续跑、导出（zip/srt/m4b）
2. 轮询：面板每 2s 拉一次 `voiceover_status`，完成后停止（不要 websocket）
3. `docs/demo.md`：一条 60 秒演示脚本（1 万字 → 8 章 → 播放 → 导出）
4. 上架材料：中英文 README、3 张截图、`dshbase` / `dshmarket` 提交说明、`CHANGELOG` 0.1.0

## 验收
- 面板在无 `browserUrl`（headless）时不渲染播放器，不报错
- 降级状态下能力条正确显示黄条与原因
- 演示脚本可用于录屏，全流程 ≤ 3 分钟（含等待）
- `dsh plugin add` 安装后首屏 30 秒内能看到面板

## 不要做
- 不要做设置页（配置走 DSH 配置层）
- 不要做波形图 / 音频剪辑
- 不要在客户端持有音频数据（只拿 URL）
```

---

## §7 代理协作提示（给「写提示词的人」看）

| 情况 | 做法 |
|---|---|
| 代理改动了 public 工具返回结构 | 立刻回滚，或要求它补 `CHANGELOG` + 兼容层 |
| 代理引入新依赖 | 先问「能不能用 200 行以内自己写」；`fflate` / `semver` 这类可接受 |
| 代理把测试写成需要网络 | 退回，要求注入替身 |
| 代理说「已完成」但没跑测试 | 要求贴出 `npm test` 的完整输出末 20 行 |
| 代理想重构引擎层 | 拒绝（M 阶段内引擎层只允许加文件，不允许改既有导出） |
| 一次性给了 5 个里程碑 | 缩到 1 个；里程碑粒度就是为「一次只做一个可验收的事」设计的 |
