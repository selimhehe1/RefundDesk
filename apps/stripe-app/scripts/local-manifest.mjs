import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UPLOADABLE_MANIFEST_PATH = join(APP_DIRECTORY, "stripe-app.json");
const LOCAL_MANIFEST_PATH = join(APP_DIRECTORY, "stripe-app.local.json");
const LOCAL_BUILD_PATH = join(APP_DIRECTORY, ".build");
const FORWARDED_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"];
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
const NON_PUBLIC_DNS_SUFFIXES = [
  "corp",
  "example",
  "home",
  "internal",
  "invalid",
  "lan",
  "local",
  "localhost",
  "test",
];
const NON_PUBLIC_ADDRESSES = new BlockList();
const GLOBAL_UNICAST_IPV6_ADDRESSES = new BlockList();

GLOBAL_UNICAST_IPV6_ADDRESSES.addSubnet("2000::", 3, "ipv6");

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3ffe::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]) {
  NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertPublicDnsHostname(hostname) {
  const normalizedHostname = hostname.toLowerCase();
  const ipCandidate =
    normalizedHostname.startsWith("[") && normalizedHostname.endsWith("]")
      ? normalizedHostname.slice(1, -1)
      : normalizedHostname;
  if (
    isIP(ipCandidate) !== 0 ||
    normalizedHostname.endsWith(".") ||
    !normalizedHostname.includes(".")
  ) {
    throw new Error("REFUNDDESK_DEV_API_BASE must use a public DNS hostname");
  }

  const labels = normalizedHostname.split(".");
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    )
  ) {
    throw new Error("REFUNDDESK_DEV_API_BASE contains an invalid DNS hostname");
  }
  if (
    NON_PUBLIC_DNS_SUFFIXES.some(
      (suffix) => normalizedHostname === suffix || normalizedHostname.endsWith(`.${suffix}`),
    )
  ) {
    throw new Error("REFUNDDESK_DEV_API_BASE must use a public DNS hostname");
  }
}

export function normalizeDevelopmentApiBase(rawValue) {
  if (typeof rawValue !== "string" || rawValue.length === 0) {
    throw new Error("REFUNDDESK_DEV_API_BASE is required");
  }
  if (rawValue !== rawValue.trim()) {
    throw new Error("REFUNDDESK_DEV_API_BASE must not contain surrounding whitespace");
  }

  let url;
  try {
    url = new URL(rawValue);
  } catch {
    throw new Error("REFUNDDESK_DEV_API_BASE must be a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("REFUNDDESK_DEV_API_BASE must use HTTPS");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("REFUNDDESK_DEV_API_BASE must not contain credentials");
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error("REFUNDDESK_DEV_API_BASE must not contain a query or fragment");
  }
  assertPublicDnsHostname(url.hostname);

  const normalizedPath = url.pathname.replace(/\/+$/u, "");
  const apiBase = `${url.origin}${normalizedPath}`;
  return { apiBase, connectSource: `${apiBase}/` };
}

export async function assertPublicDnsResolution(hostname, lookupHost = lookup) {
  let addresses;
  try {
    addresses = await lookupHost(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("REFUNDDESK_DEV_API_BASE hostname must resolve to public IP addresses");
  }

  if (
    !Array.isArray(addresses) ||
    addresses.length === 0 ||
    addresses.some(({ address, family }) => {
      const detectedFamily = isIP(address);
      return (
        detectedFamily === 0 ||
        detectedFamily !== family ||
        (family === 6 && !GLOBAL_UNICAST_IPV6_ADDRESSES.check(address, "ipv6")) ||
        NON_PUBLIC_ADDRESSES.check(address, family === 6 ? "ipv6" : "ipv4")
      );
    })
  ) {
    throw new Error("REFUNDDESK_DEV_API_BASE hostname must resolve to public IP addresses");
  }
}

export function resolveStripeCliLaunch(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { command: "stripe", arguments: [] };
  }

  const environment = options.environment ?? process.env;
  const fileExists = options.fileExists ?? existsSync;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const pathValue = environment["PATH"] ?? environment["Path"] ?? environment["path"] ?? "";
  for (const directory of pathValue.split(delimiter).filter((value) => value.length > 0)) {
    for (const executable of ["stripe.exe", "stripe.com"]) {
      const candidate = resolve(directory, executable);
      if (fileExists(candidate)) {
        return { command: candidate, arguments: [] };
      }
    }
  }

  const appData = environment["APPDATA"];
  if (typeof appData === "string" && appData.length > 0) {
    const npmShim = join(appData, "npm", "node_modules", "@stripe", "cli", "bin", "shim.js");
    if (fileExists(npmShim)) {
      return { command: nodeExecutable, arguments: [npmShim] };
    }
  }

  throw new Error(
    "Stripe CLI executable not found; install stripe.exe or the official @stripe/cli package",
  );
}

export function createDevelopmentManifest(uploadableManifest, developmentApiBase) {
  if (!isRecord(uploadableManifest)) {
    throw new Error("The uploadable Stripe App manifest must be a JSON object");
  }
  const uiExtension = uploadableManifest["ui_extension"];
  const constants = uploadableManifest["constants"];
  if (!isRecord(uiExtension) || !isRecord(constants)) {
    throw new Error("The uploadable Stripe App manifest is missing required objects");
  }
  const contentSecurityPolicy = uiExtension["content_security_policy"];
  if (!isRecord(contentSecurityPolicy)) {
    throw new Error("The uploadable Stripe App manifest is missing its content security policy");
  }

  return {
    ...uploadableManifest,
    ui_extension: {
      ...uiExtension,
      content_security_policy: {
        ...contentSecurityPolicy,
        "connect-src": [developmentApiBase.connectSource],
      },
    },
    constants: {
      ...constants,
      API_BASE: developmentApiBase.apiBase,
      PHASE0_PROBE_ENABLED: true,
      PILOT_LIVE_ENABLED: false,
    },
  };
}

function waitForChild(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    const childExited = (code, signal) => {
      child.off("error", childFailed);
      resolvePromise({ code, signal });
    };
    const childFailed = (error) => {
      child.off("exit", childExited);
      rejectPromise(error);
    };
    child.once("exit", childExited);
    child.once("error", childFailed);
  });
}

