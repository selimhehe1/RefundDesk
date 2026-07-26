export type RequestNonceFactory = () => string;

export type MutationIntentStart =
  | { readonly status: "busy" }
  | { readonly status: "failed"; readonly error: unknown }
  | { readonly status: "started"; readonly requestNonce: string };

export class MutationIntentRegistry {
  private readonly activeKeys = new Set<string>();
  private readonly requestNonces = new Map<string, string>();

  constructor(private readonly createRequestNonce: RequestNonceFactory) {}

  begin(intentKey: string): MutationIntentStart {
    if (this.activeKeys.size > 0) {
      return { status: "busy" };
    }
    let requestNonce = this.requestNonces.get(intentKey);
    if (requestNonce === undefined) {
      try {
        requestNonce = this.createRequestNonce();
      } catch (error) {
        return { status: "failed", error };
      }
    }
    this.requestNonces.set(intentKey, requestNonce);
    this.activeKeys.add(intentKey);
    return { status: "started", requestNonce };
  }

  release(intentKey: string): void {
    this.activeKeys.delete(intentKey);
  }

  complete(intentKey: string): void {
    this.activeKeys.delete(intentKey);
    this.requestNonces.delete(intentKey);
  }

  reset(intentKey: string): void {
    if (!this.activeKeys.has(intentKey)) {
      this.requestNonces.delete(intentKey);
    }
  }
}
