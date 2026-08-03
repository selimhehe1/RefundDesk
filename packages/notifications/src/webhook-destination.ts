/**
 * Destination policy for outbound notification webhooks (ADR 0021).
 *
 * A tenant names a URL that the worker will then request, which is a server-side request
 * forgery primitive against the hosted network. Everything here exists to bound it, and it
 * is deliberately closed by default: an address that cannot be understood is refused.
 */

const MAXIMUM_DESTINATION_LENGTH = 2_048;

/** Host suffixes that name the machine itself or a private zone rather than the internet. */
const PRIVATE_HOST_SUFFIXES = [".local", ".localhost", ".internal", ".intranet", ".home.arpa"];
const PRIVATE_HOST_NAMES = ["localhost"];

export type WebhookDestination = { readonly url: URL } | { readonly error: string };

function parseIpv4(value: string): readonly number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (octet > 255) {
      return null;
    }
    octets.push(octet);
  }
  return octets;
}

function isBlockedIpv4(octets: readonly number[]): boolean {
  const [a = 0, b = 0] = octets;
  return (
    a === 0 || // unspecified / "this network"
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, including cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 0) || // IETF protocol assignments
    (a === 192 && b === 168) || // private
    (a === 198 && b >= 18 && b <= 19) || // benchmarking
    a >= 224 // multicast, reserved and broadcast
  );
}

function normalizeIpv6(value: string): string {
  return value.replace(/^\[/u, "").replace(/\]$/u, "").toLowerCase();
}

/**
 * True when an address must never be connected to. Anything unparsable is blocked: a
 * destination we cannot classify is not a destination we may trust.
 */
export function isBlockedAddress(address: string): boolean {
  const candidate = normalizeIpv6(address.trim());
  if (candidate.length === 0) {
    return true;
  }

  const ipv4 = parseIpv4(candidate);
  if (ipv4 !== null) {
    return isBlockedIpv4(ipv4);
  }

  if (!candidate.includes(":")) {
    return true;
  }

  // IPv4-mapped and IPv4-compatible forms must be judged by their IPv4 value, otherwise
  // ::ffff:127.0.0.1 would slip through as "an IPv6 address".
  const mapped = /(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(candidate);
  if (mapped?.[1] !== undefined) {
    const embedded = parseIpv4(mapped[1]);
    return embedded === null || isBlockedIpv4(embedded);
  }

  if (!/^[0-9a-f:]+$/u.test(candidate)) {
    return true;
  }
  if (candidate === "::" || candidate === "::1") {
    return true;
  }
  return (
    /^f[cd][0-9a-f]{2}:/u.test(candidate) || // unique local
    /^fe[89ab][0-9a-f]:/u.test(candidate) || // link-local
    /^ff[0-9a-f]{2}:/u.test(candidate) // multicast
  );
}

/**
 * True when the host component is an address rather than a name. The URL parser normalises
 * decimal and octal IPv4 forms, so `https://2852039166/` arrives here as `169.254.169.254`
 * and cannot be used to smuggle the metadata endpoint past this check.
 */
function isAddressLiteral(hostname: string): boolean {
  return hostname.startsWith("[") || parseIpv4(hostname) !== null;
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    PRIVATE_HOST_NAMES.includes(host) ||
    PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  );
}

/**
 * Applies every check that can be made without touching the network. The remaining check —
 * that each address DNS resolves to is public — happens at send time, because a name that
 * resolves publicly today can be rebound tomorrow.
 */
export function validateWebhookDestination(raw: string): WebhookDestination {
  const candidate = raw.trim();
  if (candidate.length === 0) {
    return { error: "Enter a valid HTTPS webhook address." };
  }
  if (candidate.length > MAXIMUM_DESTINATION_LENGTH) {
    return { error: "The webhook address is too long." };
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { error: "Enter a valid HTTPS webhook address." };
  }

  if (url.protocol !== "https:") {
    return { error: "The webhook address must use HTTPS." };
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return { error: "The webhook address must not contain credentials." };
  }
  if (url.port.length > 0 && url.port !== "443") {
    return { error: "The webhook address must use the default HTTPS port." };
  }
  if (isPrivateHostname(url.hostname)) {
    return { error: "The webhook address must be a public internet address." };
  }
  // A name is only judged here by its shape; its resolved addresses are checked at send
  // time, because a name that resolves publicly today can be rebound later.
  if (isAddressLiteral(url.hostname) && isBlockedAddress(url.hostname)) {
    return { error: "The webhook address must be a public internet address." };
  }

  return { url };
}