export async function runLocalStripeApp(options = {}) {
  const apiBase = normalizeDevelopmentApiBase(
    options.apiBaseValue ?? process.env["REFUNDDESK_DEV_API_BASE"],
  );
  await assertPublicDnsResolution(new URL(apiBase.apiBase).hostname, options.lookupHost ?? lookup);
  const appDirectory = options.appDirectory ?? APP_DIRECTORY;
  const uploadableManifestPath =
    options.uploadableManifestPath ?? join(appDirectory, "stripe-app.json");
  const localManifestPath =
    options.localManifestPath ?? join(appDirectory, "stripe-app.local.json");
  const localBuildPath = options.localBuildPath ?? join(appDirectory, ".build");
  const readText = options.readText ?? readFile;
  const writeText = options.writeText ?? writeFile;
  const removeFile = options.removeFile ?? rm;
  const spawnProcess = options.spawnProcess ?? spawn;
  const signalTarget = options.signalTarget ?? process;
  const stripeLaunch = options.stripeLaunch ?? resolveStripeCliLaunch();
  const uploadableManifest = JSON.parse(await readText(uploadableManifestPath, "utf8"));
  const developmentManifest = createDevelopmentManifest(uploadableManifest, apiBase);
  const signalHandlers = new Map();
  let child;
  let forwardedSignal = null;

  await writeText(localManifestPath, `${JSON.stringify(developmentManifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  try {
    child = spawnProcess(
      stripeLaunch.command,
      [...stripeLaunch.arguments, "apps", "start", "--manifest", localManifestPath],
      {
        cwd: appDirectory,
        shell: false,
        stdio: "inherit",
      },
    );
    for (const signal of FORWARDED_SIGNALS) {
      const handler = () => {
        forwardedSignal ??= signal;
        if (child !== undefined && child.exitCode === null && child.signalCode === null) {
          child.kill(signal);
        }
      };
      signalHandlers.set(signal, handler);
      signalTarget.once(signal, handler);
    }

    const outcome = await waitForChild(child);
    const signal = outcome.signal ?? forwardedSignal;
    return signal === null ? (outcome.code ?? 1) : (SIGNAL_EXIT_CODES[signal] ?? 1);
  } finally {
    for (const [signal, handler] of signalHandlers) {
      signalTarget.off(signal, handler);
    }
    await Promise.all([
      removeFile(localManifestPath, { force: true }),
      removeFile(localBuildPath, { force: true, recursive: true }),
    ]);
  }
}

export const localManifestPaths = {
  build: LOCAL_BUILD_PATH,
  local: LOCAL_MANIFEST_PATH,
  uploadable: UPLOADABLE_MANIFEST_PATH,
};
