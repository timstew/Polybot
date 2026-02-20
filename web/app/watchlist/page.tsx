"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { WalletLink } from "@/components/wallet-link";
import { PnlCell } from "@/components/pnl-cell";
import { CategoryBadge } from "@/components/category-badge";
import {
  api,
  type WatchlistEntry,
  type WatchlistSnapshot,
  type WatchlistPosition,
} from "@/lib/api";
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  Eye,
  Plus,
  Trash2,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

// ── Helpers ────────────────────────────────────────────────────────

function fmt(n: number) {
  return `$${(n ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function TrendBadge({ value }: { value: number | null }) {
  if (value === null || value === undefined) return <span className="text-xs text-muted-foreground">--</span>;
  const positive = value >= 0;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-xs font-medium ${
        positive ? "text-emerald-600" : "text-red-500"
      }`}
    >
      {positive ? (
        <TrendingUp className="h-3 w-3" />
      ) : (
        <TrendingDown className="h-3 w-3" />
      )}
      {positive ? "+" : ""}
      {value.toFixed(1)}%
    </span>
  );
}

// Tiny sparkline using SVG (last N snapshots of profit_all)
function Sparkline({ data }: { data: number[] }) {
  if (data.length < 2) return <span className="text-xs text-muted-foreground">--</span>;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const w = 60;
  const h = 20;
  const points = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - ((v - min) / range) * h;
      return `${x},${y}`;
    })
    .join(" ");
  const trending = data[data.length - 1] >= data[0];
  return (
    <svg width={w} height={h} className="inline-block">
      <polyline
        points={points}
        fill="none"
        stroke={trending ? "#059669" : "#ef4444"}
        strokeWidth="1.5"
      />
    </svg>
  );
}

// ── Add Wallet Dialog ──────────────────────────────────────────────

function AddWalletForm({ onAdd }: { onAdd: () => void }) {
  const [wallet, setWallet] = useState("");
  const [category, setCategory] = useState("unknown");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const handleSubmit = async () => {
    if (!wallet.startsWith("0x") || wallet.length < 10) return;
    setLoading(true);
    try {
      await api.watchlistAdd(wallet.toLowerCase(), { category, notes });
      setWallet("");
      setNotes("");
      setOpen(false);
      onAdd();
    } catch (e) {
      console.error("Failed to add:", e);
    } finally {
      setLoading(false);
    }
  };

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="mr-1 h-4 w-4" /> Add Wallet
      </Button>
    );
  }

  return (
    <div className="flex items-end gap-2 rounded-lg border p-3">
      <div className="flex-1">
        <label className="text-xs text-muted-foreground">Wallet Address</label>
        <Input
          placeholder="0x..."
          value={wallet}
          onChange={(e) => setWallet(e.target.value)}
          className="h-8 font-mono text-sm"
        />
      </div>
      <div className="w-32">
        <label className="text-xs text-muted-foreground">Category</label>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="h-8 w-full rounded-md border bg-background px-2 text-sm"
        >
          <option value="unknown">Auto-detect</option>
          <option value="crypto">Crypto</option>
          <option value="politics">Politics</option>
          <option value="sports">Sports</option>
          <option value="finance">Finance</option>
        </select>
      </div>
      <div className="w-48">
        <label className="text-xs text-muted-foreground">Notes</label>
        <Input
          placeholder="Optional notes..."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="h-8 text-sm"
        />
      </div>
      <Button size="sm" onClick={handleSubmit} disabled={loading || !wallet.startsWith("0x")}>
        {loading ? "Adding..." : "Add"}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </div>
  );
}

// ── Expanded Detail Row ────────────────────────────────────────────

