import { runLocalStripeApp } from "./local-manifest.mjs";

if (process.argv.length > 2) {
  process.stderr.write(
    "RefundDesk local Stripe App development accepts no CLI arguments or live-mode flags.\n",
  );
  process.exitCode = 1;
} else {
  try {
    process.exitCode = await runLocalStripeApp();
  } catch (error) {
    const message = error instanceof Error ? error.message : "The Stripe App launcher failed";
    process.stderr.write(`[refunddesk-stripe-app] ${message}\n`);
    process.exitCode = 1;
  }
}
