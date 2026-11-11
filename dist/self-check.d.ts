import { type SpawnFunction } from './edge-tts.ts';
import type { ResolvedConfig } from './config.ts';
/** Canonical result of the environment self-check. */
export interface SelfCheckResult {
    edgeTtsAvailable: boolean;
    edgeTtsVersion?: string;
    spawnAllowed: boolean;
    outputDirWritable: boolean;
    dshHome: string;
    /** Whether a proxy is configured for the Edge-TTS subprocess. */
    proxyConfigured: boolean;
}
/** Injection points for the self-check. */
export interface SelfCheckOptions {
    config: ResolvedConfig;
    signal?: AbortSignal;
    spawnImpl?: SpawnFunction;
}
/**
 * Probe the local runtime without synthesizing audio: binary availability,
 * permission to create the subprocess, and output-directory writability.
 */
export declare function selfCheck(options: SelfCheckOptions): Promise<SelfCheckResult>;
//# sourceMappingURL=self-check.d.ts.map