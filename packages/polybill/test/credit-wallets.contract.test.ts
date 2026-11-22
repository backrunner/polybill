import { providerIdempotencyKey } from "@polybill/adapter-kit";
import { parseId, parseIdempotencyKey } from "@polybill/core";
import { createMemoryStore } from "@polybill/store-memory";
import { createScriptedFetch, type ScriptedStep } from "@polybill/testing";
import { describe, expect, it } from "vitest";
import { createCreemAdapter } from "../../provider-creem/src/index.js";
import { createPolybill } from "../src/index.js";
import { now, subscriptionContext } from "./subscription-fixtures.js";

const base = "https://test-api.creem.io/v1/customer-credits";
const accounts = `${base}/accounts`;
const listUrl = `${accounts}?customer_id=cust_creem&limit=100`;
const account = {
  id: "cca_remote",
  store_id: "store_fixture",
  customer_id: "cust_creem",
  name: "generation",
  unit_label: "credits",
  status: "active",
  created_at: now,
  updated_at: now,
};
const accountUrl = `${accounts}/${account.id}`;
const wallet = { customerId: parseId<"CustomerId">("cust_polymapped", "cust"), name: "generation" };
const grant = {
  ...wallet,
  amount: "9007199254740993",
  reference: "signup",
  idempotencyKey: parseIdempotencyKey("credit-grant-key"),
};
const debit = {
  ...wallet,
  amount: "5",
  reference: "generation:one",
  idempotencyKey: parseIdempotencyKey("credit-debit-key"),
};
const moderationId = "b1414363-0cc1-46ea-9071-c6c4fcbee8c0";

