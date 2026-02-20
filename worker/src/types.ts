export interface CopyTarget {
  wallet: string;
  mode: "paper" | "real";
  trade_pct: number;
  max_position_usd: number;
  active: number; // 0 or 1
  total_paper_pnl: number;
  total_real_pnl: number;
  slippage_bps: number;
  latency_ms: number;
  fee_rate: number;
  measured_slippage_bps: number;
  full_copy_below_usd: number;
}

export interface CopyTrade {
  id: string;
  source_trade_id: string;
  source_wallet: string;
  market: string;
  asset_id: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  mode: string;
  timestamp: string;
  status: string;
  pnl: number;
  source_price: number;
  exec_price: number;
  fee_amount: number;
  title: string;
}

export interface DataApiTrade {
  id: string;
  market: string;
  asset_id: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  timestamp: number; // epoch ms
  taker: string;
  maker: string;
  title: string;
  outcome: string;
  activity_type: "TRADE" | "CONVERSION" | "REDEEM";
  usdcSize: number; // for CONVERSION/REDEEM: effective USDC value
}

export interface Env {
  DB: D1Database;
  FIREHOSE_DB?: D1Database;
  LISTENER: DurableObjectNamespace;
  FIREHOSE: DurableObjectNamespace;
  WATCHLIST: DurableObjectNamespace;
  PYTHON_API_URL: string;
}
