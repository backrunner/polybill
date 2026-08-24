import { createWebCryptoPort } from "@polybill/adapter-kit";
import { PolybillError, parseId } from "@polybill/core";
import { VoucherService } from "@polybill/licensing";
import { D1LicensingStore } from "@polybill/store-d1";
import { SecureIdGenerator, systemClock } from "polybill";
import type { WorkerEnv } from "./bindings.js";
import { licensingCrypto } from "./crypto.js";

export class VoucherRedemptionCoordinator {
  readonly #env: WorkerEnv;

  constructor(_state: unknown, env: WorkerEnv) {
    this.#env = env;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return Response.json({ code: "method_not_allowed" }, { status: 405 });
    try {
      const input = redeemInput(await request.json());
      const crypto = licensingCrypto(this.#env);
      const service = new VoucherService({
        store: new D1LicensingStore(this.#env.POLYBILL_DB),
        crypto,
        ids: new SecureIdGenerator(createWebCryptoPort()),
        clock: systemClock,
      });
      const redemption = await service.redeem({
        tenantId: parseId<"TenantId">(this.#env.POLYBILL_TENANT_ID, "ten"),
        ...input,
      });
      return Response.json(redemption);
    } catch (error) {
      if (error instanceof PolybillError)
        return Response.json(
          { code: error.code },
          { status: error.code === "not_found" ? 404 : 409 },
        );
      return Response.json({ code: "invalid_request" }, { status: 400 });
    }
  }
}

export interface RedeemVoucherInput {
  readonly code: string;
  readonly idempotencyKey: string;
  readonly beneficiaryRef: string;
}

export function redeemInput(value: unknown): RedeemVoucherInput {
  if (typeof value !== "object" || value === null)
    throw new TypeError("Redemption body is invalid");
  const input = value as Readonly<Record<string, unknown>>;
  if (
    typeof input.code !== "string" ||
    typeof input.idempotencyKey !== "string" ||
    typeof input.beneficiaryRef !== "string"
  )
    throw new TypeError("Redemption fields are invalid");
  return {
    code: input.code,
    idempotencyKey: input.idempotencyKey,
    beneficiaryRef: input.beneficiaryRef,
  };
}
