/**
 * Lightweight bulkhead for synthesis tasks.
 *
 * A slot wraps one complete request: cache lookup, chunked serial synthesis,
 * and any fallback engine. Chunks share their caller's slot, so a long text
 * never consumes more than one slot. Cache hits are filtered before `run`, so
 * they never queue.
 */
import { ErrorCode, TtsError } from "./errors.js";
/**
 * Counting semaphore with a bounded FIFO wait queue. Every mutation happens
 * synchronously, so slot hand-off cannot leak capacity between tasks.
 */
export class ConcurrencyLimiter {
    running = 0;
    waiters = [];
    limits;
    constructor(limits) {
        this.limits = limits;
    }
    /** Current capacity snapshot. */
    get stats() {
        return { running: this.running, queued: this.waiters.length };
    }
    /** Run `task` in a slot, waiting for capacity up to `queueTimeoutMs`. */
    async run(task, signal) {
        await this.acquire(signal);
        try {
            return await task();
        }
        finally {
            this.release();
        }
    }
    acquire(signal) {
        if (signal?.aborted) {
            return Promise.reject(new TtsError(ErrorCode.Aborted, 'Synthesis was aborted before it started.'));
        }
        if (this.running < this.limits.maxConcurrent) {
            this.running += 1;
            return Promise.resolve();
        }
        if (this.waiters.length >= this.limits.queueSize) {
            return Promise.reject(this.busy('the wait queue is full'));
        }
        return new Promise((resolve, reject) => {
            const waiter = {
                resolve,
                reject,
                timer: setTimeout(() => {
                    this.remove(waiter);
                    reject(this.busy('the queue wait timed out'));
                }, this.limits.queueTimeoutMs),
            };
            if (signal) {
                waiter.signal = signal;
                waiter.onAbort = () => {
                    this.remove(waiter);
                    reject(new TtsError(ErrorCode.Aborted, 'Synthesis was aborted while waiting for a slot.'));
                };
                signal.addEventListener('abort', waiter.onAbort, { once: true });
            }
            this.waiters.push(waiter);
        });
    }
    /** Remove a waiter and release its timer/listener; safe to call twice. */
    remove(waiter) {
        clearTimeout(waiter.timer);
        if (waiter.onAbort) {
            waiter.signal?.removeEventListener('abort', waiter.onAbort);
        }
        const index = this.waiters.indexOf(waiter);
        if (index !== -1)
            this.waiters.splice(index, 1);
    }
    /** Free a slot and hand it directly to the oldest waiter. */
    release() {
        this.running -= 1;
        const next = this.waiters.shift();
        if (!next)
            return;
        clearTimeout(next.timer);
        if (next.onAbort) {
            next.signal?.removeEventListener('abort', next.onAbort);
        }
        this.running += 1;
        next.resolve();
    }
    /** Structured capacity error; never includes call arguments. */
    busy(detail) {
        const { running, queued } = this.stats;
        return new TtsError(ErrorCode.TtsBusy, `TTS synthesis is busy: running=${running}, queued=${queued}, maxConcurrent=${this.limits.maxConcurrent}, queueSize=${this.limits.queueSize} (${detail}).`, 'Retry after the current syntheses finish, or raise `maxConcurrent` / `queueSize` in the plugin config.');
    }
}
//# sourceMappingURL=concurrency.js.map