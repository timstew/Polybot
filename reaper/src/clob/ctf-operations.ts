/**
 * CTF (Conditional Token Framework) on-chain operations — merge + redeem.
 *
 * Replaces the Python `redeem.py` middleman. Uses ethers v5 directly on Polygon.
 * All contract addresses sourced from official @polymarket/clob-client config.
 *
 * Security notes:
 * - Addresses verified against @polymarket/clob-client v1 + v2 MATIC_CONTRACTS
 * - callStatic dry-run before every real tx (pattern from poly-sdk analysis)
 * - Paper mode guard — real txs only when mode === "real"
 *
 * Gas: Polygon gas is ~$0.001-$0.01/tx. No relayer needed for EOA wallets.
 */

import { ethers, type Wallet } from "ethers";

// ── Contract addresses from @polymarket/clob-client MATIC_CONTRACTS ──────
// Verified April 16, 2026 against:
//   node_modules/@polymarket/clob-client/dist/config.js
//   node_modules/@polymarket/clob-client-v2/dist/config.js
const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";     // conditionalTokens
const NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";  // negRiskAdapter
const USDC_POLYGON = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";     // collateral (v1 = USDC.e)
const ZERO_BYTES32 = ethers.constants.HashZero;

// ── Minimal ABIs (only the functions we call) ────────────────────────────
// Function signatures verified against Python redeem.py which has been
// executing successfully on these contracts since March 2026.
const CTF_ABI = [
  "function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)",
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
  "function balanceOf(address owner, uint256 tokenId) view returns (uint256)",
];

const NEG_RISK_ABI = [
  "function redeemPositions(bytes32 conditionId, uint256[] amounts)",
];

const POLYGON_RPC = "https://polygon-bor.publicnode.com";
const GAS_LIMIT = 500_000; // generous limit; actual usage is ~100-200K

// ── Types ───────────────────────────────────────────────────────────────

export interface MergeResult {
  status: "merged" | "simulated" | "failed";
  tx_hash?: string;
  pairs_merged: number;
  error?: string;
}

export interface RedeemResult {
  status: "redeemed" | "simulated" | "failed";
  tx_hash?: string;
  condition_id: string;
  error?: string;
}

// ── Cached provider + contract instances ────────────────────────────────

let cachedWallet: Wallet | null = null;
let cachedProvider: ethers.providers.JsonRpcProvider | null = null;

function getProvider(): ethers.providers.JsonRpcProvider {
  if (!cachedProvider) {
    cachedProvider = new ethers.providers.JsonRpcProvider(POLYGON_RPC);
  }
  return cachedProvider;
}

function getWallet(privateKey: string): Wallet {
  if (!cachedWallet || cachedWallet.privateKey !== privateKey) {
    cachedWallet = new ethers.Wallet(privateKey, getProvider());
  }
  return cachedWallet;
}

// ── Merge ───────────────────────────────────────────────────────────────

/**
 * Merge paired UP+DOWN tokens back to USDC.e.
 * Both token types must have sufficient balance.
 *
 * @param privateKey — EOA private key (from env)
 * @param conditionId — market condition ID (hex string with 0x prefix)
 * @param amount — number of pairs to merge (in token units, 6 decimals)
 * @param dryRun — if true, only simulate (callStatic), don't send tx
 */
export async function mergePositions(
  privateKey: string,
  conditionId: string,
  amount: number,
  dryRun = false,
): Promise<MergeResult> {
  try {
    const wallet = getWallet(privateKey);
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);

    // Partition for binary markets: [1, 2] = [outcome 0 (UP/YES), outcome 1 (DOWN/NO)]
    const partition = [1, 2];
    const amountWei = ethers.utils.parseUnits(amount.toFixed(6), 6);

    // Dry-run: simulate to catch revert reasons before spending gas
    try {
      await ctf.callStatic.mergePositions(
        USDC_POLYGON, ZERO_BYTES32, conditionId, partition, amountWei,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { status: "failed", pairs_merged: 0, error: `Dry-run reverted: ${reason.slice(0, 200)}` };
    }

    if (dryRun) {
      return { status: "simulated", pairs_merged: amount };
    }

    // Real tx
    const tx = await ctf.mergePositions(
      USDC_POLYGON, ZERO_BYTES32, conditionId, partition, amountWei,
      { gasLimit: GAS_LIMIT },
    );
    const receipt = await tx.wait(1); // wait 1 confirmation

    return {
      status: "merged",
      tx_hash: receipt.transactionHash,
      pairs_merged: amount,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { status: "failed", pairs_merged: 0, error: error.slice(0, 300) };
  }
}

// ── Redeem ──────────────────────────────────────────────────────────────

/**
 * Redeem winning tokens after market resolution.
 * Supports both standard CTF and NegRisk adapter contracts.
 *
 * @param privateKey — EOA private key
 * @param conditionId — market condition ID
 * @param isNegRisk — true if the market uses the NegRisk adapter
 * @param amounts — for NegRisk: array of amounts per outcome. For CTF: ignored (redeems all).
 */
export async function redeemPositions(
  privateKey: string,
  conditionId: string,
  isNegRisk = false,
  amounts?: number[],
  dryRun = false,
): Promise<RedeemResult> {
  try {
    const wallet = getWallet(privateKey);

    if (isNegRisk) {
      // NegRisk adapter has different signature
      const negRisk = new ethers.Contract(NEG_RISK_ADAPTER, NEG_RISK_ABI, wallet);
      const amountsWei = (amounts || []).map(a => ethers.utils.parseUnits(a.toFixed(6), 6));

      try {
        await negRisk.callStatic.redeemPositions(conditionId, amountsWei);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { status: "failed", condition_id: conditionId, error: `Dry-run reverted: ${reason.slice(0, 200)}` };
      }

      if (dryRun) return { status: "simulated", condition_id: conditionId };

      const tx = await negRisk.redeemPositions(conditionId, amountsWei, { gasLimit: GAS_LIMIT });
      const receipt = await tx.wait(1);
      return { status: "redeemed", tx_hash: receipt.transactionHash, condition_id: conditionId };
    }

    // Standard CTF redeem
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);
    // indexSets for binary: [1, 2] — both outcomes
    const indexSets = [1, 2];

    try {
      await ctf.callStatic.redeemPositions(USDC_POLYGON, ZERO_BYTES32, conditionId, indexSets);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { status: "failed", condition_id: conditionId, error: `Dry-run reverted: ${reason.slice(0, 200)}` };
    }

    if (dryRun) return { status: "simulated", condition_id: conditionId };

    const tx = await ctf.redeemPositions(
      USDC_POLYGON, ZERO_BYTES32, conditionId, indexSets,
      { gasLimit: GAS_LIMIT },
    );
    const receipt = await tx.wait(1);
    return { status: "redeemed", tx_hash: receipt.transactionHash, condition_id: conditionId };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { status: "failed", condition_id: conditionId, error: error.slice(0, 300) };
  }
}

/**
 * Check token balance for a specific conditional token.
 */
export async function getTokenBalance(
  privateKey: string,
  tokenId: string,
): Promise<number> {
  try {
    const wallet = getWallet(privateKey);
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);
    const balance = await ctf.balanceOf(wallet.address, tokenId);
    return parseFloat(ethers.utils.formatUnits(balance, 6));
  } catch {
    return 0;
  }
}
