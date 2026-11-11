/**
 * Prompt builders. One function per stage, each returning the exact strings the
 * model receives. The text is versioned by `PROMPT_VERSION` in `types.ts`:
 * bumping it invalidates the outline/script cache on purpose.
 *
 * Rules that matter and are easy to lose in a refactor:
 * - every prompt demands JSON only (no fences, no prose);
 * - the model never sees the whole book at once (block -> outline -> chapter);
 * - neighboring summaries are injected so cross-chapter references survive.
 */

import type { Outline, OutlineChapter } from './types.ts'

/** One prompt pair. */
export interface Prompt {
  system: string
  user: string
}

const JSON_ONLY =
  '只输出 JSON，不要解释、不要 Markdown 围栏、不要前后缀。字段不得增删；缺值用 ""、[] 或 null。'

/** Stage P0a: find chapter boundaries inside one text block. */
export function chunkPrompt(input: {
  docTitle: string
  blockId: string
  blockIndex: number
  blockTotal: number
  startParagraph: number
  blockText: string
}): Prompt {
  return {
    system: `你是长文档结构分析器，负责在正文块中找出适合分章的位置。${JSON_ONLY}`,
    user: `## 输入
- 全文标题：${input.docTitle}
- 本块编号：${input.blockId}（第 ${input.blockIndex} 块 / 共 ${input.blockTotal} 块）
- 本块起始段落序号：${input.startParagraph}
- 本块正文（段落以 ###P<序号>### 开头）：

${input.blockText}

## 规则
1. 切点只能落在语义完整的位置：一个论点结束、一个子话题切换、一个案例讲完。禁止在小节中间、列举中途、例子没讲完时切断。
2. 每块给出 1–3 个候选切点，按推荐度排序，优先选读者会自然停下来的地方。
3. 每个候选给出 afterParagraph（切点前最后一段的序号）与不超过 14 字的标题。
4. 标题用动宾或名词短语，不带序号，不带「本章」「第一部分」。
5. 若本块是连续叙事、没有自然断点，chapterCandidates 给空数组，这是合法输出。
6. summary 不超过 120 字，只陈述讲了什么，不做评价、不引申。
7. crossRefs 记录需要前文或后文才能理解的指代（如「上述三原则」）。

## 输出
{"blockId":"","summary":"","chapterCandidates":[{"afterParagraph":0,"title":"","confidence":0.8,"reason":""}],"crossRefs":[]}`,
  }
}

/** Stage P0b: merge block results into one coverage-complete outline. */
export function outlinePrompt(input: {
  docTitle: string
  paragraphTotal: number
  charTotal: number
  blocks: unknown
}): Prompt {
  return {
    system: `你是长文档的章节规划器。根据分块结果整理章节大纲。${JSON_ONLY}`,
    user: `## 输入
- 全文标题：${input.docTitle}
- 全文段落总数：${input.paragraphTotal}
- 全文总字数：${input.charTotal}
- 分块结果（JSON 数组）：

${JSON.stringify(input.blocks, null, 2)}

## 规则
1. 必须覆盖全文：第一章从段落 0 开始，最后一章到段落 ${input.paragraphTotal - 1} 结束，相邻章节首尾相接，不留空隙、不重叠。
2. 章节数 3–20；每章 800–4000 字，若必然超出，在 note 里说明（例如「该案例不可拆」）。
3. 标题风格统一：不超过 14 字，动宾或名词短语，不带序号。
4. 每章 summary 不超过 80 字，供其他章节做上下文注入。
5. sourceRange 用 [起始段落序号, 结束段落序号]，包含两端。
6. 候选切点间隔小于 400 字时合并为一个章节。

## 输出
{"title":"","chapters":[{"id":"ch-01","title":"","sourceRange":[0,0],"summary":"","estimatedChars":0,"crossRefs":[],"note":""}]}`,
  }
}

