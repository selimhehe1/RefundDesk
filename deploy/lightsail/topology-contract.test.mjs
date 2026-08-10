import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));

async function read(name) {
  return readFile(resolve(directory, name), "utf8");
}

function serviceBlock(compose, name) {
  const startMarker = `  ${name}:\n`;
  const start = compose.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${name} service`);
  const remainder = compose.slice(start + startMarker.length);
  const nextService = remainder.search(/^ {2}[a-z][a-z0-9-]*:\n/gmu);
  return nextService === -1 ? remainder : remainder.slice(0, nextService);
}

function environmentNames(source) {
  return new Set(
    source
      .split(/\r?\n/u)
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => line.slice(0, line.indexOf("="))),
  );
}

function shellFunction(source, name) {
  const normalized = source.replaceAll("\r\n", "\n");
  const start = normalized.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `missing ${name}`);
  const end = normalized.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `unterminated ${name}`);
  return normalized.slice(start, end + 2);
}

test("release recovery parses Docker running state as a strict boolean", async () => {
  const common = await read("scripts/_common.sh");
  const fence = await read("scripts/release-fence.sh");
  const release = await read("scripts/release.sh");
  const rootMount = await read("scripts/prepare-postgres-root-mount.sh");
  const helper = shellFunction(common, "docker_running_state_from_inspection");

  assert.equal(shellFunction(fence, "docker_running_state_from_inspection"), helper);
  assert.match(
    helper,
    /jq --exit-status --raw-output --slurp[\s\S]*if length == 1[\s\S]*and \(\.\[0\] \| type\) == "array"[\s\S]*and \(\.\[0\] \| length\) == 1[\s\S]*and \(\.\[0\]\[0\]\.State\.Running \| type\) == "boolean"[\s\S]*then \(\.\[0\]\[0\]\.State\.Running \| tostring\)[\s\S]*else error\("invalid Docker running state"\)/u,
  );
  assert.equal(
    (common.match(/docker_running_state_from_inspection "\$\{inspection\}"/gu) ?? []).length,
    1,
  );
  assert.equal(
    (release.match(/docker_running_state_from_inspection "\$\{inspection\}"/gu) ?? []).length,
    1,
  );
  assert.equal(
    (fence.match(/docker_running_state_from_inspection "\$\{inspection\}"/gu) ?? []).length,
    2,
  );
  assert.equal(
    (
      rootMount.match(
        /docker_running_state_from_inspection "\$\{(?:inspection|postgres_inspection)\}"/gu,
      ) ?? []
    ).length,
    2,
  );
  assert.doesNotMatch(
    [common, fence, release, rootMount].join("\n"),
    /jq --(?:exit-status --)?raw-output '\.\[0\]\.State\.Running'/u,
  );
});

test("Docker running-state filter accepts false and rejects malformed inspections", async (t) => {
  const common = await read("scripts/_common.sh");
  const helper = shellFunction(common, "docker_running_state_from_inspection");
  const filterMatch = helper.match(
    /jq --exit-status --raw-output --slurp '([\s\S]*?)' <<<"\$\{inspection\}"/u,
  );
  assert.ok(filterMatch);

  const version = spawnSync("jq", ["--version"], { encoding: "utf8" });
  if (version.error?.code === "ENOENT") {
    t.skip("jq is unavailable on this host; CI executes this functional contract");
    return;
  }
  assert.equal(version.status, 0, version.stderr);

  for (const running of [false, true]) {
    const result = spawnSync("jq", ["--exit-status", "--raw-output", "--slurp", filterMatch[1]], {
      encoding: "utf8",
      input: JSON.stringify([{ State: { Running: running } }]),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), String(running));
  }

  for (const input of [
    "[]",
    "{}",
    "null",
    "{",
    JSON.stringify([{ State: {} }]),
    JSON.stringify([{ State: { Running: "false" } }]),
    JSON.stringify([{ State: { Running: false } }, { State: { Running: true } }]),
    `${JSON.stringify([{ State: { Running: false } }])}\n${JSON.stringify([
      { State: { Running: true } },
    ])}`,
  ]) {
    const result = spawnSync("jq", ["--exit-status", "--raw-output", "--slurp", filterMatch[1]], {
      encoding: "utf8",
      input,
    });
    assert.notEqual(result.status, 0);
  }
});

test("standard release and recovery reject incident worker mode before start", async (t) => {
  const bashVersion = spawnSync("bash", ["--version"], { encoding: "utf8" });
  if (bashVersion.error?.code === "ENOENT" || bashVersion.status !== 0) {
    t.skip("a native Bash runtime is unavailable; the isolated Linux contract executes this test");
    return;
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "refunddesk-worker-mode-contract-"));
  const commonPath = resolve(directory, "scripts/_common.sh");
  const revision = "1".repeat(40);
  const composePath = join(temporaryDirectory, "compose.yml");
  const releaseEnvironmentPath = join(temporaryDirectory, "release.env");
  const inspectionPath = join(temporaryDirectory, "inspection.json");
  const exactDeclaration =
    "      REFUNDDESK_WORKER_RUNTIME_MODE: ${REFUNDDESK_WORKER_RUNTIME_MODE:-normal}";
  const parseMode = () =>
    spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; standard_release_environment_worker_mode "$2" "$3" "$4"',
        "refunddesk-worker-mode-test",
        commonPath,
        composePath,
        releaseEnvironmentPath,
        revision,
      ],
      { encoding: "utf8" },
    );
  const assertInspection = (mode) =>
    spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; inspection="$(<"$2")"; assert_standard_worker_runtime_mode_from_inspection "$inspection" "$3"',
        "refunddesk-worker-mode-test",
        commonPath,
        inspectionPath,
        mode,
      ],
      { encoding: "utf8" },
    );

  try {
    await writeFile(composePath, "services:\n  worker:\n    image: legacy\n");
    await writeFile(
      releaseEnvironmentPath,
      `REFUNDDESK_IMAGE_TAG=sandbox-${revision}\nREFUNDDESK_REVISION=${revision}\n`,
    );
    let result = parseMode();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "LEGACY_NORMAL\n");

    await writeFile(composePath, `services:\n  worker:\n${exactDeclaration}\n`);
    await writeFile(
      releaseEnvironmentPath,
      `REFUNDDESK_IMAGE_TAG=sandbox-${revision}\nREFUNDDESK_REVISION=${revision}\nREFUNDDESK_WORKER_RUNTIME_MODE=normal\n`,
    );
    result = parseMode();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "NORMAL\n");

    for (const invalidEnvironment of [
      `REFUNDDESK_IMAGE_TAG=sandbox-${revision}\nREFUNDDESK_REVISION=${revision}\nREFUNDDESK_WORKER_RUNTIME_MODE=incident_admission\n`,
      `REFUNDDESK_IMAGE_TAG=sandbox-${revision}\nREFUNDDESK_REVISION=${revision}\nREFUNDDESK_WORKER_RUNTIME_MODE=normal`,
      `REFUNDDESK_IMAGE_TAG=sandbox-${revision}\nREFUNDDESK_REVISION=${revision}\nREFUNDDESK_WORKER_RUNTIME_MODE=normal\nREFUNDDESK_WORKER_RUNTIME_MODE=normal\n`,
    ]) {
      await writeFile(releaseEnvironmentPath, invalidEnvironment);
      assert.notEqual(parseMode().status, 0);
    }

    await writeFile(
      releaseEnvironmentPath,
      `REFUNDDESK_IMAGE_TAG=sandbox-${revision}\nREFUNDDESK_REVISION=${revision}\n`,
    );
    assert.notEqual(parseMode().status, 0, "legacy bytes require a legacy Compose source");
    await writeFile(
      releaseEnvironmentPath,
      `REFUNDDESK_IMAGE_TAG=sandbox-${revision}\nREFUNDDESK_REVISION=${revision}\nREFUNDDESK_WORKER_RUNTIME_MODE=normal\n`,
    );
    await writeFile(composePath, "services:\n  worker:\n    image: legacy\n");
    assert.notEqual(parseMode().status, 0, "explicit bytes require the exact Compose declaration");

    for (const [mode, environment, expectedStatus] of [
      ["NORMAL", ["A=B", "REFUNDDESK_WORKER_RUNTIME_MODE=normal"], 0],
      ["NORMAL", ["REFUNDDESK_WORKER_RUNTIME_MODE=incident_admission"], 1],
      [
        "NORMAL",
        ["REFUNDDESK_WORKER_RUNTIME_MODE=normal", "REFUNDDESK_WORKER_RUNTIME_MODE=normal"],
        1,
      ],
      ["LEGACY_NORMAL", ["A=B"], 0],
      ["LEGACY_NORMAL", ["REFUNDDESK_WORKER_RUNTIME_MODE=normal"], 1],
    ]) {
      await writeFile(inspectionPath, `${JSON.stringify([{ Config: { Env: environment } }])}\n`);
      assert.equal(assertInspection(mode).status, expectedStatus);
    }
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("PostgreSQL tree fingerprint propagates archive failures", async (t) => {
  const version = spawnSync("bash", ["--version"], { encoding: "utf8" });
  if (version.error?.code === "ENOENT" || version.status !== 0) {
    t.skip("bash is unavailable on this host; CI executes this functional contract");
    return;
  }

  const migration = await read("scripts/prepare-postgres-root-mount.sh");
  const fingerprint = shellFunction(migration, "tree_fingerprint");
  assert.match(migration, /^set -Eeuo pipefail$/mu);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "refunddesk-fingerprint-"));
  const failingTar = join(temporaryDirectory, "tar");

  try {
    await writeFile(failingTar, "#!/usr/bin/env bash\nexit 73\n", { mode: 0o700 });
    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -Eeuo pipefail
${fingerprint}
if tree_fingerprint "$1" >/dev/null; then
  exit 99
else
  status=$?
fi
[[ "\${status}" -eq 73 ]]
`,
        "bash",
        temporaryDirectory,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${temporaryDirectory}:${process.env.PATH ?? ""}`,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("release fence tolerates only proven Compose recreation churn", async (t) => {
  const prerequisites = spawnSync("bash", ["--version"], { encoding: "utf8" });
  if (prerequisites.error?.code === "ENOENT" || prerequisites.status !== 0) {
    t.skip("bash is unavailable on this host; Linux CI executes this functional contract");
    return;
  }
  const bashHasJq =
    spawnSync("bash", ["-c", "command -v jq >/dev/null"], { encoding: "utf8" }).status === 0;

  const fence = await read("scripts/release-fence.sh");
  const revision = "b".repeat(40);
  const oldContainerId = "a".repeat(64);
  const newContainerId = "b".repeat(64);
  const functions = [
    "docker_running_state_from_inspection",
    "candidate_container_ids",
    "container_id_is_proven_absent",
    "runtime_candidate_snapshot",
    "container_is_fenced",
    "candidate_admission_is_valid",
    "enforce_runtime_admission_snapshot",
    "enforce_runtime_admission_once",
  ]
    .map((name) => shellFunction(fence, name))
    .join("\n\n");
  const admissionSnapshot = shellFunction(fence, "enforce_runtime_admission_snapshot");
  const admissionLoop = shellFunction(fence, "enforce_runtime_admission_once");
  assert.doesNotMatch(admissionSnapshot, /local -n/u);
  assert.match(
    admissionSnapshot,
    /local churn=false[\s\S]*\[\[ "\$\{churn\}" == "false" \]\] \|\| return 2/u,
  );
  assert.match(
    admissionLoop,
    /snapshot_status=0[\s\S]*snapshot_status=\$\?[\s\S]*snapshot_status != 0 && snapshot_status != 2/u,
  );
  const fakeDockerSource = [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    'state="${FAKE_DOCKER_STATE:?}"',
    'scenario="${FAKE_DOCKER_SCENARIO:?}"',
    'old_id="${FAKE_DOCKER_OLD_ID:?}"',
    'new_id="${FAKE_DOCKER_NEW_ID:?}"',
    'printf "%q " "$@" >>"${state}/operations.log"',
    'printf "\\n" >>"${state}/operations.log"',
    "current_id() {",
    '  case "$(<"${state}/container")" in',
    '    old) printf "%s\\n" "${old_id}" ;;',
    '    new) printf "%s\\n" "${new_id}" ;;',
    "    none) return 1 ;;",
    "    *) exit 90 ;;",
    "  esac",
    "}",
    "replace_with_new() {",
    '  printf "new\\n" >"${state}/container"',
    '  printf "false\\n" >"${state}/running"',
    '  printf "always\\n" >"${state}/restart"',
    '  : >"${state}/churn-triggered"',
    "}",
    'if [[ "${1:-}" == "container" && "${2:-}" == "ls" ]]; then',
    '  if [[ "${scenario}" == "list-error" ]]; then',
    "    exit 70",
    "  fi",
    '  service_filter=""',
    '  id_filter=""',
    '  previous=""',
    '  for argument in "$@"; do',
    '    if [[ "${previous}" == "--filter" ]]; then',
    '      case "${argument}" in',
    '        label=com.docker.compose.service=*) service_filter="${argument##*=}" ;;',
    '        id=*) id_filter="${argument#id=}" ;;',
    "      esac",
    "    fi",
    '    previous="${argument}"',
    "  done",
    '  if [[ -n "${id_filter}" ]]; then',
    '    if active_id="$(current_id)" && [[ "${active_id}" == "${id_filter}" ]]; then',
    '      printf "%s\\n" "${active_id}"',
    "    fi",
    "    exit 0",
    "  fi",
    '  [[ "${service_filter}" == "caddy" ]] || exit 0',
    '  if [[ "${scenario}" == "snapshot-churn" ]]; then',
    '    if [[ "$(<"${state}/container")" == "old" ]]; then',
    '      printf "new\\n" >"${state}/container"',
    "    else",
    '      printf "old\\n" >"${state}/container"',
    "    fi",
    '    count_file="${state}/caddy-list-count"',
    "    count=0",
    '    [[ ! -f "${count_file}" ]] || count="$(<"${count_file}")"',
    '    printf "%s\\n" "$((count + 1))" >"${count_file}"',
    "  fi",
    '  if active_id="$(current_id)"; then',
    '    printf "%s\\n" "${active_id}"',
    "  fi",
    "  exit 0",
    "fi",
    'if [[ "${1:-}" == "inspect" ]]; then',
    '  requested_id="${2:-}"',
    '  active_id="$(current_id)" || exit 65',
    '  [[ "${requested_id}" == "${active_id}" ]] || exit 65',
    '  if [[ "${scenario}" == "inspect-absent" && ! -f "${state}/churn-triggered" ]]; then',
    "    replace_with_new",
    "    exit 65",
    "  fi",
    '  if [[ "${scenario}" == "inspect-error-present" ]]; then',
    "    exit 70",
    "  fi",
    '  running="$(<"${state}/running")"',
    '  restart="$(<"${state}/restart")"',
    '  printf \'[{"Config":{"Labels":{"com.docker.compose.project":"refunddesk","com.docker.compose.service":"caddy","com.refunddesk.revision":"%s"}},"HostConfig":{"RestartPolicy":{"Name":"%s"}},"State":{"Running":%s}}]\\n\' "${FAKE_DOCKER_CONTAINER_REVISION:?}" "${restart}" "${running}"',
    "  exit 0",
    "fi",
    'if [[ "${1:-}" == "update" ]]; then',
    '  requested_id="${!#}"',
    '  active_id="$(current_id)" || exit 65',
    '  [[ "${requested_id}" == "${active_id}" ]] || exit 65',
    '  if [[ "${scenario}" == "update-absent" && ! -f "${state}/churn-triggered" ]]; then',
    "    replace_with_new",
    "    exit 65",
    "  fi",
    '  if [[ "${scenario}" == "update-error-present" ]]; then',
    "    exit 70",
    "  fi",
    '  if [[ "${scenario}" == "update-error-already-no" ]]; then',
    "    exit 70",
    "  fi",
    '  printf "no\\n" >"${state}/restart"',
    '  printf "%s\\n" "${active_id}"',
    "  exit 0",
    "fi",
    'if [[ "${1:-}" == "stop" ]]; then',
    '  requested_id="${!#}"',
    '  active_id="$(current_id)" || exit 65',
    '  [[ "${requested_id}" == "${active_id}" ]] || exit 65',
    '  if [[ "${scenario}" == "stop-absent" && ! -f "${state}/churn-triggered" ]]; then',
    "    replace_with_new",
    "    exit 65",
    "  fi",
    '  if [[ "${scenario}" == "stop-error-present" || "${scenario}" == "stop-error-kill-success" ]]; then',
    "    exit 70",
    "  fi",
    '  printf "false\\n" >"${state}/running"',
    '  printf "%s\\n" "${active_id}"',
    "  exit 0",
    "fi",
    'if [[ "${1:-}" == "kill" ]]; then',
    '  requested_id="${2:-}"',
    '  active_id="$(current_id)" || exit 65',
    '  [[ "${requested_id}" == "${active_id}" ]] || exit 65',
    '  if [[ "${scenario}" == "stop-error-kill-success" ]]; then',
    '    printf "false\\n" >"${state}/running"',
    '    printf "%s\\n" "${active_id}"',
    "    exit 0",
    "  fi",
    "  exit 70",
    "fi",
    "exit 88",
    "",
  ].join("\n");
  const fakeJqSource = [
    "#!/usr/bin/env node",
    'let input = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => { input += chunk; });',
    'process.stdin.on("end", () => {',
    "  try {",
    "    const args = process.argv.slice(2);",
    '    const filter = args.at(-1) ?? "";',
    "    const values = {};",
    "    for (let index = 0; index < args.length - 2; index += 1) {",
    '      if (args[index] === "--arg") {',
    "        values[args[index + 1]] = args[index + 2];",
    "      }",
    "    }",
    "    const inspection = JSON.parse(input.trim());",
    "    const candidate = Array.isArray(inspection) && inspection.length === 1 ? inspection[0] : null;",
    '    if (filter.includes("invalid Docker running state")) {',
    '      if (typeof candidate?.State?.Running !== "boolean") process.exit(1);',
    "      process.stdout.write(`${String(candidate.State.Running)}\\n`);",
    "      return;",
    "    }",
    "    const labels = candidate?.Config?.Labels;",
    "    const labelsMatch =",
    '      labels?.["com.docker.compose.project"] === values.project &&',
    '      labels?.["com.docker.compose.service"] === values.service;',
    "    if (!labelsMatch) process.exit(1);",
    "    if (filter.includes('RestartPolicy.Name == \"no\"')) {",
    '      if (candidate?.HostConfig?.RestartPolicy?.Name !== "no") process.exit(1);',
    "      if (candidate?.State?.Running !== false) process.exit(1);",
    "      return;",
    "    }",
    '    if (filter.includes("HostConfig.RestartPolicy.Name")) {',
    "      const restart = candidate?.HostConfig?.RestartPolicy?.Name;",
    '      if (typeof restart !== "string") process.exit(1);',
    "      process.stdout.write(`${restart}\\n`);",
    "      return;",
    "    }",
    '    if (filter.includes("com.refunddesk.revision")) {',
    '      const revision = labels["com.refunddesk.revision"] ?? "unversioned";',
    "      process.stdout.write(`${revision}\\n`);",
    "      return;",
    "    }",
    "    process.exit(2);",
    "  } catch {",
    "    process.exit(4);",
    "  }",
    "});",
    "",
  ].join("\n");
  const harness = [
    "set -Eeuo pipefail",
    'readonly COMPOSE_PROJECT="refunddesk"',
    "readonly -a RUNTIME_SERVICES=(caddy web verifier worker)",
    "readonly RUNTIME_ADMISSION_MAX_ATTEMPTS=4",
    'readonly RUNTIME_ADMISSION_RETRY_DELAY_SECONDS="0.01"',
    `readonly REVISION="${revision}"`,
    'readonly ADMISSION_FILE="$1/admission"',
    "secret_file_is_root_owned() {",
    '  [[ -f "$1" && ! -L "$1" ]]',
    "}",
    functions,
    "status=0",
    "enforce_runtime_admission_once || status=$?",
    'printf "status=%s\\n" "${status}"',
    "",
  ].join("\n");

  async function runScenario({
    admitted = false,
    initialContainer = "new",
    initialRestart = "always",
    initialRunning = false,
    name,
  }) {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "refunddesk-release-fence-"));
    try {
      const fakeDocker = join(temporaryDirectory, "docker");
      const fixtureWrites = [
        writeFile(fakeDocker, fakeDockerSource, { mode: 0o700 }),
        writeFile(join(temporaryDirectory, "container"), `${initialContainer}\n`),
        writeFile(join(temporaryDirectory, "running"), `${String(initialRunning)}\n`),
        writeFile(join(temporaryDirectory, "restart"), `${initialRestart}\n`),
        writeFile(join(temporaryDirectory, "operations.log"), ""),
      ];
      if (!bashHasJq) {
        fixtureWrites.push(
          writeFile(join(temporaryDirectory, "jq"), fakeJqSource, { mode: 0o700 }),
        );
      }
      await Promise.all(fixtureWrites);
      if (admitted) {
        await writeFile(join(temporaryDirectory, "admission"), `revision=${revision}\n`, {
          mode: 0o600,
        });
      }
      const result = spawnSync("bash", ["-c", harness, "bash", temporaryDirectory], {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_DOCKER_CONTAINER_REVISION: revision,
          FAKE_DOCKER_NEW_ID: newContainerId,
          FAKE_DOCKER_OLD_ID: oldContainerId,
          FAKE_DOCKER_SCENARIO: name,
          FAKE_DOCKER_STATE: temporaryDirectory,
          PATH: `${temporaryDirectory}${process.platform === "win32" ? ";" : ":"}${
            process.env.PATH ?? ""
          }`,
        },
      });
      return {
        caddyListCount: await readFile(join(temporaryDirectory, "caddy-list-count"), "utf8").catch(
          () => "",
        ),
        container: await readFile(join(temporaryDirectory, "container"), "utf8"),
        operations: await readFile(join(temporaryDirectory, "operations.log"), "utf8"),
        restart: await readFile(join(temporaryDirectory, "restart"), "utf8"),
        result,
        running: await readFile(join(temporaryDirectory, "running"), "utf8"),
      };
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  }

  for (const name of ["inspect-absent", "update-absent"]) {
    await t.test(`${name} is retried only after exact absence proof`, async () => {
      const outcome = await runScenario({ initialContainer: "old", name });
      assert.equal(outcome.result.status, 0, outcome.result.stderr);
      assert.match(outcome.result.stdout, /^status=0$/mu);
      assert.equal(outcome.container.trim(), "new");
      assert.equal(outcome.restart.trim(), "no");
      assert.equal(outcome.running.trim(), "false");
      assert.match(outcome.operations, /container ls --all --quiet --no-trunc --filter id=/u);
    });
  }

  await t.test(
    "a disappearing running container is retried and its replacement is fenced",
    async () => {
      const outcome = await runScenario({
        initialContainer: "old",
        initialRunning: true,
        name: "stop-absent",
      });
      assert.equal(outcome.result.status, 0, outcome.result.stderr);
      assert.match(outcome.result.stdout, /^status=0$/mu);
      assert.equal(outcome.container.trim(), "new");
      assert.equal(outcome.restart.trim(), "no");
      assert.equal(outcome.running.trim(), "false");
    },
  );

  for (const name of ["inspect-error-present", "update-error-present", "stop-error-present"]) {
    await t.test(`${name} fails closed while the exact container still exists`, async () => {
      const outcome = await runScenario({
        initialRunning: name === "stop-error-present",
        name,
      });
      assert.equal(outcome.result.status, 0, outcome.result.stderr);
      assert.match(outcome.result.stdout, /^status=1$/mu);
      if (name === "stop-error-present") {
        assert.equal(outcome.running.trim(), "true");
      }
    });
  }

  await t.test("an already fenced restart policy avoids a racy Docker update", async () => {
    const outcome = await runScenario({
      initialRestart: "no",
      name: "update-error-already-no",
    });
    assert.equal(outcome.result.status, 0, outcome.result.stderr);
    assert.match(outcome.result.stdout, /^status=0$/mu);
    assert.equal(outcome.restart.trim(), "no");
    assert.doesNotMatch(outcome.operations, /(?:^|\n)update /u);
  });

  await t.test("a failed graceful stop still kill-fences a present running container", async () => {
    const outcome = await runScenario({
      initialRunning: true,
      name: "stop-error-kill-success",
    });
    assert.equal(outcome.result.status, 0, outcome.result.stderr);
    assert.match(outcome.result.stdout, /^status=0$/mu);
    assert.equal(outcome.running.trim(), "false");
    assert.match(outcome.operations, /kill [0-9a-f]{64}/u);
  });

  await t.test("a Docker enumeration error fails closed", async () => {
    const outcome = await runScenario({ name: "list-error" });
    assert.equal(outcome.result.status, 0, outcome.result.stderr);
    assert.match(outcome.result.stdout, /^status=1$/mu);
  });

  await t.test("a target-revision runtime is stopped before admission", async () => {
    const outcome = await runScenario({ initialRunning: true, name: "normal" });
    assert.equal(outcome.result.status, 0, outcome.result.stderr);
    assert.match(outcome.result.stdout, /^status=0$/mu);
    assert.equal(outcome.running.trim(), "false");
    assert.match(outcome.operations, /stop --time 45/u);
  });

  await t.test(
    "a target-revision runtime may remain running only after exact admission",
    async () => {
      const outcome = await runScenario({
        admitted: true,
        initialRunning: true,
        name: "normal",
      });
      assert.equal(outcome.result.status, 0, outcome.result.stderr);
      assert.match(outcome.result.stdout, /^status=0$/mu);
      assert.equal(outcome.restart.trim(), "no");
      assert.equal(outcome.running.trim(), "true");
      assert.doesNotMatch(outcome.operations, /stop --time 45/u);
    },
  );

  await t.test("continuous snapshot churn exhausts a bounded retry count", async () => {
    const outcome = await runScenario({
      initialContainer: "old",
      name: "snapshot-churn",
    });
    assert.equal(outcome.result.status, 0, outcome.result.stderr);
    assert.match(outcome.result.stdout, /^status=1$/mu);
    assert.equal(outcome.caddyListCount.trim(), "8");
  });

  assert.doesNotMatch(fence, /No such (?:container|object)/iu);
});

test("runtime topology publishes only the public Caddy ports", async () => {
  const compose = await read("compose.yml");
  assert.match(compose, /^name: refunddesk$/mu);
  assert.match(
    compose,
    /image: postgres:18\.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296/u,
  );
  assert.equal(
    (
      compose.match(
        /image: caddy:2\.11\.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648/gu,
      ) ?? []
    ).length,
    2,
  );
  const postgres = serviceBlock(compose, "postgres");
  assert.match(postgres, /PGDATA: \/var\/lib\/postgresql$/mu);
  assert.match(
    postgres,
    /source: \/var\/lib\/refunddesk\/postgres\/data\s+target: \/var\/lib\/postgresql$/mu,
  );
  assert.doesNotMatch(postgres, /target: \/var\/lib\/postgresql\/data/u);
  assert.equal((compose.match(/image: caddy:2\.11\.4-alpine/gu) ?? []).length, 2);
  assert.doesNotMatch(compose, /^\s{4}build:/mu, "the 1 GiB host must never build images");

  for (const service of [
    "postgres",
    "bootstrap",
    "migrate",
    "maintenance",
    "worker",
    "verifier",
    "web",
  ]) {
    assert.doesNotMatch(serviceBlock(compose, service), /^\s{4}ports:/mu);
  }
  const publicCaddy = serviceBlock(compose, "caddy");
  assert.match(publicCaddy, /^\s{4}ports:\n\s{6}- "80:8080"\n\s{6}- "443:8443"$/mu);
  for (const caddyService of ["verifier", "caddy"]) {
    const block = serviceBlock(compose, caddyService);
    assert.match(block, /^\s{4}cap_add:\n\s{6}- NET_BIND_SERVICE$/mu);
  }
  for (const service of ["postgres", "bootstrap", "migrate", "maintenance", "worker", "web"]) {
    assert.doesNotMatch(serviceBlock(compose, service), /NET_BIND_SERVICE/u);
  }
});

test("web and worker have disjoint database and verifier networks", async () => {
  const compose = await read("compose.yml");
  const web = serviceBlock(compose, "web");
  const worker = serviceBlock(compose, "worker");
  const migrate = serviceBlock(compose, "migrate");
  const maintenance = serviceBlock(compose, "maintenance");
  const bootstrap = serviceBlock(compose, "bootstrap");

  assert.match(web, /database-web:/u);
  assert.match(web, /verifier-front:/u);
  assert.match(web, /web-egress:/u);
  assert.doesNotMatch(
    web,
    /database-worker|database-migrate|database-maintenance|verifier-back|worker-egress/u,
  );
  assert.doesNotMatch(
    web,
    /depends_on:[\s\S]*?\bverifier:/u,
    "webhook ingestion must start independently of the verifier and worker",
  );

  assert.match(worker, /database-worker:/u);
  assert.match(worker, /verifier-back:/u);
  assert.match(worker, /worker-egress:/u);
  assert.doesNotMatch(
    worker,
    /database-web|database-migrate|database-maintenance|verifier-front|web-egress/u,
  );

  assert.match(migrate, /- database-migrate/u);
  assert.match(migrate, /^\s{4}read_only: true$/mu);
  assert.doesNotMatch(
    migrate,
    /database-web|database-worker|database-maintenance|egress|verifier-/u,
  );
  assert.match(bootstrap, /- database-migrate/u);
  assert.doesNotMatch(
    bootstrap,
    /database-web|database-worker|database-maintenance|egress|verifier-/u,
  );
  assert.match(maintenance, /- database-maintenance/u);
  assert.match(maintenance, /^\s{4}read_only: true$/mu);
  assert.doesNotMatch(
    maintenance,
    /database-web|database-worker|database-migrate|egress|verifier-/u,
  );

  for (const network of [
    "edge",
    "verifier-front",
    "verifier-back",
    "database-web",
    "database-worker",
    "database-migrate",
    "database-maintenance",
  ]) {
    assert.match(
      compose,
      new RegExp(`  ${network}:\\n    driver: bridge\\n    internal: true`, "u"),
    );
  }
});

test("TLS names and ingress deny rules are explicit", async () => {
  const [
    compose,
    publicCaddy,
    verifierCaddy,
    platform,
    worker,
    migration,
    maintenance,
    verifyDeployment,
  ] = await Promise.all([
    read("compose.yml"),
    read("Caddyfile.public"),
    read("Caddyfile.verifier"),
    read("platform.env.example"),
    read("worker.env.example"),
    read("migration.env.example"),
    read("maintenance.env.example"),
    read("scripts/verify-deployment.sh"),
  ]);

  assert.match(compose, /postgres\.refunddesk\.internal/gu);
  assert.match(platform, /sslmode=verify-full/u);
  assert.match(worker, /sslmode=verify-full/gu);
  assert.match(migration, /sslmode=verify-full/gu);
  assert.match(maintenance, /sslmode=verify-full/gu);
  assert.match(
    platform,
    /https:\/\/verifier\.refunddesk\.internal:8443\/internal\/v1\/signed-requests\/verify/u,
  );
  const boundedServerOptions =
    /servers \{\s+timeouts \{\s+read_header 5s\s+read_body 30s\s+write 30s\s+idle 60s\s+\}\s+max_header_size 64KiB\s+\}/u;
  assert.match(publicCaddy, boundedServerOptions);
  assert.match(verifierCaddy, boundedServerOptions);
  assert.match(publicCaddy, /persist_config off/u);
  assert.match(verifierCaddy, /persist_config off/u);
  assert.match(
    publicCaddy,
    /@blocked path \/internal \/internal\/\* \/api\/ready \/api\/webhooks\/stripe-connected \/api\/webhooks\/stripe-connected\/\* \/api\/webhooks\/stripe-account\/live/u,
  );
  assert.match(
    publicCaddy,
    /@signed_api path \/api\/v1\/\*\s+request_body @signed_api \{\s+max_size 32768\s+\}/u,
  );
  assert.match(
    publicCaddy,
    /@account_webhooks path \/api\/webhooks\/stripe-account\/test \/api\/webhooks\/stripe-account\/sandbox\s+request_body @account_webhooks \{\s+max_size 1048576\s+\}/u,
  );
  assert.match(
    publicCaddy,
    /@unverified_edge not header X-RefundDesk-Origin-Token \{\$REFUNDDESK_EDGE_ORIGIN_TOKEN\}\s+respond @unverified_edge 404/u,
  );
  assert.match(
    publicCaddy,
    /vars refunddesk_cloudfront_viewer_chain "\{http\.request\.header\.X-Forwarded-For\}"/u,
  );
  assert.match(
    publicCaddy,
    /header_up X-RefundDesk-Viewer-Chain "\{vars\.refunddesk_cloudfront_viewer_chain\}"/u,
  );
  assert.match(publicCaddy, /header_up X-RefundDesk-Edge-Verified cloudfront-v1/u);
  assert.match(publicCaddy, /header_up -X-RefundDesk-Origin-Token/u);
  const originTokenDeny = publicCaddy.indexOf("respond @unverified_edge 404");
  const publicProxy = publicCaddy.indexOf("reverse_proxy web.refunddesk.internal:3000");
  assert.ok(
    originTokenDeny >= 0 && publicProxy > originTokenDeny,
    "origin-token denial must execute before the public reverse proxy",
  );
  assert.match(verifierCaddy, /https:\/\/verifier\.refunddesk\.internal:8443/u);
  assert.match(
    verifierCaddy,
    /method POST\s+path \/internal\/v1\/signed-requests\/verify \/internal\/v1\/signed-requests\/attest/u,
  );
  assert.match(verifierCaddy, /request_body @authority \{\s+max_size 32768\s+\}/u);
  assert.match(verifyDeployment, /\/api\/webhooks\/stripe-account\/test/u);
  assert.match(verifyDeployment, /\/api\/webhooks\/stripe-account\/sandbox/u);
  assert.match(verifyDeployment, /\/api\/webhooks\/stripe-account\/live/u);
  assert.match(verifyDeployment, /\/api\/webhooks\/stripe-connected\/test/u);
  assert.match(verifyDeployment, /require_command base64/u);
  assert.match(verifyDeployment, /Caddy autosave residue is present/u);
  assert.equal(
    (verifierCaddy.match(/reverse_proxy/gu) ?? []).length,
    1,
    "verifier must have one exact upstream",
  );
});

test("deployment verification normalizes HTTP CRLF before exact header checks", async () => {
  const verifyDeployment = await read("scripts/verify-deployment.sh");

  assert.match(verifyDeployment, /normalize_http_headers\(\) \{\s+tr --delete '\\r'\s+\}/u);
  assert.equal(
    (verifyDeployment.match(/\|\s+normalize_http_headers/gu) ?? []).length,
    2,
    "both local-origin and CloudFront header blocks must be normalized",
  );
  assert.doesNotMatch(
    verifyDeployment,
    /\\r\?\$/u,
    "GNU grep ERE does not interpret \\r as a carriage return",
  );
});

test("the public CI edge token is coupled to every production deny-list", async () => {
  const [workflow, releaseCheck, verifyDeployment] = await Promise.all([
    read("../../.github/workflows/ci.yml"),
    read("../../packages/config/src/check-release.ts"),
    read("scripts/verify-deployment.sh"),
  ]);
  const workflowToken = workflow.match(/REFUNDDESK_EDGE_ORIGIN_TOKEN=([A-Za-z0-9_-]{43})/u)?.[1];
  assert.ok(workflowToken, "CI must use one shape-valid public Caddy token");
  assert.match(releaseCheck, new RegExp(`"${workflowToken}"`, "u"));
  assert.match(verifyDeployment, new RegExp(`"${workflowToken}"`, "u"));
});

test("deployment verification fails closed when host listener inventory is unavailable", async () => {
  const verifyDeployment = await read("scripts/verify-deployment.sh");
  const inventory = verifyDeployment.indexOf('host_tcp_listeners="$(');
  const socketQuery = verifyDeployment.indexOf(
    "ss --listening --tcp --numeric --no-header",
    inventory,
  );
  const inventoryFailure = verifyDeployment.indexOf(
    'die "host listening TCP inventory is unavailable"',
    socketQuery,
  );
  const internalPortCheck = verifyDeployment.indexOf(
    '<<<"${host_tcp_listeners}"',
    inventoryFailure,
  );

  assert.ok(
    inventory >= 0 &&
      socketQuery > inventory &&
      inventoryFailure > socketQuery &&
      internalPortCheck > inventoryFailure,
  );
  assert.doesNotMatch(
    verifyDeployment,
    /if ss --listening --tcp/u,
    "an ss failure must not be mistaken for an empty listener inventory",
  );
});

test("deployment verification compiles every await-based Node eval as an ES module", async () => {
  const verifyDeployment = await read("scripts/verify-deployment.sh");
  const inlineEvalPattern =
    /\bnode (?<options>(?:--[a-z-]+(?:=[a-z]+)?\s+)*)-e '\n(?<source>[\s\S]*?)\n\s*'/gu;
  const awaitProbes = [...verifyDeployment.matchAll(inlineEvalPattern)].filter(({ groups }) =>
    /\bawait\b/u.test(groups.source),
  );

  assert.equal(awaitProbes.length, 6, "all six await-based deployment probes must be covered");
  for (const { groups } of awaitProbes) {
    const options = groups.options.trim().split(/\s+/u).filter(Boolean);
    assert.ok(
      options.includes("--input-type=module"),
      "top-level await requires Node's module eval mode",
    );
    const syntaxCheck = spawnSync(
      process.execPath,
      [...options, "--eval", `if (false) {\n${groups.source}\n}`],
      {
        encoding: "utf8",
      },
    );
    assert.equal(syntaxCheck.status, 0, syntaxCheck.stderr);
  }
});

test("deployment verification bounds and classifies exact-container readiness retries", async () => {
  const verifyDeployment = await read("scripts/verify-deployment.sh");
  const helper = shellFunction(verifyDeployment, "retry_bounded_service_probe");
  const retryCalls = verifyDeployment.match(/^\s*retry_bounded_service_probe \\\s*$/gmu) ?? [];

  assert.match(verifyDeployment, /^require_command timeout$/mu);
  assert.match(helper, /local retry_delay_seconds=5/u);
  assert.match(helper, /max_attempts=\$\(\(deadline_seconds \/ retry_delay_seconds \+ 2\)\)/u);
  assert.match(helper, /local max_attempt_timeout_seconds=50/u);
  assert.match(helper, /\$\{container_id\}" =~ \^\[0-9a-f\]\{64\}\$/u);
  assert.doesNotMatch(helper, /docker inspect/u);
  assert.ok(helper.includes('docker exec -- "${container_id}" "$@"'));
  assert.ok(
    helper.indexOf("(( remaining_seconds > 0 )) || break") < helper.indexOf("timeout \\"),
    "a zero remaining duration must stop before GNU timeout can disable its bound",
  );
  assert.match(helper, /timeout \\\s+--foreground \\\s+--signal=TERM \\\s+--kill-after=5s/u);
  assert.match(helper, /75\|124\|137\)/u);
  assert.match(helper, /deployment probe transient failure/u);
  assert.match(helper, /deployment probe failed permanently/u);
  assert.match(helper, /deployment probe exhausted/u);
  assert.doesNotMatch(helper, /\beval\b/u);

  assert.equal(retryCalls.length, 4, "all four private readiness probes must be bounded");
  for (const probe of ["web-ready", "worker-ready", "verifier-auth", "graceful-web-ready"]) {
    assert.match(verifyDeployment, new RegExp(`\\n\\s*${probe} \\\\\\n`, "u"));
  }
  assert.equal(
    (verifyDeployment.match(/AbortSignal\.timeout\(20000\)/gu) ?? []).length,
    5,
    "every await-based deployment fetch must keep a 20-second network bound",
  );
  assert.doesNotMatch(verifyDeployment, /AbortSignal\.timeout\(5000\)/u);
  assert.equal(
    (verifyDeployment.match(/process\.exit\(response\.status === 503 \? 75 : 1\)/gu) ?? []).length,
    4,
    "only HTTP 503 may be classified as retryable by private probes",
  );
  assert.match(
    verifyDeployment,
    /VERIFIED_WEB_CONTAINER_ID="\$\{container_id\}"[\s\S]+VERIFIED_WORKER_CONTAINER_ID="\$\{container_id\}"/u,
  );
});

test("bounded readiness helper retries only transient command outcomes", async (t) => {
  const version = spawnSync("bash", ["--version"], { encoding: "utf8" });
  if (version.error?.code === "ENOENT" || version.status !== 0) {
    t.skip("bash is unavailable on this host; Linux CI executes this functional contract");
    return;
  }

  const verifyDeployment = await read("scripts/verify-deployment.sh");
  const helper = shellFunction(verifyDeployment, "retry_bounded_service_probe");
  const containerId = "a".repeat(64);
  const harness = `set -Eeuo pipefail
${helper}
scenario="$1"
expected_id="$2"
fake_index=0
case "\${scenario}" in
  transient-success) fake_statuses=(75 75 0) ;;
  timeout-success) fake_statuses=(124 0) ;;
  permanent-failure) fake_statuses=(1) ;;
  transient-exhausted)
    fake_statuses=()
    for _ in {1..40}; do
      fake_statuses+=(75)
    done
    ;;
  *) exit 90 ;;
