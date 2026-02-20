const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

async function fetchJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function postJSON<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export interface DbTableCounts {
  [key: string]: number;
}

export interface Stats {
  trade_count: number;
  wallet_count: number;
  bot_count: number;
  copy_targets: number;
  listening: boolean;
  listener_new_trades: number;
  listener_polls: number;
  listener_cumulative_seconds: number;
  copy_listening: boolean;
  db_ops?: DbTableCounts;
  db_firehose?: DbTableCounts;
}

export interface BotRow {
  wallet: string;
  confidence: number;
  category: string;
  trade_count: number;
  unique_markets: number;
  avg_trade_size_usd: number;
  avg_hold_time_hours: number;
  tags: string[];
  first_seen: string | null;
  last_seen: string | null;
}

export interface RankRow {
  rank: number;
  wallet: string;
  username: string;
  total_trades: number;
  total_volume_usd: number;
  realized_pnl: number;
  unrealized_pnl: number;
  pnl_pct: number;
  win_rate: number;
  markets_traded: number;
  active_positions: number;
  market_categories: string[];
  profit_1d: number;
  profit_7d: number;
  profit_30d: number;
  profit_all: number;
}

export interface Position {
  title: string;
  outcome: string;
  size: number;
  avg_price: number;
  current_price: number;
  initial_value: number;
  current_value: number;
  cash_pnl: number;
  percent_pnl: number;
  realized_pnl: number;
  slug: string;
}

export interface WalletDetail {
  username: string;
  alt_username: string;
  bot: {
    wallet: string;
    confidence: number;
    category: string;
    tags: string[];
    avg_hold_time_hours: number;
  } | null;
  profitability: {
    total_trades: number;
    total_volume_usd: number;
    realized_pnl: number;
    unrealized_pnl: number;
    pnl_pct: number;
    win_rate: number;
    markets_traded: number;
    active_positions: number;
    market_categories: string[];
  };
  positions: Position[];
}

export interface TradeRow {
  id: string;
  market: string;
  title: string;
  side: string;
  price: number;
  size: number;
  timestamp: string | null;
}

export interface CopyTarget {
  wallet: string;
  username: string;
  mode: string;
  trade_pct: number;
  max_position_usd: number;
  active: boolean;
  total_paper_pnl: number;
  total_real_pnl: number;
  slippage_bps: number;
  latency_ms: number;
  fee_rate: number;
  measured_slippage_bps: number;
  measured_latency_ms: number;
  observations: number;
  avg_hold_time_hours: number;
  trade_count: number;
  listening_hours: number;
  peak_capital: number;
  categories: string[];
  wins: number;
  losses: number;
  win_rate: number;
  open_positions_count: number;
  roi_pct: number;
}

export interface CopyTradeRow {
  id: string;
  source_trade_id: string;
  source_wallet: string;
  market: string;
  asset_id: string;
  side: string;
  price: number;
  size: number;
  mode: string;
  timestamp: string;
  status: string;
  pnl: number;
  source_price: number;
  exec_price: number;
  fee_amount: number;
}

export interface UnifiedBotRow {
  wallet: string;
  username: string;
  confidence: number;
  category: string;
  tags: string[];
  avg_hold_time_hours: number;
  pnl_pct: number;
  realized_pnl: number;
  unrealized_pnl: number;
  win_rate: number;
  total_volume_usd: number;
  active_positions: number;
  portfolio_value: number;
  market_categories: string[];
  profit_1d: number;
  profit_7d: number;
  profit_30d: number;
  profit_all: number;
  copy_score: number;
  efficiency: number;
  trades_per_market: number;
  avg_market_burst: number;
  max_market_burst: number;
  market_concentration: number;
}

export interface CopyDetailSummary {
  total_trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  open_positions_count: number;
  total_realized_pnl: number;
  total_unrealized_pnl: number;
  total_fees: number;
  total_slippage_cost: number;
  best_trade_pnl: number;
  worst_trade_pnl: number;
}

export interface PnlPoint {
  t: string;
  pnl: number;
}

export interface CopyOpenPosition {
  market: string;
  title: string;
  asset_id: string;
  size: number;
  entry_price: number;
  current_price: number;
  unrealized_pnl: number;
  entry_time: string;
}

export interface CopyClosedPosition {
  market: string;
  title: string;
  asset_id: string;
  size: number;
  entry_price: number;
  exit_price: number;
  realized_pnl: number;
  hold_time_hours: number;
  closed_at: string;
}

export interface CopyMissedPosition {
  title: string;
  outcome: string;
  size: number;
  current_value: number;
  cash_pnl: number;
  percent_pnl: number;
}

export interface OutcomeBreakdown {
  resolution_win: number;
  resolution_loss: number;
  sold_profit: number;
  sold_loss: number;
}

