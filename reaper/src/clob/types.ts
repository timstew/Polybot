/**
 * Unified CLOB types — our abstraction over v1/v2 differences.
 *
 * These are the ONLY types the rest of the app uses.
 * The v1/v2 adapters translate to/from these.
 */

/** Order book entry (price level). */
export interface BookLevel {
  price: number;
  size: number;
}

/** Order book snapshot. */
export interface OrderBook {
  tokenId: string;
  bids: BookLevel[];
  asks: BookLevel[];
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
}

/** Result of placing an order. */
export interface PlaceResult {
  success: boolean;
  orderId: string;
  status: "placed" | "filled" | "failed";
  fillPrice?: number;
  fillSize?: number;
  error?: string;
}

/** An open order on the CLOB. */
export interface ClobOrder {
  id: string;
  status: string; // LIVE, MATCHED, FILLED, CANCELLED
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  originalSize: number;
  sizeMatched: number;
  createdAt: number;
}

/** Balance info. */
export interface BalanceInfo {
  balance: number;
  allowance: number;
}

/** API credentials. */
export interface ClobCredentials {
  apiKey: string;
  secret: string;
  passphrase: string;
}

/** The interface every CLOB adapter must implement. */
export interface ClobAdapter {
  readonly version: "v1" | "v2";

  /** Initialize the client — derive or create API keys. */
  init(): Promise<ClobCredentials>;

  /** Check if the CLOB API is reachable. */
  healthCheck(): Promise<boolean>;

  /** Place a GTC limit buy order. */
  placeLimitOrder(tokenId: string, side: "BUY" | "SELL", price: number, size: number): Promise<PlaceResult>;

  /** Cancel a single order by CLOB order ID. */
  cancelOrder(orderId: string): Promise<boolean>;

  /** Cancel all open orders. */
  cancelAll(): Promise<boolean>;

  /** Get a single order by ID. */
  getOrder(orderId: string): Promise<ClobOrder | null>;

  /** Get all open orders. */
  getOpenOrders(): Promise<ClobOrder[]>;

  /** Get the order book for a token. */
  getOrderBook(tokenId: string): Promise<OrderBook>;

  /** Get USDC balance. */
  getBalance(): Promise<BalanceInfo>;

  /** Get API credentials (for WebSocket auth). */
  getCredentials(): ClobCredentials | null;
}
