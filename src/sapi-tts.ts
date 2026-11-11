/**
 * Windows SAPI fallback, driven through `powershell.exe`.
 *
 * `System.Speech.Synthesis.SpeechSynthesizer` can only write WAV, while the
 * cache and route own `.mp3` files. The WAV is therefore converted with
 * `ffmpeg`; when ffmpeg is unavailable this engine reports failure and the
 * chain continues to the browser `speechSynthesis` marker.
 */
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { AUDIO_FORMAT, outputFilePath } from './cache.ts'
import { runProcess, type SpawnFunction } from './edge-tts.ts'
import { ErrorCode, TtsError } from './errors.ts'

export const DEFAULT_POWERSHELL_BINARY = 'powershell.exe'
export const DEFAULT_FFMPEG_BINARY = 'ffmpeg'

export interface SapiOptions {
  /** Edge-style rate such as `+0%`; mapped onto SAPI's -10..10 scale. */
  rate: string
  outputDir: string
  hash: string
  timeoutMs: number
  signal?: AbortSignal
  spawnImpl?: SpawnFunction
  now?: Date
  platform?: NodeJS.Platform
  powershellBinary?: string
  ffmpegBinary?: string
}

/** SAPI only exists on Windows; every other platform skips this engine. */
export function isSapiSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
}

/** Map `+25%` / `-10%` onto SAPI's integer -10..10 rate scale. */
export function sapiRate(rate: string): number {
  const match = /^([+-])(\d{1,3})%$/.exec(rate.trim())
  if (!match) return 0
  const magnitude = Math.round(Number(match[2]) / 10)
  const signed = match[1] === '-' ? -magnitude : magnitude
  return Math.max(-10, Math.min(10, signed))
}

/** PowerShell single-quoted literal escaping. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

async function run(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; signal?: AbortSignal; spawnImpl?: SpawnFunction },
  label: string,
): Promise<{ code: number | null; stderr: string }> {
  try {
    const result = await runProcess(command, args, options)
    return { code: result.code, stderr: result.stderr }
  } catch (error) {
    if (error instanceof TtsError && error.code === ErrorCode.Aborted) throw error
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${label} could not run: ${detail}`, { cause: error })
  }
}

/**
 * Synthesize `text` with the system voice. Produces the same dated `.mp3` cache
 * path as Edge-TTS, so a successful fallback is cached like any other result.
 */
export async function synthesizeSapi(
  text: string,
  options: SapiOptions,
): Promise<{ filePath: string; format: string }> {
  const platform = options.platform ?? process.platform
  if (!isSapiSupported(platform)) {
    throw new Error('SAPI synthesis is only available on Windows.')
  }

  const target = outputFilePath(options.outputDir, options.hash, options.now)
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-tts-sapi-'))
  const wavPath = join(tempDir, 'speech.wav')
  const textPath = join(tempDir, 'input.txt')
  const partialPath = `${target}.partial`

  try {
    await writeFile(textPath, text, 'utf8')

    const script = [
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -AssemblyName System.Speech',
      '$engine = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      `$engine.Rate = ${sapiRate(options.rate)}`,
      `$engine.SetOutputToWaveFile(${quote(wavPath)})`,
      `$dshText = Get-Content -Raw -LiteralPath ${quote(textPath)} -Encoding UTF8`,
      '$engine.Speak($dshText)',
      '$engine.Dispose()',
    ].join('; ')

    const powershell = options.powershellBinary ?? DEFAULT_POWERSHELL_BINARY
    const sapi = await run(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script,
      ],
      {
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        spawnImpl: options.spawnImpl,
      },
      'powershell.exe',
    )
    if (sapi.code !== 0) {
      throw new Error(
        `powershell.exe exited with code ${sapi.code ?? 'null'}: ${sapi.stderr.trim()}`,
      )
    }

    const wav = await stat(wavPath).catch(() => undefined)
    if (!wav?.isFile() || wav.size === 0) {
      throw new Error('SAPI produced an empty WAV file.')
    }

    const ffmpeg = options.ffmpegBinary ?? DEFAULT_FFMPEG_BINARY
    await mkdir(dirname(target), { recursive: true })
    const converted = await run(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        wavPath,
        '-codec:a',
        'libmp3lame',
        '-q:a',
        '4',
        partialPath,
      ],
      {
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        spawnImpl: options.spawnImpl,
      },
      'ffmpeg',
    )
    if (converted.code !== 0) {
      throw new Error(
        `ffmpeg exited with code ${converted.code ?? 'null'}: ${converted.stderr.trim()}`,
      )
    }

    const mp3 = await stat(partialPath).catch(() => undefined)
    if (!mp3?.isFile() || mp3.size === 0) {
      throw new Error('ffmpeg produced an empty MP3 file.')
    }

    await rename(partialPath, target)

    return { filePath: target, format: AUDIO_FORMAT }
  } catch (error) {
    await rm(partialPath, { force: true }).catch(() => {})
    throw error
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}
