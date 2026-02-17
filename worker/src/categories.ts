const FEE_KEYWORDS = [
  "btc-updown",
  "eth-updown",
  "sol-updown",
  "updown",
];

export const DEFAULT_FEE_RATE = 0.0625;

export function marketHasFees(title: string): boolean {
  const lower = title.toLowerCase();
  return FEE_KEYWORDS.some((kw) => lower.includes(kw));
}
