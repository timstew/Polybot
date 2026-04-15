/**
 * HTTP API server — serves the dashboard and provides JSON endpoints.
 *
 * Serves a single-page dashboard at / and JSON APIs at /api/*.
 * Uses plain Node.js HTTP (no Express needed for this).
 */

import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { getDb, getAllConfig } from "./db.js";
import * as ledger from "./orders/order-ledger.js";

const PYTHON_API_URL = process.env.PYTHON_API_URL || "http://127.0.0.1:8000";

export function startApiServer(port = 3001): void {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

    try {
      // ── Dashboard ─────────────────────────────────────────────
      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(getDashboardHtml());
        return;
      }

      // ── API endpoints ─────────────────────────────────────────
      if (url.pathname === "/api/activity") {
        const limit = parseInt(url.searchParams.get("limit") || "50");
        const rows = getDb().prepare(
          "SELECT * FROM activity_log ORDER BY id DESC LIMIT ?"
        ).all(limit);
        json(res, rows);
        return;
      }

      if (url.pathname === "/api/orders") {
        const status = url.searchParams.get("status"); // filter by status
        const rows = status
          ? getDb().prepare("SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT 100").all(status)
          : getDb().prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT 100").all();
        json(res, rows);
        return;
      }

      if (url.pathname === "/api/windows") {
        const rows = getDb().prepare(
          "SELECT * FROM windows ORDER BY CASE status WHEN 'ACTIVE' THEN 0 WHEN 'RESOLVING' THEN 1 ELSE 2 END, open_time DESC LIMIT 50"
        ).all();
        json(res, rows);
        return;
      }

      if (url.pathname === "/api/fills") {
        const windowSlug = url.searchParams.get("window");
        const rows = windowSlug
          ? getDb().prepare("SELECT * FROM fills WHERE window_slug = ? ORDER BY created_at DESC").all(windowSlug)
          : getDb().prepare("SELECT * FROM fills ORDER BY created_at DESC LIMIT 100").all();
        json(res, rows);
        return;
      }

      if (url.pathname === "/api/status") {
        const activeWindows = getDb().prepare("SELECT * FROM windows WHERE status = 'ACTIVE'").all();
        const openOrders = ledger.getActiveOrders();
        const recentFills = getDb().prepare("SELECT * FROM fills ORDER BY created_at DESC LIMIT 10").all();
        const config = getAllConfig();
        const committedCapital = ledger.getCommittedCapital();

        // Get balance from Python API
        let balance = 0;
        try {
          const resp = await fetch(`${PYTHON_API_URL}/api/strategy/balance`);
          const data = await resp.json() as { balance: number };
          balance = data.balance ?? 0;
        } catch { /* ignore */ }

        // Stats
        const stats = getDb().prepare(`
          SELECT
            COUNT(*) as total_windows,
            SUM(CASE WHEN net_pnl >= 0 THEN 1 ELSE 0 END) as wins,
            SUM(CASE WHEN net_pnl < 0 THEN 1 ELSE 0 END) as losses,
            COALESCE(SUM(net_pnl), 0) as total_pnl,
            COALESCE(SUM(total_buy_cost), 0) as total_volume
          FROM windows WHERE status = 'RESOLVED'
        `).get() as Record<string, number>;

        json(res, {
          balance,
          committedCapital,
          activeWindows,
          openOrders: openOrders.length,
          recentFills,
          config,
          stats,
        });
        return;
      }

      if (url.pathname === "/api/config") {
        json(res, getAllConfig());
        return;
      }

      // Not found
      res.writeHead(404);
      res.end("Not found");
    } catch (err) {
      console.error("[API]", err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  server.listen(port, () => {
    console.log(`[API] Dashboard at http://localhost:${port}`);
  });
}

function json(res: http.ServerResponse, data: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reaper — Bonereaper Clone</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; background: #0a0a0a; color: #e0e0e0; }
    .card { background: #141414; border: 1px solid #2a2a2a; border-radius: 8px; padding: 16px; }
    .fill-row { animation: flash 0.5s ease-out; }
    @keyframes flash { from { background: #1a3a1a; } to { background: transparent; } }
    .error-row { background: #2a1a1a; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
    .badge-green { background: #1a3a1a; color: #4ade80; }
    .badge-red { background: #3a1a1a; color: #f87171; }
    .badge-blue { background: #1a1a3a; color: #60a5fa; }
    .badge-yellow { background: #3a3a1a; color: #fbbf24; }
    .badge-gray { background: #2a2a2a; color: #9ca3af; }
    .mono { font-family: 'SF Mono', 'Fira Code', monospace; }
    .pulse { animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
  </style>
</head>
<body class="p-4 max-w-7xl mx-auto">
  <div class="flex items-center justify-between mb-6">
    <div>
      <h1 class="text-2xl font-bold text-white">Reaper</h1>
      <p class="text-sm text-gray-500">Bonereaper Clone — Event-Driven Order Management</p>
    </div>
    <div id="connection-status" class="badge badge-gray">Loading...</div>
  </div>

  <!-- Status cards -->
  <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6" id="status-cards">
    <div class="card">
      <div class="text-xs text-gray-500">USDC Balance</div>
      <div class="text-xl font-bold text-white" id="balance">—</div>
    </div>
    <div class="card">
      <div class="text-xs text-gray-500">Committed</div>
      <div class="text-xl font-bold text-yellow-400" id="committed">—</div>
    </div>
    <div class="card">
      <div class="text-xs text-gray-500">Total P&L</div>
      <div class="text-xl font-bold" id="pnl">—</div>
    </div>
    <div class="card">
      <div class="text-xs text-gray-500">Win Rate</div>
      <div class="text-xl font-bold" id="winrate">—</div>
    </div>
    <div class="card">
      <div class="text-xs text-gray-500">Open Orders</div>
      <div class="text-xl font-bold text-blue-400" id="open-orders">—</div>
    </div>
  </div>

  <!-- Main content: two columns -->
  <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
    <!-- Activity feed (2/3 width) -->
    <div class="lg:col-span-2">
      <div class="card">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-sm font-bold text-gray-400 uppercase tracking-wide">Activity Feed</h2>
          <span class="text-xs text-gray-600" id="activity-count">0 events</span>
        </div>
        <div id="activity-feed" class="space-y-1 max-h-[70vh] overflow-y-auto text-xs">
          <div class="text-gray-600 text-center py-8">Waiting for events...</div>
        </div>
      </div>
    </div>

    <!-- Right column: windows + orders -->
    <div class="space-y-4">
      <!-- Active windows -->
      <div class="card">
        <h2 class="text-sm font-bold text-gray-400 uppercase tracking-wide mb-3">Active Windows</h2>
        <div id="windows" class="space-y-2">
          <div class="text-gray-600 text-center py-4 text-xs">No active windows</div>
        </div>
      </div>

      <!-- Recent fills -->
      <div class="card">
        <h2 class="text-sm font-bold text-gray-400 uppercase tracking-wide mb-3">Recent Fills</h2>
        <div id="fills" class="space-y-1">
          <div class="text-gray-600 text-center py-4 text-xs">No fills yet</div>
        </div>
      </div>

      <!-- Completed windows -->
      <div class="card">
        <h2 class="text-sm font-bold text-gray-400 uppercase tracking-wide mb-3">Completed</h2>
        <div id="completed" class="space-y-1">
          <div class="text-gray-600 text-center py-4 text-xs">No completed windows</div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const API = '';
    let lastActivityId = 0;

    function fmt(n) { return n == null ? '—' : '$' + Number(n).toFixed(2); }
    function fmtPnl(n) {
      if (n == null) return '—';
      const s = '$' + Math.abs(n).toFixed(2);
      return n >= 0 ? '+' + s : '-' + s;
    }
    function badge(text, color) { return '<span class="badge badge-' + color + '">' + text + '</span>'; }
    function timeAgo(ts) {
      if (!ts) return '';
      const d = new Date(ts.includes('Z') ? ts : ts + 'Z');
      const s = Math.floor((Date.now() - d.getTime()) / 1000);
      if (s < 60) return s + 's ago';
      if (s < 3600) return Math.floor(s/60) + 'm ago';
      return Math.floor(s/3600) + 'h ago';
    }

    function levelBadge(level) {
      const colors = { info: 'gray', trade: 'green', signal: 'blue', warning: 'yellow', error: 'red' };
      return badge(level, colors[level] || 'gray');
    }

    function typeBadge(type) {
      const colors = {
        FILL: 'green', ORDER_PLACED: 'blue', ORDER_FILLED: 'green', ORDER_CANCELLED: 'gray',
        ORDER_FAILED: 'red', ORDER_ERROR: 'red', MERGE: 'blue', REDEEM: 'green',
        WINDOW_ENTER: 'blue', RESOLVE: 'yellow', STARTUP: 'gray', SHUTDOWN: 'gray',
        USER_WS: 'blue', RECONCILE: 'yellow', FILL_UNKNOWN: 'yellow', FILL_CONFIRMED: 'green',
        FILL_REVERTED: 'red', CANCEL_ALL: 'gray', ERROR: 'red',
      };
      return badge(type, colors[type] || 'gray');
    }

    async function refresh() {
      try {
        // Status
        const status = await fetch(API + '/api/status').then(r => r.json());
        document.getElementById('balance').textContent = fmt(status.balance);
        document.getElementById('committed').textContent = fmt(status.committedCapital);
        const pnl = status.stats?.total_pnl || 0;
        const pnlEl = document.getElementById('pnl');
        pnlEl.textContent = fmtPnl(pnl);
        pnlEl.className = 'text-xl font-bold ' + (pnl >= 0 ? 'text-green-400' : 'text-red-400');
        const wins = status.stats?.wins || 0;
        const losses = status.stats?.losses || 0;
        const total = wins + losses;
        document.getElementById('winrate').textContent = total > 0 ? Math.round(wins/total*100) + '%' : '—';
        document.getElementById('winrate').className = 'text-xl font-bold ' + (wins >= losses ? 'text-green-400' : 'text-red-400');
        document.getElementById('open-orders').textContent = status.openOrders;

        // Connection
        const connEl = document.getElementById('connection-status');
        connEl.textContent = status.activeWindows?.length > 0 ? 'LIVE' : 'IDLE';
        connEl.className = 'badge ' + (status.activeWindows?.length > 0 ? 'badge-green pulse' : 'badge-gray');

        // Windows
        const winsEl = document.getElementById('windows');
        const activeWins = status.activeWindows || [];
        if (activeWins.length === 0) {
          winsEl.innerHTML = '<div class="text-gray-600 text-center py-4 text-xs">No active windows</div>';
        } else {
          winsEl.innerHTML = activeWins.map(w => {
            const up = (w.up_inventory || 0).toFixed(0);
            const dn = (w.down_inventory || 0).toFixed(0);
            const pc = w.up_avg_cost && w.down_avg_cost && w.up_inventory > 0 && w.down_inventory > 0
              ? (w.up_avg_cost + w.down_avg_cost).toFixed(3) : '—';
            const title = (w.title || w.slug || '').slice(-25);
            return '<div class="p-2 rounded bg-gray-900 border border-gray-800">' +
              '<div class="flex justify-between items-center">' +
              '<span class="text-gray-300 text-xs">' + title + '</span>' +
              badge(w.status, w.status === 'ACTIVE' ? 'green' : 'yellow') +
              '</div>' +
              '<div class="mt-1 text-xs text-gray-400">' +
              up + '↑ / ' + dn + '↓  pc=' + pc + '  fills=' + (w.fill_count || 0) +
              '</div></div>';
          }).join('');
        }

        // Fills
        const fillsEl = document.getElementById('fills');
        const fills = status.recentFills || [];
        if (fills.length === 0) {
          fillsEl.innerHTML = '<div class="text-gray-600 text-center py-4 text-xs">No fills yet</div>';
        } else {
          fillsEl.innerHTML = fills.map(f =>
            '<div class="flex justify-between text-xs py-0.5">' +
            '<span>' + badge(f.side, f.side === 'UP' ? 'green' : 'red') +
            ' ' + Number(f.size).toFixed(1) + '@$' + Number(f.price).toFixed(3) + '</span>' +
            '<span class="text-gray-500">' + badge(f.source, 'gray') + '</span></div>'
          ).join('');
        }

        // Completed windows
        const compEl = document.getElementById('completed');
        const completed = await fetch(API + '/api/windows').then(r => r.json());
        const resolved = completed.filter(w => w.status === 'RESOLVED').slice(0, 10);
        if (resolved.length === 0) {
          compEl.innerHTML = '<div class="text-gray-600 text-center py-4 text-xs">No completed windows</div>';
        } else {
          compEl.innerHTML = resolved.map(w => {
            const net = w.net_pnl || 0;
            return '<div class="flex justify-between text-xs py-0.5">' +
              '<span>' + badge(w.outcome || '?', w.outcome === 'UP' ? 'green' : 'red') +
              ' ' + (w.title || w.slug || '').slice(-20) + '</span>' +
              '<span class="' + (net >= 0 ? 'text-green-400' : 'text-red-400') + '">' + fmtPnl(net) + '</span></div>';
          }).join('');
        }

        // Activity feed
        const activity = await fetch(API + '/api/activity?limit=100').then(r => r.json());
        const feedEl = document.getElementById('activity-feed');
        document.getElementById('activity-count').textContent = activity.length + ' events';
        if (activity.length === 0) {
          feedEl.innerHTML = '<div class="text-gray-600 text-center py-8">Waiting for events...</div>';
        } else {
          feedEl.innerHTML = activity.map(a => {
            const isNew = a.id > lastActivityId;
            const cls = a.level === 'error' ? 'error-row' : isNew ? 'fill-row' : '';
            return '<div class="flex gap-2 py-1 px-2 rounded ' + cls + '">' +
              '<span class="text-gray-600 shrink-0 w-16">' + timeAgo(a.timestamp) + '</span>' +
              typeBadge(a.type) +
              '<span class="text-gray-300 truncate">' + (a.detail || '').replace(/"/g, '') + '</span>' +
              '</div>';
          }).join('');
          if (activity.length > 0) lastActivityId = Math.max(...activity.map(a => a.id));
        }
      } catch (err) {
        document.getElementById('connection-status').textContent = 'ERROR';
        document.getElementById('connection-status').className = 'badge badge-red';
      }
    }

    // Refresh every 2s
    refresh();
    setInterval(refresh, 2000);
  </script>
</body>
</html>`;
}
