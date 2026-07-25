import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";

const redactPaths = [
  "email",
  "*.email",
  "justification",
  "*.justification",
  "req.headers.authorization",
  "req.headers.stripe-signature",
  "request.headers.authorization",
  "request.headers.stripe-signature",
  "body",
  "rawBody",
  "event.data",
  "stripePayload",
  "config.stripe",
  "config.keys",
  "err.message",
];

export function createLogger(
  service: string,
  level: LoggerOptions["level"] = "info",
  destination?: DestinationStream,
): Logger {
  const options: LoggerOptions = {
    level,
    base: { service },
    redact: {
      paths: redactPaths,
      censor: "[REDACTED]",
      remove: false,
    },
    hooks: {
      logMethod(arguments_, method) {
        const first = arguments_[0];
        const carriesError =
          first instanceof Error ||
          (typeof first === "object" &&
            first !== null &&
            "err" in first &&
            first.err instanceof Error);
        if (carriesError) {
          const fields = first instanceof Error ? { err: first } : first;
          return method.apply(this, [fields, "Operational error"]);
        }
        return method.apply(this, arguments_);
      },
    },
    serializers: {
      err(error: unknown) {
        if (!(error instanceof Error)) {
          return { type: "UnknownError" };
        }
        const possibleCode = "code" in error && typeof error.code === "string" ? error.code : "";
        const codeIsSafe =
          /^[A-Za-z0-9_.-]{1,64}$/u.test(possibleCode) &&
          !/^(?:(?:sk|rk)_(?:test|live)_|(?:whsec|absec)_)/u.test(possibleCode);
        return {
          type: error.name,
          code: codeIsSafe ? possibleCode : "UNCLASSIFIED",
        };
      },
    },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}
