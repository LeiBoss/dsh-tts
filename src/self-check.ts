import { constants } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import { runProcess, type SpawnFunction } from './edge-tts.ts'
import { ErrorCode, TtsError } from './errors.ts'
import type { ResolvedConfig } from './config.ts'

/** Canonical result of the environment self-check. */
export interface SelfCheckResult {
  edgeTtsAvailable: boolean
  edgeTtsVersion?: string
  spawnAllowed: boolean
  outputDirWritable: boolean
  dshHome: string
  /** Whether a proxy is configured for the Edge-TTS subprocess. */
  proxyConfigured: boolean
}

/** Injection points for the self-check. */
export interface SelfCheckOptions {
  config: ResolvedConfig
  signal?: AbortSignal
  spawnImpl?: SpawnFunction
}

/** Version-looking token printed by `edge-tts --version`. */
const VERSION_PATTERN = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/

function parseVersion(output: string): string | undefined {
  return VERSION_PATTERN.exec(output)?.[0]
}

async function directoryWritable(outputDir: string): Promise<boolean> {
  if (!outputDir) return false
  try {
    await mkdir(outputDir, { recursive: true })
    await access(outputDir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Probe the local runtime without synthesizing audio: binary availability,
 * permission to create the subprocess, and output-directory writability.
 */
export async function selfCheck(options: SelfCheckOptions): Promise<SelfCheckResult> {
  const { config } = options
  const outputDirWritable = await directoryWritable(config.outputDir)

  let edgeTtsAvailable = false
  let edgeTtsVersion: string | undefined
  let spawnAllowed = true

  try {
    const probe = await runProcess(config.edgeTtsBinary, ['--version'], {
      timeoutMs: Math.min(config.timeoutMs, 5_000),
      signal: options.signal,
      spawnImpl: options.spawnImpl,
    })
    // The process started, so Edge-TTS exists even when it rejects a
    // `--version` flag with a usage exit status.
    edgeTtsAvailable = true
    edgeTtsVersion = parseVersion(probe.stdout) ?? parseVersion(probe.stderr)
  } catch (error) {
    if (error instanceof TtsError) {
      switch (error.code) {
        case ErrorCode.Aborted:
          throw error
        case ErrorCode.SpawnEperm:
          spawnAllowed = false
          break
        case ErrorCode.EdgeTtsNotFound:
          spawnAllowed = true
          break
        case ErrorCode.SynthesisTimeout:
          // The binary started but the version probe hung.
          edgeTtsAvailable = true
          break
        default:
          break
      }
    }
  }

  return {
    edgeTtsAvailable,
    ...(edgeTtsVersion === undefined ? {} : { edgeTtsVersion }),
    spawnAllowed,
    outputDirWritable,
    dshHome: config.dshHome,
    proxyConfigured: config.proxy !== undefined,
  }
}
