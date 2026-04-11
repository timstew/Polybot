"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ReferenceLine,
  ReferenceArea,
  ResponsiveContainer,
  Legend as RechartsLegend,
} from "recharts";
import {
  api,
  type StrategyChartData,
  type ChartTickPoint,
} from "@/lib/api";

const TIMEFRAMES: Record<string, { since: number; maxPoints: number }> = {
  "1H":  { since: 3_600_000,    maxPoints: 200 },
  "6H":  { since: 21_600_000,   maxPoints: 300 },
  "1D":  { since: 86_400_000,   maxPoints: 400 },
  "1W":  { since: 604_800_000,  maxPoints: 500 },
  "ALL": { since: 0,            maxPoints: 500 },
};

type Tab = "pnl" | "wallets" | "book" | "metrics";

const fmtTime = (t: number) => {
  const d = new Date(t);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const fmtDateTime = (t: number) => {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${fmtTime(t)}`;
};

const fmt = (v: number) => `$${v.toFixed(2)}`;

// Compute regime bands from tick_series for background coloring
function computeRegimeBands(ticks: ChartTickPoint[]): Array<{ x1: number; x2: number; regime: string }> {
  if (ticks.length === 0) return [];
  const bands: Array<{ x1: number; x2: number; regime: string }> = [];
  let current = ticks[0].regime;
  let start = ticks[0].t;
  for (let i = 1; i < ticks.length; i++) {
    if (ticks[i].regime !== current) {
      bands.push({ x1: start, x2: ticks[i - 1].t, regime: current });
      current = ticks[i].regime;
      start = ticks[i].t;
    }
  }
  bands.push({ x1: start, x2: ticks[ticks.length - 1].t, regime: current });
  return bands;
}

const REGIME_COLORS: Record<string, string> = {
  trending: "rgba(59,130,246,0.08)",
  oscillating: "rgba(249,115,22,0.08)",
  calm: "rgba(34,197,94,0.08)",
  volatile: "rgba(239,68,68,0.08)",
  "near-strike": "rgba(168,85,247,0.08)",
  "late-window": "rgba(156,163,175,0.08)",
};

export function StrategyCharts({ strategyId, isActive }: { strategyId: string; isActive: boolean }) {
  const [hasOpened, setHasOpened] = useState(false);
  const [data, setData] = useState<StrategyChartData | null>(null);
  const [loading, setLoading] = useState(false);
  const [timeframe, setTimeframe] = useState<string>("1D");
  const [tab, setTab] = useState<Tab>("pnl");
  const [selectedSymbols, setSelectedSymbols] = useState<Set<string> | null>(null); // null = all
  const [selectedDurations, setSelectedDurations] = useState<Set<number> | null>(null); // null = all
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const detailsRef = useRef<HTMLDetailsElement>(null);

  const fetchData = useCallback(async () => {
    const tf = TIMEFRAMES[timeframe];
    const since = tf.since ? Date.now() - tf.since : 0;
    try {
      const result = await api.strategyChartData(strategyId, since, undefined, tf.maxPoints);
      setData(result);
    } catch { /* ignore */ }
    setLoading(false);
  }, [strategyId, timeframe]);

  // Fetch on first open, and re-fetch on timeframe change
  useEffect(() => {
    if (!hasOpened) return;
    setLoading(true);
    fetchData();
  }, [hasOpened, fetchData]);

  // Poll every 15s when active and open
  useEffect(() => {
    if (!hasOpened || !isActive) return;
    intervalRef.current = setInterval(fetchData, 15_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [hasOpened, isActive, fetchData]);

  const handleToggle = () => {
    if (detailsRef.current?.open && !hasOpened) {
      setHasOpened(true);
    }
  };

  // Extract available symbols and durations from both PnL trades and tick data
  const availableSymbols = useMemo(() => {
    if (!data) return [];
    const syms = new Set<string>();
    for (const t of data.pnl_series) if (t.symbol) syms.add(t.symbol);
    for (const t of data.tick_series) if (t.symbol) syms.add(t.symbol);
    return [...syms].sort();
  }, [data]);

  const availableDurations = useMemo(() => {
    if (!data) return [];
    const durs = new Set<number>();
    for (const t of data.pnl_series) if (t.window_duration_ms) durs.add(t.window_duration_ms);
    for (const t of data.tick_series) if (t.window_duration_ms) durs.add(t.window_duration_ms);
    return [...durs].sort((a, b) => a - b);
  }, [data]);

  // Filter tick series by selected symbols/durations
  const filteredTicks = useMemo(() => {
    if (!data?.tick_series) return [];
    return data.tick_series.filter((t) => {
      if (selectedSymbols && t.symbol && !selectedSymbols.has(t.symbol)) return false;
      if (selectedDurations && t.window_duration_ms && !selectedDurations.has(t.window_duration_ms)) return false;
      return true;
    });
  }, [data, selectedSymbols, selectedDurations]);

  // Filter PnL series — recompute cumulative PnL for the filtered subset
  const filteredPnl = useMemo(() => {
    if (!data?.pnl_series) return [];
    const filtered = data.pnl_series.filter((t) => {
      if (selectedSymbols && t.symbol && !selectedSymbols.has(t.symbol)) return false;
      if (selectedDurations && t.window_duration_ms && !selectedDurations.has(t.window_duration_ms)) return false;
      return true;
    });
    // Recompute cumulative PnL for filtered trades
    let cum = 0;
    return filtered.map((p) => ({ ...p, cumulative_pnl: (cum += p.trade_pnl) }));
  }, [data, selectedSymbols, selectedDurations]);

  const hasSnapshots = filteredTicks.length > 0;
  const showFilters = availableSymbols.length > 1 || availableDurations.length > 1;

  const toggleSymbol = (sym: string) => {
    setSelectedSymbols((prev) => {
      if (!prev) {
        // Was "all" — now select only this one
        return new Set([sym]);
      }
      const next = new Set(prev);
      if (next.has(sym)) next.delete(sym); else next.add(sym);
      // If all selected or none, reset to null (= all)
      if (next.size === 0 || next.size === availableSymbols.length) return null;
      return next;
    });
  };

  const toggleDuration = (dur: number) => {
    setSelectedDurations((prev) => {
      if (!prev) return new Set([dur]);
      const next = new Set(prev);
      if (next.has(dur)) next.delete(dur); else next.add(dur);
      if (next.size === 0 || next.size === availableDurations.length) return null;
      return next;
    });
  };

  return (
    <details ref={detailsRef} className="group" onToggle={handleToggle}>
      <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
        Charts
      </summary>

      <div className="mt-3 space-y-3">
        {/* Timeframe + Tab selectors */}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex gap-1">
            {(["pnl", "wallets", "book", "metrics"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                  tab === t
                    ? "bg-foreground text-background border-foreground"
                    : "bg-background text-muted-foreground border-border hover:text-foreground"
                }`}
              >
                {t === "pnl" ? "P&L" : t === "wallets" ? "Wallets" : t === "book" ? "Volume" : "Metrics"}
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            {Object.keys(TIMEFRAMES).map((tf) => (
              <button
                key={tf}
                onClick={() => setTimeframe(tf)}
                className={`px-2 py-1 text-xs rounded-md border transition-colors ${
                  timeframe === tf
                    ? "bg-foreground text-background border-foreground"
                    : "bg-background text-muted-foreground border-border hover:text-foreground"
                }`}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>

        {/* Symbol + Duration filters (only for snapshot-based tabs) */}
        {showFilters && (
          <div className="flex items-center gap-3 flex-wrap text-xs">
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground">Symbol:</span>
              {availableSymbols.map((sym) => {
                const active = !selectedSymbols || selectedSymbols.has(sym);
                return (
                  <button
                    key={sym}
                    onClick={() => toggleSymbol(sym)}
                    className={`px-1.5 py-0.5 rounded border transition-colors ${
                      active
                        ? "bg-blue-100 border-blue-300 text-blue-800"
                        : "bg-background border-border text-muted-foreground opacity-50"
                    }`}
                  >
                    {sym}
                  </button>
                );
              })}
            </div>
            {availableDurations.length > 1 && (
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground">Window:</span>
                {availableDurations.map((dur) => {
                  const active = !selectedDurations || selectedDurations.has(dur);
                  const label = dur >= 3_600_000 ? `${dur / 3_600_000}h` : `${dur / 60_000}m`;
                  return (
                    <button
                      key={dur}
                      onClick={() => toggleDuration(dur)}
                      className={`px-1.5 py-0.5 rounded border transition-colors ${
                        active
                          ? "bg-purple-100 border-purple-300 text-purple-800"
                          : "bg-background border-border text-muted-foreground opacity-50"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {loading && !data && (
          <div className="h-[220px] flex items-center justify-center text-sm text-muted-foreground">Loading...</div>
        )}

        {/* P&L tab */}
        {tab === "pnl" && data && (
          <PnlChart data={filteredPnl} />
        )}

        {/* Wallets tab */}
        {tab === "wallets" && data && (
          hasSnapshots
            ? <WalletsChart data={filteredTicks} />
            : <SnapshotHint />
        )}

        {/* Book tab — UP vs DOWN volume timeline */}
        {tab === "book" && data && (
          hasSnapshots
            ? <BookChart data={filteredTicks} />
            : <SnapshotHint />
        )}

        {/* Metrics tab */}
        {tab === "metrics" && data && (
          hasSnapshots
            ? <MetricsChart data={filteredTicks} />
            : <SnapshotHint />
        )}
      </div>
    </details>
  );
}

function SnapshotHint() {
  return (
    <div className="h-[220px] flex items-center justify-center text-sm text-muted-foreground">
      Enable <code className="mx-1 px-1 py-0.5 bg-muted rounded text-xs">record_snapshots</code> in strategy params to see this chart
    </div>
  );
}

function PnlChart({ data }: { data: StrategyChartData["pnl_series"] }) {
  if (data.length < 2) {
    return (
      <div className="h-[220px] flex items-center justify-center text-sm text-muted-foreground">
        Not enough trade data yet
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data}>
        <defs>
          <linearGradient id="stratPnlGreen" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="stratPnlRed" x1="0" y1="1" x2="0" y2="0">
            <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis dataKey="t" tick={{ fontSize: 10 }} tickFormatter={fmtDateTime} />
        <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => fmt(v)} width={60} />
        <RechartsTooltip
          formatter={(value: number | undefined) => [fmt(value ?? 0), "Cumulative P&L"]}
          labelFormatter={(label: any) => new Date(label).toLocaleString()}
        />
        <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="3 3" />
        <Area
          type="monotone"
          dataKey="cumulative_pnl"
          stroke="#22c55e"
          fill="url(#stratPnlGreen)"
          strokeWidth={2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function WalletsChart({ data }: { data: ChartTickPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis dataKey="t" tick={{ fontSize: 10 }} tickFormatter={fmtDateTime} />
        <YAxis yAxisId="left" tick={{ fontSize: 10 }} width={40} />
        <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10 }} width={50} tickFormatter={(v: number) => `$${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)}`} />
        <RechartsTooltip
          labelFormatter={(label: any) => new Date(label).toLocaleString()}
          formatter={(value: number | undefined, name?: string) => [
            name === "total_volume" ? `$${(value ?? 0).toFixed(0)}` : String(value ?? 0),
            name === "total_volume" ? "Volume" : "Wallets",
          ]}
        />
        <Bar yAxisId="right" dataKey="total_volume" fill="rgba(59,130,246,0.2)" stroke="rgba(59,130,246,0.5)" />
        <Line yAxisId="left" type="monotone" dataKey="unique_wallets" stroke="#8b5cf6" strokeWidth={2} dot={false} />
        <RechartsLegend />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function BookChart({ data }: { data: ChartTickPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis dataKey="t" tick={{ fontSize: 10 }} tickFormatter={fmtDateTime} />
        <YAxis tick={{ fontSize: 10 }} width={50} tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)} />
        <RechartsTooltip
          labelFormatter={(label: any) => new Date(label).toLocaleString()}
          formatter={(value: number | undefined, name?: string) => [
            (value ?? 0).toFixed(0),
            name === "up_volume" ? "UP Volume" : "DOWN Volume",
          ]}
        />
        <Bar dataKey="up_volume" fill="rgba(34,197,94,0.5)" stackId="vol" />
        <Bar dataKey="down_volume" fill="rgba(239,68,68,0.5)" stackId="vol" />
        <RechartsLegend />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function MetricsChart({ data }: { data: ChartTickPoint[] }) {
  const bands = computeRegimeBands(data);

  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis dataKey="t" tick={{ fontSize: 10 }} tickFormatter={fmtDateTime} />
        <YAxis yAxisId="left" tick={{ fontSize: 10 }} domain={[0, 1]} width={35} />
        <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10 }} width={40} />

        {/* Regime background bands */}
        {bands.map((band, i) => (
          <ReferenceArea
            key={i}
            x1={band.x1}
            x2={band.x2}
            yAxisId="left"
            fill={REGIME_COLORS[band.regime] || "rgba(0,0,0,0.03)"}
            fillOpacity={1}
            ifOverflow="extendDomain"
          />
        ))}

        <RechartsTooltip
          labelFormatter={(label: any) => new Date(label).toLocaleString()}
          formatter={(value: number | undefined, name?: string) => {
            const v = value ?? 0;
            if (name === "signal_strength") return [v.toFixed(3), "Signal"];
            return [v.toFixed(1), name === "up_inventory" ? "UP Inv" : "DN Inv"];
          }}
        />

        <Area yAxisId="right" type="monotone" dataKey="up_inventory" fill="rgba(34,197,94,0.15)" stroke="rgba(34,197,94,0.6)" strokeWidth={1} />
        <Area yAxisId="right" type="monotone" dataKey="down_inventory" fill="rgba(239,68,68,0.15)" stroke="rgba(239,68,68,0.6)" strokeWidth={1} />
        <Line yAxisId="left" type="monotone" dataKey="signal_strength" stroke="#3b82f6" strokeWidth={2} dot={false} />
        <RechartsLegend />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
