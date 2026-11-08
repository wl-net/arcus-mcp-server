// Optional features, read once at startup

/** Optional features, off unless named in FEATURES (comma-separated, e.g. FEATURES=personal_info) */
export const Features = {
  /** Email addresses, phone numbers, street addresses and locations in tool results */
  PERSONAL_INFO: "personal_info",
} as const;

export type Feature = (typeof Features)[keyof typeof Features];

const KNOWN_FEATURES = new Set<string>(Object.values(Features));

/** Parse FEATURES, reporting names it doesn't know */
export function parseFeatures(
  value: string | undefined,
  warn: (name: string) => void = (name) => process.stderr.write(`[arcus] Unknown feature in FEATURES: ${name}\n`)
): Set<Feature> {
  const features = new Set<Feature>();
  for (const name of (value ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean)) {
    if (KNOWN_FEATURES.has(name)) features.add(name as Feature);
    else warn(name);
  }
  return features;
}
