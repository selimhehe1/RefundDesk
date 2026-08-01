import { describe, expect, it, vi } from "vitest";

import { SampledSignalEmitter } from "../src/server/sampled-signal-emitter.js";

describe("SampledSignalEmitter", () => {
  it("emits immediately, suppresses a burst and reports one aggregate per window", () => {
    let nowMs = 0;
    const emit = vi.fn();
    const sampler = new SampledSignalEmitter<"edge_rate_limited">({
      clockMs: () => nowMs,
      emit,
    });

    sampler.emit("edge_rate_limited");
    for (let index = 0; index < 10_000; index += 1) {
      sampler.emit("edge_rate_limited");
    }
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenLastCalledWith({
      observedCount: 1,
      signal: "edge_rate_limited",
      suppressedCount: 0,
    });

    nowMs = 59_999;
    sampler.emit("edge_rate_limited");
    expect(emit).toHaveBeenCalledOnce();

    nowMs = 60_000;
    sampler.emit("edge_rate_limited");
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith({
      observedCount: 10_002,
      signal: "edge_rate_limited",
      suppressedCount: 10_001,
    });
  });

  it("keeps independent windows and pins a backwards or invalid clock", () => {
    let nowMs = 60_000;
    const emit = vi.fn();
    const sampler = new SampledSignalEmitter<"a" | "b">({
      clockMs: () => nowMs,
      emit,
    });

    sampler.emit("a");
    sampler.emit("b");
    nowMs = Number.NaN;
    sampler.emit("a");
    nowMs = 1;
    sampler.emit("a");
    expect(emit).toHaveBeenCalledTimes(2);

    nowMs = 120_000;
    sampler.emit("a");
    expect(emit).toHaveBeenCalledTimes(3);
    expect(emit).toHaveBeenLastCalledWith({
      observedCount: 3,
      signal: "a",
      suppressedCount: 2,
    });
  });

  it("saturates hostile aggregate counts at a safe integer", () => {
    let nowMs = 0;
    const emit = vi.fn();
    const sampler = new SampledSignalEmitter<"edge_rate_limited">({
      clockMs: () => nowMs,
      emit,
      maximumCount: 3,
    });

    sampler.emit("edge_rate_limited");
    for (let index = 0; index < 100; index += 1) {
      sampler.emit("edge_rate_limited");
    }
    nowMs = 60_000;
    sampler.emit("edge_rate_limited");

    expect(emit).toHaveBeenLastCalledWith({
      observedCount: 3,
      signal: "edge_rate_limited",
      suppressedCount: 3,
    });
  });
});
