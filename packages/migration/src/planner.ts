import type { Capability, CapabilitySnapshot } from "@polybill/adapter-kit";
import type {
  MigrationAction,
  MigrationLoss,
  MigrationPlan,
  MigrationPlanInput,
  MigrationPlanItem,
  MigrationSourceItem,
} from "./types.js";

export async function planMigration(input: MigrationPlanInput): Promise<MigrationPlan> {
  const responsibilityLosses = commercialLosses(
    input.sourceCapabilities,
    input.targetCapabilities,
    input.legalResponsibilityAcknowledged ?? false,
  );
  const items = input.items
    .map((item) => planItem(item, input))
    .sort((left, right) => left.key.localeCompare(right.key));
  return {
    id: input.id,
    tenantId: input.tenantId,
    sourceConnectionId: input.sourceConnectionId,
    targetConnectionId: input.targetConnectionId,
    mode: input.mode,
    phase: responsibilityLosses.some((loss) => loss.blocking) ? "blocked" : "planned",
    sourceCapabilitiesHash: await snapshotHash(input.sourceCapabilities),
    targetCapabilitiesHash: await snapshotHash(input.targetCapabilities),
    items,
    losses: [...responsibilityLosses, ...items.flatMap((item) => item.losses)],
    createdAt: input.createdAt,
  };
}

function planItem(item: MigrationSourceItem, input: MigrationPlanInput): MigrationPlanItem {
  const decision = actionFor(item, input);
  return {
    key: item.key,
    entityType: item.entityType,
    sourceId: item.sourceId,
    ...(item.canonicalId === undefined ? {} : { canonicalId: item.canonicalId }),
    ...(item.targetExternalId === undefined ? {} : { targetExternalId: item.targetExternalId }),
    action: decision.action,
    desired: sanitizeDesired(item.payload),
    dependsOn: item.dependsOn ?? [],
    losses: decision.losses,
    ...(decision.requiredHumanAction === undefined
      ? {}
      : { requiredHumanAction: decision.requiredHumanAction }),
    rollback: rollbackFor(decision.action),
  };
}

function actionFor(
  item: MigrationSourceItem,
  input: MigrationPlanInput,
): {
  action: MigrationAction;
  losses: readonly MigrationLoss[];
  requiredHumanAction?: string;
} {
  if (item.targetExternalId !== undefined) return { action: "map_existing", losses: [] };
  if (item.entityType === "payment_method") {
    if (
      item.paymentMethodKind === "card" &&
      input.allowProviderAssistedCards === true &&
      supports(input.targetCapabilities, "migration.payment_method")
    )
      return {
        action: "provider_assisted",
        losses: [],
        requiredHumanAction: "Complete the provider-managed token transfer outside Polybill",
      };
    return reauthorization("Payment credentials cannot be copied by the SDK");
  }
  if (item.entityType === "subscription" && item.active === true) {
    const capability = input.targetCapabilities.capabilities["migration.subscription"];
    if (capability?.support === "native" && input.allowProviderAssistedSubscriptions === true)
      return {
        action: "provider_assisted",
        losses: [],
        requiredHumanAction: "Confirm the target provider migration cohort before source cancel",
      };
    if (input.mode === "dual_run" || input.mode === "new_sales_cutover")
      return {
        action: "keep_source_pinned",
        losses: [
          loss(
            "active_subscription_pinned",
            "Active billing authorization remains at source",
            false,
          ),
        ],
      };
    return reauthorization("Active subscription requires customer reauthorization");
  }
  if (item.entityType === "payment" || item.entityType === "subscription")
    return {
      action: "map_existing",
      losses: [
        loss(
          "historical_ledger_source_retained",
          "Historical financial records remain authoritative at the source",
          false,
        ),
      ],
    };
  if (item.entityType === "license" || item.entityType === "voucher")
    return { action: "map_existing", losses: [] };
  const capability = migrationCapability(item.entityType, input.targetCapabilities);
  if (capability === undefined || capability.support === "unsupported")
    return {
      action: "manual_review",
      losses: [
        loss(
          "target_capability_unsupported",
          capability?.reason ?? "Target does not declare this migration capability",
          true,
        ),
      ],
      requiredHumanAction:
        (capability?.support === "unsupported" ? capability.alternatives?.join("; ") : undefined) ??
        "Select a supported target workflow",
    };
  return { action: "create_target", losses: [] };
}

function reauthorization(message: string) {
  return {
    action: "request_reauthorization" as const,
    losses: [loss("reauthorization_required", message, false)],
    requiredHumanAction:
      "Send a target checkout or portal link and keep source active until success",
  };
}

function commercialLosses(
  source: CapabilitySnapshot,
  target: CapabilitySnapshot,
  acknowledged: boolean,
): readonly MigrationLoss[] {
  const changed =
    source.commercialTerms.sellerOfRecord !== target.commercialTerms.sellerOfRecord ||
    source.commercialTerms.taxCalculation !== target.commercialTerms.taxCalculation ||
    source.commercialTerms.taxInvoiceIssuer !== target.commercialTerms.taxInvoiceIssuer ||
    source.commercialTerms.disputeResponsibility !== target.commercialTerms.disputeResponsibility;
  return changed
    ? [
        loss(
          "legal_responsibility_change",
          "Seller, tax, invoice, or dispute responsibility changes at cutover",
          !acknowledged,
        ),
      ]
    : [];
}

function migrationCapability(
  entityType: string,
  snapshot: CapabilitySnapshot,
): Capability | undefined {
  if (entityType === "product" || entityType === "sku" || entityType === "price")
    return snapshot.capabilities["migration.catalog"];
  if (entityType === "customer") return snapshot.capabilities["migration.customer"];
  if (entityType === "subscription") return snapshot.capabilities["migration.subscription"];
  if (entityType === "payment_method") return snapshot.capabilities["migration.payment_method"];
  return undefined;
}

function supports(snapshot: CapabilitySnapshot, key: "migration.payment_method"): boolean {
  const capability = snapshot.capabilities[key];
  return capability?.support === "native" || capability?.support === "emulated";
}

function rollbackFor(action: MigrationAction): MigrationPlanItem["rollback"] {
  if (action === "create_target") return "archive_created";
  if (action === "map_existing") return "mapping_only";
  if (action === "keep_source_pinned" || action === "request_reauthorization")
    return "source_pinned";
  return "none";
}

function loss(code: string, message: string, blocking: boolean): MigrationLoss {
  return { code, message, blocking };
}

async function snapshotHash(snapshot: CapabilitySnapshot): Promise<string> {
  const value = stable(snapshot);
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
    .join(",")}}`;
}

const credentialKey =
  /^(token|secret|pan|cvc|cvv|bank.?account|wallet.?token|api.?key|signature|license.?key)$/i;

function sanitizeDesired(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) =>
      credentialKey.test(key) ? [] : [[key, sanitizeValue(item)]],
    ),
  );
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value !== null && typeof value === "object")
    return sanitizeDesired(value as Readonly<Record<string, unknown>>);
  return value;
}
