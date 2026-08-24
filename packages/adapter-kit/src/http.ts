import { PolybillError, type ProviderName } from "@polybill/core";

export interface HttpTransportOptions {
  readonly fetch: typeof globalThis.fetch;
  readonly provider: ProviderName;
  readonly maxResponseBytes?: number;
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
  return {
    async send(request) {
      let response: Response;
      try {
        response = await options.fetch(request.url, {
          method: request.method,
          ...(request.headers === undefined ? {} : { headers: request.headers }),
          ...(request.body === undefined ? {} : { body: request.body }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
      } catch (cause) {
        throw new PolybillError("Provider request failed before a response was received", {
          code: "provider_unavailable",
          operation: "http.send",
          provider: options.provider,
          retryable: true,
          cause,
        });
      }
      const body = await readBounded(response, limit, options.provider);
      return {
        status: response.status,
        headers: response.headers,
        body,
        json: () => {
          try {
            return JSON.parse(new TextDecoder().decode(body)) as unknown;
          } catch (cause) {
            throw new PolybillError("Provider returned invalid JSON", {
              code: "provider_response_invalid",
              operation: "http.decode_json",
              provider: options.provider,
              retryable: false,
              cause,
            });
          }
        },
        text: () => new TextDecoder().decode(body),
      };
    },
  };
}

async function readBounded(
  response: Response,
  maxBytes: number,
  provider: ProviderName,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw responseTooLarge(provider);
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
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
}

function responseTooLarge(provider: ProviderName): PolybillError {
  return new PolybillError("Provider response exceeded the configured size limit", {
    code: "provider_response_invalid",
    operation: "http.read",
    provider,
    retryable: false,
  });
}
