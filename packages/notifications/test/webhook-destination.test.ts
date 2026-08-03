import { describe, expect, it } from "vitest";

import { isBlockedAddress, validateWebhookDestination } from "../src/webhook-destination.js";

function accepted(raw: string): URL {
  const result = validateWebhookDestination(raw);
  if ("error" in result) {
    throw new Error(`Expected ${raw} to be accepted, got: ${result.error}`);
  }
  return result.url;
}

function rejection(raw: string): string {
  const result = validateWebhookDestination(raw);
  if (!("error" in result)) {
    throw new Error(`Expected ${raw} to be rejected.`);
  }
  return result.error;
}

describe("validateWebhookDestination", () => {
  it("accepts an ordinary chat webhook", () => {
    expect(accepted("https://hooks.slack.com/services/T000/B000/XXXX").host).toBe(
      "hooks.slack.com",
    );
    expect(accepted("https://example.com:443/hook").pathname).toBe("/hook");
  });

  it("requires HTTPS", () => {
    expect(rejection("http://hooks.slack.com/services/T000")).toContain("HTTPS");
    expect(rejection("ftp://example.com/hook")).toContain("HTTPS");
    expect(rejection("file:///etc/passwd")).toContain("HTTPS");
    // A scheme the URL parser accepts but that would bypass the network policy entirely.
    expect(rejection("javascript:alert(1)")).toContain("HTTPS");
  });

  it("refuses embedded credentials", () => {
    expect(rejection("https://user:secret@example.com/hook")).toContain("credentials");
    expect(rejection("https://user@example.com/hook")).toContain("credentials");
  });

  it("refuses a non-default port, which would allow internal port probing", () => {
    expect(rejection("https://example.com:8443/hook")).toContain("port");
    expect(rejection("https://example.com:22/hook")).toContain("port");
  });

  it("refuses loopback and private hosts written literally", () => {
    for (const raw of [
      "https://127.0.0.1/hook",
      "https://127.1.2.3/hook",
      "https://10.0.0.5/hook",
      "https://192.168.1.10/hook",
      "https://172.16.0.1/hook",
      "https://169.254.169.254/hook",
      "https://0.0.0.0/hook",
      "https://[::1]/hook",
      "https://[fd00::1]/hook",
      "https://[fe80::1]/hook",
    ]) {
      expect(rejection(raw)).toContain("public");
    }
  });

  it("refuses hostnames that name the machine or an internal zone", () => {
    for (const raw of [
      "https://localhost/hook",
      "https://LOCALHOST/hook",
      "https://api.localhost/hook",
      "https://printer.local/hook",
      "https://service.internal/hook",
      "https://db.intranet/hook",
    ]) {
      expect(rejection(raw)).toContain("public");
    }
  });

  it("refuses what cannot be parsed or is unreasonably long", () => {
    expect(rejection("")).toContain("valid HTTPS");
    expect(rejection("   ")).toContain("valid HTTPS");
    expect(rejection("not a url")).toContain("valid HTTPS");
    expect(rejection(`https://example.com/${"x".repeat(2100)}`)).toContain("too long");
  });

  it("keeps the metadata endpoint out even when written unusually", () => {
    // Decimal and octal forms resolve to 169.254.169.254 on most stacks.
    expect(rejection("https://2852039166/hook")).toContain("public");
    expect(rejection("https://0251.0376.0251.0376/hook")).toContain("public");
  });
});

describe("isBlockedAddress", () => {
  it("blocks every address family that can reach our own network", () => {
    for (const address of [
      "127.0.0.1",
      "0.0.0.0",
      "10.1.2.3",
      "172.31.255.255",
      "192.168.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "192.0.0.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("allows ordinary public addresses", () => {
    for (const address of ["1.1.1.1", "8.8.8.8", "52.95.110.1", "2606:4700::1111"]) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it("treats an unparsable address as blocked", () => {
    for (const address of ["", "not-an-ip", "999.999.999.999", "12345"]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });
});
