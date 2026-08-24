import { arrayField, invalid, object, optionalString, stringField } from "@polybill/adapter-kit";
import type {
  PaymentRef,
  PaymentRefSnapshot,
  RefListItem,
  RefListResult,
} from "x402-paysdk/merchant";

const operation = "x402.refs.decode";

export function decodePaymentRef(value: unknown): PaymentRef {
  const root = object(value, "x402", operation);
  return {
    refId: stringField(root, "refId", "x402", operation),
    refUrl: stringField(root, "refUrl", "x402", operation),
    snapshot: decodePaymentRefSnapshot(root.snapshot),
  };
}

export function decodePaymentRefSnapshot(value: unknown): PaymentRefSnapshot {
  const root = object(value, "x402", operation);
  if (root.v !== 2 || root.scheme !== "exact") throw invalid("x402", operation);
  const asset = stringField(root, "asset", "x402", operation);
  if (asset !== "USDC") throw invalid("x402", operation);
  const amount = optionalString(root, "amount");
  if (amount !== undefined && !/^[1-9][0-9]*$/.test(amount)) throw invalid("x402", operation);
  const invoiceId = optionalString(root, "invoiceId");
  const description = optionalString(root, "description");
  const expiresAt = root.expiresAt;
  if (expiresAt !== undefined && !safeInteger(expiresAt)) throw invalid("x402", operation);
  return {
    v: 2,
    scheme: "exact",
    network: stringField(root, "network", "x402", operation),
    payTo: stringField(root, "payTo", "x402", operation),
    asset: "USDC",
    ...(amount === undefined ? {} : { amount }),
    resource: stringField(root, "resource", "x402", operation),
    ...(invoiceId === undefined ? {} : { invoiceId }),
    ...(description === undefined ? {} : { description }),
    mimeType: stringField(root, "mimeType", "x402", operation),
    ...(expiresAt === undefined ? {} : { expiresAt: Number(expiresAt) }),
  };
}

export function decodeRefList(value: unknown): RefListResult {
  const root = object(value, "x402", operation);
  const items = arrayField(root, "items", "x402", operation).map(decodeRefListItem);
  const nextCursor = optionalString(root, "nextCursor");
  return { items, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

function decodeRefListItem(value: unknown): RefListItem {
  const root = object(value, "x402", operation);
  const asset = stringField(root, "asset", "x402", operation);
  const status = stringField(root, "status", "x402", operation);
  if (asset !== "USDC" || (status !== "active" && status !== "revoked"))
    throw invalid("x402", operation);
  const amount = optionalString(root, "amount");
  if (amount !== undefined && !/^[1-9][0-9]*$/.test(amount)) throw invalid("x402", operation);
  const createdAt = root.createdAt;
  const expiresAt = root.expiresAt;
  if (!safeInteger(createdAt) || (expiresAt !== undefined && !safeInteger(expiresAt)))
    throw invalid("x402", operation);
  const invoiceId = optionalString(root, "invoiceId");
  const label = optionalString(root, "label");
  return {
    refId: stringField(root, "refId", "x402", operation),
    payTo: stringField(root, "payTo", "x402", operation),
    network: stringField(root, "network", "x402", operation),
    asset: "USDC",
    ...(amount === undefined ? {} : { amount }),
    ...(invoiceId === undefined ? {} : { invoiceId }),
    ...(label === undefined ? {} : { label }),
    createdAt: Number(createdAt),
    ...(expiresAt === undefined ? {} : { expiresAt: Number(expiresAt) }),
    status,
  };
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
