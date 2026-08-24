import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createMemoryStore } from "@polybill/store-memory";
import {
  createWebhookConsumer,
  createWebhookHandler,
  MemoryWebhookInbox,
  providerSlug,
  type InboxRecord,
} from "@polybill/webhooks";
import { createPolybill } from "polybill";
import { nodeConfig } from "./config.js";

const config = nodeConfig(process.env);
const store = createMemoryStore();
const inbox = new MemoryWebhookInbox();
const slug = providerSlug(config.connection.provider);
const adapters = new Map([[slug, config.adapter]]);
const consume = createWebhookConsumer({ adapters, inbox, mappingStore: store });
const webhook = createWebhookHandler({
  adapters,
  inbox,
  queue: { send: (record: InboxRecord) => consume(record) },
  resolver: {
    resolve: async (input) =>
      input.provider === slug &&
      (input.connectionId === undefined || input.connectionId === config.connection.id)
        ? {
            tenantId: config.connection.tenantId,
            connection: config.connection,
            secret: { active: config.webhookSecret, activeKeyId: "node-current" },
          }
        : undefined,
  },
});
const billing = createPolybill({
  tenantId: config.connection.tenantId,
  connection: config.connection,
  credentials: { apiKey: config.apiKey },
  adapter: config.adapter,
  store,
});

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname === "/health" && request.method === "GET")
      return send(response, Response.json({ status: "ok", provider: config.connection.provider }));
    if (url.pathname === "/capabilities" && request.method === "GET")
      return send(response, Response.json(await billing.getCapabilities()));
    if (url.pathname.startsWith("/webhooks/polybill/"))
      return send(response, await webhook(await webRequest(request, url)));
    return send(response, Response.json({ code: "not_found" }, { status: 404 }));
  } catch {
    return send(response, Response.json({ code: "internal_error" }, { status: 500 }));
  }
});

server.listen(config.port, "127.0.0.1", () => {
  console.log(`Polybill Node example listening on http://127.0.0.1:${config.port}`);
  console.warn(
    "The in-memory store is for local development only; use a durable store in production.",
  );
});

async function webRequest(request: IncomingMessage, url: URL): Promise<Request> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request)
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  const body = Buffer.concat(chunks);
  return new Request(url, {
    method: request.method ?? "GET",
    headers: webHeaders(request),
    ...(body.byteLength === 0 ? {} : { body }),
  });
}

function webHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (value !== undefined) for (const item of value) headers.append(name, item);
  }
  return headers;
}

async function send(response: ServerResponse, value: Response): Promise<void> {
  response.statusCode = value.status;
  value.headers.forEach((header, name) => response.setHeader(name, header));
  response.end(Buffer.from(await value.arrayBuffer()));
}
