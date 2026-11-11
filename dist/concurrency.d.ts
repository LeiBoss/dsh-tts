/** Limits resolved from plugin config. */
export interface ConcurrencyLimits {
    maxConcurrent: number;
    queueSize: number;
    queueTimeoutMs: number;
}
/** Observable capacity, surfaced in TTS_BUSY messages. */
export interface LimiterStats {
    running: number;
    queued: number;
}
/**
 * Counting semaphore with a bounded FIFO wait queue. Every mutation happens
 * synchronously, so slot hand-off cannot leak capacity between tasks.
 */
export declare class ConcurrencyLimiter {
    private running;
    private readonly waiters;
    private readonly limits;
    constructor(limits: ConcurrencyLimits);
    /** Current capacity snapshot. */
    get stats(): LimiterStats;
    /** Run `task` in a slot, waiting for capacity up to `queueTimeoutMs`. */
    run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
    private acquire;
    /** Remove a waiter and release its timer/listener; safe to call twice. */
    private remove;
    /** Free a slot and hand it directly to the oldest waiter. */
    private release;
    /** Structured capacity error; never includes call arguments. */
    private busy;
}
//# sourceMappingURL=concurrency.d.ts.map