function WatchlistDetail({
  entry,
  onPromote,
  onRemove,
}: {
  entry: WatchlistEntry;
  onPromote: (wallet: string, mode: "paper" | "real") => void;
  onRemove: (wallet: string) => void;
}) {
  const [history, setHistory] = useState<WatchlistSnapshot[]>([]);
  const [positions, setPositions] = useState<WatchlistPosition[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.watchlistHistory(entry.wallet, 50),
      api.watchlistPositions(entry.wallet),
    ]).then(([h, p]) => {
      setHistory(h);
      setPositions(p);
      setLoading(false);
    });
  }, [entry.wallet]);

  if (loading) {
    return (
      <TableRow>
        <TableCell colSpan={11} className="bg-muted/30 p-4">
          <Skeleton className="h-24 w-full" />
        </TableCell>
      </TableRow>
    );
  }

  // Build sparkline data from history (oldest first)
  const sparkData = [...history].reverse().map((s) => s.profit_all);

  return (
    <TableRow>
      <TableCell colSpan={11} className="bg-muted/30 p-4">
        <div className="grid grid-cols-3 gap-4">
          {/* Snapshot history chart */}
          <div>
            <h4 className="mb-2 text-sm font-medium">P&L Trend ({history.length} snapshots)</h4>
            {sparkData.length >= 2 ? (
              <svg width="100%" height="80" viewBox="0 0 200 80" preserveAspectRatio="none">
                {(() => {
                  const min = Math.min(...sparkData);
                  const max = Math.max(...sparkData);
                  const range = max - min || 1;
                  const points = sparkData
                    .map((v, i) => {
                      const x = (i / (sparkData.length - 1)) * 200;
                      const y = 75 - ((v - min) / range) * 70;
                      return `${x},${y}`;
                    })
                    .join(" ");
                  const trending = sparkData[sparkData.length - 1] >= sparkData[0];
                  return (
                    <polyline
                      points={points}
                      fill="none"
                      stroke={trending ? "#059669" : "#ef4444"}
                      strokeWidth="2"
                    />
                  );
                })()}
              </svg>
            ) : (
              <p className="text-xs text-muted-foreground">Waiting for snapshots...</p>
            )}
          </div>

          {/* Top Positions */}
          <div>
            <h4 className="mb-2 text-sm font-medium">Top Positions</h4>
            {positions.length === 0 ? (
              <p className="text-xs text-muted-foreground">No position data yet</p>
            ) : (
              <div className="space-y-1">
                {positions.slice(0, 5).map((p, i) => (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <span className="max-w-[180px] truncate" title={p.title}>
                      {p.title}
                    </span>
                    <PnlCell value={p.pnl} />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Actions */}
          <div>
            <h4 className="mb-2 text-sm font-medium">Actions</h4>
            <div className="space-y-2">
              <Button
                size="sm"
                className="w-full"
                onClick={() => onPromote(entry.wallet, "paper")}
              >
                <ArrowUpRight className="mr-1 h-3 w-3" /> Promote to Paper Trading
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                onClick={() => onPromote(entry.wallet, "real")}
              >
                <ArrowUpRight className="mr-1 h-3 w-3" /> Promote to Real Trading
              </Button>
              <Button
                size="sm"
                variant="destructive"
                className="w-full"
                onClick={() => onRemove(entry.wallet)}
              >
                <Trash2 className="mr-1 h-3 w-3" /> Remove from Watchlist
              </Button>
              {entry.notes && (
                <p className="text-xs text-muted-foreground">
                  Notes: {entry.notes}
                </p>
              )}
            </div>
          </div>
        </div>
      </TableCell>
    </TableRow>
  );
}

// ── Main Page ──────────────────────────────────────────────────────

export default function WatchlistPage() {
  const [entries, setEntries] = useState<WatchlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedWallet, setExpandedWallet] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.watchlist();
      setEntries(data);
    } catch (e) {
      console.error("Failed to load watchlist:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  }, [load]);

  const handlePromote = async (wallet: string, mode: "paper" | "real") => {
    try {
      await api.watchlistPromote(wallet, mode);
      load();
    } catch (e) {
      console.error("Promote failed:", e);
    }
  };

  const handleRemove = async (wallet: string) => {
    try {
      await api.watchlistRemove(wallet);
      setExpandedWallet(null);
      load();
    } catch (e) {
      console.error("Remove failed:", e);
    }
  };

  // Summary stats
  const total = entries.length;
  const profitable = entries.filter(
    (e) => e.latest && e.latest.profit_all > 0,
  ).length;
  const avgWinRate =
    entries.length > 0
      ? entries.reduce((sum, e) => sum + (e.latest?.win_rate ?? 0), 0) / entries.length
      : 0;
  const bestToday = entries.reduce(
    (best, e) => {
      const p1d = e.latest?.profit_1d ?? 0;
      return p1d > (best?.latest?.profit_1d ?? -Infinity) ? e : best;
    },
    entries[0],
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Watchlist</h1>
          <p className="text-sm text-muted-foreground">
            Monitor bot performance before committing to copy trading
          </p>
        </div>
        <AddWalletForm onAdd={load} />
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Watching
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{total}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Profitable
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-emerald-600">
              {profitable}
              {total > 0 && (
                <span className="ml-1 text-sm text-muted-foreground">
                  / {total}
                </span>
              )}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Avg Win Rate
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">
              {(avgWinRate * 100).toFixed(1)}%
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Best Today
            </CardTitle>
          </CardHeader>
          <CardContent>
            {bestToday ? (
              <div>
                <p className="text-lg font-bold">
                  {bestToday.username || bestToday.wallet.slice(0, 8)}
                </p>
                <p className="text-sm text-emerald-600">
                  {fmt(bestToday.latest?.profit_1d ?? 0)}
                </p>
              </div>
            ) : (
              <p className="text-muted-foreground">--</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Watchlist Table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="space-y-2 p-6">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : entries.length === 0 ? (
            <div className="p-12 text-center">
              <Eye className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
              <h3 className="text-lg font-medium">No wallets on watchlist</h3>
              <p className="text-sm text-muted-foreground">
                Add bots from the Dashboard or enter a wallet address above
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>Wallet</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-center">Trend</TableHead>
                  <TableHead className="text-right">Today</TableHead>
                  <TableHead className="text-right">7d</TableHead>
                  <TableHead className="text-right">All Time</TableHead>
                  <TableHead className="text-right">Win %</TableHead>
                  <TableHead className="text-right">Trades/24h</TableHead>
                  <TableHead className="text-right">Positions</TableHead>
                  <TableHead className="text-right">Added</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <>
                    <TableRow
                      key={entry.wallet}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() =>
                        setExpandedWallet(
                          expandedWallet === entry.wallet ? null : entry.wallet,
                        )
                      }
                    >
                      <TableCell className="w-8 px-2">
                        {expandedWallet === entry.wallet ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </TableCell>
                      <TableCell>
                        <WalletLink
                          address={entry.wallet}
                          username={entry.username}
                        />
                      </TableCell>
                      <TableCell>
                        <CategoryBadge category={entry.category} />
                      </TableCell>
                      <TableCell className="text-center">
                        <TrendBadge value={entry.latest?.trend_7d ?? null} />
                      </TableCell>
                      <TableCell className="text-right">
                        <PnlCell value={entry.latest?.profit_1d ?? 0} />
                      </TableCell>
                      <TableCell className="text-right">
                        <PnlCell value={entry.latest?.profit_7d ?? 0} />
                      </TableCell>
                      <TableCell className="text-right">
                        <PnlCell value={entry.latest?.profit_all ?? 0} />
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {entry.latest
                          ? `${(entry.latest.win_rate * 100).toFixed(1)}%`
                          : "--"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {entry.latest?.trades_24h ?? "--"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {entry.latest?.open_positions ?? "--"}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        <Tooltip>
                          <TooltipTrigger>
                            {timeAgo(entry.added_at)}
                          </TooltipTrigger>
                          <TooltipContent>
                            Added by {entry.added_by}
                            {entry.last_checked && (
                              <>, checked {timeAgo(entry.last_checked)}</>
                            )}
                          </TooltipContent>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                    {expandedWallet === entry.wallet && (
                      <WatchlistDetail
                        key={`detail-${entry.wallet}`}
                        entry={entry}
                        onPromote={handlePromote}
                        onRemove={handleRemove}
                      />
                    )}
                  </>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
