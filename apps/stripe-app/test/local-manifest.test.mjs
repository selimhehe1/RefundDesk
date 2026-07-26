import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertPublicDnsResolution,
  createDevelopmentManifest,
  normalizeDevelopmentApiBase,
  resolveStripeCliLaunch,
  runLocalStripeApp,
} from "../scripts/local-manifest.mjs";

const temporaryDirectories = [];

async function createTemporaryApp() {
  const directory = await mkdtemp(join(tmpdir(), "refunddesk-stripe-app-"));
  temporaryDirectories.push(directory);
  const manifest = {
    id: "com.refunddesk.workflow",
    ui_extension: {
      content_security_policy: {
        "connect-src": ["https://api.refunddesk.example/api/"],
        purpose: "Test policy",
      },
    },
    constants: {
      API_BASE: "https://api.refunddesk.example/api",
      PILOT_LIVE_ENABLED: false,
    },
  };
  await writeFile(join(directory, "stripe-app.json"), `${JSON.stringify(manifest)}\n`, "utf8");
  return { directory, manifest };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("local Stripe App manifest", () => {
  it("normalizes a public HTTPS API base for the constant and CSP", () => {
    expect(normalizeDevelopmentApiBase("https://refunddesk-tunnel.example.com/api/")).toEqual({
      apiBase: "https://refunddesk-tunnel.example.com/api",
      connectSource: "https://refunddesk-tunnel.example.com/api/",
    });
  });

  it.each([
    [undefined, "is required"],
    ["http://refunddesk-tunnel.example.com/api", "must use HTTPS"],
    ["https://localhost/api", "public DNS hostname"],
    ["https://127.0.0.1/api", "public DNS hostname"],
    ["https://refunddesk.internal/api", "public DNS hostname"],
    ["https://api.refunddesk.example/api", "public DNS hostname"],
    ["https://user:secret@refunddesk-tunnel.example.com/api", "must not contain credentials"],
    ["https://refunddesk-tunnel.example.com/api?live=true", "query or fragment"],
    ["https://refunddesk-tunnel.example.com/api#live", "query or fragment"],
  ])("rejects a non-public or unsafe API base: %s", (value, expectedMessage) => {
    expect(() => normalizeDevelopmentApiBase(value)).toThrow(expectedMessage);
  });

  it("derives a development manifest without mutating or trusting uploadable live controls", () => {
    const uploadableManifest = {
      id: "com.refunddesk.workflow",
      ui_extension: {
        content_security_policy: {
          "connect-src": ["http://localhost:3000/api/"],
          purpose: "Test policy",
        },
      },
      constants: {
        API_BASE: "http://localhost:3000/api",
        PILOT_LIVE_ENABLED: true,
      },
    };
    const original = JSON.parse(JSON.stringify(uploadableManifest));
    const manifest = createDevelopmentManifest(
      uploadableManifest,
      normalizeDevelopmentApiBase("https://refunddesk-tunnel.example.com/api"),
    );

    expect(uploadableManifest).toEqual(original);
    expect(manifest.ui_extension.content_security_policy["connect-src"]).toEqual([
      "https://refunddesk-tunnel.example.com/api/",
    ]);
    expect(manifest.constants).toEqual({
      API_BASE: "https://refunddesk-tunnel.example.com/api",
      PILOT_LIVE_ENABLED: false,
    });
  });

  it("accepts only DNS answers that are publicly routable at startup", async () => {
    await expect(
      assertPublicDnsResolution("refunddesk-tunnel.example.com", async () => [
        { address: "104.16.132.229", family: 4 },
        { address: "2606:4700::6810:84e5", family: 6 },
      ]),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["loopback", "127.0.0.1", 4],
    ["private IPv4", "10.0.0.7", 4],
    ["link-local IPv4", "169.254.1.2", 4],
    ["deprecated IPv4 relay", "192.88.99.1", 4],
    ["reserved low IPv6", "::2", 6],
    ["unique-local IPv6", "fd00::7", 6],
    ["link-local IPv6", "fe80::1", 6],
    ["deprecated site-local IPv6", "fec0::1", 6],
    ["IETF special-purpose IPv6", "2001:2::1", 6],
    ["IPv6 6to4 embedding loopback IPv4", "2002:7f00:1::", 6],
    ["deprecated 6bone IPv6", "3ffe::1", 6],
    ["documentation IPv6", "3fff::1", 6],
  ])("rejects a public hostname resolving to %s", async (_name, address, family) => {
    await expect(
      assertPublicDnsResolution("refunddesk-tunnel.example.com", async () => [{ address, family }]),
    ).rejects.toThrow("must resolve to public IP addresses");
  });

  it("resolves the npm-installed Stripe CLI on Windows without invoking a shell", () => {
    const npmShim =
      "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@stripe\\cli\\bin\\shim.js";
    expect(
      resolveStripeCliLaunch({
        platform: "win32",
        environment: {
          APPDATA: "C:\\Users\\test\\AppData\\Roaming",
          PATH: "C:\\Windows\\System32",
        },
        fileExists: (path) => path === npmShim,
        nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
      }),
    ).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      arguments: [npmShim],
    });
  });

  it("starts Stripe with only the generated manifest and removes it after exit", async () => {
    const { directory } = await createTemporaryApp();
    const uploadablePath = join(directory, "stripe-app.json");
    const localPath = join(directory, "stripe-app.local.json");
    const localBuildPath = join(directory, ".build");
    const uploadableBefore = await readFile(uploadablePath, "utf8");
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn();
    let generatedManifest;
    const spawnProcess = vi.fn((command, arguments_, options) => {
      generatedManifest = JSON.parse(readFileSync(localPath, "utf8"));
      mkdirSync(localBuildPath);
      writeFileSync(join(localBuildPath, "manifest.js"), "local build\n", "utf8");
      expect(command).toBe("stripe-test");
      expect(arguments_).toEqual(["apps", "start", "--manifest", localPath]);
      expect(arguments_).not.toContain("--live");
      expect(options.cwd).toBe(directory);
      expect(options.shell).toBe(false);
      void Promise.resolve().then(() => {
        child.exitCode = 0;
        child.emit("exit", 0, null);
      });
      return child;
    });

    const exitCode = await runLocalStripeApp({
      apiBaseValue: "https://refunddesk-tunnel.example.com/api",
      appDirectory: directory,
      lookupHost: async () => [{ address: "104.16.132.229", family: 4 }],
      signalTarget: new EventEmitter(),
      spawnProcess,
      stripeLaunch: { command: "stripe-test", arguments: [] },
    });

    expect(exitCode).toBe(0);
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(generatedManifest.constants).toMatchObject({
      API_BASE: "https://refunddesk-tunnel.example.com/api",
      PILOT_LIVE_ENABLED: false,
    });
    expect(existsSync(localPath)).toBe(false);
    expect(existsSync(localBuildPath)).toBe(false);
    expect(await readFile(uploadablePath, "utf8")).toBe(uploadableBefore);
  });

  it("removes the generated manifest when Stripe cannot start", async () => {
    const { directory } = await createTemporaryApp();
    const localPath = join(directory, "stripe-app.local.json");
    const spawnProcess = vi.fn(() => {
      throw new Error("STRIPE_CLI_UNAVAILABLE");
    });

    await expect(
      runLocalStripeApp({
        apiBaseValue: "https://refunddesk-tunnel.example.com/api",
        appDirectory: directory,
        lookupHost: async () => [{ address: "104.16.132.229", family: 4 }],
        signalTarget: new EventEmitter(),
        spawnProcess,
        stripeLaunch: { command: "stripe-test", arguments: [] },
      }),
    ).rejects.toThrow("STRIPE_CLI_UNAVAILABLE");

    expect(existsSync(localPath)).toBe(false);
  });

  it("rejects every CLI argument instead of forwarding a live-mode flag", () => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../scripts/start-local.mjs", import.meta.url)), "--live"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("accepts no CLI arguments or live-mode flags");
  });
});
