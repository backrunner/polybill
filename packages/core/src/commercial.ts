import type { EvidenceId } from "./ids.js";
import type { IsoDateTime } from "./time.js";

export type CommercialModel = "merchant_of_record" | "payment_processor" | "settlement_network";
export type Responsibility = "provider" | "merchant" | "shared" | "conditional";

export interface CommercialTermsSnapshot {
  readonly model: CommercialModel;
  readonly sellerOfRecord: "provider" | "merchant" | "conditional";
  readonly taxCalculation: Responsibility;
  readonly taxInvoiceIssuer: "provider" | "merchant" | "none" | "conditional";
  readonly disputeResponsibility: Responsibility;
  readonly jurisdictions?: readonly string[];
  readonly termsVersion?: string;
  readonly observedAt: IsoDateTime;
  readonly evidenceRef: EvidenceId;
}

export interface CommercialPolicy {
  readonly sellerOfRecord?: "provider_required" | "merchant_allowed";
  readonly taxInvoice?: "provider_required" | "merchant_allowed";
}

export type CommercialPolicyViolation =
  | "seller_of_record_incompatible"
  | "tax_invoice_issuer_incompatible"
  | "commercial_terms_conditional";

export function checkCommercialPolicy(
  policy: CommercialPolicy,
  terms: CommercialTermsSnapshot,
): readonly CommercialPolicyViolation[] {
  const violations: CommercialPolicyViolation[] = [];
  if (policy.sellerOfRecord === "provider_required" && terms.sellerOfRecord !== "provider") {
    violations.push(
      terms.sellerOfRecord === "conditional"
        ? "commercial_terms_conditional"
        : "seller_of_record_incompatible",
    );
  }
  if (policy.taxInvoice === "provider_required" && terms.taxInvoiceIssuer !== "provider") {
    violations.push(
      terms.taxInvoiceIssuer === "conditional"
        ? "commercial_terms_conditional"
        : "tax_invoice_issuer_incompatible",
    );
  }
  return violations;
}
