/**
 * Regime classification for strategy orchestrator.
 *
 * Tracks market regime per asset+duration key as continuous EMA state.
 * Regimes carry across windows and transition with hysteresis to avoid
 * false flips on noise.
 */

import type { PriceSnapshot, WindowSignal } from "./price-feed";
import { getOrderFlowSignal } from "./price-feed";

// ── Types ──

export type RegimeType =
  | "trending"
  | "oscillating"
  | "calm"
  | "volatile"
  | "near-strike"
  | "late-window";

export const ALL_REGIME_TYPES: RegimeType[] = [
  "trending",
  "oscillating",
  "calm",
  "volatile",
  "near-strike",
  "late-window",
];

export interface RegimeFeatures {
  choppiness: number;       // 0-1: fraction of direction changes in returns
  trendStrength: number;    // 0+: |mean return| / vol
  realizedVol: number;      // standard deviation of tick returns
  momentum: number;         // from WindowSignal
  signalStrength: number;   // from WindowSignal
  distanceToStrike: number; // |spot - strike| / strike (0-1, 0 = at strike)
  timeRemainingPct: number; // 0-1: time remaining in window
  flipCount: number;        // direction changes in current window
  orderFlowImbalance: number; // -1 to +1 from order flow
}

export interface RegimeState {
  key: string;                                  // "BTCUSDT:5min"
  emaScores: Record<RegimeType, number>;        // each 0-1, EMA with α=0.3
  confirmedRegime: RegimeType;                  // switches with hysteresis
  confidence: number;                           // score of confirmed regime
  streak: number;                               // consecutive observations in this regime
  pendingTransition: RegimeType | null;         // needs 2 consecutive observations
  pendingCount: number;                         // how many consecutive observations of pending regime
  lastUpdatedAt: number;
  history: Array<{ regime: RegimeType; at: number }>;
}

// ── Constants ──

const EMA_ALPHA = 0.3;
const HYSTERESIS_MARGIN = 0.10;  // new regime must exceed current by this much
const TRANSITION_COUNT = 2;       // consecutive observations before transition
const MAX_HISTORY = 20;

// ── Feature Extraction ──

export function computeRegimeFeatures(
  priceHistory: PriceSnapshot[],
  signal: WindowSignal,
  strikePrice: number | null,
  windowOpenTime: number,
  windowEndTime: number,
): RegimeFeatures {
  const now = Date.now();
  const windowDuration = windowEndTime - windowOpenTime;
  const timeRemainingPct = Math.max(0, Math.min(1, (windowEndTime - now) / windowDuration));

  // Compute returns from recent history (last 60 samples)
  const relevant = priceHistory.slice(-60);
  const returns: number[] = [];
  for (let i = 1; i < relevant.length; i++) {
    returns.push(((relevant[i].price - relevant[i - 1].price) / relevant[i - 1].price) * 100);
  }

  // Choppiness: fraction of direction changes
  let dirChanges = 0;
  for (let i = 1; i < returns.length; i++) {
    if ((returns[i] > 0 && returns[i - 1] < 0) || (returns[i] < 0 && returns[i - 1] > 0)) {
      dirChanges++;
    }
  }
  const choppiness = returns.length > 1 ? dirChanges / (returns.length - 1) : 0.5;

  // Realized volatility
  const meanReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length > 0
    ? returns.reduce((a, r) => a + (r - meanReturn) ** 2, 0) / returns.length
    : 0;
  const realizedVol = Math.sqrt(variance);

  // Trend strength
  const trendStrength = realizedVol > 0 ? Math.abs(meanReturn) / realizedVol : 0;

  // Distance to strike
  let distanceToStrike = 1.0; // default: far from strike
  if (strikePrice && strikePrice > 0 && signal.currentPrice > 0) {
    distanceToStrike = Math.abs(signal.currentPrice - strikePrice) / strikePrice;
  }

  // Order flow (use 10s window for responsiveness)
  const orderFlow = getOrderFlowSignal(signal.symbol);
  const orderFlowImbalance = orderFlow.available ? orderFlow.imbalance10s : 0;

  return {
    choppiness,
    trendStrength,
    realizedVol,
    momentum: signal.momentum,
    signalStrength: signal.signalStrength,
    distanceToStrike,
    timeRemainingPct,
    flipCount: 0, // set by orchestrator from window state
    orderFlowImbalance,
  };
}

// ── Raw Scoring ──

