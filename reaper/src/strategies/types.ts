/**
 * BidStrategy — stateless bid computation from explicit market context.
 *
 * All strategies must be pure (deterministic given context) so they can be
 * replayed identically in backtests.
 */

export interface BidContext {
  // Window metadata
  window_slug: string;
  window_duration_sec: number;
  elapsed_sec: number;         // seconds since window open (can be negative if early)
  elapsed_pct: number;          // elapsed_sec / window_duration_sec
  remaining_sec: number;

  // Market state
  p_true: number;               // 0..1 — strategy's fair-value estimate
  spot_price: number;
  up_best_bid: number | null;
  up_best_ask: number | null;
  up_ask_size: number | null;   // tokens available at the best ask (for taker sizing)
  up_last_trade: number | null;
  dn_best_bid: number | null;
  dn_best_ask: number | null;
  dn_ask_size: number | null;
  dn_last_trade: number | null;

  // Our inventory / state
  up_inventory: number;
  up_avg_cost: number;
  dn_inventory: number;
  dn_avg_cost: number;

  // Budget
  base_bid_size: number;        // dynamic, from capital scaling
  committed_capital: number;    // currently tied up in resting orders
  effective_capital: number;    // max allowed

  // Strategy state (sticky across ticks for a given window) — opt-in
  state?: Record<string, unknown>;
}

export interface BidLevel {
  side: "UP" | "DOWN";
  price: number;      // $0.01 precision (will be truncated if needed)
  size: number;       // integer tokens
  level: number;      // 1..N ladder position (higher = more aggressive)
}

export interface BidStrategy {
  readonly name: string;
  readonly description: string;
  compute(ctx: BidContext): BidLevel[];

  /** Optional: strategies can expose a label describing current phase for UI/logging. */
  getPhase?(ctx: BidContext): string;

  /** Optional: clear per-window sticky state when a window resolves. */
  clearWindowState?(slug: string): void;
}
