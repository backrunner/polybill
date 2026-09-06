import type { NotifyNonceStore } from "x402-paysdk/merchant";

export interface X402AdapterOptions {
  readonly gateway: string;
  readonly payTo: string;
  readonly network: string;
  readonly expectedMerchantId?: string;
  readonly notifyUrl?: string;
  readonly settlement: {
    readonly kind: "fixed";
    readonly pricingCurrency: "USD";
    readonly atomicPerMinor: string;
    readonly acceptPegRisk: true;
  };
  readonly trustedReceiptSigners: readonly string[];
  readonly minConfirmations: number;
  readonly nonceStore: NotifyNonceStore;
  readonly expiresInSeconds?: number;
  readonly notifyToleranceSeconds?: number;
  readonly notifyMaxBodyBytes?: number;
}

export function assertX402Options(options: X402AdapterOptions): void {
  if (
    options.settlement.kind !== "fixed" ||
    options.settlement.pricingCurrency !== "USD" ||
    options.settlement.acceptPegRisk !== true
  )
    throw new TypeError("x402 fixed settlement requires explicit USD peg-risk acceptance");
  const gateway = new URL(options.gateway);
  if (gateway.username !== "" || gateway.password !== "")
    throw new TypeError("x402 gateway must not include credentials");
  if (
    (gateway.pathname !== "/" && gateway.pathname !== "") ||
    gateway.search !== "" ||
    gateway.hash !== ""
  )
    throw new TypeError("x402 gateway must be an origin without a path, query or fragment");
  if (gateway.protocol !== "https:" && !isLoopback(gateway))
    throw new TypeError("x402 gateway must use HTTPS outside local development");
  if (!/^[1-9][0-9]*$/.test(options.settlement.atomicPerMinor))
    throw new TypeError("x402 atomicPerMinor must be a positive integer string");
  positiveInteger(options.minConfirmations, "x402 minConfirmations");
  if (options.expiresInSeconds !== undefined)
    positiveInteger(options.expiresInSeconds, "x402 expiresInSeconds");
  if (options.notifyToleranceSeconds !== undefined)
    positiveInteger(options.notifyToleranceSeconds, "x402 notifyToleranceSeconds");
  if (options.notifyMaxBodyBytes !== undefined)
    positiveInteger(options.notifyMaxBodyBytes, "x402 notifyMaxBodyBytes");
  if (options.trustedReceiptSigners.length === 0)
    throw new TypeError("x402 requires at least one trusted receipt signer");
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`${name} must be a positive safe integer`);
}

function isLoopback(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
  );
}