describe("Creem native credit wallet facade", () => {
  it("creates and reads the wallet, then grants, debits and reverses exact amounts", async () => {
    const grantTransaction = transaction({
      id: "cct_granted",
      side: "credit",
      amount: grant.amount,
      reference: grant.reference,
      key: await upstreamKey(grant.idempotencyKey, "credit"),
    });
    const debitTransaction = transaction({
      id: "cct_debited",
      side: "debit",
      amount: debit.amount,
      reference: debit.reference,
      key: await upstreamKey(debit.idempotencyKey, "debit"),
      moderationId,
    });
    const reversal = transaction({
      id: "cct_reversed",
      side: "credit",
      amount: debit.amount,
      reference: "remote-reversal",
      key: "native-reversal-key",
      reversalOf: debitTransaction.id,
    });
    const script = createScriptedFetch([
      get(listUrl, list([])),
      post(accounts, account),
      get(listUrl, list([account])),
      post(`${accountUrl}/credit`, grantTransaction),
      get(listUrl, list([account])),
      get(`${accountUrl}/balance`, { balance: grant.amount, updated_at: now }),
      post("https://test-api.creem.io/v1/moderation/prompt", {
        id: moderationId,
        object: "moderation_result",
        prompt: "An illustration of a lighthouse",
        external_id: debit.reference,
        decision: "allow",
        usage: { units: 1 },
      }),
      get(listUrl, list([account])),
      post(`${accountUrl}/debit`, debitTransaction),
      get(listUrl, list([account])),
      post(`${accountUrl}/reverse`, reversal),
    ]);
    const client = await fixture(script.fetch);
    expect(client.credits).toBeUndefined();
    const create = {
      ...wallet,
      unit: "credits",
      idempotencyKey: parseIdempotencyKey("create-wallet"),
    };
    const created = await client.creditWallets.ensure(create);
    expect(created).toEqual({ ...wallet, unit: "credits", status: "active" });
    expect(await client.creditWallets.ensure(create)).toEqual(created);
    const added = await client.creditWallets.grant(grant);
    expect(added).toMatchObject({ kind: "grant", amount: grant.amount });
    expect(await client.creditWallets.balance(wallet)).toBe(grant.amount);
    const screen = await client.moderation?.screen({
      text: "An illustration of a lighthouse",
      reference: debit.reference,
    });
    if (screen?.receipt === undefined) throw new Error("Missing receipt");
    const command = { ...debit, moderation: screen.receipt };
    await expect(
      client.creditWallets.debit({ ...command, reference: "other-generation" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    const spent = await client.creditWallets.debit(command);
    expect(spent).toMatchObject({ kind: "debit", amount: "5", id: expect.stringMatching(/^ctx_/) });
    expect(await client.creditWallets.debit(command)).toEqual(spent);
    const reversed = await client.creditWallets.reverse({
      transactionId: spent.id,
      idempotencyKey: parseIdempotencyKey("reverse-credit-key"),
    });
    expect(reversed).toMatchObject({
      reversalOf: spent.id,
      reference: debit.reference,
      kind: "reversal",
    });
    expect(await script.requests[1]?.json()).toEqual({
      customer_id: "cust_creem",
      name: "generation",
      unit_label: "credits",
    });
    expect(await script.requests[3]?.json()).toEqual({
      amount: grant.amount,
      reference: grant.reference,
      idempotency_key: grantTransaction.idempotency_key,
    });
    expect(await script.requests[8]?.json()).toEqual({
      amount: "5",
      reference: debit.reference,
      idempotency_key: debitTransaction.idempotency_key,
      moderation_id: moderationId,
    });
    expect(await script.requests[10]?.json()).toEqual({ transaction_id: debitTransaction.id });
    expect(JSON.stringify([created, added, spent, reversed])).not.toMatch(
      /cca_remote|cct_|cust_creem/,
    );
    script.assertConsumed();
  });

  it("adopts an account created by a paid checkout on a later page", async () => {
    const script = createScriptedFetch([
      get(listUrl, list([{ ...account, id: "cca_other", name: "default" }], true)),
      get(`${listUrl}&starting_after=cca_other`, list([{ ...account, name: "Generation" }])),
    ]);
    const client = await fixture(script.fetch);
    await expect(
      client.creditWallets.ensure({
        ...wallet,
        unit: "credits",
        idempotencyKey: parseIdempotencyKey("credit-account-key"),
      }),
    ).resolves.toMatchObject({ ...wallet, status: "active" });
    script.assertConsumed();
  });

  it("rejects missing receipts, foreign receipts, and an account from another customer", async () => {
    const script = createScriptedFetch([
      get(listUrl, list([{ ...account, customer_id: "cust_other" }])),
    ]);
    const client = await fixture(script.fetch);
    const context = subscriptionContext("creem", script.fetch);
    await expect(client.creditWallets.debit(debit)).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      client.creditWallets.debit({
        ...debit,
        moderation: {
          connection: { ...context.connection, environment: "live" },
          providerResultId: moderationId,
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(client.creditWallets.grant(grant)).rejects.toMatchObject({
      code: "provider_response_invalid",
    });
    script.assertConsumed();
  });

  it("recovers a lost credit response through the matching ledger entry without sending again", async () => {
    const completed = transaction({
      id: "cct_recovered",
      side: "credit",
      amount: grant.amount,
      reference: grant.reference,
      key: await upstreamKey(grant.idempotencyKey, "credit"),
    });
    const script = createScriptedFetch([
      get(listUrl, list([account])),
      { method: "POST", url: `${accountUrl}/credit`, error: new Error("Connection reset") },
      get(listUrl, list([account])),
      get(`${base}/transactions?reference=signup`, list([])),
      get(listUrl, list([account])),
      get(`${base}/transactions?reference=signup`, list([completed])),
    ]);
    const client = await fixture(script.fetch);
    await expect(client.creditWallets.grant(grant)).rejects.toMatchObject({
      code: "provider_unavailable",
    });
    await expect(client.creditWallets.grant({ ...grant, amount: "1" })).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    await expect(client.creditWallets.grant(grant)).rejects.toMatchObject({
      code: "outcome_unknown",
    });
    await expect(client.creditWallets.grant(grant)).resolves.toMatchObject({
      kind: "grant",
      amount: grant.amount,
    });
    script.assertConsumed();
  });

  it("can retry the original write after an account lookup failed before transport", async () => {
    const remote = transaction({
      id: "cct_retrylookup",
      side: "credit",
      amount: grant.amount,
      reference: grant.reference,
      key: await upstreamKey(grant.idempotencyKey, "credit"),
    });
    const script = createScriptedFetch([
      { method: "GET", url: listUrl, error: new Error("Connection reset") },
      get(listUrl, list([account])),
      post(`${accountUrl}/credit`, remote),
    ]);
    const client = await fixture(script.fetch);
    await expect(client.creditWallets.grant(grant)).rejects.toMatchObject({
      code: "provider_unavailable",
    });
    await expect(client.creditWallets.grant(grant)).resolves.toMatchObject({
      kind: "grant",
      amount: grant.amount,
    });
    script.assertConsumed();
  });

  it("does not recover a ledger transaction with the correct key but a different amount", async () => {
    const mismatched = transaction({
      id: "cct_other",
      side: "credit",
      amount: "99",
      reference: grant.reference,
      key: await upstreamKey(grant.idempotencyKey, "credit"),
    });
    const script = createScriptedFetch([
      get(listUrl, list([account])),
      { method: "POST", url: `${accountUrl}/credit`, error: new Error("Connection reset") },
      get(listUrl, list([account])),
      get(`${base}/transactions?reference=signup`, list([mismatched])),
    ]);
    const client = await fixture(script.fetch);
    await expect(client.creditWallets.grant(grant)).rejects.toMatchObject({
      code: "provider_unavailable",
    });
    await expect(client.creditWallets.grant(grant)).rejects.toMatchObject({
      code: "provider_response_invalid",
    });
    script.assertConsumed();
  });
});

async function fixture(fetch: typeof globalThis.fetch) {
  const context = subscriptionContext("creem", fetch);
  const store = createMemoryStore();
  await store.bindConnection(context.connection);
  store.seedMapping(
    context.tenantId,
    context.connection.id,
    "customer",
    wallet.customerId,
    account.customer_id,
  );
  return createPolybill({ ...context, adapter: createCreemAdapter(), store });
}

function get(url: string, payload: unknown): ScriptedStep {
  return { method: "GET", url, response: Response.json(payload) };
}

function post(url: string, payload: unknown): ScriptedStep {
  return { method: "POST", url, response: Response.json(payload, { status: 201 }) };
}

function list(data: readonly unknown[], hasMore = false) {
  return { object: "list", data, has_more: hasMore };
}

async function upstreamKey(key: typeof grant.idempotencyKey, side: "credit" | "debit") {
  const context = subscriptionContext("creem", globalThis.fetch);
  return providerIdempotencyKey(
    { ...context, idempotencyKey: key },
    "POST",
    new URL(`${accountUrl}/${side}`).pathname,
  );
}

function transaction(input: {
  readonly id: string;
  readonly side: "credit" | "debit";
  readonly amount: string;
  readonly reference: string;
  readonly key: string | undefined;
  readonly moderationId?: string;
  readonly reversalOf?: string;
}) {
  return {
    id: input.id,
    store_id: account.store_id,
    reference: input.reference,
    idempotency_key: input.key,
    moderation_id: input.moderationId ?? null,
    reversal_of: input.reversalOf ?? null,
    created_at: now,
    entries: [
      {
        id: "cce_fixture",
        transaction_id: input.id,
        account_id: account.id,
        side: input.side,
        amount: input.amount,
        created_at: now,
      },
    ],
  };
}
