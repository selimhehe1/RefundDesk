/**
 * Plain-language text for the API's error codes.
 *
 * The extension deliberately never displays the `message` the API returns: a regression
 * test in `signed-fetch.test.ts` pins that server text must not reach the user, because it
 * can carry internal detail. Showing only the raw code was the opposite failure — users
 * read `RefundDesk could not complete the request (NO_DISTINCT_APPROVER).` and could not
 * act on it.
 *
 * Wording therefore lives here, under the extension's control, and says what the person
 * can do next. An unknown code falls back to the generic sentence.
 */
const API_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  ACCOUNT_ENVIRONMENT_MISMATCH: "RefundDesk does not serve this Stripe account and environment.",
  ADMIN_REQUIRED: "Only a Stripe Administrator can do this.",
  APPROVAL_ATTESTATION_REQUIRED: "This approval could not be verified. Try again.",
  APPROVER_REQUIRED: "Only a configured RefundDesk approver can do this.",
  COMMAND_INVALID: "Check the values you entered and try again.",
  EDGE_ADMISSION_UNAVAILABLE: "RefundDesk is busy. Try again in a moment.",
  EDGE_RATE_LIMITED: "Too many requests right now. Wait a moment and try again.",
  ENVELOPE_INVALID: "RefundDesk could not verify this request. Reload the page and try again.",
  ENVELOPE_NON_CANONICAL:
    "RefundDesk could not verify this request. Reload the page and try again.",
  IDEMPOTENCY_CONFLICT: "This action was already sent with different details. Reload and retry.",
  INSTALLATION_INACTIVE: "The RefundDesk installation is not active on this account.",
  INSTALLATION_NOT_FOUND:
    "RefundDesk is not set up on this account yet. An Administrator must open it once.",
  INTERNAL_ERROR: "RefundDesk could not complete the request. Try again.",
  LIVE_MODE_DISABLED: "RefundDesk runs in test and sandbox only. Live mode is disabled.",
  NO_DISTINCT_APPROVER:
    "A second person must be an approver: a requester can never approve their own refund. Ask an Administrator to add one in Settings.",
  PAYMENT_NOT_ELIGIBLE: "This payment cannot be refunded through RefundDesk.",
  PILOT_BACKEND_UNAVAILABLE: "RefundDesk is temporarily unavailable. Try again shortly.",
  RATE_LIMITED: "Too many requests right now. Wait a moment and try again.",
  RATE_LIMITER_UNAVAILABLE: "RefundDesk is busy. Try again in a moment.",
  REQUEST_NOT_FOUND: "This refund request no longer exists. Refresh the list.",
  REQUEST_TIMEOUT: "The request took too long. Try again.",
  REQUEST_TOO_LARGE: "The text you entered is too long. Shorten it and try again.",
  RESOURCE_MISMATCH: "This action does not match the payment it was opened from.",
  ROUTE_MISMATCH: "RefundDesk could not complete the request. Reload the page and try again.",
  SELF_APPROVAL: "You cannot approve or reject your own request.",
  UNAUTHORIZED: "You are not allowed to do this.",
  WORKFLOW_CONFLICT: "This request changed since you opened it. Refresh and try again.",
};

export const GENERIC_API_ERROR_MESSAGE = "RefundDesk could not complete the request. Try again.";

// A code is an enum-like token authored in the backend, so an unrecognised one stays
// visible for support. The shape is checked first: an arbitrary string from a malformed
// response must never be interpolated into user-facing text.
// In JavaScript `$` is the end of input, with no trailing-newline exception.
const API_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;

export function apiErrorMessage(code: string | undefined): string {
  if (code === undefined) {
    return GENERIC_API_ERROR_MESSAGE;
  }
  const known = API_ERROR_MESSAGES[code];
  if (known !== undefined) {
    return known;
  }
  return API_ERROR_CODE_PATTERN.test(code)
    ? `RefundDesk could not complete the request (${code}).`
    : GENERIC_API_ERROR_MESSAGE;
}
