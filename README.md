# dsh-tts

DSH 音频能力，两个包：

| 包 | 角色 | 一句话 |
|---|---|---|
| [`@leiboss/dsh-tts`](packages/tts) | 引擎层 | 文本进、音频文件出；并发、缓存、分块、降级，并暴露可注入的 `ctx.tts` 服务 |
| [`@leiboss/dsh-voiceover`](packages/voiceover) | 产品层 | 长文进、成套成果出：分章、口播化改写、字幕、manifest、可断点续跑 |

设计文档在 [`docs/`](docs)：

- [`docs/DESIGN.md`](docs/DESIGN.md) — 定位、产物契约、架构、降级矩阵、D 线 daemon/MCP、里程碑
- [`docs/PROMPTS.md`](docs/PROMPTS.md) — 生产链路提示词 P0a–P7、评测集、反模式
- [`docs/BUILD-PROMPTS.md`](docs/BUILD-PROMPTS.md) — 给 AI 编程代理的 M0–M6 实现提示词

## 开发

需要 Node ≥ 22.18（`node --test` 直接跑 TypeScript 需要类型剥离）。

```bash
npm install          # 首次：刷新 workspace 的 lockfile
npm run build        # 先 tts，后 voiceover
npm test             # 两个包的 node --test
npm run check:engines
```

一次性跑单个测试文件（比整个 runner 快，也绕开子进程限制）：

```bash
node packages/voiceover/test/pipeline.test.ts
```

## 安装（用户侧）

```bash
dsh plugin --profile <profile> add @leiboss/dsh-tts        # 只要引擎
dsh plugin --profile <profile> add @leiboss/dsh-voiceover  # 产品或引擎一起装
```

`@leiboss/dsh-voiceover` 的 `cordis.patch.yml` 会同时挂载引擎（id `voiceover-tts`），所以只装产品包即可；两个都装也不会撞 id。

## 状态

| 能力 | 状态 |
|---|---|
| 引擎服务化（`ctx.tts`） | 已实现，待宿主联调 |
| 纯 JS 时长测量（MP3 帧解析） | 已实现 + 单测 |
| 分章 / 改写 / 质检 / 合成 / 字幕 / manifest | 已实现 + 单测 |
| 断点续跑（内容哈希） | 已实现 + 单测 |
| 零依赖引擎（`edge-js`） | 未实现（需先确认 node-edge-tts 的运行时 API） |
| 进度面板（client UI） | 未实现 |
| `voiceover serve` / MCP | 未实现 |
| zip / m4b 导出 | 未实现 |

## 许可

MIT