export interface OpenPositionStats {
  count: number;
  capital_at_risk: number;
  avg_implied_prob: number;
  expected_pnl: number;
}

export interface CopyDetailData {
  summary: CopyDetailSummary;
  outcome_breakdown?: OutcomeBreakdown;
  open_position_stats?: OpenPositionStats;
  pnl_series: PnlPoint[];
  open_positions: CopyOpenPosition[];
  closed_positions: CopyClosedPosition[];
  missed_positions: CopyMissedPosition[];
}

export interface UnifiedResponse {
  bots: UnifiedBotRow[];
  total: number;
  offset: number;
  limit: number;
}

export interface CategoryBreakdown {
  category: string;
  pnl: number;
  win_rate: number;
  volume: number;
  trade_count: number;
}

export interface StrategyAnalysis {
  wallet: string;
  username: string;
  analysis_time: string;
  total_trades: number;
  active_hours: number[][]; // 24x7 heatmap
  active_hours_utc: number[];
  quiet_window: {
    start_hour_utc: number;
    end_hour_utc: number;
    timezone_guess: string;
  };
  category_breakdown: CategoryBreakdown[];
  sizing: {
    median: number;
    p25: number;
    p75: number;
    max: number;
    count: number;
  };
  hold_times: Record<string, number>;
  hold_time_median_min: number;
  entry_exit: {
    avg_loss_exit_time_min: number;
    avg_win_exit_time_min: number;
    total_closed_trades: number;
  };
  side_analysis: {
    both_sides_pct: number;
    net_long_bias: number;
    markets_traded: number;
  };
  profits: {
    profit_1d: number;
    profit_7d: number;
    profit_30d: number;
    profit_all: number;
  };
  open_positions: number;
}

export interface SimilarBot {
  wallet: string;
  username: string;
  similarity: number;
  category: string;
  categories: string[];
  win_rate: number;
  profit_all: number;
  copy_score: number;
  trade_count: number;
}

export interface WatchlistLatest {
  profit_1d: number;
  profit_7d: number;
  profit_30d: number;
  profit_all: number;
  volume_24h: number;
  win_rate: number;
  open_positions: number;
  active_markets: number;
  avg_trade_size: number;
  trades_24h: number;
  copy_score: number;
  trend_7d: number | null;
  snapshot_at: string;
}

export interface WatchlistEntry {
  wallet: string;
  username: string;
  added_at: string;
  added_by: string;
  category: string;
  check_interval_min: number;
  last_checked: string | null;
  notes: string;
  latest: WatchlistLatest | null;
}

export interface WatchlistSnapshot {
  id: number;
  wallet: string;
  snapshot_at: string;
  profit_1d: number;
  profit_7d: number;
  profit_30d: number;
  profit_all: number;
  volume_24h: number;
  win_rate: number;
  open_positions: number;
  active_markets: number;
  avg_trade_size: number;
  trades_24h: number;
  copy_score: number;
  positions_json: string;
}

export interface WatchlistPosition {
  title: string;
  outcome: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  value: number;
  pnl: number;
}