esac
log() {
  printf 'log=%s calls=%s\\n' "$*" "\${fake_index}"
}
die() {
  printf 'die=%s calls=%s\\n' "$*" "\${fake_index}" >&2
  exit 99
}
sleep() {
  SECONDS=$((SECONDS + $1))
  return 0
}
timeout() {
  while (( $# > 0 )) && [[ "$1" != "docker" ]]; do
    shift
  done
  [[ "$1" == "docker" ]] || return 88
  "$@"
}
docker() {
  [[ "$1" == "exec" && "$2" == "--" && "$3" == "\${expected_id}" ]] || return 87
  shift 3
  printf 'argument=%q\\n' "$@"
  status="\${fake_statuses[\${fake_index}]}"
  fake_index=$((fake_index + 1))
  return "\${status}"
}
retry_bounded_service_probe \
  web-ready \
  "\${expected_id}" \
  150 \
  node "argument with spaces"
printf 'result=passed calls=%s\\n' "\${fake_index}"
`;

  const cases = [
    {
      name: "transient-success",
      status: 0,
      output: /result=passed calls=3/u,
      diagnostics: /probe=web-ready; attempt=3/u,
    },
    {
      name: "timeout-success",
      status: 0,
      output: /result=passed calls=2/u,
      diagnostics: /exit_status=124/u,
    },
    {
      name: "permanent-failure",
      status: 99,
      output: /calls=1/u,
      diagnostics: /failed permanently; probe=web-ready; attempt=1; exit_status=1/u,
    },
    {
      name: "transient-exhausted",
      status: 99,
      output: /calls=30/u,
      diagnostics: /probe exhausted; probe=web-ready; attempts=30/u,
    },
  ];

  for (const scenario of cases) {
    const result = spawnSync("bash", ["-c", harness, "bash", scenario.name, containerId], {
      encoding: "utf8",
    });
    assert.equal(result.status, scenario.status, `${scenario.name}: ${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, scenario.output);
    assert.match(`${result.stdout}\n${result.stderr}`, scenario.diagnostics);
    assert.match(result.stdout, /argument=node[\s\S]+argument=argument\\ with\\ spaces/u);
  }
});

test("private readiness probes expose only safe transient and permanent exit classes", async () => {
  const verifyDeployment = await read("scripts/verify-deployment.sh");
  const inlineEvalPattern =
    /\bnode (?<options>(?:--[a-z-]+(?:=[a-z]+)?\s+)*)-e '\n(?<source>[\s\S]*?)\n\s*'/gu;
  const probeSources = new Map();

  for (const { groups } of verifyDeployment.matchAll(inlineEvalPattern)) {
    const probe = groups.source.match(/deployment_probe=(?<name>[a-z-]+)/u)?.groups?.name;
    if (probe) {
      probeSources.set(probe, {
        options: groups.options.trim().split(/\s+/u).filter(Boolean),
        source: groups.source,
      });
    }
  }

  assert.deepEqual([...probeSources.keys()].sort(), [
    "graceful-web-ready",
    "verifier-auth",
    "web-ready",
    "worker-ready",
  ]);

  const runProbe = (probe, responses) => {
    const entry = probeSources.get(probe);
    assert.ok(entry, `missing ${probe} source`);
    const prelude = `
      const mockedResponses = ${JSON.stringify(responses)};
      globalThis.fetch = async () => {
        const next = mockedResponses.shift();
        if (!next) throw Object.assign(new Error("mock exhausted"), {name: "TypeError"});
        if (next.error) throw Object.assign(new Error("redacted"), {name: next.error});
        return {
          body: "must-not-be-logged-secret",
          ok: next.status >= 200 && next.status < 300,
          status: next.status,
        };
      };
    `;
    return spawnSync(
      process.execPath,
      [...entry.options, "--eval", `${prelude}\n${entry.source}`],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          REFUNDDESK_SIGNED_REQUEST_VERIFIER_URL:
            "https://verifier.refunddesk.invalid/internal/v1/signed-requests/verify",
        },
      },
    );
  };
  const expectProbe = (probe, responses, expectedStatus, stderrPattern) => {
    const result = runProbe(probe, responses);
    assert.equal(result.status, expectedStatus, result.stderr);
    assert.match(result.stderr, stderrPattern);
    assert.doesNotMatch(result.stderr, /must-not-be-logged-secret/u);
  };

  assert.equal(runProbe("web-ready", [{ status: 200 }]).status, 0);
  expectProbe("web-ready", [{ status: 503 }], 75, /result=http_503/u);
  expectProbe("web-ready", [{ status: 404 }], 1, /result=http_404/u);
  expectProbe("web-ready", [{ error: "TypeError" }], 75, /result=transport_error/u);

  assert.equal(runProbe("worker-ready", [{ status: 200 }, { status: 200 }]).status, 0);
  expectProbe(
    "worker-ready",
    [{ status: 200 }, { status: 503 }],
    75,
    /endpoint=ready result=http_503/u,
  );

  assert.equal(runProbe("verifier-auth", [{ status: 403 }]).status, 0);
  expectProbe("verifier-auth", [{ status: 503 }], 75, /result=http_503/u);
  expectProbe("verifier-auth", [{ status: 200 }], 1, /result=http_200/u);
  expectProbe("graceful-web-ready", [{ status: 503 }], 75, /result=http_503/u);
});

test("CI smoke keeps inter-service bearer rejection distinct from Stripe signature rejection", async () => {
  const workflow = await read("../../.github/workflows/ci.yml");
  const authoritySmoke =
    /for authority_action in verify attest; do[\s\S]*?http:\/\/127\.0\.0\.1:3201\/internal\/v1\/signed-requests\/\$\{authority_action\}[\s\S]*?\)" = "403"[\s\S]*?done/u;

  assert.match(workflow, authoritySmoke, "missing private authority smoke requests");
  assert.doesNotMatch(workflow.match(authoritySmoke)?.[0] ?? "", /\)" = "401"/u);
});

