import { Banner, Box, Spinner } from "@stripe/ui-extension-sdk/ui";

export function LoadingState({ label }: { readonly label: string }) {
  return (
    <Box css={{ stack: "x", gap: "small", alignY: "center" }}>
      <Spinner size="small" />
      <Box>{label}</Box>
    </Box>
  );
}

export function EmptyState({ message }: { readonly message: string }) {
  return (
    <Box css={{ paddingY: "medium" }}>
      <Box>{message}</Box>
    </Box>
  );
}

export function ErrorState({ message }: { readonly message: string }) {
  return <Banner type="critical" title="Request unavailable" description={message} />;
}
