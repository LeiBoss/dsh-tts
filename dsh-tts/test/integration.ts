/**
 * Manual end-to-end check. Requires a real `edge-tts` installation and working
 * network access to the Edge-TTS service; it is NOT part of `npm test`.
 *
 *   DSH_HOME=/tmp/dsh-tts-integration npm run test:integration
 */
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.ts'
import { synthesize } from '../src/edge-tts.ts'
import { cacheKey } from '../src/cache.ts'
import { selfCheck } from '../src/self-check.ts'

async function main(): Promise<void> {
  const dshHome = process.env.DSH_HOME ?? (await mkdtemp(join(tmpdir(), 'dsh-tts-home-')))
  const config = resolveConfig({ outputDir: undefined }, { ...process.env, DSH_HOME: dshHome })

  console.log(`DSH_HOME: ${dshHome}`)
  console.log(`outputDir: ${config.outputDir}`)

  const health = await selfCheck({ config })
  console.log('self-check:', health)
  if (!health.edgeTtsAvailable || !health.spawnAllowed || !health.outputDirWritable) {
    console.error('Environment is not ready; fix the failing self-check field first.')
    process.exitCode = 1
    return
  }

  const text = '你好，这是一次 dsh-tts 端到端集成测试。'
  const voice = config.defaultVoice
  const rate = '+0%'
  const audio = await synthesize(text, {
    voice,
    rate,
    binary: config.edgeTtsBinary,
    outputDir: config.outputDir,
    hash: cacheKey(text, voice, rate),
    timeoutMs: config.timeoutMs,
  })

  const info = await stat(audio.filePath)
  console.log(`audio: ${audio.filePath}`)
  console.log(`format: ${audio.format}, bytes: ${info.size}`)
  if (info.size <= 0) {
    console.error('Generated file is empty.')
    process.exitCode = 1
  }
}

await main()
