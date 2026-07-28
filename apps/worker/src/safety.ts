import type { WorkerInstallation } from "./ports.js";

export class LiveModeRejectedError extends Error {
  readonly code = "LIVE_MODE_REJECTED";

  constructor() {
    super("RefundDesk pilot worker does not execute live work");
    this.name = "LiveModeRejectedError";
  }
}

export function assertPilotConfiguration(config: { readonly liveEnabled: boolean }): void {
  if (config.liveEnabled) {
    throw new LiveModeRejectedError();
  }
}

export function assertPilotInstallation(
  installation: Pick<WorkerInstallation, "active" | "environment" | "tenantLiveEnabled">,
): void {
  if (!installation.active) {
    throw new Error("INSTALLATION_INACTIVE");
  }
  if (installation.environment === "live" || installation.tenantLiveEnabled) {
    throw new LiveModeRejectedError();
  }
}