test("environment examples preserve authority separation and disable live", async () => {
  const [
    compose,
    platformSource,
    workerSource,
    migrationSource,
    maintenanceSource,
    postgresSource,
    bootstrapSql,
    bootstrapScript,
  ] = await Promise.all([
    read("compose.yml"),
    read("platform.env.example"),
    read("worker.env.example"),
    read("migration.env.example"),
    read("maintenance.env.example"),
    read("postgres.env.example"),
    read("10-bootstrap-roles.sql"),
    read("scripts/bootstrap-roles.sh"),
  ]);
  const platform = environmentNames(platformSource);
  const worker = environmentNames(workerSource);
  const migration = environmentNames(migrationSource);
  const maintenance = environmentNames(maintenanceSource);

  for (const forbidden of [
    "WORKER_DATABASE_URL",
    "PGBOSS_DATABASE_URL",
    "DATABASE_MIGRATION_URL",
    "STRIPE_APP_SIGNING_SECRET",
    "STRIPE_PLATFORM_TEST_EFFECT_KEY",
    "STRIPE_MANAGED_SANDBOX_EFFECT_KEY",
    "REFUNDDESK_PROOF_HMAC_KEY_V1",
    "REFUNDDESK_PROOF_HMAC_KEY_V2",
    "REFUNDDESK_PROOF_KEY_ROTATION_STATE",
    "REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V1",
    "REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V2",
    "REFUNDDESK_APPROVAL_ATTESTATION_KEY_ROTATION_STATE",
  ]) {
    assert.equal(platform.has(forbidden), false, `platform contains ${forbidden}`);
  }
  for (const forbidden of [
    "DATABASE_URL",
    "DATABASE_MIGRATION_URL",
    "STRIPE_PLATFORM_TEST_READ_KEY",
    "STRIPE_MANAGED_SANDBOX_READ_KEY",
    "STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET",
    "STRIPE_ACCOUNT_SANDBOX_WEBHOOK_SECRET",
    "REFUNDDESK_FIELD_ENCRYPTION_KEY_V1",
    "REFUNDDESK_FIELD_ENCRYPTION_KEY_V2",
    "REFUNDDESK_FIELD_KEY_ROTATION_STATE",
    "REFUNDDESK_EXPORT_SIGNING_KEY_V1",
  ]) {
    assert.equal(worker.has(forbidden), false, `worker contains ${forbidden}`);
  }
  assert.deepEqual([...migration].sort(), [
    "DATABASE_MIGRATION_URL",
    "DATABASE_URL",
    "LOG_LEVEL",
    "NODE_ENV",
    "PGBOSS_DATABASE_URL",
    "WORKER_DATABASE_URL",
  ]);
  assert.deepEqual([...maintenance].sort(), [
    "NODE_ENV",
    "REFUNDDESK_MAINTENANCE_DATABASE_URL",
    "REFUNDDESK_PURGE_PSEUDONYM_HMAC_KEY_V1",
    "REFUNDDESK_RETENTION_BATCH_SIZE",
    "REFUNDDESK_RETENTION_SCOPE",
  ]);
  for (const forbidden of [
    "DATABASE_URL",
    "WORKER_DATABASE_URL",
    "PGBOSS_DATABASE_URL",
    "DATABASE_MIGRATION_URL",
    "STRIPE_APP_SIGNING_SECRET",
    "STRIPE_PLATFORM_TEST_EFFECT_KEY",
    "STRIPE_MANAGED_SANDBOX_EFFECT_KEY",
    "REFUNDDESK_FIELD_ENCRYPTION_KEY_V1",
    "REFUNDDESK_PROOF_HMAC_KEY_V1",
    "REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V1",
  ]) {
    assert.equal(maintenance.has(forbidden), false, `maintenance contains ${forbidden}`);
  }
  for (const source of [platformSource, workerSource, migrationSource, maintenanceSource]) {
    assert.doesNotMatch(source, /(?:sk|rk)_live_|STRIPE_PLATFORM_TEST_KEY=/u);
  }
  assert.match(platformSource, /^REFUNDDESK_GLOBAL_LIVE_ENABLED=false$/mu);
  assert.match(workerSource, /^REFUNDDESK_GLOBAL_LIVE_ENABLED=false$/mu);
  assert.match(platformSource, /^REFUNDDESK_FIELD_KEY_ROTATION_STATE=legacy$/mu);
  assert.match(workerSource, /^REFUNDDESK_PROOF_KEY_ROTATION_STATE=legacy$/mu);
  assert.match(workerSource, /^REFUNDDESK_APPROVAL_ATTESTATION_KEY_ROTATION_STATE=legacy$/mu);
  assert.match(platformSource, /^STRIPE_ACCOUNT_LIVE_WEBHOOK_SECRET=disabled$/mu);
  for (const source of [platformSource, workerSource]) {
    assert.match(source, /^STRIPE_PLATFORM_TEST_ACCOUNT_ID=acct_[A-Za-z0-9]+$/mu);
    assert.match(source, /^STRIPE_MANAGED_SANDBOX_ACCOUNT_ID=acct_[A-Za-z0-9]+$/mu);
  }
  assert.match(
    postgresSource,
    /^POSTGRES_PASSWORD_FILE=\/run\/secrets\/postgres-owner-password$/mu,
  );
  assert.doesNotMatch(
    postgresSource,
    /(?:^|_)(?:PASSWORD|WEB_PASSWORD|WORKER_PASSWORD|QUEUE_PASSWORD|MAINTENANCE_PASSWORD)=/mu,
  );
  assert.doesNotMatch(
    serviceBlock(compose, "postgres"),
    /docker-entrypoint-initdb\.d|postgres-(?:web|worker|queue|maintenance)-password/u,
  );
  const bootstrap = serviceBlock(compose, "bootstrap");
  for (const name of ["owner", "web", "worker", "queue", "maintenance"]) {
    assert.match(bootstrap, new RegExp(`postgres-${name}-password`, "u"));
  }
  assert.match(bootstrapScript, /export PGSSLMODE=verify-full/u);
  assert.match(bootstrapScript, /REFUNDDESK_POSTGRES_MAINTENANCE_PASSWORD/u);
  assert.match(bootstrapScript, /--no-psqlrc/u);
  assert.match(bootstrapScript, /--set=ON_ERROR_STOP=1/u);
  assert.match(bootstrapSql, /^\\set ON_ERROR_STOP on$/mu);
  assert.equal((bootstrapSql.match(/RAISE EXCEPTION USING/gu) ?? []).length, 2);
  assert.match(bootstrapSql, /ERRCODE = '42501'/u);
  assert.match(bootstrapSql, /ERRCODE = '22023'/u);
  assert.doesNotMatch(bootstrapSql, /^\\(?:q|quit)(?:\s|$)/mu);
  assert.doesNotMatch(bootstrapSql, /\brefunddesk_(?:runtime|worker|queue)\b/u);
  assert.doesNotMatch(bootstrapSql, /\brefunddesk_attestation_writer\b/u);
  assert.match(
    bootstrapSql,
    /CREATE ROLE refunddesk_maintenance NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/u,
  );
  assert.match(bootstrapSql, /ALTER ROLE refunddesk_maintenance WITH NOLOGIN PASSWORD NULL/u);
  assert.match(bootstrapSql, /GRANT refunddesk_maintenance TO refunddesk_maintenance_login;/u);
  assert.match(
    bootstrapSql,
    /'REVOKE %I FROM refunddesk_maintenance'[\s\S]+WHERE member\.rolname = 'refunddesk_maintenance'/u,
  );
  assert.match(
    bootstrapSql,
    /'REVOKE refunddesk_maintenance_login FROM %I'[\s\S]+WHERE parent\.rolname = 'refunddesk_maintenance_login'/u,
  );
  assert.match(
    bootstrapSql,
    /REVOKE refunddesk_maintenance\s+FROM refunddesk_web_login, refunddesk_worker_login, refunddesk_queue_login;/u,
  );
  assert.match(bootstrapSql, /count\(DISTINCT password_value\) = 5/u);
  assert.match(bootstrapSql, /min\(length\(password_value\)\) >= 32/u);
  const firstRoleCreation = bootstrapSql.indexOf("CREATE ROLE refunddesk_maintenance");
  const sessionGuardAbort = bootstrapSql.indexOf(
    "RefundDesk database bootstrap session contract is invalid.",
  );
  const passwordGuardAbort = bootstrapSql.indexOf(
    "RefundDesk database password contract is invalid.",
  );
  assert.ok(
    sessionGuardAbort >= 0 &&
      passwordGuardAbort > sessionGuardAbort &&
      firstRoleCreation > passwordGuardAbort,
  );
  assert.equal((bootstrapSql.match(/CREATE ROLE refunddesk_[a-z]+_login LOGIN/gu) ?? []).length, 4);
});

test("release promotion requires revision-bound application key rotation history", async () => {
  const release = await read("scripts/release.sh");
  const transitionCheck = release.indexOf("check-key-rotation-transition.js");
  const candidateCreation = release.indexOf(
    "refunddesk_compose up \\\n  --no-start \\\n  --no-deps \\\n  --no-build \\\n  --pull never \\\n  --force-recreate \\\n  verifier worker web caddy",
  );
  const effectWorkerStart = release.indexOf("refunddesk_compose start worker web verifier");
  const deploymentVerification = release.indexOf(
    'bash "${SCRIPT_DIR}/verify-deployment.sh" --origin "${PUBLIC_ORIGIN}"',
  );
  const rotationStateWrite = release.lastIndexOf('--target "${ROTATION_STATE_FILE}"');
  const journalPrepare = release.lastIndexOf('python3 "${TRANSITION_HELPER}" prepare');
  const journalComplete = release.indexOf('python3 "${TRANSITION_HELPER}" complete');

  assert.notEqual(transitionCheck, -1);
  assert.notEqual(candidateCreation, -1);
  assert.notEqual(effectWorkerStart, -1);
  assert.notEqual(deploymentVerification, -1);
  assert.notEqual(rotationStateWrite, -1);
  assert.notEqual(journalPrepare, -1);
  assert.notEqual(journalComplete, -1);
  assert.ok(transitionCheck < candidateCreation);
  assert.ok(journalPrepare < candidateCreation);
  assert.ok(candidateCreation < effectWorkerStart);
  assert.ok(transitionCheck < effectWorkerStart);
  assert.ok(journalPrepare < effectWorkerStart);
  assert.ok(deploymentVerification < rotationStateWrite);
  assert.ok(rotationStateWrite < journalComplete);
  assert.match(release, /prove_candidate_created_contract/u);
  assert.match(
    release,
    /refunddesk_compose up[\s\S]+--no-start[\s\S]+--force-recreate[\s\S]+verifier worker web caddy[\s\S]+prove_candidate_created_contract/u,
  );
  assert.match(release, /prove_candidate_runtime_contract/u);
  assert.match(release, /REFUNDDESK_RUNTIME_RESTART_POLICY=no/u);
  assert.match(
    release,
    /REFUNDDESK_RUNTIME_RESTART_POLICY=no\\nREFUNDDESK_WORKER_RUNTIME_MODE=normal\\n/u,
  );
  assert.match(
    release,
    /prove_candidate_created_contract[\s\S]*assert_standard_worker_runtime_mode_from_inspection "\$\{inspection\}" NORMAL[\s\S]*refunddesk_compose start worker web verifier/u,
  );
  assert.match(
    release,
    /REFUNDDESK_IMAGE_TAG=sandbox-%s\\nREFUNDDESK_REVISION=%s\\nREFUNDDESK_WORKER_RUNTIME_MODE=normal\\n/u,
  );
  assert.match(release, /docker update --restart=unless-stopped/u);
  assert.match(release, /ACTIVE_REVISION_FOR_ROTATION/u);
  assert.match(release, /CURRENT_SOURCE_REVISION_FOR_ROTATION/u);
  assert.match(release, /RECORDED_ROTATION_REVISION/u);
  assert.match(release, /active revision marker and current source revision differ/u);
  assert.match(release, /application-key-rotation-state\.json/u);
  assert.match(release, /PREVIOUS_ROTATION_STATE_BACKUP/u);
  assert.match(release, /schemaVersion: 2/u);
  assert.match(release, /assert-union/u);
  assert.match(
    release,
    /key retirement is disabled until retained rows and backups prove old-key independence/u,
  );
});

test("same-revision releases recreate every fenced stateless runtime", async () => {
  const release = await read("scripts/release.sh");
  const candidateCommand = [
    "refunddesk_compose up \\",
    "  --no-start \\",
    "  --no-deps \\",
    "  --no-build \\",
    "  --pull never \\",
    "  --force-recreate \\",
    "  verifier worker web caddy",
  ].join("\n");
  const promotionStart = release.indexOf("PROMOTION_STARTED=true");
  const journalPrepare = release.indexOf('python3 "${TRANSITION_HELPER}" prepare', promotionStart);
  const armFence = release.indexOf("arm_release_fence", journalPrepare);
  const candidateCreation = release.indexOf(candidateCommand, journalPrepare);
  const candidateProof = release.indexOf("prove_candidate_created_contract", candidateCreation);
  const autosaveCleanup = release.indexOf("remove_caddy_autosave_residue", candidateProof);
  const lastFenceCheck = release.lastIndexOf("assert_release_fence_armed", candidateCreation);
  const runtimeAdmission = release.indexOf("enable_candidate_runtime", candidateProof);
  const candidateStart = release.indexOf(
    "refunddesk_compose start worker web verifier",
    runtimeAdmission,
  );
  const candidateBlock = release.slice(candidateCreation, candidateProof);

  assert.ok(promotionStart >= 0);
  assert.ok(journalPrepare > promotionStart);
  assert.ok(armFence > journalPrepare);
  assert.ok(lastFenceCheck > armFence);
  assert.ok(candidateCreation > lastFenceCheck);
  assert.ok(candidateProof > candidateCreation);
  assert.ok(autosaveCleanup > candidateProof);
  assert.ok(runtimeAdmission > autosaveCleanup);
  assert.ok(runtimeAdmission > candidateProof);
  assert.ok(candidateStart > runtimeAdmission);
  assert.equal(release.split(candidateCommand).length - 1, 1);
  assert.equal((release.match(/--force-recreate/gu) ?? []).length, 2);
  assert.equal(candidateBlock, `${candidateCommand}\n`);
  assert.doesNotMatch(candidateBlock, /postgres|--volumes/u);
  const autosaveContract = shellFunction(release, "remove_caddy_autosave_residue");
  assert.match(autosaveContract, /CADDY_AUTOSAVE_PATH/u);
  assert.match(autosaveContract, /! -L "\$\{CADDY_AUTOSAVE_PATH\}"/u);
  assert.match(autosaveContract, /rm -f -- "\$\{CADDY_AUTOSAVE_PATH\}"/u);
  assert.match(release, /CADDY_AUTOSAVE_PATH="\$\{CADDY_AUTOSAVE_DIRECTORY\}\/autosave\.json"/u);
});

test("stable launchers reject pre-contract targets and bind retention to the active source", async () => {
  const [
    contract,
    releaseLauncher,
    retentionLauncher,
    installSource,
    bootstrapHost,
    release,
    transitionHelper,
    retentionService,
    releaseFence,
  ] = await Promise.all([
    read("RELEASE_CONTRACT_VERSION"),
    read("scripts/release-launcher.sh"),
    read("scripts/retention-launcher.sh"),
    read("scripts/install-source.sh"),
    read("scripts/bootstrap-host.sh"),
    read("scripts/release.sh"),
    read("scripts/release-transition-journal.py"),
    read("systemd/refunddesk-retention.service"),
    read("scripts/release-fence.sh"),
  ]);

  assert.equal(contract, "2\n");
  assert.match(installSource, /deploy\/lightsail\/RELEASE_CONTRACT_VERSION/u);
  assert.match(installSource, /deploy\/lightsail\/scripts\/release-launcher\.sh/u);
  assert.match(installSource, /deploy\/lightsail\/scripts\/release-fence\.sh/u);
  assert.match(installSource, /deploy\/lightsail\/scripts\/backup-launcher\.sh/u);
  assert.match(installSource, /deploy\/lightsail\/scripts\/retention-launcher\.sh/u);
  assert.match(installSource, /control-plane-generations/u);
  assert.match(installSource, /requires_legacy_snapshot/u);
  assert.match(installSource, /python3 "\$\{CONTROL_PLANE_DURABILITY_HELPER\}" durable-symlink/u);
  assert.match(
    installSource,
    /--target "\$\{REFUNDDESK_CONTROL_PLANE_LINK\}"[\s\S]+--value "\$\{legacy_final\}"/u,
  );
  assert.doesNotMatch(installSource, /--value "\$\{target_generation\}"/u);
  assert.match(installSource, /\/usr\/local\/sbin\/refunddesk-release/u);
  assert.match(installSource, /\/usr\/local\/sbin\/refunddesk-release-fence/u);
  assert.match(installSource, /\/usr\/local\/sbin\/refunddesk-quiesce-recovery/u);
  for (const stablePath of [
    "/usr/local/sbin/refunddesk-release",
    "/usr/local/sbin/refunddesk-release-fence",
    "/usr/local/sbin/refunddesk-backup",
    "/usr/local/sbin/refunddesk-retention",
    "/usr/local/sbin/refunddesk-quiesce-recovery",
  ]) {
    assert.ok(bootstrapHost.includes(stablePath));
  }

  assert.match(releaseLauncher, /^readonly RELEASE_CONTRACT_VERSION="2"$/mu);
  assert.match(
    releaseLauncher,
    /target source does not implement release contract \$\{RELEASE_CONTRACT_VERSION\}/u,
  );
  assert.match(
    releaseLauncher,
    /unfinished release transition permits only its exact target revision/u,
  );
  const contractCheck = releaseLauncher.indexOf(
    "target source does not implement release contract",
  );
  const targetExecution = releaseLauncher.indexOf("exec systemd-run");
  assert.ok(contractCheck >= 0 && targetExecution > contractCheck);
  assert.match(releaseLauncher, /--property=KillMode=control-group/u);
  assert.match(releaseLauncher, /--property=Restart=no/u);
  assert.match(releaseLauncher, /REFUNDDESK_RELEASE_SYSTEMD_UNIT/u);

  assert.match(release, /release must be invoked by the stable host-side launcher/u);
  assert.match(release, /REFUNDDESK_RELEASE_LAUNCHER_CONTRACT/u);
  assert.match(
    release,
    /systemctl show "\$\{REFUNDDESK_RELEASE_SYSTEMD_UNIT\}" --property=MainPID/u,
  );
  assert.match(releaseFence, /observed_process_starttime/u);
  assert.match(releaseFence, /systemctl kill --kill-whom=all --signal=KILL/u);
  assert.match(
    releaseFence,
    /while \[\[ -e "\$\{TRANSITION_JOURNAL\}" \|\| -L "\$\{TRANSITION_JOURNAL\}" \]\]/u,
  );
  assert.match(releaseFence, /enforce_runtime_admission_once/u);
  assert.match(releaseFence, /database-owner-reservation/u);
  assert.match(releaseFence, /application-key-transition\.lock/u);
  assert.match(releaseFence, /flock --exclusive 8/u);
  assert.match(releaseFence, /flock --unlock 8/u);
  const enableCandidateRuntime = shellFunction(release, "enable_candidate_runtime");
  const admissionOpen = enableCandidateRuntime.indexOf("open_transition_journal_lock");
  const admissionLock = enableCandidateRuntime.indexOf("lock_transition_journal");
  const admissionPublish = enableCandidateRuntime.indexOf("mv --no-target-directory");
  const admissionUnlock = enableCandidateRuntime.indexOf("flock --unlock 8");
  const exactAdmissionProof = enableCandidateRuntime.indexOf("assert_candidate_runtime_admission");
  const admissionFenceProof = enableCandidateRuntime.indexOf("assert_release_fence_armed");
  assert.ok(
    admissionOpen >= 0 &&
      admissionLock > admissionOpen &&
      admissionPublish > admissionLock &&
      admissionUnlock > admissionPublish &&
      exactAdmissionProof > admissionUnlock &&
      admissionFenceProof > exactAdmissionProof,
  );
  assert.doesNotMatch(enableCandidateRuntime, /refunddesk_compose|docker/u);
  assert.match(
    shellFunction(release, "transition_journal_lock_descriptor_is_current"),
    /stat --format='%u:%g:%a'[\s\S]*stat --format='%d:%i'[\s\S]*\/proc\/self\/fd\/8/u,
  );
  assert.match(
    shellFunction(release, "lock_transition_journal"),
    /transition_journal_lock_descriptor_is_current[\s\S]*flock --exclusive 8[\s\S]*transition_journal_lock_descriptor_is_current/u,
  );
  assert.equal((release.match(/exec 8<>"\$\{TRANSITION_JOURNAL_LOCK\}"/gu) ?? []).length, 1);
  const finalCommitLock = release.lastIndexOf("lock_transition_journal");
  const finalCommit = release.lastIndexOf('python3 "${TRANSITION_HELPER}" complete');
  const finalCommitUnlock = release.lastIndexOf("flock --unlock 8");
  assert.ok(
    finalCommitLock >= 0 && finalCommit > finalCommitLock && finalCommitUnlock > finalCommit,
  );
  assert.match(
    release,
    /lock_transition_journal \|\|[\s\S]*python3 "\$\{TRANSITION_HELPER\}" complete[\s\S]*TRANSITION_COMMITTED=true[\s\S]*flock --unlock 8/u,
  );
  assert.match(
    releaseFence,
    /release transition journal is absent; release fence is already disarmed[\s\S]*remove_runtime_markers[\s\S]*exit 0/u,
  );
  for (const startupFailure of [
    "release transition journal is invalid or divergent before arming",
    "release process disappeared before the fence was armed",
    "release process identity changed before the fence was armed",
    "candidate runtime admission could not be enforced before arming",
  ]) {
    assert.match(
      releaseFence,
      new RegExp(
        `enter_emergency_fence "${startupFailure.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"`,
        "u",
      ),
    );
  }
  assert.doesNotMatch(
    releaseFence,
    /die "(?:release transition journal is absent|release transition journal is invalid or divergent|release process disappeared before the fence was armed|release process identity changed before the fence was armed|candidate runtime admission could not be enforced before arming)"/u,
  );
  assert.match(transitionHelper, /os\.O_EXCL/u);
  assert.match(transitionHelper, /os\.fsync\(stream\.fileno\(\)\)/u);
  assert.match(transitionHelper, /target key set does not preserve the prior key union/u);
  assert.match(retentionLauncher, /retention is blocked while a release transition is unfinished/u);
  assert.match(retentionLauncher, /active revision and current source differ/u);
  assert.match(
    retentionLauncher,
    /current source release contract is outside the supported range/u,
  );
  assert.match(retentionLauncher, /exec \/usr\/bin\/bash "\$\{runner\}"/u);
  assert.match(retentionService, /^ExecStart=\/usr\/local\/sbin\/refunddesk-retention$/mu);
  assert.doesNotMatch(retentionService, /^ConditionPathExists=/mu);
});

