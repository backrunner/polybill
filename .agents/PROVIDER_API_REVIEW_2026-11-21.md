# Provider API review — 2026-11-21

Polybill's edge adapters use the official HTTP contracts with injected fetch and Web Crypto.
Upstream SDK versions are reference points. The only vendor SDK loaded by an adapter is
`x402-paysdk`. Provider API date pins are independent of upstream package versions.

| Provider | Upstream reference | Polybill coverage and limits |
| --- | --- | --- |
| Creem | [TypeScript SDK](https://www.npmjs.com/package/creem/v/2.0.0), [OpenAPI](https://github.com/armitage-labs/creem/blob/main/packages/sdk/openapi.json), [Gen AI guide](https://docs.creem.io/merchant-of-record/account-reviews/gen-ai-technical-integration-guide) | Native Customer Credits, text moderation, and credit webhook notifications. Creem product delivery can grant credits on checkout and renewal. Payment refund creation still returns status only. |
| Dodo Payments | [TypeScript SDK](https://www.npmjs.com/package/dodopayments/v/2.63.1), [October](https://docs.dodopayments.com/changelog/v1.118.3), [November](https://docs.dodopayments.com/changelog/v1.120.40), [OpenAPI moderation](https://docs.dodopayments.com/api-reference/moderation/screen) | Standalone text and image moderation. Checkout already reads payment-linked subscription IDs. Cross-currency refunds and keep-cycle proration need independent contracts for settlement currency and billing-cycle effects. |
| Waffo Pancake | [TypeScript SDK changelog](https://github.com/waffo-com/waffo-pancake-sdk-ts/blob/main/CHANGELOG.md) (0.28.0) | Customer portal SSO uses a configured store ID and a mapped buyer identity. Checkout session creation returns no authoritative total for canonical discount verification. Ad hoc prices require a mapped product and tax category, so they fail capability negotiation. Payment method brand is webhook evidence. |
| Stripe | [TypeScript SDK](https://www.npmjs.com/package/stripe/v/23.2.0), [versioning](https://docs.stripe.com/api/versioning), [Managed Payments](https://docs.stripe.com/managed-payments) | Existing Basil pin retains historical billing and webhook semantics. Moving to the Endive SDK contract needs a separate pinned response and webhook comparison. Managed Payments has its own eligibility and commercial-terms configuration. |
| Polar | [TypeScript SDK](https://www.npmjs.com/package/@polar-sh/sdk/v/1.3.2), [API changelog](https://polar.sh/docs/changelog/api) | Refresh reviewed 2026-10 and 2027-01 surfaces. An ended trial awaiting setup maps to incomplete. The 2027-01 item APIs preserve pending provider-managed discounts. |
| Paddle Billing | [TypeScript SDK](https://www.npmjs.com/package/@paddle/paddle-node-sdk/v/3.12.0), [developer changelog](https://developer.paddle.com/changelog/) | Keep API v1. API key rotation, account settings, retention reports and presentation settings are platform operations outside canonical billing. |
| Lemon Squeezy | [TypeScript SDK](https://www.npmjs.com/package/@lemonsqueezy/lemonsqueezy.js/v/4.0.0), [API changelog](https://docs.lemonsqueezy.com/api/getting-started/changelog), [wind-down](https://docs.lemonsqueezy.com/migration) | Existing integrations and scanning remain available for migration. New sign-ups closed 2026-11-16. Transaction processing, including renewals, ends 2027-03-31. Provider-assisted migrations remain external workflows. |
| x402 | [x402-paysdk](https://www.npmjs.com/package/x402-paysdk/v/0.1.0) | 0.1.0 remains the current SDK. One-time settlement and existing receipt verification remain the reviewed surface. |

## Native credit wallets

- `client.creditWallets` uses the provider ledger with a canonical customer ID and wallet name.
  Account ownership comes from the scoped customer mapping and provider read-back. Amounts are
  integer decimal strings in wallet units. The existing portable `client.credits` ledger is
  independent. No wallet state or balance is mirrored there.
- Get or ensure an account, read its balance, grant credits, debit, and reverse a Polybill
  transaction. Account creation uses a unique customer/name and zero opening balance. Reusing a
  name with a different unit fails. Transactions use canonical IDs and private provider mappings;
  explicit grant/debit commands preserve a host reference. The normal mutation claim precedes the
  remote write. Creem credit/debit passes the scoped key in `idempotency_key` and recovers unknown
  outcomes only from a matching ledger transaction. Wallet creation can recover by customer/name
  and unit; reversal can retry the same upstream transaction, which Creem makes idempotent.
- Configure `customerCredits` delivery on the Creem product and use the mapped customer at
  checkout. For AI generation use `requires_moderation: true`; select `resets_each_period` for
  subscriptions only when it matches the product terms. Creem owns automatic grants, renewal
  resets and payment-linked credit reversals. Credit webhook events signal a fresh balance read.
  They never apply an adjustment, grant payment finality or replace the balance with event data.
  A checkout with an explicit canonical customer requires that customer's Creem mapping.
- AI generation debits carry Creem's allow receipt for the same tenant, connection and environment.
  A receipt with a host reference can only be passed to a debit with that reference.
  Creem enforces store binding, expiry and single-use. The host stores receipts server-side and
  keeps each receipt tied to the exact generation it screened. A failed generation can reverse its
  debit by canonical transaction ID. Generation execution and retries remain host-owned.
- Native wallet transactions are pinned to the source provider. No schema migration is needed.

## Standalone moderation

`polybill/moderation` initializes with an explicit connection, a credential source and a
moderation provider. It does not require checkout, a webhook handler or a billing store. Creem
screens text; Dodo screens text and/or base64 image content. The result is `allow`, `flag` or
`deny`. Only `allow` permits generation. An unknown response, disabled account or transport
failure throws and produces no usable receipt. Prompt, image bytes and echoed provider text are
not logged or returned. Creem's endpoint accepts text; image-only screening cannot yield a Creem
receipt through the current API. Dodo's verdict is independent of Creem's credit policy.

## Waffo customer portal

Set `credentials.storeId` to the Pancake store's `STO_` ID and map the canonical customer to
the server-side buyer identity used at Waffo checkout. `customers.portal(customerId, returnUrl)`
issues a fresh token scoped to that buyer and store. Waffo controls the portal destination. Redirect
an authenticated customer immediately to the returned URL with `Cache-Control: no-store` and
`Referrer-Policy: no-referrer`. The URL fragment carries a bearer token and belongs outside logs
or caches.

## Evidence

Verification uses versioned references and offline fixtures. Adapter maturity remains
experimental; provider account permissions, real charges, renewal and delivery require
authenticated provider-side validation.
