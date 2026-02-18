import WalletPageClient from "./client";

export async function generateStaticParams() {
  // At least one param is required for output:"export" in Next.js 16.
  // Use "placeholder" to avoid Cloudflare Pages near-miss 308 redirects.
  return [{ address: "placeholder" }];
}

export default function WalletPage() {
  return <WalletPageClient />;
}
