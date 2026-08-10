#!/usr/bin/env node
// Runs the operator contract suite and reports how much of it actually
// executed.  The Lightsail contracts assert file modes, ownership and access
// refusals, so they only produce a valid measurement on Linux as an
// unprivileged user: on Windows they skip, and as root they report failures
// that do not exist because root traverses the refusals it is asked to prove.
//
// A skipped scenario and a passing scenario are indistinguishable in the exit
// code, which is how a broken implementation once reached the ledger behind a
// green `container:check`.  This wrapper leaves the exit code alone and makes
// the coverage impossible to overlook instead.
import { spawn } from "node:child_process";
import process from "node:process";

const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write("usage: run-operator-contracts.mjs <test-file>...\n");
  process.exit(64);
}

const child = spawn(process.execPath, ["--test", "--test-reporter=tap", ...files], {
  stdio: ["ignore", "pipe", "inherit"],
});

let tap = "";
child.stdout.on("data", (chunk) => {
  tap += chunk;
  process.stdout.write(chunk);
});

const readCount = (key) => {
  const match = tap.match(new RegExp(String.raw`^# ${key} (\d+)`, "m"));
  return match === null ? null : Number(match[1]);
};

child.on("close", (code, signal) => {
  const total = readCount("tests");
  const skipped = readCount("skipped");
  const passed = readCount("pass");
  const failed = readCount("fail");

  const onLinux = process.platform === "linux";
  // geteuid is absent on Windows, where the question does not apply.
  const asRoot = typeof process.geteuid === "function" && process.geteuid() === 0;
  const lines = [];

  if (total === null || skipped === null) {
    lines.push("Coverage unknown: the TAP summary could not be read.");
  } else if (skipped > 0) {
    lines.push(
      `PARTIAL COVERAGE: ${skipped} of ${total} scenarios were skipped on ${process.platform}.`,
      "This run is NOT evidence for the Lightsail operator contracts.",
    );
  } else if (!onLinux) {
    lines.push(`Ran on ${process.platform}; the Linux-only assertions cannot be exercised here.`);
  }

  if (asRoot) {
    lines.push(
      "Ran as root. These contracts prove access refusals that root traverses,",
      "so failures reported here may not exist for an unprivileged user.",
    );
  }

  if (lines.length > 0) {
    lines.push("A valid measurement is Linux, unprivileged. See AGENTS.md for the exact command.");
    const width = Math.max(...lines.map((line) => line.length));
    const rule = "!".repeat(width + 4);
    process.stdout.write(`\n${rule}\n`);
    for (const line of lines) {
      process.stdout.write(`! ${line.padEnd(width)} !\n`);
    }
    process.stdout.write(`${rule}\n\n`);
  } else if (total !== null) {
    process.stdout.write(
      `\nFull coverage: ${passed}/${total} passing, ${failed} failing, 0 skipped, ` +
        "linux unprivileged.\n\n",
    );
  }

  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
