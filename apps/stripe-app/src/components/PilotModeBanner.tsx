import type { ExtensionContextValue } from "@stripe/ui-extension-sdk/context";
import { Badge, Banner, Box } from "@stripe/ui-extension-sdk/ui";

export function PilotModeBanner({ context }: { readonly context: ExtensionContextValue }) {
  if (context.environment.mode === "live") {
    return (
      <Banner
        type="critical"
        title="Live mode is disabled"
        description="This pilot never sends live refund or workflow requests."
      />
    );
  }

  const sandbox = context.userContext.account.isSandbox;
  return (
    <Banner
      title={sandbox ? "Managed sandbox" : "Test mode"}
      description="RefundDesk is restricted to synthetic card payments in this environment."
    />
  );
}

export function PilotModeLabel({ context }: { readonly context: ExtensionContextValue }) {
  if (context.environment.mode === "live") {
    return <Badge type="negative">Live disabled</Badge>;
  }
  return <Badge type="info">{context.userContext.account.isSandbox ? "Sandbox" : "Test"}</Badge>;
}

export function PilotLimitationNotice() {
  return (
    <Box css={{ stack: "y", gap: "xsmall" }}>
      <Box>RefundDesk requires approval only for refund requests started in RefundDesk.</Box>
      <Box>
        Stripe refunds created elsewhere cannot be blocked; RefundDesk detects and flags them.
      </Box>
    </Box>
  );
}
