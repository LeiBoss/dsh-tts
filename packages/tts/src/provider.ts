/**
 * Public contract for callers that want to own the playback UX.
 *
 * This file is types only: no runtime logic, no imports, no constants.
 */

export interface TTSProvider {
  readonly name: string
  isAvailable(): Promise<boolean>
  synthesize(text: string, options: SynthesizeOptions): Promise<SynthesizeResult>
}

export interface SynthesizeOptions {
  voice?: string
  rate?: string
  pitch?: string
  volume?: string
  signal?: AbortSignal
}

/**
 * Matches the `tts_generate` output. `filePath`/`format` are present only for
 * real audio; the `fallback: 'speechSynthesis'` shape carries the original
 * text instead and leaves the reading to the caller.
 */
export interface SynthesizeResult {
  filePath?: string
  format?: string
  browserUrl?: string
  engine?: string
  fallback?: 'speechSynthesis'
  text?: string
  voice?: string
  rate?: string
}
