import { signRsaSha256, verifyRsaSha256 } from "../src/index.js";
import { describe, expect, it } from "vitest";

const privateKey = `-----BEGIN PRIVATE KEY-----
MIICdQIBADANBgkqhkiG9w0BAQEFAASCAl8wggJbAgEAAoGBAKKAbsVwOAS4o69T
F15SDcbsejyhR7/2FyYs6Yx9CqQ8oTIP7YEchza2vQmm1IwbzXWyx3U4A3H6p0gk
8T0RHlH9MgKcMYNUg6IAR+ze7RTO02t+YaWAUj2RXPp1NsJkLS4i6HGQkVaU5QH1
otUcq7s+/tIGeINXLzNJEVrbO7zhAgMBAAECgYAFHOFfWO6KR3zu8UBU+WPxlFMs
QS7OvWFxFAytHOoOzNGNj667Vzhx4kIEYbliRyWpxFw+Ner11RsaS/9DGpzHjsJW
jhewuN2yjrFwsbjgZvdnTUUipKVoCxdztRKNPpfYCNgQs//V1TeBCItCLDpKA1ti
Tzs/TY1N8bCP9vQWOQJBANh2uKCaBGkJrjDkDndHYCsGH9j6UG9rHevNCmqWtBVv
z+fCdTtCAnM19n3D9Q64/v0uCc3qiprd9bv9yr24UacCQQDALpYogQwijCZqVMxh
/VdMLNvTiJ2Y920OKQqLdk07+12mJ4gendAm+v6M8Kn9AZqIKPiQQqtqDcPCZgrW
Pn43AkALWiaSnaEvlQdinwM3NDIR749KBM6lGTwHeshaEK8/FI8Vu3gEdJDGVAUq
UVWPwRn2UyzGdM9yEcPqaQPx8TGvAkBhZzszzDQaTm4p9lCgWYalVRcVX2iA3uan
BqYRiSQcAoq0a9TRr6qQFyZsyI1fbjCkUh+o/iFi3xcYsB9N9t6BAkAyyEZwwamX
+6SlgAOX6F2DC+aI4SvnMKrFT315x5Q2bMRd6rGp8cSoKmS2LITR8gh2y2kOXy/d
yEEUE8r2n9CA
-----END PRIVATE KEY-----`;

const publicKey = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCigG7FcDgEuKOvUxdeUg3G7Ho8
oUe/9hcmLOmMfQqkPKEyD+2BHIc2tr0JptSMG811ssd1OANx+qdIJPE9ER5R/TIC
nDGDVIOiAEfs3u0UztNrfmGlgFI9kVz6dTbCZC0uIuhxkJFWlOUB9aLVHKu7Pv7S
BniDVy8zSRFa2zu84QIDAQAB
-----END PUBLIC KEY-----`;

describe("Web Crypto RSA helpers", () => {
  it("matches an OpenSSL RSA-SHA256 known-answer vector", async () => {
    const message = new TextEncoder().encode(
      "POST\n/v1/actions/checkout/create-session\n1756080000\n47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
    );
    const signature = await signRsaSha256(privateKey, message);
    expect(signature).toBe(
      "gXJV0YSvD8IDiopg50bpfLrBW8hrvUk5HyAujUt3k9uqGTjv+bgycIn8zyqzikWzpu0AthPOV9cpXLJL0Ht6M49CD3o/nvMRd+hlL0JMy0t4Vis2yzfNGVIzUwbhtvfUGNpggsi2OhQCiCSJ17/BCIAbORigpIBxWa7x0CDOJNE=",
    );
    await expect(verifyRsaSha256(publicKey, message, signature)).resolves.toBe(true);
    await expect(
      verifyRsaSha256(publicKey, new TextEncoder().encode("tampered"), signature),
    ).resolves.toBe(false);
  });
});
