import {
  arrayField,
  invalid,
  object,
  stringField,
  type CustomerProvider,
  type ProviderContext,
} from "@polybill/adapter-kit";
import { parseIsoDateTime, PolybillError } from "@polybill/core";
import { waffoRequest } from "./client.js";

const operation = "waffo.customer.portal";

export function waffoPortalStore(context: ProviderContext): string | undefined {
  const store = context.credentials.storeId;
  return store !== undefined && /^STO_[A-Za-z0-9]{22}$/u.test(store) ? store : undefined;
}

export const waffoCustomers: CustomerProvider = {
  async portal(context, buyerIdentity) {
    const storeId = waffoPortalStore(context);
    if (storeId === undefined || buyerIdentity.trim().length === 0)
      throw new PolybillError("Waffo portal requires a configured store and mapped buyer", {
        code: "invalid_request",
        operation,
        provider: "waffo",
        connectionId: context.connection.id,
        retryable: false,
      });
    const response = await waffoRequest(context, "/v1/actions/auth/issue-session-token", {
      storeId,
      buyerIdentity,
      purpose: "portal",
    });
    const body = object(response.json(), "waffo", operation);
    if (body.errors !== undefined && arrayField(body, "errors", "waffo", operation).length > 0)
      throw invalid("waffo", operation);
    const data = object(body.data, "waffo", operation);
    const value = portalSession(data, storeId, context);
    return {
      value,
      evidence: {
        provider: "waffo",
        environment: context.connection.environment,
        observedAt: context.clock.now(),
      },
      idempotency: "polybill",
      warnings: [],
    };
  },
};

function portalSession(
  data: Readonly<Record<string, unknown>>,
  storeId: string,
  context: ProviderContext,
) {
  const token = stringField(data, "token", "waffo", operation);
  try {
    const url = new URL(stringField(data, "portalUrl", "waffo", operation));
    const expiresAt = parseIsoDateTime(data.expiresAt);
    if (
      !/^[\w-]+\.[\w-]+\.[\w-]+$/u.test(token) ||
      url.origin !== "https://pancake.waffo.ai" ||
      url.pathname.replace(/\/$/u, "") !== `/consumer/portal/store/${storeId}` ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      Date.parse(expiresAt) <= Date.parse(context.clock.now())
    )
      throw invalid("waffo", operation);
    url.hash = `token=${token}`;
    return { url: url.href, expiresAt };
  } catch {
    throw invalid("waffo", operation);
  }
}
