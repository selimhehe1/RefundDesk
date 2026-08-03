import { describe, expect, it, vi } from "vitest";

import { addressFamily, createPinnedLookup } from "../src/pinned-lookup.js";

describe("addressFamily", () => {
  it("tells the two families apart by the only character that separates them", () => {
    expect(addressFamily("93.184.216.34")).toBe(4);
    expect(addressFamily("2606:2800:220:1:248:1893:25c8:1946")).toBe(6);
    expect(addressFamily("::1")).toBe(6);
  });
});

describe("createPinnedLookup", () => {
  it("answers with the pinned addresses whatever hostname it is asked about", () => {
    const lookup = createPinnedLookup(["93.184.216.34"]);
    const callback = vi.fn();

    // The hostname is deliberately hostile: a resolver would send this somewhere else.
    lookup("rebound.example", { all: true }, callback);

    expect(callback).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
  });

  it("returns every pinned address in order when asked for all of them", () => {
    const lookup = createPinnedLookup(["93.184.216.34", "2606:2800:220:1::1"]);
    const callback = vi.fn();

    lookup("hooks.example.com", { all: true }, callback);

    expect(callback).toHaveBeenCalledWith(null, [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1::1", family: 6 },
    ]);
  });

  it("gives a single address with its family when only one is asked for", () => {
    const lookup = createPinnedLookup(["2606:2800:220:1::1", "93.184.216.34"]);
    const callback = vi.fn();

    lookup("hooks.example.com", {}, callback);

    expect(callback).toHaveBeenCalledWith(null, "2606:2800:220:1::1", 6);
  });

  it("honours a requested family instead of handing back one the socket cannot use", () => {
    const lookup = createPinnedLookup(["2606:2800:220:1::1", "93.184.216.34"]);
    const callback = vi.fn();

    lookup("hooks.example.com", { family: 4 }, callback);

    expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  });

  it("reports a resolution failure rather than substituting another family", () => {
    const lookup = createPinnedLookup(["93.184.216.34"]);
    const callback = vi.fn();

    lookup("hooks.example.com", { family: 6 }, callback);

    const [error] = callback.mock.calls[0] as [NodeJS.ErrnoException];
    expect(error?.code).toBe("ENOTFOUND");
  });

  it("refuses to exist with nothing to pin to", () => {
    // Failing at construction matters: a lookup built from an empty check would report every
    // connection as unresolvable, which reads as a network problem rather than a missing check.
    expect(() => createPinnedLookup([])).toThrow("PINNED_LOOKUP_REQUIRES_AT_LEAST_ONE_ADDRESS");
  });
});