test("stable control-plane files switch through one crash-safe generation pointer", async () => {
  const [
    common,
    installSource,
    release,
    releaseLauncher,
    releaseFence,
    backupLauncher,
    retentionLauncher,
    recoveryLauncher,
  ] = await Promise.all([
    read("scripts/_common.sh"),
    read("scripts/install-source.sh"),
    read("scripts/release.sh"),
    read("scripts/release-launcher.sh"),
    read("scripts/release-fence.sh"),
    read("scripts/backup-launcher.sh"),
    read("scripts/retention-launcher.sh"),
    read("scripts/quiesce-recovery-launcher.sh"),
  ]);

  assert.match(
    common,
    /^readonly REFUNDDESK_CONTROL_PLANE_LINK="\$\{REFUNDDESK_ROOT\}\/control-plane-current"$/mu,
  );
  for (const requiredControlPath of [
    "scripts/release-launcher.sh",
    "scripts/release-fence.sh",
    "scripts/backup-launcher.sh",
    "scripts/retention-launcher.sh",
    "scripts/quiesce-recovery-launcher.sh",
    "systemd/refunddesk-backup.service",
    "systemd/refunddesk-backup.timer",
    "systemd/refunddesk-retention.service",
    "systemd/refunddesk-retention.timer",
    "systemd/refunddesk-quiesce-recovery.service",
  ]) {
    assert.match(
      installSource,
      new RegExp(requiredControlPath.replaceAll(".", "\\."), "u"),
      `missing generation member ${requiredControlPath}`,
    );
  }
  for (const requiredMode of [
    "scripts/release-launcher.sh|/usr/local/sbin/refunddesk-release|0755",
    "scripts/release-fence.sh|/usr/local/sbin/refunddesk-release-fence|0755",
    "scripts/backup-launcher.sh|/usr/local/sbin/refunddesk-backup|0755",
    "scripts/retention-launcher.sh|/usr/local/sbin/refunddesk-retention|0755",
    "scripts/quiesce-recovery-launcher.sh|/usr/local/sbin/refunddesk-quiesce-recovery|0755",
    "systemd/refunddesk-backup.service|/etc/systemd/system/refunddesk-backup.service|0644",
    "systemd/refunddesk-backup.timer|/etc/systemd/system/refunddesk-backup.timer|0644",
    "systemd/refunddesk-retention.service|/etc/systemd/system/refunddesk-retention.service|0644",
    "systemd/refunddesk-retention.timer|/etc/systemd/system/refunddesk-retention.timer|0644",
    "systemd/refunddesk-quiesce-recovery.service|/etc/systemd/system/refunddesk-quiesce-recovery.service|0644",
  ]) {
    assert.ok(
      common.includes(`"${requiredMode}"`),
      `missing exact source mode contract ${requiredMode}`,
    );
  }
  for (const consumer of [installSource, release]) {
    assert.match(consumer, /refunddesk_control_plane_mappings/u);
  }
  const sourceNormalization = installSource.indexOf(
    'normalize_source_control_plane_modes "${TEMP_SOURCE}"',
  );
  const sourceModeProof = installSource.indexOf(
    'assert_source_control_plane_modes "${TEMP_SOURCE}"',
    sourceNormalization,
  );
  const sourceDurability = installSource.indexOf(
    'python3 "${TEMP_DURABILITY_HELPER}" fsync-tree',
    sourceModeProof,
  );
  const sourcePublication = installSource.indexOf(
    'mv --no-target-directory -- "${TEMP_SOURCE}" "${FINAL_SOURCE}"',
    sourceDurability,
  );
  assert.ok(
    sourceNormalization >= 0 &&
      sourceModeProof > sourceNormalization &&
      sourceDurability > sourceModeProof &&
      sourcePublication > sourceDurability,
    "source modes must be normalized and proved before durability and publication",
  );
  const existingSourceBranch = installSource.indexOf(
    'if [[ -e "${FINAL_SOURCE}" || -L "${FINAL_SOURCE}" ]]; then',
  );
  const existingSourceModeProof = installSource.indexOf(
    'assert_source_control_plane_modes "${FINAL_SOURCE}"',
    existingSourceBranch,
  );
  const existingSourceHelper = installSource.indexOf(
    'DURABILITY_HELPER="${FINAL_SOURCE}/deploy/lightsail/scripts/release-transition-journal.py"',
    existingSourceModeProof,
  );
  const existingSourceReturn = installSource.indexOf("\n  exit 0", existingSourceHelper);
  assert.ok(
    existingSourceBranch >= 0 &&
      existingSourceModeProof > existingSourceBranch &&
      existingSourceHelper > existingSourceModeProof &&
      existingSourceReturn > existingSourceHelper,
    "an existing source must be validation-only and mode-proved before executing its helper",
  );
  assert.doesNotMatch(
    installSource.slice(existingSourceBranch, existingSourceReturn),
    /normalize_source_control_plane_modes/u,
  );
  const releaseModeProof = release.indexOf(
    'die "verified control-plane source ownership or mode differs: ${control_plane_relative}"',
  );
  const releasePointerSwitch = release.indexOf(
    '--target "${REFUNDDESK_CONTROL_PLANE_LINK}"',
    releaseModeProof,
  );
  const activeModeProof = release.indexOf(
    'die "active control-plane ownership or mode differs: ${installed_control_path}"',
    releasePointerSwitch,
  );
  assert.ok(
    releaseModeProof >= 0 &&
      releasePointerSwitch > releaseModeProof &&
      activeModeProof > releasePointerSwitch,
    "release must prove exact source modes before and after the control-plane pointer switch",
  );
  const snapshotSync = installSource.indexOf(
    'python3 "${CONTROL_PLANE_DURABILITY_HELPER}" fsync-tree',
  );
  const snapshotPublication = installSource.indexOf('--value "${legacy_final}"', snapshotSync);
  const stableConversion = installSource.indexOf('--target "${stable_path}"', snapshotPublication);
  assert.ok(
    snapshotSync >= 0 &&
      snapshotPublication > snapshotSync &&
      stableConversion > snapshotPublication,
  );
  assert.match(installSource, /active release bridge cannot invoke release-contract-2 targets/u);
  assert.match(
    installSource,
    /active release-fence bridge cannot protect a contract-2 transition/u,
  );
  assert.doesNotMatch(installSource, /systemctl stop refunddesk-(?:backup|retention)\.timer/u);

  for (const launcher of [
    releaseLauncher,
    releaseFence,
    backupLauncher,
    retentionLauncher,
    recoveryLauncher,
  ]) {
    assert.match(launcher, /control-plane-current/u);
    assert.match(launcher, /control-plane-generations/u);
  }
  const verifiedGeneration = release.lastIndexOf('--target "${REFUNDDESK_CONTROL_PLANE_LINK}"');
  const transitionCommit = release.lastIndexOf('python3 "${TRANSITION_HELPER}" complete');
  assert.ok(verifiedGeneration >= 0 && transitionCommit > verifiedGeneration);
});

test("release accepts only exact-depth controlled generation roots", async (t) => {
  const release = await read("scripts/release.sh");
  const validator = shellFunction(release, "assert_control_plane_generation_root");
  assert.match(validator, /\^\[0-9a-f\]\{40\}\$/u);
  assert.match(validator, /"\$\{generation\}" != \*\/\*/u);
  assert.match(validator, /"\$\{revision\}\/source\/deploy\/lightsail"/u);

  if (process.platform === "win32") {
    t.skip("Linux CI executes the shell-function cases");
    return;
  }
  const bash = spawnSync("bash", ["--version"], { encoding: "utf8" });
  if (bash.error?.code === "ENOENT" || bash.status !== 0) {
    t.skip("bash is unavailable on this host; CI executes the shell-function cases");
    return;
  }

  const runValidator = (candidate) =>
    spawnSync(
      "bash",
      [
        "-c",
        `set -Eeuo pipefail
readonly REFUNDDESK_ROOT=/opt/refunddesk
die() { exit 1; }
${validator}
assert_control_plane_generation_root "$1"`,
        "bash",
        candidate,
      ],
      { encoding: "utf8" },
    );
  const revision = "a".repeat(40);
  for (const accepted of [
    "/opt/refunddesk/control-plane-generations/bridge-test",
    `/opt/refunddesk/releases/${revision}/source/deploy/lightsail`,
  ]) {
    assert.equal(runValidator(accepted).status, 0, accepted);
  }
  for (const rejected of [
    "/opt/refunddesk/control-plane-generations/nested/escape",
    "/opt/refunddesk/control-plane-generations/",
    "/opt/refunddesk/releases/not-a-revision/source/deploy/lightsail",
    `/opt/refunddesk/releases/${revision}/source/deploy/lightsail/extra`,
    "/opt/refunddesk/outside",
  ]) {
    assert.notEqual(runValidator(rejected).status, 0, rejected);
  }
});

