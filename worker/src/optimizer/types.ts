/**
 * Shared types for strategy snapshot recording and offline replay.
 */

import type { WindowSignal } from "../strategies/price-feed";
import type { RegimeType, RegimeFeatures } from "../strategies/regime";

export interface BookConvictionSnapshot {
  upMid: number | null;
  downMid: number | null;
  bookDirection: "UP" | "DOWN" | "NEUTRAL";
  bookStrength: number;
  bidDepthRatio: number;
  midDelta: number;
  agreement: number;
}

/** Volume bucketed by price for a single token — replaces raw tape entries */
export interface TapeBucket {
  tokenId: string;
  price: number;   // rounded to $0.01
  size: number;     // total volume at this price
}

/** Aggregate tape stats for market context */
export interface TapeMeta {
  totalTrades: number;
  totalVolume: number;
  uniqueWallets: number;
}

/** A fill event observed by the live strategy during a tick period */
export interface RecordedFill {
  side: "UP" | "DOWN";
  price: number;    // actual fill price (bestAsk from crossesSpread)
  size: number;     // filled size
}

/** A sell event executed by the live strategy during a tick period */
export interface RecordedSell {
  side: "UP" | "DOWN";   // which token was sold
  price: number;          // actual sell price
  size: number;           // sold size
  costBasis: number;      // avg cost of the sold tokens
  fee: number;            // taker fee charged
  pnl: number;            // realized P&L from this sell
}

export interface TickSnapshot {
  t: number;
  price: number;
  signal: WindowSignal;
  regime: RegimeType;
  regimeFeatures: RegimeFeatures;
  regimeScores: Record<string, number>;
  fairUp: number;
  fairDown: number;
  bookConviction: BookConvictionSnapshot;
  tapeBuckets: TapeBucket[];
  tapeMeta: TapeMeta;
  bookBids: { price: number; size: number }[];
  upBookAsks: { price: number; size: number }[];
  downBookAsks: { price: number; size: number }[];
  upBidOrderId: string | null;
  upBidPrice: number;
  upBidSize: number;
  downBidOrderId: string | null;
  downBidPrice: number;
  downBidSize: number;
  upInventory: number;
  downInventory: number;
  upAvgCost: number;
  downAvgCost: number;
  /** Fill events detected since the previous tick.
   *  Recorded by the live strategy so replay can reproduce them exactly. */
  fills?: RecordedFill[];
  /** Sell events executed since the previous tick.
   *  Recorded by the live strategy so replay can reproduce sell P&L exactly. */
  sells?: RecordedSell[];
}

export interface WindowSnapshot {
  id: string;
  cryptoSymbol: string;
  windowOpenTime: number;
  windowEndTime: number;
  windowDurationMs: number;
  oracleStrike: number | null;
  outcome: "UP" | "DOWN" | "UNKNOWN";
  priceAtWindowOpen: number;
  hourUtc: number;
  dayOfWeek: number;
  upTokenId: string;
  downTokenId: string;
  ticks: TickSnapshot[];
}

export interface ReplayResult {
  upInventory: number;
  downInventory: number;
  upAvgCost: number;
  downAvgCost: number;
  totalBuyCost: number;
  realizedSellPnl: number;
  fillCount: number;
  sellCount: number;
  flipCount: number;
  netPnl: number;
  // Simulated replay debugging fields
  simulatedFillCount?: number;
  simulatedSellCount?: number;
  bidPlacementCount?: number;
}
