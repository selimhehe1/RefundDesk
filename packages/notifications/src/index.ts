export interface Notification {
  readonly kind:
    | "approval_requested"
    | "request_approved"
    | "request_rejected"
    | "refund_succeeded"
    | "refund_failed"
    | "external_refund_detected";
  readonly tenantId: string;
  readonly requestId?: string;
  readonly recipientUserIds: readonly string[];
}

export interface NotificationProvider {
  send(notification: Notification): Promise<void>;
}

export class NoopNotificationProvider implements NotificationProvider {
  async send(notification: Notification): Promise<void> {
    void notification;
    await Promise.resolve();
  }
}
