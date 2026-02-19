"use client";

import { useEffect, useState } from "react";
import {
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ReferenceLine,
  ResponsiveContainer,
  Legend as RechartsLegend,
} from "recharts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { PnlCell } from "@/components/pnl-cell";
import {
  api,
  type CopyDetailData,
  type OutcomeBreakdown,
  type OpenPositionStats,
} from "@/lib/api";
import { TrendingUp, Award, Hash, DollarSign, Activity } from "lucide-react";

function fmt(n: number) {
  return `$${(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtHold(hours: number): string {
  if (!hours || hours <= 0) return "\u2014";
  if (hours >= 24) return `${(hours / 24).toFixed(1)}d`;
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  const mins = hours * 60;
  if (mins >= 1) return `${mins.toFixed(0)}m`;
  return `${(mins * 60).toFixed(0)}s`;
}

function truncTitle(title: string, max = 35) {
  if (title.length <= max) return title;
  return `${title.slice(0, max)}...`;
}

function Stat({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ElementType;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border p-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-sm font-semibold tabular-nums">{children}</div>
      </div>
    </div>
  );
}

export function CopyTargetDetail({
  wallet,
  source = "local",
}: {
  wallet: string;
  source?: "local" | "cloud";
}) {
  const [data, setData] = useState<CopyDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .copyDetail(wallet, source)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [wallet, source]);

  if (error) {
    return (
      <p className="py-4 text-sm text-red-500">
        Failed to load detail: {error}
      </p>
    );
  }

  if (!data) {
    return (
      <div className="space-y-3 py-4">
        <div className="grid grid-cols-5 gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
        <Skeleton className="h-48" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      </div>
    );
  }

  const {
    summary: s,
    outcome_breakdown: ob,
    open_position_stats: ops,
    pnl_series,
    open_positions,
    closed_positions,
    missed_positions,
  } = data;
  const netPnl = s.total_realized_pnl + s.total_unrealized_pnl - s.total_fees;

  // Build pie chart data from outcome breakdown
  const OUTCOME_COLORS: Record<string, string> = {
    "Resolution Win": "#22c55e",
    "Resolution Loss": "#ef4444",
    "Sold for Profit": "#3b82f6",
    "Sold at Loss": "#f97316",
    "Open Positions": "#a3a3a3",
  };
  const pieData: { name: string; value: number }[] = [];
  if (ob) {
    if (ob.resolution_win > 0)
      pieData.push({ name: "Resolution Win", value: ob.resolution_win });
    if (ob.resolution_loss > 0)
      pieData.push({ name: "Resolution Loss", value: ob.resolution_loss });
    if (ob.sold_profit > 0)
      pieData.push({ name: "Sold for Profit", value: ob.sold_profit });
    if (ob.sold_loss > 0)
      pieData.push({ name: "Sold at Loss", value: ob.sold_loss });
  }
  if (open_positions.length > 0)
    pieData.push({ name: "Open Positions", value: open_positions.length });

  return (
    <div className="space-y-4 py-4">
      {/* Section 1: Summary Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat icon={TrendingUp} label="Net P&L">
          <span className={netPnl >= 0 ? "text-green-600" : "text-red-600"}>
            {fmt(netPnl)}
          </span>
        </Stat>
        <Stat icon={Award} label="Win Rate">
          <div className="flex items-center gap-2">
            <span>
              {s.wins + s.losses > 0 ? `${s.win_rate.toFixed(0)}%` : "N/A"}
            </span>
            {s.wins + s.losses > 0 && (
              <Progress value={s.win_rate} className="h-1.5 w-12" />
            )}
          </div>
          <span className="text-xs text-muted-foreground font-normal">
            {s.wins}W / {s.losses}L
            {(s.open_positions_count ?? 0) > 0 && (
              <span className="text-amber-600">
                {" "}
                / {s.open_positions_count} open
              </span>
            )}
          </span>
        </Stat>
        <Stat icon={Hash} label="Trades">
          {s.total_trades}
        </Stat>
        <Stat icon={DollarSign} label="Fees">
          {fmt(s.total_fees)}
        </Stat>
        <Stat icon={Activity} label="Slippage Cost">
          {fmt(s.total_slippage_cost)}
        </Stat>
      </div>

      {/* Best / Worst trade mini-stats */}
      {(s.best_trade_pnl !== 0 || s.worst_trade_pnl !== 0) && (
        <div className="flex gap-4 text-xs">
          <span className="text-muted-foreground">
            Best trade:{" "}
            <span className="font-semibold text-green-600">
              {fmt(s.best_trade_pnl)}
            </span>
          </span>
          <span className="text-muted-foreground">
            Worst trade:{" "}
            <span className="font-semibold text-red-600">
              {fmt(s.worst_trade_pnl)}
            </span>
          </span>
          {s.total_unrealized_pnl !== 0 && (
            <span className="text-muted-foreground">
              Unrealized:{" "}
              <span
                className={`font-semibold ${s.total_unrealized_pnl >= 0 ? "text-green-600" : "text-red-600"}`}
              >
                {fmt(s.total_unrealized_pnl)}
              </span>
            </span>
          )}
        </div>
      )}

      {/* Section 1b: Outcome Breakdown + Open Position Risk */}
      {pieData.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Pie chart */}
          <div>
            <h4 className="mb-2 text-sm font-medium">Position Outcomes</h4>
            <ResponsiveContainer width="100%" height={180}>
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={40}
                  outerRadius={70}
                  paddingAngle={2}
                  dataKey="value"
                  label={({ value, percent }) =>
                    `${value} (${((percent ?? 0) * 100).toFixed(0)}%)`
                  }
                >
                  {pieData.map((entry) => (
                    <Cell
                      key={entry.name}
                      fill={OUTCOME_COLORS[entry.name] ?? "#94a3b8"}
                    />
                  ))}
                </Pie>
                <RechartsTooltip
                  formatter={(value, name) => [
                    `${value} position${value !== 1 ? "s" : ""}`,
                    String(name),
                  ]}
                />
                <RechartsLegend
                  verticalAlign="bottom"
                  height={36}
                  iconSize={10}
                  wrapperStyle={{ fontSize: "11px" }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>

          {/* Open position risk summary */}
          {ops && ops.count > 0 && (
            <div>
              <h4 className="mb-2 text-sm font-medium">
                Open Position Risk
                <span className="ml-1 text-xs text-muted-foreground font-normal">
                  ({ops.count} position{ops.count !== 1 ? "s" : ""})
                </span>
              </h4>
              <div className="space-y-3 rounded-lg border p-3">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Capital at risk</span>
                  <span className="font-mono font-semibold tabular-nums text-amber-600">
                    {fmt(ops.capital_at_risk)}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    Avg implied win probability
                  </span>
                  <span className="font-mono font-semibold tabular-nums">
                    {ops.avg_implied_prob}%
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Progress
                    value={ops.avg_implied_prob}
                    className="h-2 flex-1"
                  />
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    Expected P&L at resolution
                  </span>
                  <span
                    className={`font-mono font-semibold tabular-nums ${
                      ops.expected_pnl >= 0 ? "text-green-600" : "text-red-600"
                    }`}
                  >
                    {fmt(ops.expected_pnl)}
                  </span>
                </div>
                <p className="text-[10px] text-muted-foreground leading-tight">
                  Based on entry prices as implied probabilities. Actual
                  outcomes depend on current market prices and resolution.
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      <Separator />

      {/* Section 2: Cumulative P&L Chart */}
      {pnl_series.length > 1 && (
        <div>
          <h4 className="mb-2 text-sm font-medium">Cumulative P&L</h4>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={pnl_series}>
              <defs>
                <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis
                dataKey="t"
                tick={{ fontSize: 10 }}
                tickFormatter={(v: string) => {
                  const d = new Date(v);
                  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
                }}
              />
              <YAxis
                tick={{ fontSize: 10 }}
                tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                width={60}
              />
              <RechartsTooltip
                formatter={(value: number | undefined) => [
                  fmt(value ?? 0),
                  "P&L",
                ]}
                labelFormatter={(label: any) =>
                  new Date(label).toLocaleString()
                }
              />
              <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="3 3" />
              <Area
                type="monotone"
                dataKey="pnl"
                stroke="#22c55e"
                fill="url(#pnlGrad)"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {pnl_series.length <= 1 && s.total_trades === 0 && (
        <p className="text-sm text-muted-foreground py-4 text-center">
          No copy trades recorded yet. Start the copy listener to begin.
        </p>
      )}

      {/* Section 3: Open & Closed Positions */}
      {(open_positions.length > 0 || closed_positions.length > 0) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Open Positions */}
          <div>
            <h4 className="mb-2 text-sm font-medium">
              Open Positions ({open_positions.length})
            </h4>
            {open_positions.length === 0 ? (
              <p className="text-xs text-muted-foreground">No open positions</p>
            ) : (
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Market</TableHead>
                      <TableHead className="text-xs text-right">Size</TableHead>
                      <TableHead className="text-xs text-right">
                        Entry
                      </TableHead>
                      <TableHead className="text-xs text-right">
                        Current
                      </TableHead>
                      <TableHead className="text-xs text-right">P&L</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {open_positions.map((p, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-xs max-w-[180px] truncate">
                          {truncTitle(p.title)}
                        </TableCell>
                        <TableCell className="text-xs text-right font-mono tabular-nums">
                          {p.size.toFixed(2)}
                        </TableCell>
                        <TableCell className="text-xs text-right font-mono tabular-nums">
                          ${p.entry_price.toFixed(4)}
                        </TableCell>
                        <TableCell className="text-xs text-right font-mono tabular-nums">
                          ${p.current_price.toFixed(4)}
                        </TableCell>
                        <TableCell className="text-xs text-right">
                          <PnlCell value={p.unrealized_pnl} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>

          {/* Closed Positions */}
          <div>
            <h4 className="mb-2 text-sm font-medium">
              Closed Positions ({closed_positions.length})
            </h4>
            {closed_positions.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No closed positions
              </p>
            ) : (
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Market</TableHead>
                      <TableHead className="text-xs text-right">Size</TableHead>
                      <TableHead className="text-xs text-right">
                        Entry
                      </TableHead>
                      <TableHead className="text-xs text-right">Exit</TableHead>
                      <TableHead className="text-xs text-right">P&L</TableHead>
                      <TableHead className="text-xs text-right">Hold</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {closed_positions.map((p, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-xs max-w-[180px] truncate">
                          {truncTitle(p.title)}
                        </TableCell>
                        <TableCell className="text-xs text-right font-mono tabular-nums">
                          {p.size.toFixed(2)}
                        </TableCell>
                        <TableCell className="text-xs text-right font-mono tabular-nums">
                          ${p.entry_price.toFixed(4)}
                        </TableCell>
                        <TableCell className="text-xs text-right font-mono tabular-nums">
                          ${p.exit_price.toFixed(4)}
                        </TableCell>
                        <TableCell className="text-xs text-right">
                          <PnlCell value={p.realized_pnl} />
                        </TableCell>
                        <TableCell className="text-xs text-right font-mono tabular-nums">
                          {fmtHold(p.hold_time_hours)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Section 4: Missed Positions */}
      {missed_positions.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
            Missed Positions ({missed_positions.length})
            <span className="ml-1 text-xs">
              &mdash; target positions opened before copying started
            </span>
          </summary>
          <div className="mt-2 overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Market</TableHead>
                  <TableHead className="text-xs">Outcome</TableHead>
                  <TableHead className="text-xs text-right">Size</TableHead>
                  <TableHead className="text-xs text-right">Value</TableHead>
                  <TableHead className="text-xs text-right">P&L</TableHead>
                  <TableHead className="text-xs text-right">% P&L</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {missed_positions.map((p, i) => (
                  <TableRow key={i} className="text-muted-foreground">
                    <TableCell className="text-xs max-w-[200px] truncate">
                      {truncTitle(p.title)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">
                        {p.outcome}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-right font-mono tabular-nums">
                      {p.size.toFixed(1)}
                    </TableCell>
                    <TableCell className="text-xs text-right font-mono tabular-nums">
                      {fmt(p.current_value)}
                    </TableCell>
                    <TableCell className="text-xs text-right">
                      <PnlCell value={p.cash_pnl} />
                    </TableCell>
                    <TableCell className="text-xs text-right font-mono tabular-nums">
                      <span
                        className={
                          p.percent_pnl > 0
                            ? "text-green-600"
                            : p.percent_pnl < 0
                              ? "text-red-500"
                              : ""
                        }
                      >
                        {(p.percent_pnl * 100).toFixed(1)}%
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </details>
      )}
    </div>
  );
}
