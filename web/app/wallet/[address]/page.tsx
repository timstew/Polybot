import WalletPageClient from "./client";

export async function generateStaticParams() {
  // At least one param is required for output:"export" in Next.js 16.
  // All other wallet addresses are handled by Pages SPA fallback.
  return [{ address: "_" }];
}

export default function WalletPage() {
  return <WalletPageClient />;
}
