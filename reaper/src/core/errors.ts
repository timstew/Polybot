/**
 * Polymarket error types + retry helper.
 * Inspired by @catalyst-team/poly-sdk but rewritten clean.
 */

export enum ErrorCode {
  NetworkError = "NETWORK_ERROR",
  RateLimited = "RATE_LIMITED",
  InvalidOrder = "INVALID_ORDER",
  InsufficientBalance = "INSUFFICIENT_BALANCE",
  OrderNotFound = "ORDER_NOT_FOUND",
  MarketClosed = "MARKET_CLOSED",
  Unauthorized = "UNAUTHORIZED",
  CapitalConstraint = "CAPITAL_CONSTRAINT",
  StrategyError = "STRATEGY_ERROR",
  Unknown = "UNKNOWN",
}

export class PolymarketError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable: boolean = false,
    public readonly originalError?: unknown,
  ) {
    super(message);
    this.name = "PolymarketError";
  }

  static fromHttpStatus(status: number, body?: string): PolymarketError {
    if (status === 429) return new PolymarketError(ErrorCode.RateLimited, "Rate limited", true);
    if (status === 401 || status === 403) return new PolymarketError(ErrorCode.Unauthorized, "Unauthorized", false);
    if (status === 404) return new PolymarketError(ErrorCode.OrderNotFound, "Not found", false);
    if (status >= 500) return new PolymarketError(ErrorCode.NetworkError, `HTTP ${status}`, true, body);
    return new PolymarketError(ErrorCode.Unknown, `HTTP ${status}: ${body || ""}`, false);
  }
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  onRetry?: (attempt: number, err: unknown) => void;
}

/** Exponential-backoff retry for retryable errors only. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelay = opts.baseDelayMs ?? 300;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof PolymarketError ? err.retryable : true;
      if (!retryable || attempt === maxRetries) throw err;
      const delay = baseDelay * Math.pow(2, attempt);
      opts.onRetry?.(attempt + 1, err);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
