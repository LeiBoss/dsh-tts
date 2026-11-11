import { ConcurrencyLimiter } from './concurrency.ts';
import type { ResolvedConfig } from './config.ts';
import { type SpawnFunction } from './edge-tts.ts';
import { type FallbackAttempt } from './fallback.ts';
import { type ProbeConnector } from './probe.ts';
import { type SelfCheckResult } from './self-check.ts';
/** What a caller can rely on without probing the network. */
export interface TtsCapabilities {
    /** Word-level timings, which only the pure-JS backend produces. */
    readonly wordBoundaries: boolean;
    readonly formats: readonly ('mp3' | 'wav')[];
    /** A fully local engine exists (SAPI on Windows). */
    readonly offline: boolean;
}
/** One synthesis request. */
export interface TtsRequest {
    text: string;
    voice?: string;
    rate?: string;
    pitch?: string;
    volume?: string;
    signal?: AbortSignal;
}
/** Audio actually produced on this host. */
export interface TtsAudioResult {
    kind: 'audio';
    filePath: string;
    format: string;
    durationMs: number;
    timingQuality: 'exact' | 'estimated';
    engine: string;
    fromCache: boolean;
    /** Present when the backend reported word boundaries. */
    words?: {
        text: string;
        offsetMs: number;
        durationMs: number;
    }[];
    attempts?: FallbackAttempt[];
}
/** No engine could produce a file; the caller should speak `text` itself. */
export interface TtsSpeechResult {
    kind: 'speechSynthesis';
    text: string;
    voice: string;
    rate: string;
    reason: string;
}
export type TtsResult = TtsAudioResult | TtsSpeechResult;
/** Offline/online snapshot used by the voiceover capability matrix. */
export interface TtsProbeReport {
    host: string;
    port: number;
    reachable: boolean;
    elapsedMs: number;
    viaProxy: boolean;
    offlineEngine: boolean;
}
/** Environment report with exactly one suggested next action per problem. */
export interface TtsDoctorReport {
    selfCheck: SelfCheckResult;
    probe: TtsProbeReport;
    capabilities: TtsCapabilities;
    suggestions: string[];
}
/** Injection points; production uses the real binaries and network. */
export interface TtsServiceDeps {
    spawnImpl?: SpawnFunction;
    probeConnect?: ProbeConnector;
    now?: () => Date;
    limiter?: ConcurrencyLimiter;
    log?: (message: string) => void;
}
/** One service instance owns one capacity pool and one cache namespace. */
export declare class TtsService {
    private readonly config;
    private readonly deps;
    private readonly limiter;
    private readonly log;
    private engineKind?;
    constructor(config: ResolvedConfig, deps?: TtsServiceDeps);
    /** Static capabilities; never touches the network. */
    get capabilities(): TtsCapabilities;
    /** Synthesize, preferring a cache hit and falling back across engines. */
    synthesize(request: TtsRequest): Promise<TtsResult>;
    /** Resolve the backend once per instance; `auto` prefers the pure-JS engine. */
    private resolveEngine;
    /** Produce audio without consulting the cache. */
    private produce;
    /** CLI backend: one process per chunk, no word boundaries. */
    private produceWithCli;
    /** Pure-JS backend: one connection per chunk, word boundaries preserved. */
    private produceWithEdgeJs;
    /** Try the configured chain after the primary backend failed. */
    private fallbackChain;
    /**
     * Measure the produced file and record which engine wrote it. `override`
     * carries facts the backend already knows (word boundaries, exact duration).
     */
    private finish;
    /** One TCP probe; never synthesizes and never consumes service quota. */
    probe(): Promise<TtsProbeReport>;
    /** Self-check plus probe plus one actionable suggestion per failure. */
    doctor(): Promise<TtsDoctorReport>;
}
//# sourceMappingURL=service.d.ts.map