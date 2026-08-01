import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const secretRules = Object.freeze([
  Object.freeze({
    id: "stripe-api-key",
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/u,
  }),
  Object.freeze({
    id: "stripe-webhook-signing-secret",
    pattern: /\bwhsec_[A-Za-z0-9]{20,}\b/u,
  }),
  Object.freeze({
    id: "stripe-app-signing-secret",
    pattern: /\babsec_[A-Za-z0-9_]{20,}\b/u,
  }),
  Object.freeze({
    id: "private-key",
    pattern: /-----BEGIN (?:(?:DSA|EC|ENCRYPTED|OPENSSH|RSA) )?PRIVATE KEY-----/u,
  }),
]);

const FILE_READ_ERROR_CODE = "source-file-read-error";
const REPOSITORY_LIST_ERROR_CODE = "repository-list-error";

export function listScannableFiles({ cwd = process.cwd(), execFile = execFileSync } = {}) {
  return execFile("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

export function scanFiles(sourceFiles, { cwd = process.cwd(), readFile = readFileSync } = {}) {
  const findings = [];

  for (const file of sourceFiles) {
    let content;
    try {
      content = readFile(resolve(cwd, file), "utf8");
    } catch {
      findings.push(Object.freeze({ code: FILE_READ_ERROR_CODE, file }));
      continue;
    }

    for (const rule of secretRules) {
      if (rule.pattern.test(content)) {
        findings.push(Object.freeze({ code: rule.id, file }));
      }
    }
  }

  return Object.freeze(findings);
}

export function escapePathForOutput(file) {
  return JSON.stringify(file).replace(/[\u007f-\uffff]/g, (character) => {
    const codeUnit = character.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0");
    return `\\u${codeUnit}`;
  });
}

export function formatFindings(findings) {
  return findings.map(({ code, file }) => `${escapePathForOutput(file)}: ${code}`).join("\n");
}

export function runSecretCheck({
  cwd = process.cwd(),
  execFile = execFileSync,
  readFile = readFileSync,
  writeOut = (message) => process.stdout.write(message),
  writeError = (message) => process.stderr.write(message),
} = {}) {
  let sourceFiles;
  try {
    sourceFiles = listScannableFiles({ cwd, execFile });
  } catch {
    writeError(`Secret scan failed:\n"<repository>": ${REPOSITORY_LIST_ERROR_CODE}\n`);
    return 1;
  }
  const findings = scanFiles(sourceFiles, { cwd, readFile });

  if (findings.length > 0) {
    writeError(`Secret scan failed:\n${formatFindings(findings)}\n`);
    return 1;
  }

  writeOut(
    "No Stripe credentials, app secrets, webhook secrets, or private keys found in tracked or non-ignored source files.\n",
  );
  return 0;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = runSecretCheck();
}
