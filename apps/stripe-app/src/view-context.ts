import type { ExtensionContextValue } from "@stripe/ui-extension-sdk/context";

export function viewContextKey(
  context: ExtensionContextValue,
  includeObjectContext: boolean,
): string {
  const objectContext = includeObjectContext ? context.environment.objectContext : null;
  const constants =
    typeof context.environment.constants === "object" &&
    context.environment.constants !== null &&
    !Array.isArray(context.environment.constants)
      ? (context.environment.constants as Record<string, unknown>)
      : {};
  return JSON.stringify([
    context.userContext.account.id,
    context.userContext.account.isSandbox,
    context.userContext.id ?? null,
    context.environment.mode,
    constants["API_BASE"] ?? null,
    constants["PILOT_LIVE_ENABLED"] ?? null,
    objectContext?.object ?? null,
    objectContext?.id ?? null,
  ]);
}
