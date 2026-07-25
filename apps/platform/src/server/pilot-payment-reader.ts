import type { ConnectedAccountStripeClient } from "@refunddesk/stripe-adapter";

import type {
  PilotPayment,
  PilotPaymentReader,
  PilotPaymentResource,
  PilotTenantContext,
} from "./pilot-ports";

export class ConnectedStripePaymentReader implements PilotPaymentReader {
  constructor(private readonly stripe: ConnectedAccountStripeClient) {}

  async retrievePayment(
    context: PilotTenantContext,
    resource: PilotPaymentResource,
  ): Promise<PilotPayment> {
    const payment = await this.stripe.retrievePayment(
      {
        active: context.installationStatus === "active" && context.tenantStatus === "active",
        environment: context.environment,
        stripeAccountId: context.stripeAccountId,
      },
      resource.type,
      resource.id,
    );
    return {
      amountCaptured: payment.amountCaptured,
      amountRefunded: payment.amountRefunded,
      captured: payment.captured,
      chargeId: payment.chargeId,
      currency: payment.currency,
      disputed: payment.disputed,
      hasConnectSemantics: payment.hasConnectSemantics,
      paid: payment.paid,
      paymentIntentId: payment.paymentIntentId,
      paymentKey: payment.paymentKey,
      paymentMethodType: payment.paymentMethodType,
    };
  }
}
