import { PolybillError, type Clock, type IsoDateTime, type ProviderName } from "@polybill/core";

export interface HttpTransportOptions {
  readonly fetch: typeof globalThis.fetch;
  readonly provider: ProviderName;
  readonly maxResponseBytes?: number;
  readonly deadline?: IsoDateTime;
  readonly clock?: Clock;
}

export interface HttpRequest {
  readonly url: string | URL;
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly headers?: HeadersInit;
  readonly body?: BodyInit;
  readonly signal?: AbortSignal;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
  json(): unknown;
  text(): string;
}

export interface HttpTransport {
  send(request: HttpRequest): Promise<HttpResponse>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

export function createHttpTransport(options: HttpTransportOptions): HttpTransport {
  const limit = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Invalid response limit");
  return {
    async send(request) {
      const timeout =
        options.deadline === undefined
          ? 10_000
          : Date.parse(options.deadline) -
            Date.parse(options.clock?.now() ?? new Date().toISOString());
      if (!Number.isFinite(timeout) || timeout <= 0 || request.signal?.aborted)
        throw unavailable(options.provider);
      const controller = new AbortController();
      let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
      let onAbort: () => void = () => undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          controller.abort();
          reject(unavailable(options.provider));
        };
        timer = globalThis.setTimeout(onAbort, Math.min(timeout, 2_147_483_647));
        request.signal?.addEventListener("abort", onAbort, { once: true });
      });
      try {
        const response = await Promise.race([
          options
            .fetch(request.url, {
              method: request.method,
              redirect: "error",
              ...(request.headers === undefined ? {} : { headers: request.headers }),
              ...(request.body === undefined ? {} : { body: request.body }),
              signal: controller.signal,
            })
            .catch(() => {
              throw unavailable(options.provider);
            }),
          aborted,
        ]);
        if (response.status >= 300 && response.status < 400) {
          void response.body?.cancel().catch(() => undefined);
          throw new PolybillError("Provider redirects are not accepted", {
            code: "provider_response_invalid",
            operation: "http.redirect",
            provider: options.provider,
            retryable: false,
          });
        }
        const body = await Promise.race([
          readBounded(response, limit, options.provider, controller.signal),
          aborted,
        ]);
        return {
          status: response.status,
          headers: response.headers,
          body,
          json: () => {
            try {
              return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
            } catch {
              throw new PolybillError("Provider returned invalid JSON", {
                code: "provider_response_invalid",
                operation: "http.decode_json",
                provider: options.provider,
                retryable: false,
              });
            }
          },
          text: () => new TextDecoder().decode(body),
        };
      } catch (error) {
        if (error instanceof PolybillError) throw error;
        throw unavailable(options.provider);
      } finally {
        globalThis.clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

async function readBounded(
  response: Response,
  maxBytes: number,
  provider: ProviderName,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw responseTooLarge(provider);
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw responseTooLarge(provider);
      }
      chunks.push(next.value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function unavailable(provider: ProviderName): PolybillError {
  return new PolybillError("Provider request or response stream did not complete", {
    code: "provider_unavailable",
    operation: "http.send",
    provider,
    retryable: true,
  });
}

function responseTooLarge(provider: ProviderName): PolybillError {
  return new PolybillError("Provider response exceeded the configured size limit", {
    code: "provider_response_invalid",
    operation: "http.read",
    provider,
    retryable: false,
  });
}
