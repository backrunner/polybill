---
"@polybill/provider-paddle": patch
---

Reject Paddle partial refund requests before transport. Paddle adapter refund creation now supports
full refunds only and reports `unsupported_capability` for any partial amount.