export const api = {
  stats: () => fetchJSON<Stats>("/api/stats"),
  bots: (minConfidence = 0) =>
    fetchJSON<BotRow[]>(`/api/bots?min_confidence=${minConfidence}`),
  rank: (top = 30, minConfidence = 0, sortBy = "pnl_pct") =>
    fetchJSON<RankRow[]>(
      `/api/rank?top=${top}&min_confidence=${minConfidence}&sort_by=${sortBy}`,
    ),
  unified: async (limit = 50, offset = 0): Promise<UnifiedResponse> => {
    const data = await fetchJSON<UnifiedResponse | UnifiedBotRow[]>(
      `/api/unified?limit=${limit}&offset=${offset}`,
    );
    // Handle both old (array) and new (object) response shapes
    if (Array.isArray(data)) {
      return { bots: data, total: data.length, offset: 0, limit: data.length };
    }
    return data;
  },
  detect: (minTrades = 1) =>
    postJSON<{
      status: string;
      total_wallets?: number;
      bots_found?: number;
      wallets_scanned?: number;
    }>(`/api/detect?min_trades=${minTrades}`),
  detectStatus: () =>
    fetchJSON<{
      running: boolean;
      bots_found: number;
      wallets_scanned: number;
      total_wallets: number;
    }>("/api/detect/status"),
  botsClear: () => postJSON<{ status: string }>("/api/bots/clear"),
  tradesClear: () => postJSON<{ status: string }>("/api/trades/clear"),
  copyDetail: (wallet: string, source: "local" | "cloud" = "local") =>
    fetchJSON<CopyDetailData>(`/api/copy/detail/${wallet}?source=${source}`),
  wallet: (address: string) =>
    fetchJSON<WalletDetail>(`/api/wallet/${address}`),
  walletTrades: (address: string, limit = 100) =>
    fetchJSON<TradeRow[]>(`/api/wallet/${address}/trades?limit=${limit}`),
  listenerStart: () => postJSON<{ status: string }>("/api/listener/start"),
  listenerStop: () =>
    postJSON<{ status: string; new_trades?: number }>("/api/listener/stop"),
  copyTargets: () => fetchJSON<CopyTarget[]>("/api/copy/targets"),
  copyAdd: (wallet: string) =>
    postJSON<{ status: string; wallet: string }>("/api/copy/add", { wallet }),
  copyRemove: (wallet: string) =>
    postJSON<{ status: string; wallet: string }>("/api/copy/remove", {
      wallet,
    }),
  copyReactivate: (wallet: string) =>
    postJSON<{ status: string; wallet: string }>("/api/copy/reactivate", {
      wallet,
    }),
  copySetMode: (wallet: string, mode: "paper" | "real") =>
    postJSON<{ status: string; wallet: string; mode: string }>(
      "/api/copy/set-mode",
      { wallet, mode },
    ),
  copyUpdate: (
    wallet: string,
    updates: { trade_pct?: number; max_position_usd?: number },
  ) =>
    postJSON<{ status: string; wallet: string }>("/api/copy/update", {
      wallet,
      ...updates,
    }),
  copyTrades: (wallet = "", limit = 200) =>
    fetchJSON<CopyTradeRow[]>(
      `/api/copy/trades?wallet=${wallet}&limit=${limit}`,
    ),
  copyListenerStart: () =>
    postJSON<{ status: string; detail?: string }>("/api/copy/listener/start"),
  copyListenerStop: () =>
    postJSON<{ status: string }>("/api/copy/listener/stop"),
  cloudSyncTargets: () =>
    postJSON<{ status: string; count: number }>(
      "/api/copy/listener/cloud-sync",
      {},
    ),
  cloudListenerStart: () =>
    postJSON<{ status: string }>("/api/copy/listener/cloud-start", {}),
  cloudListenerStop: () =>
    postJSON<{ status: string }>("/api/copy/listener/cloud-stop", {}),
  cloudListenerStatus: () =>
    fetchJSON<{
      running: boolean;
      polls?: number;
      trade_count?: number;
      error?: string;
    }>("/api/copy/listener/cloud-status"),
  cloudTrades: (limit = 20) =>
    fetchJSON<CopyTradeRow[]>(`/api/copy/trades/cloud?limit=${limit}`),
  cloudTargets: () => fetchJSON<CopyTarget[]>("/api/copy/targets/cloud"),
  dismissBot: (wallet: string) =>
    postJSON<{ status: string; wallet: string }>("/api/bots/dismiss", {
      wallet,
    }),
  undismissBot: (wallet: string) =>
    postJSON<{ status: string; wallet: string }>("/api/bots/undismiss", {
      wallet,
    }),

  // Strategy analysis
  walletStrategy: (address: string) =>
    fetchJSON<StrategyAnalysis>(`/api/wallet/${address}/strategy`),
  similarBots: (address: string, top = 20) =>
    fetchJSON<{ reference: string; similar: SimilarBot[] }>(
      `/api/bots/similar/${address}?top=${top}`,
    ),

  // Watchlist
  watchlist: () => fetchJSON<WatchlistEntry[]>("/api/watchlist"),
  watchlistAdd: (
    wallet: string,
    opts?: { notes?: string; category?: string; added_by?: string },
  ) =>
    postJSON<{
      status: string;
      wallet: string;
      category: string;
      username: string;
      check_interval_min: number;
    }>("/api/watchlist/add", { wallet, ...opts }),
  watchlistRemove: (wallet: string) =>
    postJSON<{ status: string; wallet: string }>("/api/watchlist/remove", {
      wallet,
    }),
  watchlistPromote: (
    wallet: string,
    mode: "paper" | "real" = "paper",
    opts?: { trade_pct?: number; max_position_usd?: number },
  ) =>
    postJSON<{ status: string; wallet: string; mode: string }>(
      "/api/watchlist/promote",
      { wallet, mode, ...opts },
    ),
  watchlistHistory: (wallet: string, limit = 100) =>
    fetchJSON<WatchlistSnapshot[]>(
      `/api/watchlist/${wallet}/history?limit=${limit}`,
    ),
  watchlistPositions: (wallet: string) =>
    fetchJSON<WatchlistPosition[]>(`/api/watchlist/${wallet}/positions`),
  watchlistStatus: () =>
    fetchJSON<{
      running: boolean;
      userStopped: boolean;
      lastRun: string | null;
      walletsChecked: number;
    }>("/api/watchlist/status"),
};