function scoreRegimes(f: RegimeFeatures): Record<RegimeType, number> {
  // Trending: high trend strength, low choppiness, momentum confirms
  const trending = Math.min(1.0,
    (f.trendStrength > 0.3 ? (f.trendStrength - 0.3) / 0.4 : 0) * 0.4
    + Math.max(0, 1 - f.choppiness / 0.5) * 0.3
    + Math.abs(f.momentum) * 0.3
  );

  // Oscillating: high choppiness, moderate vol
  const oscillating = Math.min(1.0,
    (f.choppiness > 0.3 ? (f.choppiness - 0.3) / 0.4 : 0) * 0.5
    + (f.realizedVol > 0.003 && f.realizedVol < 0.05 ? 1.0 : 0.3) * 0.3
    + Math.max(0, 1 - f.trendStrength * 2) * 0.2
  );

  // Calm: very low volatility
  const calm = Math.min(1.0,
    (f.realizedVol < 0.005 ? 1 - f.realizedVol / 0.005 : 0) * 0.5
    + (f.signalStrength < 0.3 ? 1 - f.signalStrength / 0.3 : 0) * 0.3
    + (f.trendStrength < 0.2 ? 1 - f.trendStrength / 0.2 : 0) * 0.2
  );

  // Volatile: high vol, unclear direction
  const volatile = Math.min(1.0,
    (f.realizedVol > 0.03 ? Math.min(1.0, (f.realizedVol - 0.03) / 0.05) : 0) * 0.5
    + (f.choppiness > 0.4 ? 0.5 : 0) * 0.2
    + (f.flipCount > 2 ? Math.min(1.0, f.flipCount / 5) : 0) * 0.3
  );

  // Near-strike: price near strike, high delta sensitivity
  const nearStrike = Math.min(1.0,
    (f.distanceToStrike < 0.01 ? 1 - f.distanceToStrike / 0.01 : 0) * 0.6
    + f.signalStrength * 0.2
    + (f.timeRemainingPct < 0.5 ? 1 - f.timeRemainingPct : 0) * 0.2
  );

  // Late-window: <25% time remaining
  const lateWindow = Math.min(1.0,
    (f.timeRemainingPct < 0.25 ? 1 - f.timeRemainingPct / 0.25 : 0) * 0.7
    + f.signalStrength * 0.3
  );

  return { trending, oscillating, calm, volatile, "near-strike": nearStrike, "late-window": lateWindow };
}

// ── EMA Update + Hysteresis ──

export function emptyRegimeState(key: string): RegimeState {
  const emaScores: Record<RegimeType, number> = {
    trending: 0,
    oscillating: 0,
    calm: 0.5, // default to calm
    volatile: 0,
    "near-strike": 0,
    "late-window": 0,
  };
  return {
    key,
    emaScores,
    confirmedRegime: "calm",
    confidence: 0.5,
    streak: 0,
    pendingTransition: null,
    pendingCount: 0,
    lastUpdatedAt: Date.now(),
    history: [],
  };
}

export function updateRegimeState(state: RegimeState, features: RegimeFeatures): RegimeState {
  const raw = scoreRegimes(features);

  // EMA blend
  const newScores = { ...state.emaScores };
  for (const regime of ALL_REGIME_TYPES) {
    newScores[regime] = EMA_ALPHA * raw[regime] + (1 - EMA_ALPHA) * (state.emaScores[regime] ?? 0);
  }

  // Find highest EMA score
  let bestRegime = state.confirmedRegime;
  let bestScore = 0;
  for (const regime of ALL_REGIME_TYPES) {
    if (newScores[regime] > bestScore) {
      bestScore = newScores[regime];
      bestRegime = regime;
    }
  }

  const currentScore = newScores[state.confirmedRegime];
  let confirmedRegime = state.confirmedRegime;
  let streak = state.streak;
  let pendingTransition = state.pendingTransition;
  let pendingCount = state.pendingCount;
  const history = [...state.history];

  if (bestRegime !== state.confirmedRegime && bestScore > currentScore + HYSTERESIS_MARGIN) {
    // Potential transition
    if (pendingTransition === bestRegime) {
      pendingCount++;
      if (pendingCount >= TRANSITION_COUNT) {
        // Confirmed transition
        confirmedRegime = bestRegime;
        streak = 1;
        pendingTransition = null;
        pendingCount = 0;
        history.push({ regime: confirmedRegime, at: Date.now() });
        if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
      }
    } else {
      pendingTransition = bestRegime;
      pendingCount = 1;
    }
  } else {
    // No transition — reset pending
    if (bestRegime === state.confirmedRegime) {
      streak++;
      pendingTransition = null;
      pendingCount = 0;
    }
  }

  return {
    key: state.key,
    emaScores: newScores,
    confirmedRegime,
    confidence: newScores[confirmedRegime],
    streak,
    pendingTransition,
    pendingCount,
    lastUpdatedAt: Date.now(),
    history,
  };
}

/** Classify regime from features (one-shot, no EMA history). */
export function classifyRegime(features: RegimeFeatures): { regime: RegimeType; scores: Record<RegimeType, number> } {
  const scores = scoreRegimes(features);
  let best: RegimeType = "calm";
  let bestScore = 0;
  for (const regime of ALL_REGIME_TYPES) {
    if (scores[regime] > bestScore) {
      bestScore = scores[regime];
      best = regime;
    }
  }
  return { regime: best, scores };
}
