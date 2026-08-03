/**
 * Pinning the connection to the addresses that were actually checked (ADR 0025).
 *
 * Re-checking every address a name resolves to narrows DNS rebinding, but it does not close
 * it: issuing the request against the URL makes the HTTP stack resolve the name a second
 * time, on its own. A name served with a very short TTL can answer the check with a public
 * address and the connection with a private one.
 *
 * The fix is to resolve once — under the policy — and then connect to that result. Node's
 * socket layer takes a `lookup` for exactly this, and both `net.connect` and `tls.connect`
 * pass it through, as does undici's `connect.lookup`. Building the function here keeps the
 * decision, and its tests, in the package that owns the policy, while the runtime that
 * composes a dispatcher stays free of it. Nothing is imported: a lookup is a callback shape.
 *
 * The hostname argument is deliberately ignored. That is the whole point — whatever the
 * resolver would answer now, the connection goes where the policy already agreed.
 */

export type AddressFamily = 4 | 6;

export interface PinnedAddress {
  readonly address: string;
  readonly family: AddressFamily;
}

/**
 * A `net.LookupFunction`, in both shapes Node calls it with. Declared structurally so the
 * package keeps no dependency on Node's type packages.
 */
export type PinnedLookup = (
  hostname: string,
  options: { readonly all?: boolean; readonly family?: number },
  callback: (
    error: NodeJS.ErrnoException | null,
    addressOrAddresses: string | readonly PinnedAddress[],
    family?: AddressFamily,
  ) => void,
) => void;

/** An address is IPv6 exactly when it carries a colon; nothing else can. */
export function addressFamily(address: string): AddressFamily {
  return address.includes(":") ? 6 : 4;
}

function lookupError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/**
 * Builds a lookup that answers with the given addresses and nothing else.
 *
 * An empty set is a programming error, not a resolution failure: the caller checked nothing,
 * so there is nothing to connect to. It fails closed at construction rather than producing a
 * lookup that would quietly report every connection as unresolvable.
 *
 * When Node asks for a single address it is given the first of the requested family, so a
 * dispatcher pinned to an IPv4-only result cannot be handed an IPv6 address it will not use.
 */
export function createPinnedLookup(addresses: readonly string[]): PinnedLookup {
  if (addresses.length === 0) {
    throw new Error("PINNED_LOOKUP_REQUIRES_AT_LEAST_ONE_ADDRESS");
  }
  const pinned: readonly PinnedAddress[] = addresses.map((address) => ({
    address,
    family: addressFamily(address),
  }));

  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, pinned);
      return;
    }
    const wanted = options.family === 4 || options.family === 6 ? options.family : undefined;
    const match =
      wanted === undefined ? pinned[0] : pinned.find((entry) => entry.family === wanted);
    if (match === undefined) {
      callback(
        lookupError("ENOTFOUND", "No checked address matches the requested family"),
        "",
        wanted ?? 4,
      );
      return;
    }
    callback(null, match.address, match.family);
  };
}
