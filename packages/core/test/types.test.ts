import { expectTypeOf, it } from "vitest";
import type { AssetAmount, Money, PaymentId, PriceId } from "../src/index.js";

it("keeps canonical brands distinct", () => {
  expectTypeOf<PaymentId>().not.toEqualTypeOf<PriceId>();
  expectTypeOf<Money>().not.toEqualTypeOf<AssetAmount>();
});
