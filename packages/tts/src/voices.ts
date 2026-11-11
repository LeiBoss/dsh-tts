/**
 * Static catalogue of Edge-TTS voices the plugin documents.
 *
 * The list is deliberately offline: `tts_self_check` must not query the
 * network, so it reports this constant instead of Edge-TTS's live catalogue.
 * Synthesis still accepts any voice name Edge-TTS understands; this catalogue
 * is metadata, not a whitelist.
 */

/** One documented voice. */
export interface VoiceInfo {
  name: string
  gender: 'Female' | 'Male'
  locale: string
  /** Short human-facing description used by the README. */
  description: string
}

/** Voices surfaced by `tts_self_check` and documented in the README. */
export const VOICES: readonly VoiceInfo[] = [
  {
    name: 'zh-CN-XiaoxiaoNeural',
    gender: 'Female',
    locale: 'zh-CN',
    description: '默认女声，自然通用',
  },
  {
    name: 'zh-CN-YunxiNeural',
    gender: 'Male',
    locale: 'zh-CN',
    description: '男声，年轻自然',
  },
  {
    name: 'zh-CN-XiaoyiNeural',
    gender: 'Female',
    locale: 'zh-CN',
    description: '女声，活泼',
  },
  {
    name: 'zh-CN-YunyangNeural',
    gender: 'Male',
    locale: 'zh-CN',
    description: '男声，播音腔',
  },
  {
    name: 'zh-CN-YunjianNeural',
    gender: 'Male',
    locale: 'zh-CN',
    description: '男声，沉稳',
  },
  {
    name: 'zh-CN-liaoning-XiaobeiNeural',
    gender: 'Female',
    locale: 'zh-CN-liaoning',
    description: '女声，东北话',
  },
  {
    name: 'zh-CN-shaanxi-XiaoniNeural',
    gender: 'Female',
    locale: 'zh-CN-shaanxi',
    description: '女声，陕西话',
  },
  {
    name: 'en-US-AriaNeural',
    gender: 'Female',
    locale: 'en-US',
    description: '英文女声，自然通用',
  },
  {
    name: 'en-US-GuyNeural',
    gender: 'Male',
    locale: 'en-US',
    description: '英文男声',
  },
  {
    name: 'en-US-JennyNeural',
    gender: 'Female',
    locale: 'en-US',
    description: '英文女声，对话感',
  },
]

/** Voice names only, in catalogue order. */
export const AVAILABLE_VOICES: readonly string[] = VOICES.map((voice) => voice.name)
