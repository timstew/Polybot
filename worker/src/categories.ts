// Keywords that indicate a fee-bearing market (checked against title AND slug)
const FEE_KEYWORDS = [
  // Slug patterns
  "btc-updown",
  "eth-updown",
  "sol-updown",
  "updown",
  // Title patterns
  "up or down",
  "bitcoin above",
  "ethereum above",
];

export const DEFAULT_FEE_RATE = 0.0625;

export function marketHasFees(titleOrSlug: string): boolean {
  if (!titleOrSlug) return true; // Default: assume fees when unknown
  const lower = titleOrSlug.toLowerCase();
  return FEE_KEYWORDS.some((kw) => lower.includes(kw));
}