test("backup scheduling activates only after strict configuration validation", async () => {
  const [bootstrapHost, installSource, release, helper] = await Promise.all([
    read("scripts/bootstrap-host.sh"),
    read("scripts/install-source.sh"),
    read("scripts/release.sh"),
    read("scripts/release-transition-journal.py"),
  ]);
  for (const source of [bootstrapHost, release]) {
    assert.match(source, /validate-backup/u);
    assert.match(source, /sync-systemd-wants/u);
    assert.match(source, /systemctl start refunddesk-backup\.timer/u);
    assert.match(source, /systemctl stop refunddesk-backup\.timer/u);
  }
  for (const source of [bootstrapHost, installSource, release]) {
    assert.doesNotMatch(
      source,
      /systemctl (?:enable|disable)(?: --now)? refunddesk-/u,
      "RefundDesk unit activation must not let systemctl recanonicalize a stable wants link",
    );
    assert.doesNotMatch(source, /systemctl is-enabled[^\n]*refunddesk-/u);
  }
  const wantsDirectoryContract = shellFunction(
    bootstrapHost,
    "bootstrap_ensure_systemd_wants_directory",
  );
  assert.match(wantsDirectoryContract, /! -e "\$\{wants_directory\}"/u);
  assert.match(wantsDirectoryContract, /! -L "\$\{wants_directory\}"/u);
  assert.match(wantsDirectoryContract, /install -d -o root -g root -m 0755/u);
  assert.match(wantsDirectoryContract, /fsync-directory/u);
  assert.match(wantsDirectoryContract, /8#022/u);
  const firstWantsDirectory = bootstrapHost.indexOf(
    "bootstrap_ensure_systemd_wants_directory",
    bootstrapHost.indexOf("BOOTSTRAP_QUIESCE_WANTS="),
  );
  const firstBootstrapWantsMutation = bootstrapHost.indexOf(
    "bootstrap_sync_systemd_wants",
    firstWantsDirectory,
  );
  assert.ok(firstWantsDirectory >= 0 && firstBootstrapWantsMutation > firstWantsDirectory);

  assert.match(bootstrapHost, /bootstrap_systemd_unit_property FragmentPath/u);
  assert.match(bootstrapHost, /bootstrap_systemd_unit_property NeedDaemonReload/u);
  assert.match(installSource, /--property=FragmentPath --value/u);
  assert.match(installSource, /--property=NeedDaemonReload --value/u);
  for (const source of [bootstrapHost, installSource]) {
    assert.match(source, /stat --dereference --format='%u:%g:%a'/u);
  }
  const bootstrapReload = bootstrapHost.lastIndexOf("systemctl daemon-reload");
  const bootstrapPostReload = bootstrapHost.slice(bootstrapReload);
  assert.match(bootstrapPostReload, /refunddesk-backup\.service/u);
  assert.match(bootstrapPostReload, /refunddesk-retention\.service/u);
  assert.equal((bootstrapPostReload.match(/bootstrap_prove_systemd_unit_state/gu) ?? []).length, 4);
  for (const managedUnit of [
    "BOOTSTRAP_QUIESCE_UNIT",
    "BOOTSTRAP_RETENTION_UNIT",
    "BOOTSTRAP_BACKUP_UNIT",
  ]) {
    assert.match(bootstrapPostReload, new RegExp(`\\$\\{${managedUnit}\\}`, "u"));
  }
  const installReload = installSource.lastIndexOf("systemctl daemon-reload");
  const installPostReload = installSource.slice(installReload);
  assert.match(installPostReload, /for mapping in "\$\{control_plane_mappings\[@\]\}"/u);
  assert.match(installPostReload, /systemd\/\*/u);
  assert.match(installPostReload, /installed systemd fragment state is unproven/u);
  assert.match(helper, /def validate_backup\(/u);
  assert.match(helper, /def sync_systemd_wants\(/u);
  assert.match(helper, /def assert_controlled_generation_unit\(/u);
  assert.match(helper, /predecessor differs from the active stable unit/u);
  assert.match(helper, /stable systemd unit changed while removing wants entry/u);
  assert.match(helper, /set\(values\) != expected_names/u);
  assert.match(helper, /backup environment binding is invalid/u);
  const finalizationLock = release.lastIndexOf("flock --exclusive 8");
  const restartProof = release.indexOf("restore_runtime_restart_policies", finalizationLock);
  const systemdReload = release.indexOf("systemctl daemon-reload", restartProof);
  const durableCommit = release.indexOf('python3 "${TRANSITION_HELPER}" complete', systemdReload);
  const transitionCommitted = release.indexOf("TRANSITION_COMMITTED=true", durableCommit);
  const retentionActivation = release.indexOf(
    "systemctl start refunddesk-retention.timer",
    transitionCommitted,
  );
  const backupActivation = release.indexOf(
    "systemctl start refunddesk-backup.timer",
    retentionActivation,
  );
  const finalizationUnlock = release.indexOf("flock --unlock 8", backupActivation);
  const fenceDisarm = release.indexOf("wait_for_release_fence_disarm", finalizationUnlock);
  assert.ok(
    finalizationLock >= 0 &&
      restartProof > finalizationLock &&
      systemdReload > restartProof &&
      durableCommit > systemdReload &&
      transitionCommitted > durableCommit &&
      retentionActivation > transitionCommitted &&
      backupActivation > retentionActivation &&
      finalizationUnlock > backupActivation &&
      fenceDisarm > finalizationUnlock,
  );
  const postCommitFailure = release.indexOf(
    '[[ "${PROMOTION_STARTED}" == "true" && "${PROMOTION_COMPLETE}" != "true" ]]',
  );
  const maintenanceStop = release.indexOf("refunddesk-backup.service", postCommitFailure);
  const runtimeStop = release.indexOf(
    "refunddesk_compose stop --timeout 45 caddy web verifier worker",
    postCommitFailure,
  );
  assert.ok(
    postCommitFailure >= 0 && maintenanceStop > postCommitFailure && runtimeStop > maintenanceStop,
    "post-commit failure must stop maintenance before the effect-capable runtime",
  );

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "refunddesk-backup-configuration-"));
  const environment = join(temporaryDirectory, "backup.env");
  const awsConfig = join(temporaryDirectory, "config");
  const runHelper = () =>
    spawnSync(
      "python3",
      [
        resolve(directory, "scripts/release-transition-journal.py"),
        "validate-backup",
        "--environment",
        environment,
        "--aws-config",
        awsConfig,
      ],
      { encoding: "utf8", windowsHide: true },
    );

  try {
    await writeFile(awsConfig, "[default]\nregion=eu-west-3\n", { mode: 0o600 });
    await writeFile(
      environment,
      [
        "REFUNDDESK_BACKUP_BUCKET=refunddesk-sandbox-backups",
        "REFUNDDESK_BACKUP_AGE_RECIPIENT=age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
        "REFUNDDESK_BACKUP_PREFIX=refunddesk-sandbox/postgres/",
        "REFUNDDESK_BACKUP_RETENTION_COUNT=7",
        `AWS_CONFIG_FILE=${awsConfig}`,
        "AWS_REGION=eu-west-3",
        "AWS_DEFAULT_REGION=eu-west-3",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const valid = runHelper();
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /"status": "backup-valid"/u);

    await writeFile(
      environment,
      `${await readFile(environment, "utf8")}UNEXPECTED_COMMAND=$(id)\n`,
      { mode: 0o600 },
    );
    const executableConfiguration = runHelper();
    assert.notEqual(executableConfiguration.status, 0);
    assert.match(executableConfiguration.stderr, /RELEASE_TRANSITION_CONTRACT_INVALID/u);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("systemd wants synchronization survives a control-plane switch and rejects unsafe predecessors", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows symlink ownership differs; Linux CI executes this contract");
    return;
  }
  const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (python.error?.code === "ENOENT" || python.status !== 0) {
    t.skip("python3 is unavailable on this host; CI executes this functional contract");
    return;
  }

  const helper = resolve(directory, "scripts/release-transition-journal.py");
  const temporaryDirectory = await realpath(
    await mkdtemp(join(tmpdir(), "refunddesk-systemd-wants-")),
  );
  const controlRoot = join(temporaryDirectory, "refunddesk");
  const generationRoot = join(controlRoot, "control-plane-generations");
  const legacyGeneration = join(generationRoot, "legacy-test");
  const bridgeGeneration = join(generationRoot, "bridge-test");
  const targetGeneration = join(generationRoot, "target-test");
  const controlPlaneLink = join(controlRoot, "control-plane-current");
  const systemdRoot = join(temporaryDirectory, "etc", "systemd", "system");
  const wantsRoot = join(systemdRoot, "timers.target.wants");
  const unitName = "refunddesk-retention.timer";
  const stableUnit = join(systemdRoot, unitName);
  const wantsPath = join(wantsRoot, unitName);
  const stableTarget = join(controlPlaneLink, "systemd", unitName);
  const legacyUnit = join(legacyGeneration, "systemd", unitName);
  const bridgeUnit = join(bridgeGeneration, "systemd", unitName);
  const targetUnit = join(targetGeneration, "systemd", unitName);
  const unitBytes = "[Unit]\nDescription=RefundDesk test timer\n";

  const runHelper = (activeUnit, state, restoreTarget) => {
    const arguments_ = [
      helper,
      "sync-systemd-wants",
      "--wants",
      wantsPath,
      "--stable-unit",
      stableUnit,
      "--stable-target",
      stableTarget,
      "--active-unit",
      activeUnit,
      "--control-root",
      controlRoot,
      "--state",
      state,
    ];
    if (restoreTarget !== undefined) {
      arguments_.push("--restore-target", restoreTarget);
    }
    return spawnSync("python3", arguments_, {
      encoding: "utf8",
      windowsHide: true,
    });
  };

  try {
    for (const path of [
      join(legacyGeneration, "systemd"),
      join(bridgeGeneration, "systemd"),
      join(targetGeneration, "systemd"),
      wantsRoot,
    ]) {
      await mkdir(path, { mode: 0o755, recursive: true });
    }
    for (const unit of [legacyUnit, bridgeUnit, targetUnit]) {
      await writeFile(unit, unitBytes, { mode: 0o644 });
    }
    await symlink(bridgeGeneration, controlPlaneLink, "dir");
    await symlink(stableTarget, stableUnit);
    await symlink(legacyUnit, wantsPath);

    const verifiedPredecessor = runHelper(bridgeUnit, "unchanged");
    assert.equal(verifiedPredecessor.status, 0, verifiedPredecessor.stderr);
    const synchronized = runHelper(bridgeUnit, "present");
    assert.equal(synchronized.status, 0, synchronized.stderr);
    assert.equal(await readlink(wantsPath), stableUnit);
    assert.equal(await realpath(wantsPath), bridgeUnit);

    await unlink(controlPlaneLink);
    await symlink(targetGeneration, controlPlaneLink, "dir");
    assert.equal(await realpath(wantsPath), targetUnit);

    const restoredPredecessor = runHelper(targetUnit, "restore-present", legacyUnit);
    assert.equal(restoredPredecessor.status, 0, restoredPredecessor.stderr);
    assert.equal(await readlink(wantsPath), legacyUnit);
    assert.equal(await realpath(wantsPath), legacyUnit);

    const restoredAbsent = runHelper(targetUnit, "restore-absent");
    assert.equal(restoredAbsent.status, 0, restoredAbsent.stderr);
    await assert.rejects(lstat(wantsPath), { code: "ENOENT" });
    assert.equal((await lstat(stableUnit)).isSymbolicLink(), true);
    assert.equal(await realpath(stableUnit), targetUnit);

    const synchronizedAgain = runHelper(targetUnit, "present");
    assert.equal(synchronizedAgain.status, 0, synchronizedAgain.stderr);
    const removed = runHelper(targetUnit, "absent");
    assert.equal(removed.status, 0, removed.stderr);
    await assert.rejects(lstat(wantsPath), { code: "ENOENT" });
    assert.equal((await lstat(stableUnit)).isSymbolicLink(), true);
    assert.equal(await realpath(stableUnit), targetUnit);

    const foreignUnit = join(temporaryDirectory, "foreign", unitName);
    await mkdir(dirname(foreignUnit), { mode: 0o755, recursive: true });
    await writeFile(foreignUnit, unitBytes, { mode: 0o644 });
    await symlink(foreignUnit, wantsPath);
    const escaped = runHelper(targetUnit, "unchanged");
    assert.notEqual(escaped.status, 0);
    assert.match(escaped.stderr, /RELEASE_TRANSITION_CONTRACT_INVALID/u);
    assert.equal(await readlink(wantsPath), foreignUnit);
    await unlink(wantsPath);

    const divergentGeneration = join(generationRoot, "divergent-test");
    const divergentUnit = join(divergentGeneration, "systemd", unitName);
    await mkdir(dirname(divergentUnit), { mode: 0o755, recursive: true });
    await writeFile(divergentUnit, `${unitBytes}OnFailure=unsafe.service\n`, { mode: 0o644 });
    await symlink(divergentUnit, wantsPath);
    const divergent = runHelper(targetUnit, "unchanged");
    assert.notEqual(divergent.status, 0);
    assert.match(divergent.stderr, /RELEASE_TRANSITION_CONTRACT_INVALID/u);
    assert.equal(await readlink(wantsPath), divergentUnit);
    await unlink(wantsPath);

    const nestedGeneration = join(generationRoot, "nested", "invalid-test");
    const nestedUnit = join(nestedGeneration, "systemd", unitName);
    await mkdir(dirname(nestedUnit), { mode: 0o755, recursive: true });
    await writeFile(nestedUnit, unitBytes, { mode: 0o644 });
    await symlink(nestedUnit, wantsPath);
    const nested = runHelper(targetUnit, "unchanged");
    assert.notEqual(nested.status, 0);
    assert.match(nested.stderr, /RELEASE_TRANSITION_CONTRACT_INVALID/u);
    assert.equal(await readlink(wantsPath), nestedUnit);
    await unlink(wantsPath);

    const unsafeModeGeneration = join(generationRoot, "unsafe-mode-test");
    const unsafeModeUnit = join(unsafeModeGeneration, "systemd", unitName);
    await mkdir(dirname(unsafeModeUnit), { mode: 0o755, recursive: true });
    await writeFile(unsafeModeUnit, unitBytes, { mode: 0o644 });
    await chmod(unsafeModeUnit, 0o600);
    await symlink(unsafeModeUnit, wantsPath);
    const unsafeMode = runHelper(targetUnit, "unchanged");
    assert.notEqual(unsafeMode.status, 0);
    assert.match(unsafeMode.stderr, /RELEASE_TRANSITION_CONTRACT_INVALID/u);
    assert.equal(await readlink(wantsPath), unsafeModeUnit);
    await unlink(wantsPath);

    const relativeTarget = "relative-refunddesk-retention.timer";
    await symlink(relativeTarget, wantsPath);
    const relative = runHelper(targetUnit, "unchanged");
    assert.notEqual(relative.status, 0);
    assert.match(relative.stderr, /RELEASE_TRANSITION_CONTRACT_INVALID/u);
    assert.equal(await readlink(wantsPath), relativeTarget);
    await unlink(wantsPath);

    const danglingTarget = join(generationRoot, "missing-test", "systemd", unitName);
    await symlink(danglingTarget, wantsPath);
    const dangling = runHelper(targetUnit, "unchanged");
    assert.notEqual(dangling.status, 0);
    assert.match(dangling.stderr, /RELEASE_TRANSITION_CONTRACT_INVALID/u);
    assert.equal(await readlink(wantsPath), danglingTarget);
    await unlink(wantsPath);

    await writeFile(wantsPath, unitBytes, { mode: 0o644 });
    const regularEntry = runHelper(targetUnit, "unchanged");
    assert.notEqual(regularEntry.status, 0);
    assert.match(regularEntry.stderr, /RELEASE_TRANSITION_CONTRACT_INVALID/u);
    assert.equal(await readFile(wantsPath, "utf8"), unitBytes);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("source installation restores executable control-plane modes after restrictive extraction", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows does not preserve POSIX chmod bits; Linux CI executes this contract");
    return;
  }
  const version = spawnSync("bash", ["--version"], { encoding: "utf8" });
  if (version.error?.code === "ENOENT" || version.status !== 0) {
    t.skip("bash is unavailable on this host; CI executes this functional contract");
    return;
  }

  const [common, installSource] = await Promise.all([
    read("scripts/_common.sh"),
    read("scripts/install-source.sh"),
  ]);
  const mappings = shellFunction(common, "refunddesk_control_plane_mappings");
  const normalize = shellFunction(installSource, "normalize_source_control_plane_modes");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "refunddesk-source-modes-"));
  const expectedModes = new Map([
    ["scripts/release-launcher.sh", 0o755],
    ["scripts/release-fence.sh", 0o755],
    ["scripts/backup-launcher.sh", 0o755],
    ["scripts/retention-launcher.sh", 0o755],
    ["scripts/quiesce-recovery-launcher.sh", 0o755],
    ["systemd/refunddesk-backup.service", 0o644],
    ["systemd/refunddesk-backup.timer", 0o644],
    ["systemd/refunddesk-retention.service", 0o644],
    ["systemd/refunddesk-retention.timer", 0o644],
    ["systemd/refunddesk-quiesce-recovery.service", 0o644],
  ]);

  try {
    for (const relativePath of expectedModes.keys()) {
      const target = join(temporaryDirectory, "deploy", "lightsail", relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, "fixture\n", { mode: 0o600 });
    }

    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -Eeuo pipefail
umask 077
STABLE_RELEASE_LAUNCHER=/tmp/refunddesk-release
STABLE_RELEASE_FENCE=/tmp/refunddesk-release-fence
STABLE_BACKUP_LAUNCHER=/tmp/refunddesk-backup
STABLE_RETENTION_LAUNCHER=/tmp/refunddesk-retention
STABLE_RECOVERY_LAUNCHER=/tmp/refunddesk-quiesce-recovery
die() { printf '%s\\n' "$*" >&2; exit 1; }
assert_regular_file() { [[ -f "$1" && ! -L "$1" ]] || die "not a regular file: $1"; }
${mappings}
${normalize}
normalize_source_control_plane_modes "$1"`,
        "bash",
        temporaryDirectory,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);

    for (const [relativePath, expectedMode] of expectedModes) {
      const metadata = await lstat(join(temporaryDirectory, "deploy", "lightsail", relativePath));
      assert.equal(
        metadata.mode & 0o777,
        expectedMode,
        `${relativePath} did not receive its exact operational mode`,
      );
    }
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("release rollback preserves the recoverable metadata lattice", async () => {
  const release = await read("scripts/release.sh");
  const rollbackStart = release.indexOf("fail_closed() {");
  const rollbackEnd = release.indexOf("trap fail_closed EXIT", rollbackStart);
  assert.ok(rollbackStart >= 0 && rollbackEnd > rollbackStart);
  const rollback = release.slice(rollbackStart, rollbackEnd);

  assert.match(rollback, /local metadata_rollback_ok=true/u);
  assert.equal(
    (rollback.match(/\[\[ "\$\{metadata_rollback_ok\}" == "true" \]\]/gu) ?? []).length,
    7,
  );
  assert.ok((rollback.match(/metadata_rollback_ok=false/gu) ?? []).length >= 7);

  const controlPlaneRollback = rollback.indexOf('--target "${REFUNDDESK_CONTROL_PLANE_LINK}"');
  const wantsRollback = rollback.indexOf("restore_release_systemd_wants");
  const daemonReloadRollback = rollback.indexOf("systemctl daemon-reload", wantsRollback);
  const rotationRollback = rollback.indexOf('--target "${ROTATION_STATE_FILE}"');
  const currentRollback = rollback.indexOf('--target "${REFUNDDESK_ROOT}/current"');
  const activeRollback = rollback.indexOf('--target "${REFUNDDESK_ROOT}/ACTIVE_REVISION"');
  const environmentRollback = rollback.indexOf('--target "${REFUNDDESK_RELEASE_ENV}"');
  assert.ok(
    controlPlaneRollback >= 0 &&
      wantsRollback > controlPlaneRollback &&
      daemonReloadRollback > wantsRollback &&
      rotationRollback > daemonReloadRollback &&
      currentRollback > rotationRollback &&
      activeRollback > currentRollback &&
      environmentRollback > activeRollback,
  );
  assert.match(rollback, /SYSTEMD_DAEMON_RELOAD_ATTEMPTED/u);
  assert.match(rollback, /PREVIOUS_QUIESCE_WANTS_TARGET/u);
  assert.match(rollback, /PREVIOUS_RETENTION_WANTS_TARGET/u);
  assert.match(rollback, /PREVIOUS_BACKUP_WANTS_TARGET/u);
  assert.match(rollback, /preserving root-only recovery artifact after incomplete rollback/u);
  const journalRetirementGuard = [
    '  if [[ "${TRANSITION_COMMITTED}" != "true" &&',
    '    "${metadata_rollback_ok}" == "true" &&',
    '    "${candidate_runtime_stopped}" == "true" ]] &&',
    '    [[ -e "${TRANSITION_JOURNAL_FILE}" || -L "${TRANSITION_JOURNAL_FILE}" ]]; then',
    '    if python3 "${TRANSITION_HELPER}" durable-unlink \\',
    '      --target "${TRANSITION_JOURNAL_FILE}" >/dev/null; then',
  ].join("\n");
  assert.equal(rollback.split(journalRetirementGuard).length - 1, 1);
  assert.match(
    rollback,
    /after diagnosis, recreate the runtime at \$\{ACTIVE_REVISION_FOR_ROTATION\}:[^\n]+--force-recreate verifier worker web caddy/u,
  );
  assert.match(
    rollback,
    /then rerun only the exact authorized release command; the rollback leaves the runtime stopped/u,
  );
  assert.doesNotMatch(rollback, /refunddesk_compose up/u);
  assert.match(
    rollback,
    /if \[\[ "\$\{TRANSITION_COMMITTED\}" == "true" \]\]; then[\s\S]+rm -f -- "\$\{PREVIOUS_RELEASE_ENV_BACKUP\}"/u,
  );

  const mainStart = release.indexOf("PROMOTION_STARTED=true", rollbackEnd);
  const quiescence = release.indexOf("fence_target_candidates", mainStart);
  const journalPrepare = release.indexOf('python3 "${TRANSITION_HELPER}" prepare', mainStart);
  const admission = release.indexOf("enable_candidate_runtime", journalPrepare);
  const runtimeStart = release.indexOf("refunddesk_compose start worker web verifier", admission);
  const restartRestoration = release.indexOf("restore_runtime_restart_policies", runtimeStart);
  const wantsCapture = release.indexOf("capture_release_systemd_wants", runtimeStart);
  const wantsChanged = release.indexOf("SYSTEMD_WANTS_CHANGED=true", wantsCapture);
  const firstWantsMutation = release.indexOf("sync_release_systemd_wants", wantsChanged);
  const pointerChanged = release.indexOf("CONTROL_PLANE_LINK_CHANGED=true", firstWantsMutation);
  const pointerSwitch = release.indexOf(
    '--target "${REFUNDDESK_CONTROL_PLANE_LINK}"',
    pointerChanged,
  );
  const reloadAttempted = release.indexOf("SYSTEMD_DAEMON_RELOAD_ATTEMPTED=true", pointerSwitch);
  const systemdReload = release.indexOf("systemctl daemon-reload", reloadAttempted);
  const journalComplete = release.indexOf(
    'python3 "${TRANSITION_HELPER}" complete',
    restartRestoration,
  );
  assert.ok(
    mainStart >= 0 &&
      quiescence > mainStart &&
      journalPrepare > quiescence &&
      admission > journalPrepare &&
      runtimeStart > admission &&
      wantsCapture > runtimeStart &&
      wantsChanged > wantsCapture &&
      firstWantsMutation > wantsChanged &&
      pointerChanged > firstWantsMutation &&
      pointerSwitch > pointerChanged &&
      restartRestoration > pointerSwitch &&
      reloadAttempted > pointerSwitch &&
      reloadAttempted > restartRestoration &&
      systemdReload > reloadAttempted &&
      journalComplete > systemdReload,
  );
  assert.match(
    rollback,
    /systemd_rollback_reload_required=true[\s\S]*restore_release_systemd_wants[\s\S]*systemctl daemon-reload/u,
  );
});

test("transition journal blocks divergence after a simulated kill before commit", async () => {
  const helper = resolve(directory, "scripts/release-transition-journal.py");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "refunddesk-release-transition-"));
  const journal = join(temporaryDirectory, "transition.json");
  const commitMarker = join(temporaryDirectory, "committed.json");
  const candidate = join(temporaryDirectory, "candidate.json");
  const divergent = join(temporaryDirectory, "divergent.json");
  const previousFingerprints = join(temporaryDirectory, "previous-fingerprints.json");
  const targetFingerprints = join(temporaryDirectory, "target-fingerprints.json");
  const replacedFingerprints = join(temporaryDirectory, "replaced-fingerprints.json");
  const fingerprintA = `sha256:${"a".repeat(64)}`;
  const fingerprintB = `sha256:${"b".repeat(64)}`;
  const fingerprintC = `sha256:${"c".repeat(64)}`;
  const fingerprintD = `sha256:${"d".repeat(64)}`;
  const revisionA = "1".repeat(40);
  const revisionB = "2".repeat(40);
  const revisionC = "3".repeat(40);
  const fingerprints = (v1, v2) => ({
    approvalAttestation: { v1, v2 },
    field: { v1, v2 },
    proof: { v1, v2 },
  });
  const transition = {
    from: {
      fingerprints: fingerprints(fingerprintA, null),
      recorded: false,
      revision: revisionA,
      states: {
        approvalAttestation: "legacy",
        field: "legacy",
        proof: "legacy",
      },
    },
    schemaVersion: 1,
    status: "in_progress",
    to: {
      fingerprints: {
        approvalAttestation: { v1: fingerprintA, v2: fingerprintB },
        field: { v1: fingerprintA, v2: fingerprintC },
        proof: { v1: fingerprintA, v2: fingerprintD },
      },
      recorded: true,
      revision: revisionB,
      states: {
        approvalAttestation: "staged",
        field: "staged",
        proof: "staged",
      },
    },
  };
  const runHelper = (...arguments_) =>
    spawnSync("python3", [helper, ...arguments_], {
      encoding: "utf8",
      windowsHide: true,
    });

  try {
    await writeFile(previousFingerprints, `${JSON.stringify(transition.from.fingerprints)}\n`, {
      mode: 0o600,
    });
    await writeFile(targetFingerprints, `${JSON.stringify(transition.to.fingerprints)}\n`, {
      mode: 0o600,
    });
    const union = runHelper(
      "assert-union",
      "--previous",
      previousFingerprints,
      "--target",
      targetFingerprints,
    );
    assert.equal(union.status, 0, union.stderr);
    await writeFile(
      replacedFingerprints,
      `${JSON.stringify({
        ...transition.to.fingerprints,
        field: { ...transition.to.fingerprints.field, v1: fingerprintB },
      })}\n`,
      { mode: 0o600 },
    );
    const replaced = runHelper(
      "assert-union",
      "--previous",
      previousFingerprints,
      "--target",
      replacedFingerprints,
    );
    assert.notEqual(replaced.status, 0);

    await writeFile(candidate, `${JSON.stringify(transition)}\n`, { mode: 0o600 });
    const prepared = runHelper("prepare", "--path", journal, "--candidate", candidate);
    assert.equal(prepared.status, 0, prepared.stderr);

    // Simulated SIGKILL after services-up: deliberately omit the complete command.
    await writeFile(join(temporaryDirectory, "services-up"), "true\n");
    await writeFile(
      divergent,
      `${JSON.stringify({
        ...transition,
        to: { ...transition.to, revision: revisionC },
      })}\n`,
      { mode: 0o600 },
    );
    const rejected = runHelper("prepare", "--path", journal, "--candidate", divergent);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /RELEASE_TRANSITION_CONTRACT_INVALID/u);

    const resumed = runHelper("prepare", "--path", journal, "--candidate", candidate);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stdout, /"status": "resumed"/u);

    const committed = runHelper(
      "complete",
      "--path",
      journal,
      "--candidate",
      candidate,
      "--commit-marker",
      commitMarker,
    );
    assert.equal(committed.status, 0, committed.stderr);
    await assert.rejects(readFile(journal), { code: "ENOENT" });
    const committedMetadata = await lstat(commitMarker);
    assert.equal(committedMetadata.isFile(), true);
    if (process.platform !== "win32") {
      assert.equal(committedMetadata.uid, process.geteuid());
      assert.equal(committedMetadata.mode & 0o777, 0o600);
    }
    const committedState = JSON.parse(await readFile(commitMarker, "utf8"));
    assert.equal(committedState.status, "committed");
    assert.equal(committedState.to.revision, revisionB);
    const assertedCommit = runHelper(
      "assert-commit",
      "--marker",
      commitMarker,
      "--candidate",
      candidate,
    );
    assert.equal(assertedCommit.status, 0, assertedCommit.stderr);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("internal PKI provisioning is initial-only and preserves exact TLS identities", async () => {
  const provisionPki = await read("scripts/provision-internal-pki.sh");

  assert.match(provisionPki, /^readonly POSTGRES_DNS_NAME="postgres\.refunddesk\.internal"$/mu);
  assert.match(provisionPki, /^readonly VERIFIER_DNS_NAME="verifier\.refunddesk\.internal"$/mu);
  assert.match(provisionPki, /^readonly SERVER_VALID_DAYS=365$/mu);
  assert.match(provisionPki, /rsa_keygen_bits:3072/gu);
  assert.match(provisionPki, /extendedKeyUsage=serverAuth/gu);
  assert.match(provisionPki, /subjectAltName=DNS:\$\{dns_name\}/u);
  assert.match(provisionPki, /-verify_hostname "\$\{dns_name\}"/u);
  assert.match(
    provisionPki,
    /refusing to overwrite existing TLS material in \$\{TLS_ROOT\}\/\$\{name\}/u,
  );

  assert.match(provisionPki, /install -o 999 -g 999 -m 0400[\s\S]*postgres-server\.key/u);
  assert.match(provisionPki, /install -o 1000 -g 1000 -m 0400[\s\S]*verifier-server\.key/u);
  assert.match(
    provisionPki,
    /assert_file_metadata "\$\{root\}\/client\/refunddesk-ca-bundle\.crt" 0 0 444/u,
  );
  assert.match(
    provisionPki,
    /\/run must be tmpfs so CA private keys never reach persistent storage/u,
  );
  assert.match(provisionPki, /mktemp --directory \/run\/refunddesk-internal-pki\.XXXXXX/u);
  assert.match(provisionPki, /recover_interrupted_pki_generation/u);
  assert.match(provisionPki, /assert_private_work_directory/u);
  assert.match(provisionPki, /assert_staging_directory/u);
  assert.match(provisionPki, /assert_generation_marker/u);
  assert.match(provisionPki, /assert_manifest_matches_installed_targets/u);
  assert.match(provisionPki, /assert_published_service_matches_private_generation/u);
  assert.match(provisionPki, /remove_published_service_generation/u);
  assert.match(
    provisionPki,
    /STAGING_DIRECTORY="\$\{TLS_ROOT\}\/\$\{STAGING_PREFIX\}\$\{PRIVATE_WORK_DIRECTORY##\*\$\{PRIVATE_WORK_PREFIX\}\}"/u,
  );
  assert.match(
    provisionPki,
    /generation_marker_candidate="\$\{TLS_ROOT\}\/\$\{GENERATION_MARKER_PREFIX\}\$\{PRIVATE_WORK_DIRECTORY##\*\$\{PRIVATE_WORK_PREFIX\}\}\.sha256"/u,
  );
  assert.match(provisionPki, /rm -- "\$\{entry\}"/u);
  assert.doesNotMatch(provisionPki, /find[^\n]*-delete|rm\s+-rf/u);
  assert.doesNotMatch(provisionPki, /install[\s\S]{0,160}(?:postgres|verifier)-ca\.key/u);
});

test("operator source is cryptographically bound to the requested Git revision", async () => {
  const [installSource, release, bootstrapHost] = await Promise.all([
    read("scripts/install-source.sh"),
    read("scripts/release.sh"),
    read("scripts/bootstrap-host.sh"),
  ]);

  assert.match(
    installSource,
    /refunddesk-source-\$\{REVISION\}\.tar\.zst/,
    "the accepted filename must carry the requested full revision",
  );
  assert.match(
    installSource,
    /zstd --test --quiet -- "\$\{ARCHIVE\}"[\s\S]+set \+o pipefail[\s\S]+zstd --decompress --stdout -- "\$\{ARCHIVE\}" \|\s+git get-tar-commit-id/u,
    "the Git archive PAX marker must be read from the authenticated source bytes",
  );
  assert.match(
    installSource,
    /\[\[ "\$\{archive_revision\}" == "\$\{REVISION\}" \]\]/u,
    "the embedded Git commit must equal the requested revision",
  );
  assert.match(
    bootstrapHost,
    /^\s+git \\$/mu,
    "the sandbox host must install Git for verification",
  );
  assert.match(
    release,
    /\[\[ "\$\{source_revision_lines\[0\]\}" == "\$\{REVISION\}" \]\]/u,
    "release promotion must preserve the source-to-image revision equality",
  );
});

test("installed unprivileged-container policies remain readable and read-only", async () => {
  const [compose, installSource] = await Promise.all([
    read("compose.yml"),
    read("scripts/install-source.sh"),
  ]);
  const postgres = serviceBlock(compose, "postgres");
  const publicCaddy = serviceBlock(compose, "caddy");
  const verifierCaddy = serviceBlock(compose, "verifier");

  for (const requiredPolicy of [
    "deploy/lightsail/Caddyfile.public",
    "deploy/lightsail/Caddyfile.verifier",
    "deploy/lightsail/pg_hba.conf",
  ]) {
    assert.ok(
      installSource.includes(`  ${requiredPolicy} \\`),
      `source installation must reject an archive without ${requiredPolicy}`,
    );
  }
  const rootOwnership = installSource.indexOf('chown -R root:root "${TEMP_SOURCE}"');
  const recursiveHardening = installSource.indexOf('chmod -R go-w "${TEMP_SOURCE}"');
  const containerReadMode = installSource.indexOf("chmod 0444 \\");
  assert.ok(
    rootOwnership >= 0 &&
      rootOwnership < recursiveHardening &&
      recursiveHardening < containerReadMode,
    "root-owned policies must be made readable only after recursive source hardening",
  );
  const readOnlyPolicyBlock = installSource.slice(
    containerReadMode,
    installSource.indexOf("\nprintf ", containerReadMode),
  );
  for (const readablePolicy of ["Caddyfile.public", "Caddyfile.verifier", "pg_hba.conf"]) {
    assert.match(
      readOnlyPolicyBlock,
      new RegExp(
        `\\$\\{TEMP_SOURCE\\}/deploy/lightsail/${readablePolicy.replace(".", "\\.")}`,
        "u",
      ),
      `${readablePolicy} must be installed read-only for its unprivileged container`,
    );
  }
  assert.match(
    postgres,
    /source: \.\/pg_hba\.conf\s+target: \/etc\/postgresql\/refunddesk-pg_hba\.conf\s+read_only: true\s+bind:\s+create_host_path: false/u,
  );
  assert.match(
    publicCaddy,
    /source: \.\/Caddyfile\.public\s+target: \/etc\/caddy\/Caddyfile\s+read_only: true\s+bind:\s+create_host_path: false/u,
  );
  assert.match(
    verifierCaddy,
    /source: \.\/Caddyfile\.verifier\s+target: \/etc\/caddy\/Caddyfile\s+read_only: true\s+bind:\s+create_host_path: false/u,
  );
});

test("host installs a pinned and authenticated AWS CLI v2", async () => {
  const bootstrapHost = await read("scripts/bootstrap-host.sh");

  assert.doesNotMatch(bootstrapHost, /^\s+awscli \\$/mu);
  assert.match(bootstrapHost, /^\s+gnupg \\$/mu);
  assert.match(bootstrapHost, /^\s+unzip \\$/mu);
  assert.match(bootstrapHost, /^readonly AWS_CLI_VERSION="2\.36\.9"$/mu);
  assert.match(
    bootstrapHost,
    /^readonly AWS_CLI_X86_64_SHA256="9b92ccb50dfc55479ac14c4ba1bb36f603a1cbfb004b50e4a50b1592ffad3da0"$/mu,
  );
  assert.match(
    bootstrapHost,
    /https:\/\/awscli\.amazonaws\.com\/awscli-exe-linux-x86_64-\$\{AWS_CLI_VERSION\}\.zip/u,
  );
  assert.match(bootstrapHost, /\[\[ "\$\(uname --machine\)" == "x86_64" \]\]/u);
  assert.match(bootstrapHost, /sha256sum --check --strict --status/u);
  assert.match(
    bootstrapHost,
    /^readonly AWS_CLI_SIGNING_KEY_FINGERPRINT="FB5DB77FD5C118B80511ADA8A6310ACC4672475C"$/mu,
  );
  assert.match(bootstrapHost, /--no-auto-key-retrieve[\s\S]+--status-fd 1 --verify/u);
  assert.match(bootstrapHost, /VALIDSIG \$\{AWS_CLI_SIGNING_KEY_FINGERPRINT\}/u);
  assert.match(
    bootstrapHost,
    /\[\[ "\$\{installed_version\}" == "aws-cli\/\$\{AWS_CLI_VERSION\} ".*\]\]/u,
  );
  assert.match(bootstrapHost, /if \[\[ -x \/usr\/local\/bin\/aws \]\]; then[\s\S]+return 0/u);
  assert.match(
    bootstrapHost,
    /if existing_aws="\$\(command -v aws 2>\/dev\/null\)"; then[\s\S]+refusing to replace AWS CLI installation/u,
  );
  assert.match(
    bootstrapHost,
    /\[\[ -e \/usr\/local\/bin\/aws \|\| -L \/usr\/local\/bin\/aws \|\| -e \/usr\/local\/aws-cli \]\]/u,
  );
  assert.doesNotMatch(bootstrapHost, /aws\/install[\s\S]{0,160}--update/u);

  const fastPath = bootstrapHost.indexOf("if [[ -x /usr/local/bin/aws ]]");
  const download = bootstrapHost.indexOf('download_url="https://awscli.amazonaws.com/');
  assert.ok(fastPath >= 0 && fastPath < download, "exact-version fast path must precede download");

  const swap = bootstrapHost.indexOf("if [[ ! -e /swapfile ]]");
  const apt = bootstrapHost.indexOf("apt-get update");
  const installAws = bootstrapHost.indexOf("\ninstall_aws_cli_v2\n");
  assert.ok(
    swap >= 0 && swap < apt && apt < installAws,
    "swap must be active before APT and the AWS CLI installation",
  );
});

test("new swapfiles retain two GiB of usable capacity after mkswap", async () => {
  const [bootstrapHost, verifyDeployment] = await Promise.all([
    read("scripts/bootstrap-host.sh"),
    read("scripts/verify-deployment.sh"),
  ]);
  const requiredUsableBytes = 2 * 1024 * 1024 * 1024;
  const swapHeaderBytes = 4096;
  const newSwapfileBytes = 2304 * 1024 * 1024;

  assert.ok(newSwapfileBytes - swapHeaderBytes >= requiredUsableBytes);
  assert.ok(requiredUsableBytes - swapHeaderBytes < requiredUsableBytes);
  assert.match(
    bootstrapHost,
    /log "creating the dedicated 2304 MiB swapfile with headroom for 2 GiB usable swap"\s+if ! fallocate --length 2304M \/swapfile; then\s+dd if=\/dev\/zero of=\/swapfile bs=1M count=2304 status=progress\s+fi\s+chmod 0600 \/swapfile\s+mkswap \/swapfile/u,
  );
  assert.doesNotMatch(bootstrapHost, /fallocate --length 2G|count=2048/u);

  const existingSwapStart = bootstrapHost.indexOf("else\n  [[ -f /swapfile && ! -L /swapfile ]]");
  const existingSwapEnd = bootstrapHost.indexOf("\nfi\n\nif ! swapon", existingSwapStart);
  assert.ok(existingSwapStart >= 0 && existingSwapStart < existingSwapEnd);
  const existingSwapBranch = bootstrapHost.slice(existingSwapStart, existingSwapEnd);
  assert.match(existingSwapBranch, /swap_bytes >= 2147483648/u);
  assert.doesNotMatch(existingSwapBranch, /\b(?:dd|fallocate|mkswap|swapoff|truncate)\b/u);
  assert.match(verifyDeployment, /bytes >= 2147483648[\s\S]+host swap is below 2 GiB/u);
});

test("host pins the classic Docker store required by release image IDs", async () => {
  const bootstrapHost = await read("scripts/bootstrap-host.sh");

  assert.match(bootstrapHost, /and \(\(\.features \/\/ \{\}\) \| type == "object"\)/u);
  assert.match(
    bootstrapHost,
    /\.features = \(\(\.features \/\/ \{\}\) \+ \{"containerd-snapshotter":false\}\)/u,
  );
  assert.match(
    bootstrapHost,
    /\{"features":\{"containerd-snapshotter":false\},"log-driver":"local"/u,
  );
  assert.match(
    bootstrapHost,
    /io\.containerd\.snapshotter\.v1[\s\S]+docker ps --all --quiet[\s\S]+docker image ls --quiet/u,
  );
  assert.match(
    bootstrapHost,
    /current_containers="\$\(docker ps --all --quiet\)" \|\|\s+die "Docker container inventory is unavailable"/u,
  );
  assert.match(
    bootstrapHost,
    /current_images="\$\(docker image ls --quiet\)" \|\|\s+die "Docker image inventory is unavailable"/u,
  );
  assert.doesNotMatch(bootstrapHost, /"containerd-snapshotter":true/u);

  const emptyStoreGuard = bootstrapHost.indexOf(
    "refusing to hide images while switching Docker image stores",
  );
  const daemonInstall = bootstrapHost.indexOf('install -o root -g root -m 0644 "${daemon_tmp}"');
  const daemonValidation = bootstrapHost.indexOf(
    'dockerd --validate --config-file="${daemon_tmp}"',
  );
  const daemonRestart = bootstrapHost.indexOf("systemctl restart docker.service");
  const driverCheck = bootstrapHost.indexOf(
    "Docker classic overlay2 image store is required for verified RefundDesk image IDs",
  );
  assert.ok(
    emptyStoreGuard >= 0 && emptyStoreGuard < daemonInstall,
    "the active containerd store must be empty before the daemon config changes",
  );
  assert.ok(
    daemonValidation >= 0 && daemonValidation < daemonInstall,
    "the generated daemon config must validate before installation",
  );
  assert.ok(
    daemonInstall < daemonRestart && daemonRestart < driverCheck,
    "the daemon config must be installed and restarted before its driver is accepted",
  );
  assert.match(
    bootstrapHost,
    /\[\[ "\$\{docker_driver\}" == "overlay2" \]\][\s\S]+Docker classic overlay2 image store is required/u,
  );
  assert.match(
    bootstrapHost,
    /docker_driver_status="\$\(docker info --format '\{\{json \.DriverStatus\}\}'\)"[\s\S]+Docker containerd image store remained active after restart/u,
  );
});

test("daily retention is revision-bound, isolated and activated on fresh or existing hosts", async () => {
  const [
    compose,
    environment,
    runner,
    retentionService,
    retentionTimer,
    bootstrapHost,
    installSource,
    release,
    common,
    purge,
  ] = await Promise.all([
    read("compose.yml"),
    read("maintenance.env.example"),
    read("scripts/run-retention.sh"),
    read("systemd/refunddesk-retention.service"),
    read("systemd/refunddesk-retention.timer"),
    read("scripts/bootstrap-host.sh"),
    read("scripts/install-source.sh"),
    read("scripts/release.sh"),
    read("scripts/_common.sh"),
    read("../../packages/db/scripts/retention-purge.mjs"),
  ]);
  const maintenance = serviceBlock(compose, "maintenance");

  for (const fragment of [
    "image: refunddesk-migrate:${REFUNDDESK_IMAGE_TAG:?REFUNDDESK_IMAGE_TAG is required}",
    "profiles:\n      - maintenance",
    'restart: "no"',
    "env_file:\n      - /etc/refunddesk/maintenance.env",
    "command:\n      - node\n      - packages/db/scripts/run-retention-purge.mjs",
    'user: "1000:1000"',
    "read_only: true",
    "cap_drop:\n      - ALL",
    "no-new-privileges:true",
    "condition: service_healthy",
    "- database-maintenance",
  ]) {
    assert.match(maintenance, new RegExp(fragment.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.doesNotMatch(
    maintenance,
    /STRIPE_|DATABASE_MIGRATION_URL|WORKER_DATABASE_URL|PGBOSS_DATABASE_URL|database-(?:web|worker|migrate)|egress/u,
  );
  assert.equal((maintenance.match(/source: /gu) ?? []).length, 1);
  assert.match(maintenance, /source: \/etc\/refunddesk\/tls\/postgres\/ca\.crt/u);

  assert.deepEqual([...environmentNames(environment)].sort(), [
    "NODE_ENV",
    "REFUNDDESK_MAINTENANCE_DATABASE_URL",
    "REFUNDDESK_PURGE_PSEUDONYM_HMAC_KEY_V1",
    "REFUNDDESK_RETENTION_BATCH_SIZE",
    "REFUNDDESK_RETENTION_SCOPE",
  ]);
  assert.match(environment, /^REFUNDDESK_RETENTION_SCOPE=test_sandbox$/mu);
  assert.doesNotMatch(environment, /STRIPE_|(?:sk|rk)_live_/u);

  for (const fragment of [
    "acquire_operator_lock",
    'assert_root_secret_file "${REFUNDDESK_RELEASE_ENV}"',
    'assert_root_secret_file "${MAINTENANCE_ENV}"',
    'assert_root_secret_file "${MAINTENANCE_PASSWORD_FILE}"',
    '[[ -L "${CURRENT_LINK}" ]]',
    'current_source="$(readlink --canonicalize-existing -- "${CURRENT_LINK}")"',
    "REFUNDDESK_IMAGE_TAG=sandbox-${revision}",
    "REFUNDDESK_REVISION=${revision}",
    `python3 - "\${MAINTENANCE_ENV}" "\${MAINTENANCE_PASSWORD_FILE}" <<'PY' || die "maintenance environment or password binding is invalid"`,
    "set(values) != expected_names",
    'urllib.parse.unquote(database_url.username or "")',
    "refunddesk_maintenance_login",
    'urllib.parse.unquote(database_url.password or "") != password_lines[0]',
    'manifest="${REFUNDDESK_ROOT}/releases/${revision}/manifest.json"',
    'expected_image_id="$(',
    'docker image inspect "${image}"',
    "org.opencontainers.image.revision",
    "service_container_id postgres",
    ".State.Health.Status",
    "worker must be present and running before retention",
    "prepare-quiesce",
    "--operation retention",
    "REFUNDDESK_QUIESCE_RECOVERY_LOCK_INHERITED=true",
    'bash "${RECOVERY_RUNNER}"',
    "refunddesk_compose stop --timeout 45 worker",
    "service_is_running worker",
    "trap restore_worker EXIT",
    "clear_database_owner_job_reservation",
    'refunddesk_compose --profile maintenance run \\\n  --name "${REFUNDDESK_DATABASE_OWNER_JOB_NAME}"',
    "--no-deps",
    "--pull never",
    'seal_database_owner_job_reservation maintenance "${revision}"',
    'assert_database_owner_job_reservation "${revision}"',
  ]) {
    assert.match(runner, new RegExp(fragment.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.doesNotMatch(runner, /^\s*(?:source|\.)\s+["']?\$\{?MAINTENANCE_ENV/mu);
  assert.doesNotMatch(
    runner,
    /<<'PY' \|\|\s*\n\s+die "maintenance environment or password binding is invalid"/u,
    "the shell failure handler must not become the first line of the Python heredoc",
  );
  assert.doesNotMatch(runner, /docker\s+pull|refunddesk_compose\s+(?:build|pull)/u);
  assert.doesNotMatch(runner, /refunddesk_compose\s+up[^\n]*maintenance/u);
  const workerStop = runner.indexOf("refunddesk_compose stop --timeout 45 worker");
  const maintenanceRun = runner.indexOf("refunddesk_compose --profile maintenance run");
  const maintenanceSeal = runner.indexOf(
    'seal_database_owner_job_reservation maintenance "${revision}"',
    maintenanceRun,
  );
  const reservationProof = runner.indexOf(
    'assert_database_owner_job_reservation "${revision}"',
    maintenanceSeal,
  );
  assert.ok(
    workerStop >= 0 &&
      maintenanceRun > workerStop &&
      maintenanceSeal > maintenanceRun &&
      reservationProof > maintenanceSeal,
  );
  assert.doesNotMatch(runner.slice(maintenanceRun), /\brun\s+--rm\b/u);
  const restoreStart = runner.indexOf("restore_worker() {");
  const restoreEnd = runner.indexOf("trap restore_worker EXIT", restoreStart);
  const restoreWorker = runner.slice(restoreStart, restoreEnd);
  assert.match(restoreWorker, /bash "\$\{RECOVERY_RUNNER\}"/u);
  assert.doesNotMatch(restoreWorker, /leaving the worker stopped/u);
  assert.match(purge, /pg_try_advisory_lock/u);
  assert.match(purge, /RETENTION_PURGE_ALREADY_RUNNING/u);
  assert.match(purge, /FROM public\.refunddesk_purge_test_sandbox_tenant/u);

  for (const fragment of [
    "Environment=HOME=/run/refunddesk-retention",
    "Environment=DOCKER_CONFIG=/run/refunddesk-retention",
    "RuntimeDirectory=refunddesk-retention",
    "ExecStart=/usr/local/sbin/refunddesk-retention",
    "After=docker.service network-online.target",
    "Wants=network-online.target",
    "NoNewPrivileges=yes",
    "PrivateDevices=yes",
    "PrivateTmp=yes",
    "ProtectHome=yes",
    "ProtectSystem=strict",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK",
    "CapabilityBoundingSet=",
    "ReadWritePaths=/run/refunddesk /run/docker.sock /run/refunddesk-retention /var/lib/refunddesk/control /var/log/refunddesk",
  ]) {
    assert.match(
      retentionService,
      new RegExp(fragment.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    );
  }
  assert.doesNotMatch(retentionService, /^EnvironmentFile=/mu);
  assert.doesNotMatch(
    retentionService,
    /^ConditionPathExists=/mu,
    "missing control files must fail visibly through the stable launcher instead of skipping retention",
  );
  assert.match(retentionTimer, /^OnCalendar=hourly$/mu);
  assert.match(retentionTimer, /^RandomizedDelaySec=5min$/mu);
  assert.match(retentionTimer, /^Persistent=true$/mu);

  for (const source of [bootstrapHost, common]) {
    assert.match(source, /refunddesk-retention\.service/u);
    assert.match(source, /refunddesk-retention\.timer/u);
  }
  for (const source of [bootstrapHost, release]) {
    assert.match(source, /systemctl start refunddesk-retention\.timer/u);
  }
  assert.match(bootstrapHost, /timers\.target\.wants\/refunddesk-retention\.timer/u);
  assert.match(release, /RETENTION_WANTS_PATH/u);
  assert.match(installSource, /deploy\/lightsail\/scripts\/run-retention\.sh/u);
  assert.match(installSource, /deploy\/lightsail\/systemd\/refunddesk-retention\.service/u);
  const promotion = release.lastIndexOf('--target "${REFUNDDESK_ROOT}/current"');
  const activation = release.indexOf("systemctl start refunddesk-retention.timer");
  assert.ok(promotion >= 0 && activation > promotion);
});

test("retention preflight executes validation and its shell failure handler", async (t) => {
  const version = spawnSync("bash", ["--version"], { encoding: "utf8" });
  if (version.error?.code === "ENOENT" || version.status !== 0) {
    t.skip("bash is unavailable on this host; Linux CI executes this functional contract");
    return;
  }

  const runner = (await read("scripts/run-retention.sh")).replaceAll("\r\n", "\n");
  const command =
    `python3 - "\${MAINTENANCE_ENV}" "\${MAINTENANCE_PASSWORD_FILE}" <<'PY' || ` +
    `die "maintenance environment or password binding is invalid"`;
  const commandStart = runner.indexOf(command);
  const terminator = runner.indexOf("\nPY\n", commandStart);
  assert.ok(commandStart >= 0 && terminator > commandStart, "missing retention preflight heredoc");
  const preflight = runner.slice(commandStart, terminator + "\nPY".length);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "refunddesk-retention-preflight-"));
  const environmentPath = join(temporaryDirectory, "maintenance.env");
  const passwordPath = join(temporaryDirectory, "postgres-maintenance-password");
  const password = "a".repeat(32);
  const pseudonymKey = Buffer.alloc(32, 7).toString("base64");
  const environment = [
    "NODE_ENV=production",
    `REFUNDDESK_MAINTENANCE_DATABASE_URL=postgresql://refunddesk_maintenance_login:${password}@postgres.refunddesk.internal:5432/refunddesk?sslmode=verify-full`,
    `REFUNDDESK_PURGE_PSEUDONYM_HMAC_KEY_V1=${pseudonymKey}`,
    "REFUNDDESK_RETENTION_BATCH_SIZE=100",
    "REFUNDDESK_RETENTION_SCOPE=test_sandbox",
    "",
  ].join("\n");
  const harness = `set -Eeuo pipefail
die() { exit 97; }
MAINTENANCE_ENV="$1"
MAINTENANCE_PASSWORD_FILE="$2"
${preflight}
`;
  const executePreflight = () =>
    spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        harness,
        "retention-preflight",
        environmentPath,
        passwordPath,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );

  try {
    await writeFile(environmentPath, environment, { encoding: "utf8", mode: 0o600 });
    await writeFile(passwordPath, `${password}\n`, { encoding: "utf8", mode: 0o600 });
    let result = executePreflight();
    assert.equal(result.status, 0, result.stderr);

    await writeFile(passwordPath, `${"b".repeat(32)}\n`, { encoding: "utf8", mode: 0o600 });
    result = executePreflight();
    assert.equal(result.status, 97, result.stderr);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("one-shot database jobs reserve one global name without retaining secrets", async () => {
  const [common, bootstrapDatabase, release, retention, reservationTest] = await Promise.all([
    read("scripts/_common.sh"),
    read("scripts/bootstrap-database.sh"),
    read("scripts/release.sh"),
    read("scripts/run-retention.sh"),
    read("scripts/test-database-owner-reservation.sh"),
  ]);

  for (const script of [bootstrapDatabase, release, retention]) {
    assert.doesNotMatch(script, /\brun\b[^\n]*--no-build/u);
    assert.match(script, /--name "\$\{REFUNDDESK_DATABASE_OWNER_JOB_NAME\}"/u);
    assert.match(script, /--no-deps/u);
    assert.match(script, /--pull never/u);
    assert.match(script, /clear_database_owner_job_reservation/u);
    assert.match(script, /seal_database_owner_job_reservation/u);
  }
  assert.doesNotMatch(
    `${bootstrapDatabase}\n${release}\n${retention}`,
    /refunddesk_compose[\s\S]{0,120}\brun\s+--rm\b/u,
  );
  assert.match(common, /readonly REFUNDDESK_DATABASE_OWNER_JOB_NAME=/u);
  assert.match(common, /database-owner-reservation/u);
  assert.match(common, /--network none/u);
  assert.match(common, /--read-only/u);
  assert.match(common, /--restart=no/u);
  assert.match(common, /--cap-drop ALL/u);
  assert.match(common, /docker create \\\n\s+--pull=never/u);
  assert.match(common, /--tmpfs \/var\/lib\/postgresql:rw,nosuid,nodev,noexec,size=65536/u);
  assert.match(common, /--entrypoint \/bin\/true/u);
  assert.match(
    common,
    /\.HostConfig\.Tmpfs[\s\S]*== \{"\/var\/lib\/postgresql":"rw,nosuid,nodev,noexec,size=65536"\}/u,
  );
  assert.match(common, /all\(\.\[0\]\.Mounts\[\]\?; \.Type != "volume"\)/u);
  assert.ok((common.match(/docker rm --volumes/gu) ?? []).length >= 2);
  assert.match(release, /docker rm --volumes "\$\{container_id\}"/u);
  assert.match(reservationTest, /any\(\.\[0\]\.Mounts\[\]\?; \.Type == "volume"\)/u);
  assert.match(reservationTest, /seal_database_owner_job_reservation migrate/u);
  assert.match(reservationTest, /assert_database_owner_job_reservation/u);
  assert.match(reservationTest, /clear_database_owner_job_reservation/u);
  assert.match(reservationTest, /volume_inventory/u);
  assert.match(reservationTest, /leaked an anonymous Docker volume/u);
  assert.match(reservationTest, /docker rm --force --volumes/u);
  assert.match(reservationTest, /\.Config\.AttachStdin == false/u);
  assert.match(reservationTest, /\.Config\.AttachStdout == true/u);
  assert.match(reservationTest, /\.Config\.AttachStderr == true/u);
  assert.match(reservationTest, /\.Config\.Tty == false/u);
  assert.match(reservationTest, /\.Config\.OpenStdin == false/u);
  assert.match(reservationTest, /\.Config\.StdinOnce == false/u);
  assert.match(
    reservationTest,
    /docker inspect -- "\$\{REFUNDDESK_DATABASE_OWNER_JOB_NAME\}" \|[\s\S]*jq --exit-status[\s\S]*>\/dev\/null/u,
  );
  assert.match(reservationTest, /docker create \\\n\s+--pull=never/u);
  assert.match(common, /\.State\.ExitCode == 0/u);
  assert.match(common, /\(\.\[0\]\.State\.Error \/\/ ""\) == ""/u);
  assert.match(
    common,
    /test\("\(PASSWORD\|SECRET\|TOKEN\|DATABASE_URL\|HMAC_KEY\|ENCRYPTION_KEY\)"\)/u,
  );
  assert.match(
    bootstrapDatabase,
    /pg_isready --quiet --username=refunddesk_owner --dbname=refunddesk/u,
  );
});

test("PostgreSQL 18 root-mount migration proves a cold clone before deleting the old layout", async () => {
  const [common, migration, migrationTest, release, bootstrap, installSource] = await Promise.all([
    read("scripts/_common.sh"),
    read("scripts/prepare-postgres-root-mount.sh"),
    read("scripts/test-postgres-root-mount-migration.sh"),
    read("scripts/release.sh"),
    read("scripts/bootstrap-database.sh"),
    read("scripts/install-source.sh"),
  ]);

  for (const fragment of [
    'POSTGRES_IMAGE="postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296"',
    'OLD_CONTAINER_PGDATA="/var/lib/postgresql/data"',
    "docker stop --time 60",
    "postmaster.pid",
    "999:999:700",
    "PG_VERSION",
    "cp --archive --reflink=auto --one-file-system",
    "tree_fingerprint",
    "--format=posix",
    "--pax-option='exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime'",
    "insufficient free space",
    "--pull=never",
    "--network none",
    "target=${REFUNDDESK_POSTGRES_CONTAINER_PGDATA}",
    'all(.[0].Mounts[]?; .Type != "volume")',
    "to_regclass('public._prisma_migrations') IS NOT NULL",
    "--entrypoint /usr/lib/postgresql/18/bin/pg_checksums",
    "docker rm --volumes",
    'docker volume rm "${old_volume_name}"',
    "assert_legacy_volume_identity",
    "assert_legacy_volume_empty",
    "result=/var/lib/postgresql/legacy-entries",
    "legacy PostgreSQL anonymous parent volume survived",
    "cold PostgreSQL root-mount probe leaked a Docker volume",
  ]) {
    assert.match(migration, new RegExp(fragment.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.match(
    common,
    /assert_postgres_root_mount_contract\(\)[\s\S]*all\(\.\[0\]\.Mounts\[\]\?; \.Type != "volume"\)/u,
  );
  assert.match(bootstrap, /refunddesk_compose up[\s\S]*assert_postgres_root_mount_contract/u);
  const migrationProof = release.indexOf('bash "${SCRIPT_DIR}/prepare-postgres-root-mount.sh"');
  const bootstrapStart = release.indexOf('bash "${SCRIPT_DIR}/bootstrap-database.sh"');
  assert.ok(migrationProof >= 0 && bootstrapStart > migrationProof);
  assert.match(installSource, /deploy\/lightsail\/scripts\/prepare-postgres-root-mount\.sh/u);
  assert.match(migrationTest, /PGDATA=\/var\/lib\/postgresql\/data/u);
  assert.match(migrationTest, /PGDATA=\/var\/lib\/postgresql/u);
  assert.match(migrationTest, /select\(\.Type == "volume"/u);
  assert.match(migrationTest, /all\(\.\[0\]\.Mounts\[\]\?; \.Type != "volume"\)/u);
  assert.match(migrationTest, /BASELINE_VOLUMES/u);
  assert.match(migrationTest, /REUSED_PARENT_VOLUME/u);
  assert.match(migrationTest, /unreadable/u);
  assert.match(
    migrationTest,
    /type=volume,source=\$\{REUSED_PARENT_VOLUME\},target=\/var\/lib\/postgresql/u,
  );
  assert.match(migrationTest, /interrupted-clone/u);
  assert.match(migration, /recover_stale_helper_container/u);
  assert.doesNotMatch(migration, /test -z "\$\(find \/mnt\/legacy/u);
  const finalEmptyProof = migration.lastIndexOf('assert_legacy_volume_empty "${old_volume_name}"');
  const explicitVolumeRemoval = migration.indexOf(
    'docker volume rm "${old_volume_name}"',
    finalEmptyProof,
  );
  assert.ok(finalEmptyProof >= 0 && explicitVolumeRemoval > finalEmptyProof);
  assert.match(
    migration,
    /source_fingerprint="\$\(tree_fingerprint "\$\{resolved_pgdata\}"\)" \|\|\s+die "source PostgreSQL tree fingerprint could not be computed"/u,
  );
  assert.match(
    migration,
    /clone_fingerprint="\$\(tree_fingerprint "\$\{clone_pgdata\}"\)" \|\|\s+die "cloned PostgreSQL tree fingerprint could not be computed"/u,
  );
  assert.match(migration, /\[\[ "\$\{source_fingerprint\}" =~ \^\[0-9a-f\]\{64\}\$ \]\]/u);
  assert.match(migration, /\[\[ "\$\{clone_fingerprint\}" =~ \^\[0-9a-f\]\{64\}\$ \]\]/u);
  assert.doesNotMatch(migration, /\[\[ "\$\(tree_fingerprint/u);
});

test("backup upload uses the AWS CLI v2 SSE-S3 surface and verifies the result", async () => {
  const [backup, backupLauncher, backupService] = await Promise.all([
    read("scripts/backup.sh"),
    read("scripts/backup-launcher.sh"),
    read("systemd/refunddesk-backup.service"),
  ]);
  const uploadAttempt = backup.indexOf("UPLOAD_ATTEMPTED=true");
  const uploadStart = backup.indexOf("\n  aws s3api put-object \\", uploadAttempt);
  const uploadEnd = backup.indexOf('\n)"; then', uploadStart);

  assert.ok(uploadStart >= 0 && uploadEnd > uploadStart, "missing backup upload command");
  const upload = backup.slice(uploadStart, uploadEnd);
  assert.match(upload, /--server-side-encryption AES256/u);
  assert.doesNotMatch(upload, /\bs3 cp\b/u);
  assert.match(upload, /--metadata "sha256=\$\{archive_sha256\},revision=\$\{revision\}"/u);

  assert.match(backup, /AWS_SHARED_CREDENTIALS_FILE=\/dev\/null/u);
  assert.match(backup, /static or preloaded AWS credentials are prohibited/u);
  assert.doesNotMatch(
    backup,
    /get-bucket-versioning/u,
    "Lightsail resource-access credentials do not expose S3 GetBucketVersioning",
  );
  assert.doesNotMatch(
    backup,
    /aws lightsail get-buckets/u,
    "the bucket resource-access role cannot call the Lightsail control plane",
  );
  const versioningWitness = backup.indexOf("versioning_probe_result=");
  const versioningProofComplete = backup.indexOf(
    "versioning-probe object remains after exact deletion",
    versioningWitness,
  );
  const runtimeQuiescence = backup.indexOf(
    'log "quiescing ingress, worker, web, verifier and PostgreSQL"',
  );
  assert.ok(
    versioningWitness >= 0 &&
      versioningProofComplete > versioningWitness &&
      runtimeQuiescence > versioningProofComplete,
    "the supported versioning probe must be completed before runtime quiescence",
  );
  assert.match(backup, /purpose=versioning-preflight/u);
  assert.match(backup, /backup bucket did not return an enabled-version ID/u);
  assert.match(backup, /versioned backup preflight probe metadata differs/u);
  assert.match(backup, /S3 did not confirm exact versioning-probe deletion/u);
  assert.match(backup, /versioning-probe object remains after exact deletion/u);
  assert.match(backup, /UPLOAD_ATTEMPTED=true[\s\S]*aws s3api put-object/u);
  assert.match(backup, /UPLOAD_COMMITTED=true[\s\S]*rotate_to_count/u);
  assert.match(backup, /--version-id "\$\{UPLOADED_VERSION_ID\}"/u);
  assert.match(backup, /--no-paginate/u);
  assert.match(backup, /\.IsTruncated \/\/ false/u);
  assert.match(backup, /\.Metadata\.sha256 \/\/ empty/u);
  assert.match(backup, /\.ServerSideEncryption \/\/ empty/u);
  assert.match(backup, /"\$\{remote_sse\}" == "AES256"/u);
  assert.match(backupService, /^ExecStart=\/usr\/local\/sbin\/refunddesk-backup$/mu);
  assert.doesNotMatch(backupService, /^(?:EnvironmentFile|ConditionPathExists)=/mu);
  for (const source of [backupLauncher, backup]) {
    assert.match(source, /backup is blocked while a release transition is unfinished/u);
    assert.match(source, /ACTIVE_REVISION/u);
    assert.match(source, /release\.env/u);
    assert.match(source, /manifest\.json/u);
    assert.match(source, /docker image inspect/u);
    assert.match(source, /org\.opencontainers\.image\.revision/u);
  }
  assert.match(backupLauncher, /exec \/usr\/bin\/bash "\$\{runner\}"/u);
  assert.doesNotMatch(
    backup,
    /refunddesk_compose up(?![^\n]*--pull never)/u,
    "every backup restore must remain bound to a previously verified local image",
  );
});

test("runtime quiescence is durable, exact-revision recovered and boot-wired", async () => {
  const [
    backup,
    retention,
    backupLauncher,
    retentionLauncher,
    recoveryLauncher,
    recovery,
    recoveryService,
    backupService,
    retentionService,
    helper,
    installSource,
    releaseLauncher,
    release,
  ] = await Promise.all([
    read("scripts/backup.sh"),
    read("scripts/run-retention.sh"),
    read("scripts/backup-launcher.sh"),
    read("scripts/retention-launcher.sh"),
    read("scripts/quiesce-recovery-launcher.sh"),
    read("scripts/recover-quiesced-runtime.sh"),
    read("systemd/refunddesk-quiesce-recovery.service"),
    read("systemd/refunddesk-backup.service"),
    read("systemd/refunddesk-retention.service"),
    read("scripts/release-transition-journal.py"),
    read("scripts/install-source.sh"),
    read("scripts/release-launcher.sh"),
    read("scripts/release.sh"),
  ]);

  for (const [runner, operation, stopMarker] of [
    [backup, "backup", "refunddesk_compose stop --timeout 45 caddy"],
    [retention, "retention", "refunddesk_compose stop --timeout 45 worker"],
  ]) {
    const journal = runner.indexOf("prepare-quiesce");
    const operationBinding = runner.indexOf(`--operation ${operation}`, journal);
    const stop = runner.indexOf(stopMarker);
    assert.ok(journal >= 0 && operationBinding > journal && stop > operationBinding);
    assert.match(runner, /REFUNDDESK_QUIESCE_RECOVERY_LOCK_INHERITED=true/u);
    assert.match(runner, /bash "\$\{RECOVERY_RUNNER\}"/u);
  }

  const archiveSync = backup.indexOf('fsync-paths \\\n  --path "${archive_path}"');
  const uploadIntent = backup.indexOf("prepare-backup-upload", archiveSync);
  const upload = backup.indexOf("aws s3api put-object", uploadIntent);
  assert.ok(archiveSync >= 0 && uploadIntent > archiveSync && upload > uploadIntent);
  assert.match(backup, /preserving the encrypted local archive and upload intent/u);
  assert.match(helper, /def validate_quiesce_journal/u);
  assert.match(helper, /def validate_backup_upload_journal/u);
  assert.match(helper, /os\.O_EXCL/u);
  assert.match(helper, /def clear_quiesce[\s\S]*durable_unlink\(journal_path\)/u);

  for (const launcher of [backupLauncher, retentionLauncher, releaseLauncher, installSource]) {
    assert.match(launcher, /refunddesk-quiesce-recovery/u);
    assert.match(launcher, /runtime-quiesce-in-progress\.json/u);
  }
  for (const launcher of [backupLauncher, retentionLauncher, recoveryLauncher]) {
    const sourceValidation = launcher.indexOf("active revision and current source differ");
    const composeSelection = launcher.indexOf(
      'canonical_compose_file="${current_source}/deploy/lightsail/compose.yml"',
    );
    const composeExport = launcher.indexOf(
      'export REFUNDDESK_COMPOSE_FILE="${canonical_compose_file}"',
    );
    const runnerExecution = launcher.indexOf('exec /usr/bin/bash "${runner}"');
    assert.ok(
      sourceValidation >= 0 &&
        composeSelection > sourceValidation &&
        composeExport > composeSelection &&
        runnerExecution > composeExport,
    );
    assert.match(
      launcher,
      /(?:assert_root_control_file "\$\{canonical_compose_file\}"|for control_file in[\s\S]{0,500}"\$\{canonical_compose_file\}"[\s\S]{0,500}assert_root_control_file "\$\{control_file\}")/u,
    );
    assert.doesNotMatch(launcher, /REFUNDDESK_COMPOSE_FILE="\$\{REFUNDDESK_ROOT\}\/current\//u);
  }
  for (const runner of [backup, retention, recovery]) {
    const sourceValidation = runner.indexOf("current source");
    const composeSelection = runner.indexOf(
      'expected_compose_file="${current_source}/deploy/lightsail/compose.yml"',
    );
    const composeBinding = runner.indexOf(
      '[[ "${REFUNDDESK_COMPOSE_FILE}" == "${expected_compose_file}" ]]',
    );
    const composeOwnership = runner.indexOf(
      'assert_root_control_file "${REFUNDDESK_COMPOSE_FILE}"',
    );
    assert.ok(
      sourceValidation >= 0 &&
        composeSelection > sourceValidation &&
        composeBinding > composeSelection &&
        composeOwnership > composeBinding,
    );
  }
  const sourceInstallLock = installSource.indexOf("acquire_operator_lock");
  const sourceInstallRecovery = installSource.indexOf(
    'if [[ -e "${QUIESCE_JOURNAL}" || -L "${QUIESCE_JOURNAL}" ]]',
    sourceInstallLock,
  );
  assert.ok(sourceInstallLock >= 0 && sourceInstallRecovery > sourceInstallLock);
  assert.match(
    installSource.slice(sourceInstallRecovery),
    /REFUNDDESK_QUIESCE_RECOVERY_LOCK_INHERITED=true/u,
  );
  assert.match(release, /release is blocked until an unfinished runtime quiescence is recovered/u);
  assert.match(recoveryLauncher, /runtime control root must be root-owned mode 0700/u);
  assert.match(recovery, /assert-quiesce/u);
  assert.match(recovery, /recover_retention_database_owner_job/u);
  const recoveryModeProof = recovery.indexOf("standard_release_environment_worker_mode");
  const recoveryReservation = recovery.indexOf(
    "refunddesk_compose up --no-start --no-deps --no-build --pull never verifier worker web",
  );
  const recoveryWorkerInspection = recovery.indexOf(
    "assert_standard_worker_runtime_mode_from_inspection",
    recoveryReservation,
  );
  const recoveryWorkerStart = recovery.indexOf(
    "refunddesk_compose start verifier worker web",
    recoveryWorkerInspection,
  );
  assert.ok(
    recoveryModeProof >= 0 &&
      recoveryReservation > recoveryModeProof &&
      recoveryWorkerInspection > recoveryReservation &&
      recoveryWorkerStart > recoveryWorkerInspection,
  );
  assert.doesNotMatch(
    recovery,
    /refunddesk_compose up(?![^\n]*--pull never)/u,
    "recovery must use only the already-verified exact local images",
  );
  const deploymentVerification = recovery.indexOf('bash "${SCRIPT_DIR}/verify-deployment.sh"');
  const journalClear = recovery.indexOf("clear-quiesce", deploymentVerification);
  assert.ok(deploymentVerification >= 0 && journalClear > deploymentVerification);
  assert.match(recovery, /flock --exclusive --nonblock 9/u);

  assert.match(
    recoveryService,
    /^ConditionPathExists=\/var\/lib\/refunddesk\/control\/runtime-quiesce-in-progress\.json$/mu,
  );
  assert.match(recoveryService, /^ExecStart=\/usr\/local\/sbin\/refunddesk-quiesce-recovery$/mu);
  assert.match(recoveryService, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK$/mu);
  assert.match(backupService, /^OnFailure=refunddesk-quiesce-recovery\.service$/mu);
  assert.match(retentionService, /^OnFailure=refunddesk-quiesce-recovery\.service$/mu);
});

test("quiesce and backup-upload journals reject divergence and clear durably", async () => {
  const helper = resolve(directory, "scripts/release-transition-journal.py");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "refunddesk-quiesce-journal-"));
  const quiesceJournal = join(temporaryDirectory, "quiesce.json");
  const uploadJournal = join(temporaryDirectory, "upload.json");
  const revision = "a".repeat(40);
  const archive = `/var/lib/refunddesk/backups/postgres-20260729T031700Z-${revision}.tar.zst.age`;
  const commonUploadArguments = [
    "--path",
    uploadJournal,
    "--archive",
    archive,
    "--bucket",
    "refunddesk-sandbox-backups",
    "--bytes",
    "4096",
    "--object-key",
    `refunddesk-sandbox/postgres/${archive.split("/").at(-1)}`,
    "--revision",
    revision,
    "--sha256",
    "b".repeat(64),
  ];
  const runHelper = (...arguments_) =>
    spawnSync("python3", [helper, ...arguments_], {
      encoding: "utf8",
      windowsHide: true,
    });

  try {
    let result = runHelper(
      "prepare-quiesce",
      "--path",
      quiesceJournal,
      "--operation",
      "backup",
      "--revision",
      revision,
    );
    assert.equal(result.status, 0, result.stderr);
    result = runHelper(
      "assert-quiesce",
      "--path",
      quiesceJournal,
      "--operation",
      "retention",
      "--revision",
      revision,
    );
    assert.notEqual(result.status, 0);
    result = runHelper(
      "prepare-quiesce",
      "--path",
      quiesceJournal,
      "--operation",
      "backup",
      "--revision",
      revision,
    );
    assert.notEqual(result.status, 0);
    result = runHelper(
      "clear-quiesce",
      "--path",
      quiesceJournal,
      "--operation",
      "backup",
      "--revision",
      revision,
    );
    assert.equal(result.status, 0, result.stderr);

    result = runHelper("prepare-backup-upload", ...commonUploadArguments);
    assert.equal(result.status, 0, result.stderr);
    result = runHelper(
      "assert-backup-upload",
      ...commonUploadArguments.map((value, index) =>
        commonUploadArguments[index - 1] === "--bytes" ? "4097" : value,
      ),
    );
    assert.notEqual(result.status, 0);
    result = runHelper("clear-backup-upload", ...commonUploadArguments);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

const containmentRevision = "8da280b78a9d1475c7bd79063e72c5af77121e8d";
const containmentImageIds = Object.freeze({
  postgres: "sha256:0a314d409a9633cff4f89dc18482262625c0ee78cb1aa2ff8e47bc6da0251e1b",
  verifier: "sha256:af555904a0961945f16bb323a501457b13a4f7e9bde969b145b97da80b38ecbe",
  worker: "sha256:e3ead31f6c3084b69731e095a250b8d0a4e3e9d6e8d239dccf077e6b90d53f64",
  web: "sha256:c1d13b7db80e019e8a0ea24717c2a2028052b5959e1aaf65746336073606601f",
  caddy: "sha256:af555904a0961945f16bb323a501457b13a4f7e9bde969b145b97da80b38ecbe",
  migrate: "sha256:7b6124fb1c02f8fbb0a2cd45cf53bb5b6bc196c85edb620aa8ec903f99888279",
});
const containmentReferences = Object.freeze({
  postgres:
    "postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296",
  verifier:
    "caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648",
  caddy:
    "caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648",
  worker: `refunddesk-worker:sandbox-${containmentRevision}`,
  web: `refunddesk-web:sandbox-${containmentRevision}`,
  migrate: `refunddesk-migrate:sandbox-${containmentRevision}`,
});
const containmentPostgresImageEnvironment = Object.freeze([
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/lib/postgresql/18/bin",
  "GOSU_VERSION=1.19",
  "LANG=en_US.utf8",
  "PG_MAJOR=18",
  "PG_VERSION=18.4-1.pgdg12+1",
  "PGDATA=/var/lib/postgresql/18/docker",
]);

function containmentTimestamp(value = Date.now()) {
  return new Date(value).toISOString().replace(/\.[0-9]{3}Z$/u, "Z");
}

function containmentContainer(service, identifier) {
  const labels = {
    "com.docker.compose.project": "refunddesk",
    "com.docker.compose.service": service,
  };
  if (service !== "postgres") labels["com.refunddesk.revision"] = containmentRevision;
  const environment = [];
  if (service === "worker" || service === "web") {
    environment.push("REFUNDDESK_GLOBAL_LIVE_ENABLED=false");
  }
  if (service === "web") environment.push("STRIPE_ACCOUNT_LIVE_WEBHOOK_SECRET=disabled");
  return {
    Id: identifier.repeat(64),
    Name: `/refunddesk-${service}-1`,
    Image: containmentImageIds[service],
    Config: {
      Image: containmentReferences[service],
      User:
        service === "postgres"
          ? "999:999"
          : service === "worker" || service === "web"
            ? "node"
            : "",
      Labels: labels,
      Env: environment,
    },
    HostConfig: {
      RestartPolicy: { Name: "unless-stopped" },
      PortBindings: service === "caddy" ? { "80/tcp": [{}], "443/tcp": [{}] } : {},
      NetworkMode: "default",
      ReadonlyRootfs: service !== "postgres",
      Tmpfs: {},
    },
    State: {
      Running: true,
      Status: "running",
      ExitCode: 0,
      Error: "",
      Health: { Status: "healthy" },
    },
    Mounts: [],
  };
}

function containmentReservation() {
  return {
    Id: "6".repeat(64),
    Name: "/refunddesk-database-owner-job",
    Image: containmentImageIds.postgres,
    Path: "/bin/true",
    Args: [],
    Config: {
      Image: containmentReferences.postgres,
      User: "",
      Entrypoint: ["/bin/true"],
      Cmd: null,
      WorkingDir: "",
      StopSignal: "SIGINT",
      Healthcheck: null,
      Shell: null,
      ExposedPorts: { "5432/tcp": {} },
      Volumes: { "/var/lib/postgresql": {} },
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      OpenStdin: false,
      StdinOnce: false,
      Labels: {
        "com.docker.compose.project": "refunddesk",
        "com.docker.compose.service": "database-owner-reservation",
        "com.refunddesk.revision": containmentRevision,
        "com.refunddesk.database-owner-reservation": "true",
      },
      Env: [...containmentPostgresImageEnvironment],
    },
    HostConfig: {
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      AutoRemove: false,
      PortBindings: {},
      PublishAllPorts: false,
      NetworkMode: "none",
      ReadonlyRootfs: true,
      Privileged: false,
      Binds: null,
      Mounts: null,
      VolumesFrom: null,
      CapAdd: null,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Devices: null,
      DeviceRequests: null,
      DeviceCgroupRules: null,
      Links: null,
      ExtraHosts: null,
      GroupAdd: null,
      PidMode: "",
      IpcMode: "private",
      UTSMode: "",
      UsernsMode: "",
      CgroupnsMode: "private",
      Tmpfs: { "/var/lib/postgresql": "rw,nosuid,nodev,noexec,size=65536" },
      PidsLimit: 8,
      Memory: 16_777_216,
      MemoryReservation: 0,
      MemorySwap: 33_554_432,
      OomKillDisable: null,
      CpuShares: 0,
      NanoCpus: 0,
      CpuPeriod: 0,
      CpuQuota: 0,
      CpusetCpus: "",
      CpusetMems: "",
    },
    State: {
      Running: false,
      Paused: false,
      Restarting: false,
      OOMKilled: false,
      Dead: false,
      Status: "created",
      Pid: 0,
      ExitCode: 0,
      Error: "",
      Health: null,
    },
    Mounts: [],
    NetworkSettings: { Ports: { "5432/tcp": null } },
  };
}

async function createContainmentHostFixture(
  operation = "backup",
  { stickyListeners = false } = {},
) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "refunddesk-containment-test-"));
  const root = join(temporaryDirectory, "root");
  const configRoot = join(temporaryDirectory, "config");
  const controlRoot = join(temporaryDirectory, "control");
  const runtimeRoot = join(temporaryDirectory, "runtime");
  const operatorDirectory = join(temporaryDirectory, "operator");
  const operatorLock = join(operatorDirectory, "operator.lock");
  const sourceRoot = join(root, "releases", containmentRevision, "source");
  const lightsailRoot = join(sourceRoot, "deploy", "lightsail");
  const sourceScripts = join(lightsailRoot, "scripts");
  const manifestPath = join(root, "releases", containmentRevision, "manifest.json");
  const fakeBin = join(temporaryDirectory, "bin");
  const fakeStatePath = join(temporaryDirectory, "host-state.json");
  for (const [path, mode] of [
    [root, 0o755],
    [join(root, "releases"), 0o755],
    [join(root, "releases", containmentRevision), 0o755],
    [sourceRoot, 0o755],
    [join(sourceRoot, "deploy"), 0o755],
    [lightsailRoot, 0o755],
    [sourceScripts, 0o755],
    [configRoot, 0o700],
    [controlRoot, 0o700],
    [runtimeRoot, 0o755],
    [operatorDirectory, 0o700],
    [fakeBin, 0o755],
  ]) {
    await mkdir(path, { mode, recursive: true });
    await chmod(path, mode);
  }

  for (const relativePath of [
    "compose.yml",
    "scripts/_common.sh",
    "scripts/release-transition-journal.py",
  ]) {
    const bytes = await readFile(resolve(directory, relativePath));
    const target = join(lightsailRoot, relativePath);
    await writeFile(target, bytes, { mode: 0o644 });
    await chmod(target, 0o644);
  }
  await writeFile(join(root, "ACTIVE_REVISION"), `${containmentRevision}\n`, { mode: 0o644 });
  await chmod(join(root, "ACTIVE_REVISION"), 0o644);
  await writeFile(join(sourceRoot, ".refunddesk-revision"), `${containmentRevision}\n`, {
    mode: 0o600,
  });
  await chmod(join(sourceRoot, ".refunddesk-revision"), 0o600);
  await symlink(sourceRoot, join(root, "current"));

  const manifest = {
    schemaVersion: 1,
    revision: containmentRevision,
    source: "https://github.com/selimhehe1/RefundDesk",
    platform: "linux/amd64",
    createdAt: "2026-08-08T12:00:00Z",
    bundle: {
      file: `refunddesk-sandbox-${containmentRevision}.images.tar.zst`,
      sha256: "a".repeat(64),
    },
    images: [
      {
        role: "migrate",
        expectedUser: "node",
        imageId: containmentImageIds.migrate,
        reference: containmentReferences.migrate,
      },
      {
        role: "web",
        expectedUser: "node",
        imageId: containmentImageIds.web,
        reference: containmentReferences.web,
      },
      {
        role: "worker",
        expectedUser: "node",
        imageId: containmentImageIds.worker,
        reference: containmentReferences.worker,
      },
    ],
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  await writeFile(manifestPath, manifestBytes, { mode: 0o644 });
  await chmod(manifestPath, 0o644);
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");

  await writeFile(
    join(configRoot, "release.env"),
    `REFUNDDESK_IMAGE_TAG=sandbox-${containmentRevision}\nREFUNDDESK_REVISION=${containmentRevision}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(configRoot, "platform.env"),
    "REFUNDDESK_GLOBAL_LIVE_ENABLED=false\nSTRIPE_ACCOUNT_LIVE_WEBHOOK_SECRET=disabled\n",
    { mode: 0o600 },
  );
  await writeFile(join(configRoot, "worker.env"), "REFUNDDESK_GLOBAL_LIVE_ENABLED=false\n", {
    mode: 0o600,
  });
  for (const file of ["release.env", "platform.env", "worker.env"]) {
    await chmod(join(configRoot, file), 0o600);
  }
  const journal = {
    operation,
    revision: containmentRevision,
    schemaVersion: 1,
    status: "in_progress",
  };
  await writeFile(
    join(controlRoot, "runtime-quiesce-in-progress.json"),
    `${JSON.stringify(journal, Object.keys(journal).sort())}\n`,
    { mode: 0o600 },
  );
  await chmod(join(controlRoot, "runtime-quiesce-in-progress.json"), 0o600);
  await writeFile(operatorLock, "", { mode: 0o600 });
  await chmod(operatorLock, 0o600);

  const source = "https://github.com/selimhehe1/RefundDesk";
  const images = Object.fromEntries(
    Object.entries(containmentReferences).map(([role, reference]) => [
      reference,
      {
        Id: containmentImageIds[role],
        Os: "linux",
        Architecture: "amd64",
        Config:
          role === "postgres"
            ? {
                User: "",
                Labels: {},
                Env: [...containmentPostgresImageEnvironment],
                Entrypoint: ["docker-entrypoint.sh"],
                Cmd: ["postgres"],
                WorkingDir: "",
                StopSignal: "SIGINT",
                Healthcheck: null,
                Shell: null,
                ExposedPorts: { "5432/tcp": {} },
                Volumes: { "/var/lib/postgresql": {} },
              }
            : {
                User: new Set(["worker", "web", "migrate"]).has(role) ? "node" : "",
                Labels: new Set(["worker", "web", "migrate"]).has(role)
                  ? {
                      "org.opencontainers.image.revision": containmentRevision,
                      "org.opencontainers.image.source": source,
                    }
                  : {},
              },
      },
    ]),
  );
  const state = {
    images,
    containers: [
      containmentContainer("postgres", "1"),
      containmentContainer("verifier", "2"),
      containmentContainer("worker", "3"),
      containmentContainer("web", "4"),
      containmentContainer("caddy", "5"),
      containmentReservation(),
    ],
    nextContainerId: "9".repeat(64),
    units: {
      "refunddesk-backup.timer": "active",
      "refunddesk-retention.timer": "active",
      "refunddesk-backup.service": "inactive",
      "refunddesk-retention.service": "inactive",
      "refunddesk-quiesce-recovery.service": "inactive",
    },
    releaseUnits: [],
    listeners: { tcp80: true, tcp443: true, udp80: false, udp443: false },
    stickyListeners,
    financeLine: "7574638204102381941|0|0|0|0|0|0|34|100",
    operations: [],
  };
  await writeFile(fakeStatePath, `${JSON.stringify(state)}\n`);

  const fakeSource = await readFile(
    resolve(directory, "test-fixtures/containment-host-command.py"),
  );
  const fakeExecutable = join(fakeBin, "containment-host-command.py");
  await writeFile(fakeExecutable, fakeSource, { mode: 0o755 });
  await chmod(fakeExecutable, 0o755);
  for (const command of ["docker", "systemctl", "ss"]) {
    await symlink(fakeExecutable, join(fakeBin, command));
  }

  return {
    temporaryDirectory,
    root,
    configRoot,
    controlRoot,
    runtimeRoot,
    operatorLock,
    fakeBin,
    fakeStatePath,
    manifestSha256,
  };
}

test("exact-8da containment runner is stop-only, bounded and source-pinned", async () => {
  const runner = await read("scripts/reconcile-host-containment.sh");
  assert.match(runner, /readonly EXACT_REVISION="8da280b78a9d1475c7bd79063e72c5af77121e8d"/u);
  assert.match(runner, /readonly EXACT_COMPOSE_SHA256="92a96553/u);
  assert.match(runner, /readonly EXACT_COMMON_SHA256="e3582a5/u);
  assert.match(runner, /readonly EXACT_HELPER_SHA256="76fba53/u);
  assert.match(runner, /flock --exclusive --timeout 30 9/u);
  assert.match(runner, /timeout 20 python3 "\$\{HELPER_FILE\}" clear-quiesce/u);
  assert.match(runner, /for service in caddy worker bootstrap migrate maintenance/u);
  assert.match(runner, /admissionInvariantSha256/u);
  assert.match(runner, /containedStateSha256/u);
  assert.match(runner, /captures: \{admission: \$admission/u);
  assert.doesNotMatch(
    runner,
    /recover_retention_database_owner_job|clear_database_owner_job_reservation/u,
  );
  const executableLines = runner
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(
    executableLines,
    /^\s*(?:timeout [0-9]+ )?(?:refunddesk_compose (?:up|start)(?:\s|$)|docker (?:compose )?(?:up|start)(?:\s|$)|systemctl (?:enable|start)(?:\s|$)|(?:stripe|aws|ssh)(?:\s|$))/imu,
  );
  assert.doesNotMatch(
    executableLines,
    /^\s*(?:timeout [0-9]+ )?docker (?:rm|create|rename)(?:\s|$)/imu,
  );
});

test("exact-8da containment runner passes, fails closed, and resumes after durable clear", async (t) => {
  if (process.platform === "win32") {
    t.skip("Linux ownership, flock and command fixtures run in CI");
    return;
  }
  for (const command of ["bash", "jq", "python3", "sha256sum", "timeout"]) {
    const probe = spawnSync(command, ["--version"], { encoding: "utf8" });
    if (probe.error?.code === "ENOENT") {
      t.skip(`${command} is unavailable; Linux CI executes this contract`);
      return;
    }
  }

  const runnerPath = resolve(directory, "scripts/reconcile-host-containment.sh");
  const runnerBytes = await readFile(runnerPath);
  const runnerSha256 = createHash("sha256").update(runnerBytes).digest("hex");
  const traceRunner = process.env.REFUNDDESK_CONTAINMENT_TEST_TRACE === "1";
  let invocationRunnerPath = runnerPath;
  if (traceRunner) {
    const traceDirectory = await mkdtemp(join(tmpdir(), "refunddesk-containment-trace-"));
    invocationRunnerPath = join(traceDirectory, "reconcile-host-containment.trace.sh");
    const traceBytes = runnerBytes
      .toString("utf8")
      .replace("set +x", "PS4='+${LINENO}: '\nset -x")
      .replace("exec 2>/dev/null", "exec 2>&2");
    await writeFile(invocationRunnerPath, traceBytes, { mode: 0o700 });
    await chmod(invocationRunnerPath, 0o700);
    t.after(() => rm(traceDirectory, { force: true, recursive: true }));
  }
  const schema = JSON.parse(
    await readFile(
      resolve(
        directory,
        "../../docs/schemas/refunddesk-lightsail-containment-reconciliation-v1.schema.json",
      ),
      "utf8",
    ),
  );
  const { validateContainmentReconciliationDocument } =
    await import("../../scripts/validate-lightsail-containment-reconciliation.mjs");

  const invokeFixture = (fixture, nonce, extraEnvironment = {}) => {
    const notBefore = containmentTimestamp(Date.now() - 10_000);
    const result = spawnSync(
      "bash",
      [
        invocationRunnerPath,
        "--nonce",
        nonce,
        "--expected-revision",
        containmentRevision,
        "--runner-sha256",
        runnerSha256,
      ],
      {
        encoding: "utf8",
        timeout: 180_000,
        env: {
          ...process.env,
          PATH: `${fixture.fakeBin}:${process.env.PATH}`,
          REFUNDDESK_CONTAINMENT_TEST_MODE: "1",
          REFUNDDESK_CONTAINMENT_ROOT: fixture.root,
          REFUNDDESK_CONTAINMENT_CONFIG_ROOT: fixture.configRoot,
          REFUNDDESK_CONTAINMENT_CONTROL_ROOT: fixture.controlRoot,
          REFUNDDESK_CONTAINMENT_RUNTIME_ROOT: fixture.runtimeRoot,
          REFUNDDESK_CONTAINMENT_OPERATOR_LOCK: fixture.operatorLock,
          REFUNDDESK_CONTAINMENT_TEST_MANIFEST_SHA256: fixture.manifestSha256,
          REFUNDDESK_CONTAINMENT_FAKE_STATE: fixture.fakeStatePath,
          ...extraEnvironment,
        },
      },
    );
    const notAfter = containmentTimestamp(Date.now() + 10_000);
    return { result, notBefore, notAfter };
  };

  const runFixture = (fixture, nonce, extraEnvironment = {}) => {
    const { result, notBefore, notAfter } = invokeFixture(fixture, nonce, extraEnvironment);
    assert.equal(result.signal, null);
    if (!traceRunner) assert.equal(result.stderr, "");
    assert.ok(Buffer.byteLength(result.stdout) < 128 * 1024);
    assert.notEqual(
      result.stdout,
      "",
      `runner emitted no JSON (status ${result.status})\n${result.stderr.slice(0, 48_000)}`,
    );
    const document = JSON.parse(result.stdout);
    let validated;
    try {
      validated = validateContainmentReconciliationDocument(Buffer.from(result.stdout), {
        schema,
        expectedNonce: nonce,
        expectedRunnerSha256: runnerSha256,
        processExitCode: result.status,
        notBefore,
        notAfter,
      });
    } catch (error) {
      if (traceRunner && error instanceof Error) {
        const failureOffset = result.stderr.indexOf("fail HOST_INVENTORY_UNAVAILABLE");
        const traceStart = Math.max(0, failureOffset - 48_000);
        const traceEnd = failureOffset < 0 ? 48_000 : failureOffset + 4_000;
        error.message += `\nrunner status=${result.status} result=${document.result} code=${document.code}\n${result.stderr.slice(traceStart, traceEnd)}`;
      }
      throw error;
    }
    assert.equal(validated.remote.nonce, nonce);
    return { result, document };
  };

  await t.test("backup containment reaches complete without a start surface", async () => {
    const fixture = await createContainmentHostFixture("backup");
    try {
      const protectedSourcePaths = [
        join(
          fixture.root,
          "releases",
          containmentRevision,
          "source",
          "deploy",
          "lightsail",
          "compose.yml",
        ),
        join(
          fixture.root,
          "releases",
          containmentRevision,
          "source",
          "deploy",
          "lightsail",
          "scripts",
          "_common.sh",
        ),
        join(
          fixture.root,
          "releases",
          containmentRevision,
          "source",
          "deploy",
          "lightsail",
          "scripts",
          "release-transition-journal.py",
        ),
      ];
      const sourceDigestsBefore = await Promise.all(
        protectedSourcePaths.map(async (path) =>
          createHash("sha256")
            .update(await readFile(path))
            .digest("hex"),
        ),
      );
      const { result, document } = runFixture(fixture, "a".repeat(64));
      assert.equal(result.status, 0, result.stdout);
      assert.equal(document.code, "PASS_CONTAINED_JOURNAL_CLEARED");
      assert.equal(document.marker.resumedFromState, "absent");
      assert.equal(document.marker.journalPresentAtInvocationStart, true);
      assert.equal(document.marker.state, "complete");
      assert.match(document.marker.admissionInvariantSha256, /^[0-9a-f]{64}$/u);
      assert.match(document.marker.containedStateSha256, /^[0-9a-f]{64}$/u);
      assert.equal(document.captures.admission.surface.backupTimerActive, true);
      assert.equal(document.captures.admission.surface.retentionTimerActive, true);
      assert.equal(document.captures.admission.surface.tcp80Listening, true);
      assert.equal(document.captures.admission.surface.tcp443Listening, true);
      assert.equal(document.captures.admission.control.knownOneShotsPresentCount, 0);
      assert.equal(document.captures.before.a.control.knownOneShotsPresentCount, 0);
      assert.equal(document.mutations.markerTransitions, 4);
      assert.equal(document.mutations.journalCleared, 1);
      assert.equal(document.mutations.reservationReconciled, 0);
      const state = JSON.parse(await readFile(fixture.fakeStatePath, "utf8"));
      assert.equal(state.financeLine, "7574638204102381941|0|0|0|0|0|0|34|100");
      assert.deepEqual(
        await Promise.all(
          protectedSourcePaths.map(async (path) =>
            createHash("sha256")
              .update(await readFile(path))
              .digest("hex"),
          ),
        ),
        sourceDigestsBefore,
      );
      const operations = state.operations.join("\n");
      assert.ok(
        state.operations.indexOf("docker:update:caddy") <
          state.operations.indexOf("docker:update:worker"),
      );
      assert.ok(
        state.operations.indexOf("docker:stop:caddy") <
          state.operations.indexOf("docker:stop:worker"),
      );
      assert.doesNotMatch(operations, /(?:^|:)(?:start|up|release|stripe|aws|ssh)(?::|$)/iu);
      await assert.rejects(readFile(join(fixture.controlRoot, "runtime-quiesce-in-progress.json")));
    } finally {
      await rm(fixture.temporaryDirectory, { force: true, recursive: true });
    }
  });

  await t.test("retention preserves the exact reservation without repair", async () => {
    const fixture = await createContainmentHostFixture("retention");
    try {
      const { result, document } = runFixture(fixture, "e".repeat(64));
      assert.equal(result.status, 0, result.stdout);
      assert.equal(document.operation, "retention");
      assert.equal(document.mutations.reservationReconciled, 0);
      const state = JSON.parse(await readFile(fixture.fakeStatePath, "utf8"));
      assert.equal(
        state.operations.some((operation) => /docker:(?:rm|create|rename):/u.test(operation)),
        false,
      );
    } finally {
      await rm(fixture.temporaryDirectory, { force: true, recursive: true });
    }
  });

  await t.test("financial work rejects before any containment mutation", async () => {
    const fixture = await createContainmentHostFixture("backup");
    try {
      const state = JSON.parse(await readFile(fixture.fakeStatePath, "utf8"));
      state.financeLine = "7574638204102381941|1|0|0|0|0|0|34|100";
      await writeFile(fixture.fakeStatePath, `${JSON.stringify(state)}\n`);
      const { result, document } = runFixture(fixture, "f".repeat(64));
      assert.equal(result.status, 20, result.stdout);
      assert.equal(document.code, "FINANCIAL_WORK_ACTIVE");
      assert.equal(document.marker.state, "absent");
      assert.equal(document.mutations.unitsStopRequested, 0);
      const finalState = JSON.parse(await readFile(fixture.fakeStatePath, "utf8"));
      assert.equal(
        finalState.operations.some(
          (operation) =>
            operation.startsWith("systemctl:stop:") || operation.startsWith("docker:update:"),
        ),
        false,
      );
      assert.equal(
        JSON.parse(
          await readFile(join(fixture.controlRoot, "runtime-quiesce-in-progress.json"), "utf8"),
        ).operation,
        "backup",
      );
    } finally {
      await rm(fixture.temporaryDirectory, { force: true, recursive: true });
    }
  });

  for (const [name, nonceCharacter, mutate] of [
    [
      "unavailable systemd inventory",
      "1",
      (state) => {
        state.systemdUnavailable = true;
      },
    ],
    [
      "unavailable listener inventory",
      "2",
      (state) => {
        state.listenerUnavailable = true;
      },
    ],
    [
      "active quiesce recovery service",
      "3",
      (state) => {
        state.units["refunddesk-quiesce-recovery.service"] = "active";
      },
    ],
    [
      "stopped stale maintenance container",
      "4",
      (state) => {
        const maintenance = containmentContainer("migrate", "7");
        maintenance.Name = "/refunddesk-maintenance-stale";
        maintenance.Config.Labels["com.docker.compose.service"] = "maintenance";
        maintenance.State.Running = false;
        maintenance.State.Status = "exited";
        maintenance.HostConfig.RestartPolicy.Name = "no";
        state.containers.push(maintenance);
      },
    ],
    [
      "invalid database owner reservation",
      "5",
      (state) => {
        const reservation = state.containers.find(
          (container) =>
            container.Config.Labels["com.docker.compose.service"] === "database-owner-reservation",
        );
        reservation.HostConfig.RestartPolicy.Name = "unless-stopped";
      },
    ],
    [
      "reservation with an arbitrary image",
      "6",
      (state) => {
        const reservation = state.containers.find(
          (container) =>
            container.Config.Labels["com.docker.compose.service"] === "database-owner-reservation",
        );
        reservation.Image = `sha256:${"f".repeat(64)}`;
      },
    ],
    [
      "reservation with a bind mount",
      "7",
      (state) => {
        const reservation = state.containers.find(
          (container) =>
            container.Config.Labels["com.docker.compose.service"] === "database-owner-reservation",
        );
        reservation.HostConfig.Binds = ["/tmp/fixture-source:/tmp/fixture-target:ro"];
        reservation.Mounts = [
          {
            Type: "bind",
            Source: "/tmp/fixture-source",
            Destination: "/tmp/fixture-target",
            RW: false,
          },
        ];
      },
    ],
    [
      "reservation with a published port",
      "8",
      (state) => {
        const reservation = state.containers.find(
          (container) =>
            container.Config.Labels["com.docker.compose.service"] === "database-owner-reservation",
        );
        reservation.HostConfig.PortBindings = {
          "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "15432" }],
        };
        reservation.NetworkSettings.Ports["5432/tcp"] = [
          { HostIp: "127.0.0.1", HostPort: "15432" },
        ];
      },
    ],
    [
      "privileged reservation",
      "9",
      (state) => {
        const reservation = state.containers.find(
          (container) =>
            container.Config.Labels["com.docker.compose.service"] === "database-owner-reservation",
        );
        reservation.HostConfig.Privileged = true;
      },
    ],
    [
      "reservation with an added capability",
      "a",
      (state) => {
        const reservation = state.containers.find(
          (container) =>
            container.Config.Labels["com.docker.compose.service"] === "database-owner-reservation",
        );
        reservation.HostConfig.CapAdd = ["SYS_ADMIN"];
      },
    ],
    [
      "reservation without no-new-privileges",
      "b",
      (state) => {
        const reservation = state.containers.find(
          (container) =>
            container.Config.Labels["com.docker.compose.service"] === "database-owner-reservation",
        );
        reservation.HostConfig.SecurityOpt = [];
      },
    ],
    [
      "reservation with a command override",
      "c",
      (state) => {
        const reservation = state.containers.find(
          (container) =>
            container.Config.Labels["com.docker.compose.service"] === "database-owner-reservation",
        );
        reservation.Config.Cmd = ["postgres"];
        reservation.Args = ["postgres"];
      },
    ],
    [
      "reservation with stdout detached",
      "0",
      (state) => {
        const reservation = state.containers.find(
          (container) =>
            container.Config.Labels["com.docker.compose.service"] === "database-owner-reservation",
        );
        reservation.Config.AttachStdout = false;
      },
    ],
    [
      "reservation with stderr detached",
      "1",
      (state) => {
        const reservation = state.containers.find(
          (container) =>
            container.Config.Labels["com.docker.compose.service"] === "database-owner-reservation",
        );
        reservation.Config.AttachStderr = false;
      },
    ],
    [
      "reservation with a user override",
      "d",
      (state) => {
        const reservation = state.containers.find(
          (container) =>
            container.Config.Labels["com.docker.compose.service"] === "database-owner-reservation",
        );
        reservation.Config.User = "0:0";
      },
    ],
    [
      "reservation with an injected secret environment binding",
      "e",
      (state) => {
        const reservation = state.containers.find(
          (container) =>
            container.Config.Labels["com.docker.compose.service"] === "database-owner-reservation",
        );
        reservation.Config.Env.push("DATABASE_URL=synthetic-denied");
      },
    ],
    [
      "reservation without its memory and pid limits",
      "f",
      (state) => {
        const reservation = state.containers.find(
          (container) =>
            container.Config.Labels["com.docker.compose.service"] === "database-owner-reservation",
        );
        reservation.HostConfig.Memory = 0;
        reservation.HostConfig.PidsLimit = 0;
      },
    ],
  ]) {
    await t.test(`${name} rejects before any effect`, async () => {
      const fixture = await createContainmentHostFixture("backup");
      try {
        const state = JSON.parse(await readFile(fixture.fakeStatePath, "utf8"));
        mutate(state);
        await writeFile(fixture.fakeStatePath, `${JSON.stringify(state)}\n`);
        const { result, document } = runFixture(fixture, nonceCharacter.repeat(64));
        assert.equal(result.status, 20, result.stdout);
        assert.equal(document.marker.state, "absent");
        assert.equal(document.mutations.unitsStopRequested, 0);
        assert.equal(document.mutations.containersRestartFenced, 0);
        assert.equal(document.mutations.containersStopped, 0);
        assert.equal(document.mutations.reservationReconciled, 0);
        const finalState = JSON.parse(await readFile(fixture.fakeStatePath, "utf8"));
        assert.equal(
          finalState.operations.some((operation) =>
            /^(?:systemctl:stop|docker:(?:update|stop|kill|rm|create|rename)):/u.test(operation),
          ),
          false,
        );
        assert.equal(
          JSON.parse(
            await readFile(join(fixture.controlRoot, "runtime-quiesce-in-progress.json"), "utf8"),
          ).operation,
          "backup",
        );
      } finally {
        await rm(fixture.temporaryDirectory, { force: true, recursive: true });
      }
    });
  }

  await t.test(
    "an uncleared public listener fails with journal and containment fence preserved",
    async () => {
      const fixture = await createContainmentHostFixture("backup", { stickyListeners: true });
      try {
        const { result, document } = runFixture(fixture, "b".repeat(64));
        assert.equal(result.status, 20, result.stdout);
        assert.equal(document.result, "FAIL");
        assert.equal(document.marker.state, "prepared");
        assert.equal(document.mutations.journalCleared, 0);
        assert.equal(document.mutations.unitsStopRequested, 5);
        assert.equal(document.mutations.containersRestartFenced, 2);
        assert.equal(document.mutations.containersStopped, 2);
        assert.equal(document.mutations.reservationReconciled, 0);
        assert.equal(
          JSON.parse(
            await readFile(join(fixture.controlRoot, "runtime-quiesce-in-progress.json"), "utf8"),
          ).operation,
          "backup",
        );
        const state = JSON.parse(await readFile(fixture.fakeStatePath, "utf8"));
        for (const service of ["worker", "caddy"]) {
          const container = state.containers.find(
            (candidate) => candidate.Config.Labels["com.docker.compose.service"] === service,
          );
          assert.equal(container.State.Running, false);
          assert.equal(container.HostConfig.RestartPolicy.Name, "no");
        }
      } finally {
        await rm(fixture.temporaryDirectory, { force: true, recursive: true });
      }
    },
  );

  for (const [killPoint, nonceCharacter, expectedResumeStops] of [
    ["after_prepared", "6", 2],
    ["after_units", "7", 2],
    ["after_caddy", "8", 1],
    ["after_worker", "9", 0],
  ]) {
    await t.test(`SIGKILL ${killPoint} resumes directly without replayed claims`, async () => {
      const fixture = await createContainmentHostFixture("backup");
      try {
        const interrupted = invokeFixture(fixture, nonceCharacter.repeat(64), {
          REFUNDDESK_CONTAINMENT_TEST_KILL_POINT: killPoint,
        }).result;
        assert.equal(interrupted.status, null);
        assert.equal(interrupted.signal, "SIGKILL");
        assert.equal(interrupted.stdout, "");
        if (!traceRunner) assert.equal(interrupted.stderr, "");
        const marker = JSON.parse(
          await readFile(join(fixture.controlRoot, "containment-reconciliation.json"), "utf8"),
        );
        assert.equal(marker.state, "prepared");
        assert.match(marker.admissionInvariantSha256, /^[0-9a-f]{64}$/u);
        assert.equal(marker.containedStateSha256, null);
        assert.equal(
          JSON.parse(
            await readFile(join(fixture.controlRoot, "runtime-quiesce-in-progress.json"), "utf8"),
          ).operation,
          "backup",
        );

        const resumed = runFixture(fixture, (15 - Number(nonceCharacter)).toString(16).repeat(64));
        assert.equal(resumed.result.status, 0, resumed.result.stdout);
        assert.equal(resumed.document.marker.resumedFromState, "prepared");
        assert.equal(resumed.document.marker.state, "complete");
        assert.equal(resumed.document.mutations.markerTransitions, 4);
        assert.equal(resumed.document.mutations.journalCleared, 1);
        assert.equal(resumed.document.mutations.reservationReconciled, 0);
        assert.equal(resumed.document.mutations.unitsStopRequested, 5);
        assert.equal(resumed.document.mutations.containersStopped, expectedResumeStops);
        const state = JSON.parse(await readFile(fixture.fakeStatePath, "utf8"));
        assert.equal(
          state.operations.filter((operation) => operation === "docker:stop:caddy").length,
          1,
        );
        assert.equal(
          state.operations.filter((operation) => operation === "docker:stop:worker").length,
          1,
        );
      } finally {
        await rm(fixture.temporaryDirectory, { force: true, recursive: true });
      }
    });
  }

  await t.test(
    "contained digest drift is rejected before effects while the journal remains",
    async () => {
      const fixture = await createContainmentHostFixture("backup");
      try {
        const interrupted = invokeFixture(fixture, "0".repeat(64), {
          REFUNDDESK_CONTAINMENT_TEST_KILL_POINT: "after_contained_verified",
        }).result;
        assert.equal(interrupted.status, null);
        assert.equal(interrupted.signal, "SIGKILL");
        assert.equal(interrupted.stdout, "");
        const marker = JSON.parse(
          await readFile(join(fixture.controlRoot, "containment-reconciliation.json"), "utf8"),
        );
        assert.equal(marker.state, "contained_verified");
        assert.match(marker.containedStateSha256, /^[0-9a-f]{64}$/u);
        assert.equal(
          JSON.parse(
            await readFile(join(fixture.controlRoot, "runtime-quiesce-in-progress.json"), "utf8"),
          ).operation,
          "backup",
        );

        const driftedState = JSON.parse(await readFile(fixture.fakeStatePath, "utf8"));
        const driftedWorker = driftedState.containers.find(
          (container) => container.Config.Labels["com.docker.compose.service"] === "worker",
        );
        driftedWorker.State.Status = "created";
        const mutationPattern =
          /^(?:systemctl:stop|docker:(?:update|stop|kill|rm|create|rename)):/u;
        const mutationsBefore = driftedState.operations.filter((operation) =>
          mutationPattern.test(operation),
        );
        await writeFile(fixture.fakeStatePath, `${JSON.stringify(driftedState)}\n`);

        const rejected = runFixture(fixture, "1".repeat(64));
        assert.equal(rejected.result.status, 20, rejected.result.stdout);
        assert.equal(rejected.document.code, "CAPTURE_CHANGED");
        assert.equal(rejected.document.marker.state, "contained_verified");
        assert.equal(rejected.document.marker.resumedFromState, "contained_verified");
        assert.equal(rejected.document.marker.journalPresentAtInvocationStart, true);
        assert.equal(rejected.document.mutations.markerTransitions, 2);
        assert.equal(rejected.document.mutations.journalCleared, 0);
        assert.equal(rejected.document.mutations.unitsStopRequested, 0);
        assert.equal(rejected.document.mutations.containersRestartFenced, 0);
        assert.equal(rejected.document.mutations.containersStopped, 0);
        assert.equal(rejected.document.mutations.reservationReconciled, 0);
        const rejectedState = JSON.parse(await readFile(fixture.fakeStatePath, "utf8"));
        assert.deepEqual(
          rejectedState.operations.filter((operation) => mutationPattern.test(operation)),
          mutationsBefore,
        );
        assert.equal(
          JSON.parse(
            await readFile(join(fixture.controlRoot, "runtime-quiesce-in-progress.json"), "utf8"),
          ).operation,
          "backup",
        );

        rejectedState.containers.find(
          (container) => container.Config.Labels["com.docker.compose.service"] === "worker",
        ).State.Status = "exited";
        await writeFile(fixture.fakeStatePath, `${JSON.stringify(rejectedState)}\n`);
        const resumed = runFixture(fixture, "2".repeat(64));
        assert.equal(resumed.result.status, 0, resumed.result.stdout);
        assert.equal(resumed.document.marker.resumedFromState, "contained_verified");
        assert.equal(resumed.document.marker.journalPresentAtInvocationStart, true);
        assert.equal(resumed.document.marker.state, "complete");
      } finally {
        await rm(fixture.temporaryDirectory, { force: true, recursive: true });
      }
    },
  );

  await t.test("fresh nonce resumes contained_verified after durable journal unlink", async () => {
    const fixture = await createContainmentHostFixture("backup");
    try {
      const interrupted = runFixture(fixture, "c".repeat(64), {
        REFUNDDESK_CONTAINMENT_TEST_ABORT_AFTER_CLEAR: "1",
      });
      assert.equal(interrupted.result.status, 21, interrupted.result.stdout);
      assert.equal(interrupted.document.marker.state, "contained_verified");
      assert.equal(interrupted.document.mutations.journalCleared, 1);
      await assert.rejects(readFile(join(fixture.controlRoot, "runtime-quiesce-in-progress.json")));
      const resumed = runFixture(fixture, "d".repeat(64));
      assert.equal(resumed.result.status, 0, resumed.result.stdout);
      assert.equal(resumed.document.marker.resumedFromState, "contained_verified");
      assert.equal(resumed.document.marker.journalPresentAtInvocationStart, false);
      assert.equal(resumed.document.marker.state, "complete");
      assert.equal(resumed.document.mutations.markerTransitions, 4);
    } finally {
      await rm(fixture.temporaryDirectory, { force: true, recursive: true });
    }
  });
});