/** Stage P1: turn written prose into a spoken script without changing facts. */
export function adaptPrompt(input: {
  docTitle: string
  chapterNo: number
  chapterTotal: number
  chapterTitle: string
  prevSummary: string
  nextSummary: string
  style: string
  text: string
}): Prompt {
  return {
    system: `你是中文有声内容的稿件编辑，把「用来读的文章」改成「用来听的稿子」。${JSON_ONLY}`,
    user: `## 输入
- 全文标题：${input.docTitle}
- 本章：第 ${input.chapterNo} 章 / 共 ${input.chapterTotal} 章 · ${input.chapterTitle}
- 上一章摘要：${input.prevSummary || '（无）'}
- 下一章摘要：${input.nextSummary || '（无）'}
- 风格档位：${input.style}（lecture / news / story / docs）
- 本章原文：

${input.text}

## 硬规则（违反任何一条都算失败）
1. 不改事实、不加观点、不删信息；不许补充原文没有的解释、数据、例子、评价。
2. 数字与专有名词保真，只展开读法：3.5% → 百分之三点五；1,280 元 → 一千二百八十元；5–10 分钟 → 五到十分钟。API、DSH、MP3 这类缩写保留原形，不翻译。
3. 单句不超过 40 字；每段不超过 4 句；一段只讲一件事。
4. 必须删除的书面残留：括号补充、脚注编号、参考文献标记、图表引用（见图 3）、Markdown 符号、表格竖线；代码块改写为「下面这段代码，这里略过」并在 risks 中记录。
5. 跨章指代要能独立听懂：出现「上一章说的」时，补不超过 12 字的名词短语点明它是什么，这不算加信息。
6. 风格档位只影响节奏，不影响事实与结构。
7. 段落之间用空行分隔，不加小标题、不加「欢迎收听」这类开场白。

## 输出
{"script":"","changes":[{"type":"number","from":"","to":"","reason":""}],"risks":[{"kind":"code","text":""}]}`,
  }
}

/** Stage P3: split the script into subtitle units (timing is computed later). */
export function subtitlePrompt(script: string): Prompt {
  return {
    system: `你是字幕断句器，把口播稿切成一条条字幕。${JSON_ONLY}`,
    user: `## 输入
${script}

## 规则
1. 每条字幕最多 2 行，每行不超过 18 个汉字（含标点），优先做成 1 行；两行之间用 \\n 分隔。
2. 在语义边界断开：主语后、谓语后、连词前。禁止把「的」「了」放在行首，禁止拆开数字与单位。
3. 一句过长可在逗号处拆成多条；不同句子的内容禁止合并到同一条。
4. 引号内尽量不拆；必须拆时在第二个引号后断开。
5. 去掉句末句号，保留问号、感叹号、省略号。
6. 不新增、不删除、不改写文字。

## 输出
{"units":[{"text":""}]}`,
  }
}

/** Stage P4: audit information fidelity, not style. */
export function auditPrompt(input: { source: string; script: string }): Prompt {
  return {
    system: `你是稿件质检员。对比原文与口播稿，只报告信息层面的差异，不评价文风。${JSON_ONLY}`,
    user: `原文：
${input.source}

口播稿：
${input.script}

## 判定标准
- high：信息丢失、事实改变、数字或单位错误、把不确定说成确定
- medium：语气改变导致含义偏移、指代不可理解、重要限定条件被弱化

## 规则
1. 最多 8 条，按 severity 降序；宁少勿凑。
2. 每条必须给 evidence.source（原文片段，不超过 30 字）与 evidence.script（口播片段，不超过 30 字）；给不出的不要报。
3. 只报告，不改写。
4. 没有 high 且没有 medium 时，verdict 必须是 pass。

## 输出
{"verdict":"pass","issues":[{"severity":"high","kind":"omission","evidence":{"source":"","script":""},"fix":""}]}`,
  }
}

/** Stage P6: repair a structurally invalid JSON response without rewriting it. */
export function repairPrompt(input: { error: string; previous: string }): Prompt {
  return {
    system: '你上一次的输出不满足 JSON schema。只修结构，不改内容。只输出 JSON。',
    user: `## 错误
${input.error}

## 上一条输出
${input.previous}

## 要求
1. 只修被指出的字段与路径，其余字段逐字符保留。
2. 不要解释、不要道歉、不要围栏。
3. 字段确实无法推断时用 null 或空字符串，不要编造。`,
  }
}

/** Coverage assertion used after planning; exported so tests can reuse it. */
export function coverageErrors(outline: Outline, paragraphTotal: number): string[] {
  const errors: string[] = []
  const chapters = outline.chapters
  if (chapters.length === 0) return ['outline has no chapters']
  const first = chapters[0] as OutlineChapter
  if (first.sourceRange[0] !== 0) errors.push(`first chapter starts at ${first.sourceRange[0]}, expected 0`)
  const last = chapters[chapters.length - 1] as OutlineChapter
  if (last.sourceRange[1] !== paragraphTotal - 1) {
    errors.push(`last chapter ends at ${last.sourceRange[1]}, expected ${paragraphTotal - 1}`)
  }
  for (let i = 1; i < chapters.length; i += 1) {
    const prev = chapters[i - 1] as OutlineChapter
    const current = chapters[i] as OutlineChapter
    if (current.sourceRange[0] !== prev.sourceRange[1] + 1) {
      errors.push(`${current.id} starts at ${current.sourceRange[0]}, expected ${prev.sourceRange[1] + 1}`)
    }
  }
  return errors
}
