#!/usr/bin/env node

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { spawnSync } from "node:child_process";

const [command, ...args] = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(process.env.POSTFLIGHT_SCENARIO_FILE, "utf8"));
const revision = process.env.POSTFLIGHT_REVISION;
const phaseFile = process.env.POSTFLIGHT_PHASE_FILE;

const containerIds = {
  postgres: "1".repeat(64),
  verifier: "2".repeat(64),
  worker: "3".repeat(64),
  web: "4".repeat(64),
  caddy: "5".repeat(64),
};
const imageIds = {
  postgres: `sha256:${"a".repeat(64)}`,
  verifier: `sha256:${"b".repeat(64)}`,
  worker: `sha256:${"c".repeat(64)}`,
  web: `sha256:${"d".repeat(64)}`,
  caddy: `sha256:${"b".repeat(64)}`,
};

function phase() {
  if (!existsSync(phaseFile)) return 0;
  return readFileSync(phaseFile, "utf8").trim().length;
}

function serviceForId(id) {
  return Object.entries(containerIds).find(([, value]) => value === id)?.[0];
}

function stateFor(service) {
  if (scenario.coreRuntimeStopped && new Set(["verifier", "web"]).has(service))
    return ["exited", "none"];
  if (service === "worker")
    return scenario.workerRunning ? ["running", "healthy"] : ["exited", "none"];
  if (service === "caddy")
    return scenario.caddyRunning ? ["running", "healthy"] : ["exited", "none"];
  if (service === "web" && scenario.captureChanged && phase() > 0) {
    return ["exited", "none"];
  }
  if (service === "web" && scenario.webRuntimeState === "running-unhealthy")
    return ["running", "unhealthy"];
  if (service === "web" && scenario.webRuntimeState === "restarting")
    return ["restarting", "starting"];
  if (service === "web" && scenario.webRuntimeState === "paused") return ["paused", "none"];
  return ["running", "healthy"];
}

function write(line = "") {
  process.stdout.write(line.length === 0 ? "" : `${line}\n`);
}

if (command === "timeout") {
  const [, executable, ...childArgs] = args;
  const result = spawnSync(executable, childArgs, { env: process.env, stdio: "inherit" });
  process.exit(result.status ?? 125);
}

if (command === "docker") {
  if (args[0] === "container" && args[1] === "ls") {
    const serviceFilter = args.find((value) =>
      value.startsWith("label=com.docker.compose.service="),
    );
    if (serviceFilter) {
      const service = serviceFilter.slice(serviceFilter.lastIndexOf("=") + 1);
      if (!scenario.missingService || scenario.missingService !== service)
        write(containerIds[service]);
      process.exit(0);
    }
    const running = Object.keys(containerIds).filter(
      (service) => stateFor(service)[0] === "running",
    );
    for (const service of running) write(containerIds[service]);
    if (scenario.unexpectedRunning) write("f".repeat(64));
    process.exit(0);
  }
  if (args[0] === "image" && args[1] === "inspect") {
    if (scenario.expectedImageUnavailable) process.exit(1);
    const reference = args.at(-1);
    if (reference.startsWith("postgres:"))
      write(scenario.expectedImageMismatch ? `sha256:${"f".repeat(64)}` : imageIds.postgres);
    else if (reference.startsWith("caddy:")) write(imageIds.caddy);
    else process.exit(1);
    process.exit(0);
  }
  if (args[0] === "inspect") {
    const id = args.at(-1);
    const service = serviceForId(id);
    if (!service) process.exit(1);
    const [state, health] = stateFor(service);
    const revisionLabel = service === "postgres" ? "<no value>" : revision;
    const globalToken =
      new Set(["web", "worker"]).has(service) && !(scenario.runtimeLiveEnabled && service === "web")
        ? scenario.runtimeLiveDuplicate && service === "web"
          ? "global-disabledglobal-other"
          : "global-disabled"
        : scenario.runtimeLiveEnabled && service === "web"
          ? "global-other"
          : "";
    const webhookToken =
      service === "web" && !scenario.runtimeWebhookEnabled
        ? scenario.runtimeWebhookDuplicate
          ? "webhook-disabledwebhook-other"
          : "webhook-disabled"
        : scenario.runtimeWebhookEnabled && service === "web"
          ? "webhook-other"
          : "";
    const workerModeToken =
      service === "worker"
        ? scenario.workerRuntimeMode === "normal"
          ? "worker-normal"
          : scenario.workerRuntimeMode === "incident_admission"
            ? "worker-incident"
            : scenario.workerRuntimeMode
              ? "worker-other"
              : ""
        : "";
    write(
      `${id}|${imageIds[service]}|${scenario.imageReferenceMismatch && service === "web" ? "false" : "true"}|${service === "caddy" || (scenario.unexpectedPublishedPort && service === "web") ? "false" : "true"}|${state}|${health}|true|true|${revisionLabel}|${globalToken}|${webhookToken}|${workerModeToken}`,
    );
    process.exit(0);
  }
  if (args[0] === "exec") {
    if (scenario.databaseUnavailable) process.exit(1);
    const active = scenario.financialActive ? 1 : 0;
    write(`7612345678901234567|${active}|${active}|${active}|0|0|0|2|3|4|5|6|9`);
    process.exit(0);
  }
  process.exit(1);
}

if (command === "systemctl") {
  if (args[0] === "show") {
    const unit = args[1];
    const active = scenario.maintenanceActive && unit === "refunddesk-retention.timer";
    const deactivating = scenario.maintenanceDeactivating && unit === "refunddesk-retention.timer";
    write(active ? "active" : deactivating ? "deactivating" : "inactive");
    process.exit(0);
  }
  if (args[0] === "list-units") {
    if (scenario.releaseFenceActive || scenario.releaseFenceDeactivating) {
      write(
        `refunddesk-release-fence-${revision.slice(0, 12)}-123.service loaded active running fixture`,
      );
    }
    if (scenario.captureChanged) appendFileSync(phaseFile, "x", { encoding: "utf8" });
    process.exit(0);
  }
  process.exit(1);
}

if (command === "ss") {
  const joined = args.join(" ");
  if (scenario.listener80 && joined.includes(":80")) write("LISTEN fixture");
  if (scenario.listener443 && joined.includes(":443")) write("LISTEN fixture");
  process.exit(0);
}

process.stderr.write(`unknown fake command: ${basename(command ?? "")}\n`);
process.exit(127);
