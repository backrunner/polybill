import { signRsaSha256, verifyRsaSha256 } from "../src/index.js";
import { describe, expect, it } from "vitest";

const privateKey = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDjlxBp+j6/bFS6
C2fX9dOKLcAUAwf34RznbML1GhFuVjXCrLAvg9bCcYqEoWVSVmhh8rxYKLhwTDB5
aKRuQ9m1Tj5b4MwwsKn1OyDkoFvwACc4GkKvD1BXGGCxaWWTPMKztSXSR/YcRGSo
afWOqT/pd1PAaQ1AdVt882NJhPfQjb9Tw+qyLW5ys7H0NAMn+iiCXQ8mI58ngPP9
HynupRvb+VGgfiy6cTYyEwpxsvskmkBwC/jn53+evkN9tjXEHVxQYf2jV8Ny8HGa
rKPZ76AkeJRLCWjvT4VzoDdpUFJPZFUHYQudoBZ8+xotuD4BNwmkL0h7PTw+fVmY
RHBsxb5nAgMBAAECggEAH4X9johMZ6xEIg7RX97bYaDLoZn34RQrsjxk1pk5P9yu
DpxnvPUYao9afdtzEtAIHkUGZHmjbl6HOlHNsL4yKgQ/6+77qWTW7bI2cKRrh5cl
14X/pYrL+HxWbExqdtXsLAMTzYgNJUYt4QvoKM31ncta7ORAIyT+OpTltDm4L4kn
wInm+/CgyjtkrpsM4kKjXbVdKZkNEUSuoKKd0Wt9szED74huHRKnW/QwQC07kfVB
0vbc8ulpbytMI5XmIweBXZXTcXRzr7fKWpiiFYf2Q2Gk1fnVhEGFGOveTyJ3+Fjp
9I6Q+GCUAs8ExOl49+emUi67X1YusqFm6NKZ8eEvsQKBgQD8EW2lUdTiSYnrm3eu
sbsP/oUij/FtnxMPqWdJoUmj57WUakxk0Gs4P9C7PkE4egaR4dhJO9PL8V83dAzA
AR18zdyLIkX3EbmBlwyUFYbAxjq90MHTxqI18RI2aaJGHjSymRgMNJzNEc+8zieX
ezi6AO6aiUQdbihStCHm8I37MQKBgQDnI+OWrAHysQ+/RJ8SMYhcJZK4mR99vR3t
4N/eC4arh5ykHGTOvSWqDsFhSC/nGO9CMt2hqY6NZ8b9SqbGSxxKBlSERwFhjBwh
QeFxIOx3jGHJ6RQzFdZZGaVOV293H6l8LRi3PnDwEKfQ8gXxvZNOz3xA+Oi/lRBM
anV00GG9FwKBgAj4JcqoKscSjtHPambQ9DMRf3NHY/PeoTMBeCdqkdA/QnrRfX5o
3CfYPXksMe3siadPPf79HgA3yoeSnZGHeKEkQiDBS3QLMWqnEU+DpJPfed+fOgZr
HwKEXX2KLLgKAx4HzI9CoAG8DIRPYaFGRTJ5LgRZtg7GCLFIr5wkGylBAoGBAJhg
05gwO3SIgA4jKg8vcmr1Jj3mTJlzRLje6BcVWCna1Exon5ifn6X15kzA7zuV952X
tP7vrhfQ06GGRl4xhCvU8oDl4qYxXRYbvYj8IIhLlugqbXOkMNQ6kP0NrWFGEVDY
1hNv6bqJ8GhSNdMBnIx3Qr3+mko69iy6fkaNXfHvAoGBAIikgMlN661t6rxzoOxk
R9OIUx7CvqBk1hdP6lIkmkkXdQZY1M4Zbferd3H+IxGu8Yc2IZrW7xYZJTOa2PL9
kGpAkoLdL40m8bPYOayB0mGtVpaL8YjOqvg75E2Mmfz7wLKdSR6eTtBYit859Zuy
pDsFV/sTPI6yIMs5NBo2wOo1
-----END PRIVATE KEY-----`;

const publicKey = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA45cQafo+v2xUugtn1/XT
ii3AFAMH9+Ec52zC9RoRblY1wqywL4PWwnGKhKFlUlZoYfK8WCi4cEwweWikbkPZ
tU4+W+DMMLCp9Tsg5KBb8AAnOBpCrw9QVxhgsWllkzzCs7Ul0kf2HERkqGn1jqk/
6XdTwGkNQHVbfPNjSYT30I2/U8Pqsi1ucrOx9DQDJ/oogl0PJiOfJ4Dz/R8p7qUb
2/lRoH4sunE2MhMKcbL7JJpAcAv45+d/nr5DfbY1xB1cUGH9o1fDcvBxmqyj2e+g
JHiUSwlo70+Fc6A3aVBST2RVB2ELnaAWfPsaLbg+ATcJpC9Iez08Pn1ZmERwbMW+
ZwIDAQAB
-----END PUBLIC KEY-----`;

describe("Web Crypto RSA helpers", () => {
  it("matches an OpenSSL RSA-SHA256 known-answer vector", async () => {
    const message = new TextEncoder().encode(
      "POST\n/v1/actions/checkout/create-session\n1756080000\n47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
    );
    const signature = await signRsaSha256(privateKey, message);
    expect(signature).toBe(
      "00IyHErD0Y04pGb+93VBWYUWaJ8bUO++8neVIcvEYPpdPZ00qqfhFR+mFKiPPcDAEo+wWejxUTH8OdzhNZ/DuxktSLdbwfBQ8XoCytpg3SWZcx9IjnvAXx1+LM4JYBaT+RQaTfTFwkGMdYbxqSRkeEqLOC6cdR9x8wm0l2Eyt3P7P9D/KBh/50P17TEnRfm4wrpUsOCEo7OkayaBVHhmZ+6uXTTW65XbqmMsZ7i2U4BJvEorOGj3zLQTxTPpmGJHDrU1E+ll8iFosCHEXzAgVpCCZR0Y4HOuhikgrIVwi0i6DuiD27QBr5Lu5Gwmj2ussO6xhSqCnwLzPTSMgbK6eg==",
    );
    await expect(verifyRsaSha256(publicKey, message, signature)).resolves.toBe(true);
    await expect(
      verifyRsaSha256(publicKey, new TextEncoder().encode("tampered"), signature),
    ).resolves.toBe(false);
  });
});
