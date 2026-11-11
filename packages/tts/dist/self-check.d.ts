import { type SpawnFunction } from './edge-tts.ts';
import type { EngineHealthSnapshot } from './engine-health.ts';
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
    /**
     * In-memory engine health snapshot. Present only when the caller supplies a
     * provider; it is never produced by probing the network here.
     */
    engineHealth?: Record<string, EngineHealthSnapshot>;
}
/** Injection points for the self-check. */
export interface SelfCheckOptions {
    config: ResolvedConfig;
    signal?: AbortSignal;
    spawnImpl?: SpawnFunction;
    /** Pure snapshot provider; must not perform I/O. */
    engineHealth?: () => Record<string, EngineHealthSnapshot>;
}
/**
 * Probe the local runtime without synthesizing audio: binary availability,
 * permission to create the subprocess, and output-directory writability.
 */
export declare function selfCheck(options: SelfCheckOptions): Promise<SelfCheckResult>;
//# sourceMappingURL=self-check.d.ts.map