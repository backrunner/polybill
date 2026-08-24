import { createHttpTransport, type ProviderContext } from "@polybill/adapter-kit";
import { MerchantClient } from "x402-paysdk/merchant";

export class InjectedMerchantClient extends MerchantClient {
  readonly #context: ProviderContext;

  constructor(context: ProviderContext, options: ConstructorParameters<typeof MerchantClient>[0]) {
    super(options);
    this.#context = context;
  }

  override async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new TypeError("x402 request path must be same-origin");
    const base = new URL(this.gateway);
    const url = new URL(path, base);
    if (url.origin !== base.origin) throw new TypeError("x402 request path must be same-origin");
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    headers.set("authorization", `Bearer ${this.apiKey}`);
    if (this.#context.idempotencyKey !== undefined)
      headers.set("idempotency-key", this.#context.idempotencyKey);
    const response = await createHttpTransport({
      fetch: this.#context.fetch,
      provider: "x402",
    }).send({
      url,
      method: methodOf(init.method),
      headers,
      ...(init.body === undefined || init.body === null ? {} : { body: init.body }),
    });
    if (response.status >= 400)
      throw new Error(`x402 merchant request failed with status ${response.status}`);
    const decoded = response.json();
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded))
      throw new TypeError("x402 merchant response must be an object");
    // The upstream public client is generic and performs endpoint-specific validation.
    return decoded as T;
  }
}

function methodOf(value: string | undefined): "GET" | "POST" | "PATCH" | "PUT" | "DELETE" {
  if (value === undefined || value === "GET") return "GET";
  if (value === "POST" || value === "PATCH" || value === "PUT" || value === "DELETE") return value;
  throw new TypeError("Unsupported x402 HTTP method");
}
