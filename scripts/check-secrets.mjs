import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const secretPatterns = [
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/u,
  /\bwhsec_[A-Za-z0-9]{20,}\b/u,
  /\babsec_[A-Za-z0-9]{20,}\b/u,
  /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u,
];

const sourceFiles = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);

const findings = [];
for (const file of sourceFiles) {
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const pattern of secretPatterns) {
    if (pattern.test(content)) {
      findings.push(`${file}: matches ${pattern.source}`);
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(`Potential committed secrets:\n${findings.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    "No Stripe credentials, app secrets, webhook secrets, or private keys found in source files.\n",
  );
}
