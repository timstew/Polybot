/**
 * CLOB v2 adapter — wraps @polymarket/clob-client-v2.
 *
 * V2 uses a new order struct (no taker/nonce/feeRateBps, adds timestamp/metadata/builder),
 * new smart contracts, and "Polymarket USD" collateral instead of USDC.e.
 * The v2 client auto-negotiates the server version (can sign v1 or v2 orders).
 */

import { ClobClient, Chain, Side, OrderType } from "@polymarket/clob-client-v2";
import { Wallet } from "ethers";
import type { ClobAdapter, ClobCredentials, PlaceResult, ClobOrder, OrderBook, BalanceInfo } from "./types.js";

const CLOB_HOST = "https://clob.polymarket.com";

export class V2Adapter implements ClobAdapter {
  readonly version = "v2" as const;
  private client: ClobClient;
  private signer: Wallet;
  private creds: ClobCredentials | null = null;

  constructor(privateKey: string) {
    this.signer = new Wallet(privateKey);
    // Initialize without creds — will derive them in init()
    this.client = new ClobClient({ host: CLOB_HOST, chain: Chain.POLYGON, signer: this.signer });
  }

  async init(): Promise<ClobCredentials> {
    console.log("[CLOB-V2] Initializing — deriving API credentials...");

    // Check server version
    try {
      const version = await this.client.getVersion();
      console.log(`[CLOB-V2] Server order struct version: ${version}`);
    } catch {
      console.warn("[CLOB-V2] Could not fetch server version — may not be fully migrated yet");
    }

    // Derive (or create) API key from the signer
    const rawCreds = await this.client.createOrDeriveApiKey();

    this.creds = {
      apiKey: rawCreds.key,
      secret: rawCreds.secret,
      passphrase: rawCreds.passphrase,
    };

    // Reinitialize client with credentials + server time sync for order signing
    this.client = new ClobClient({
      host: CLOB_HOST,
      chain: Chain.POLYGON,
      signer: this.signer,
      creds: rawCreds,
      useServerTime: true, // prevents order rejection from clock drift
    });

    console.log(`[CLOB-V2] Initialized — wallet=${this.signer.address.slice(0, 10)}...`);
    return this.creds;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.getOk();
      return true;
    } catch {
      return false;
    }
  }

  async placeLimitOrder(tokenId: string, side: "BUY" | "SELL", price: number, size: number): Promise<PlaceResult> {
    try {
      // v2: postOnly and deferExec args are swapped compared to v1
      const resp = await this.client.createAndPostOrder(
        {
          tokenID: tokenId,
          price,
          size,
          side: side === "BUY" ? Side.BUY : Side.SELL,
        },
        undefined, // options
        OrderType.GTC,
      );

      if (!resp) {
        return { success: false, orderId: "", status: "failed", error: "Empty response from CLOB" };
      }

      const orderId = resp.orderID || resp.order_id || resp.id || "";
      const status = resp.status || "";

      if (status === "MATCHED" || status === "FILLED") {
        const fillPrice = resp.price ? parseFloat(resp.price) : price;
        const fillSize = resp.size_matched ? parseFloat(resp.size_matched) : size;
        return { success: true, orderId, status: "filled", fillPrice, fillSize };
      }

      if (orderId) {
        return { success: true, orderId, status: "placed" };
      }

      const error = resp.errorMsg || resp.error || JSON.stringify(resp);
      return { success: false, orderId: "", status: "failed", error };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, orderId: "", status: "failed", error };
    }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      await this.client.cancelOrder({ orderID: orderId });
      return true;
    } catch (err) {
      console.warn(`[CLOB-V2] Cancel failed for ${orderId.slice(0, 16)}:`, err);
      return false;
    }
  }

  async cancelAll(): Promise<boolean> {
    try {
      await this.client.cancelAll();
      return true;
    } catch (err) {
      console.warn("[CLOB-V2] Cancel all failed:", err);
      return false;
    }
  }

  async getOrder(orderId: string): Promise<ClobOrder | null> {
    try {
      const order = await this.client.getOrder(orderId);
      if (!order) return null;
      return normalizeClobOrder(order);
    } catch {
      return null;
    }
  }

  async getOpenOrders(): Promise<ClobOrder[]> {
    try {
      const orders = await this.client.getOpenOrders();
      const list = Array.isArray(orders) ? orders : [];
      return list.map(normalizeClobOrder);
    } catch (err) {
      console.warn("[CLOB-V2] getOpenOrders failed:", err);
      return [];
    }
  }

  async getOrderBook(tokenId: string): Promise<OrderBook> {
    try {
      const book = await this.client.getOrderBook(tokenId);
      const bids = (book.bids || []).map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }));
      const asks = (book.asks || []).map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }));
      const bestBid = bids.length > 0 ? bids[0].price : null;
      const bestAsk = asks.length > 0 ? asks[0].price : null;
      return {
        tokenId,
        bids,
        asks,
        bestBid,
        bestAsk,
        spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
      };
    } catch (err) {
      console.warn("[CLOB-V2] getOrderBook failed:", err);
      return { tokenId, bids: [], asks: [], bestBid: null, bestAsk: null, spread: null };
    }
  }

  async getBalance(): Promise<BalanceInfo> {
    try {
      const resp = await this.client.getBalanceAllowance({ asset_type: "COLLATERAL" as never });
      return {
        balance: parseFloat(resp.balance || "0"),
        allowance: parseFloat(resp.allowance || "0"),
      };
    } catch (err) {
      console.warn("[CLOB-V2] getBalance failed:", err);
      return { balance: 0, allowance: 0 };
    }
  }

  getCredentials(): ClobCredentials | null {
    return this.creds;
  }
}

function normalizeClobOrder(order: {
  id: string;
  status: string;
  asset_id: string;
  side: string;
  price: string;
  original_size: string;
  size_matched: string;
  created_at: number;
}): ClobOrder {
  return {
    id: order.id,
    status: order.status,
    tokenId: order.asset_id,
    side: order.side as "BUY" | "SELL",
    price: parseFloat(order.price),
    originalSize: parseFloat(order.original_size),
    sizeMatched: parseFloat(order.size_matched),
    createdAt: order.created_at,
  };
}
