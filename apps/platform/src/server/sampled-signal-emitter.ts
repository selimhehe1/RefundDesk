export interface SampledSignalObservation<Signal extends string> {
  readonly observedCount: number;
  readonly signal: Signal;
  readonly suppressedCount: number;
}

export interface SampledSignalEmitterOptions<Signal extends string> {
  readonly clockMs?: () => number;
  readonly emit: (observation: SampledSignalObservation<Signal>) => void;
  readonly maximumCount?: number;
  readonly windowMs?: number;
}

interface SignalState {
  lastEmittedAtMs: number;
  suppressedCount: number;
}

const DEFAULT_WINDOW_MS = 60_000;

export class SampledSignalEmitter<Signal extends string> {
  readonly #clockMs: () => number;
  readonly #emit: SampledSignalEmitterOptions<Signal>["emit"];
  readonly #maximumCount: number;
  readonly #states = new Map<Signal, SignalState>();
  readonly #windowMs: number;
  #lastClockMs = 0;

  constructor(options: SampledSignalEmitterOptions<Signal>) {
    const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    const maximumCount = options.maximumCount ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
      throw new Error("Signal sampling window must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maximumCount) || maximumCount <= 0) {
      throw new Error("Signal aggregate count must be a positive safe integer");
    }
    this.#clockMs = options.clockMs ?? Date.now;
    this.#emit = options.emit;
    this.#maximumCount = maximumCount;
    this.#windowMs = windowMs;
  }

  emit(signal: Signal): void {
    const nowMs = this.#now();
    const state = this.#states.get(signal);
    if (state === undefined) {
      this.#states.set(signal, { lastEmittedAtMs: nowMs, suppressedCount: 0 });
      this.#emit({ observedCount: 1, signal, suppressedCount: 0 });
      return;
    }
    if (nowMs - state.lastEmittedAtMs < this.#windowMs) {
      state.suppressedCount = Math.min(this.#maximumCount, state.suppressedCount + 1);
      return;
    }

    const suppressedCount = state.suppressedCount;
    state.lastEmittedAtMs = nowMs;
    state.suppressedCount = 0;
    this.#emit({
      observedCount: Math.min(this.#maximumCount, suppressedCount + 1),
      signal,
      suppressedCount,
    });
  }

  #now(): number {
    const observed = this.#clockMs();
    if (Number.isFinite(observed) && observed >= 0) {
      this.#lastClockMs = Math.max(this.#lastClockMs, Math.trunc(observed));
    }
    return this.#lastClockMs;
  }
}
