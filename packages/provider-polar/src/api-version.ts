// Reviewed against Polar's versioned OpenAPI; see .agents/POLAR_API_2026-10.md.
export const POLAR_API_VERSION = "2026-10";
export const POLAR_API_VERSIONS = ["2026-10", "2027-01"] as const;
export type PolarApiVersion = (typeof POLAR_API_VERSIONS)[number];

export function assertPolarApiVersion(value: unknown): asserts value is PolarApiVersion {
  if (value !== "2026-10" && value !== "2027-01")
    throw new TypeError("Unsupported Polar API version; choose 2026-10 or 2027-01");
}

export function supportsPolarWebhookVersion(value: unknown): boolean {
  // Historical deliveries keep their original payload, including before API versioning.
  return value === undefined || value === "2026-04" || value === "2026-10" || value === "2027-01";
}
