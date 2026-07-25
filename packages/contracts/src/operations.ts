import { z } from "zod";

import {
  alertAcknowledgeCommandSchema,
  alertListCommandSchema,
  auditExportCommandSchema,
  decisionCommandSchema,
  emptyCommandSchema,
  refundRequestCommandSchema,
  requestIdCommandSchema,
  requestListCommandSchema,
  settingsUpdateCommandSchema,
} from "./schemas.js";

export const operationSchemas = {
  "context.sync": emptyCommandSchema,
  "payment.eligibility": emptyCommandSchema,
  "refund_request.create": refundRequestCommandSchema,
  "refund_request.list": requestListCommandSchema,
  "refund_request.get": requestIdCommandSchema,
  "refund_request.decide": decisionCommandSchema,
  "refund_request.cancel": requestIdCommandSchema,
  "external_alert.list": alertListCommandSchema,
  "external_alert.acknowledge": alertAcknowledgeCommandSchema,
  "settings.get": emptyCommandSchema,
  "settings.update": settingsUpdateCommandSchema,
  "audit.export": auditExportCommandSchema,
} as const satisfies Readonly<Record<string, z.ZodType>>;

export type PilotOperation = keyof typeof operationSchemas;

export type OperationCommand<Operation extends PilotOperation> = z.infer<
  (typeof operationSchemas)[Operation]
>;

export function isPilotOperation(operation: string): operation is PilotOperation {
  return Object.hasOwn(operationSchemas, operation);
}

export function parseOperationCommand<Operation extends PilotOperation>(
  operation: Operation,
  commandJson: string,
): OperationCommand<Operation> {
  let command: unknown;
  try {
    command = JSON.parse(commandJson);
  } catch {
    throw new z.ZodError([
      {
        code: "custom",
        message: "command_json must contain valid JSON",
        path: [],
      },
    ]);
  }
  return operationSchemas[operation].parse(command) as OperationCommand<Operation>;
}
