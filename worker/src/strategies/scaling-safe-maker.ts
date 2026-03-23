/**
 * Scaling Safe Maker Strategy
 *
 * Extends SafeMakerStrategy with adaptive bid sizing: starts small (5/side),
 * ramps up after paired windows, ramps down after one-sided losses.
 * Prevents catastrophic loss from large one-sided fills in correlated markets.
 */

import type { StrategyContext } from "../strategy";
import { registerStrategy } from "../strategy";
import {
  SafeMakerStrategy,
  type CompletedMakerWindow,
  type DirectionalMakerParams,
} from "./safe-maker";

interface ScalingParams {
  min_bid_size: number;
  max_bid_size: number;
  ramp_increment: number;
  ramp_decay: number;
}

const SCALING_DEFAULTS: ScalingParams = {
  min_bid_size: 5,
  max_bid_size: 60,
  ramp_increment: 5,
  ramp_decay: 0.5,
};

class ScalingSafeMakerStrategy extends SafeMakerStrategy {
  name = "scaling-safe-maker";

  private getScalingParams(params: DirectionalMakerParams): ScalingParams {
    return { ...SCALING_DEFAULTS, ...(params as unknown as Partial<ScalingParams>) };
  }

  protected override getBaseSize(params: DirectionalMakerParams): number {
    const sp = this.getScalingParams(params);
    const current = this.custom.currentBaseSize ?? sp.min_bid_size;
    return Math.max(sp.min_bid_size, Math.min(sp.max_bid_size, current));
  }

  protected override onWindowResolved(
    completed: CompletedMakerWindow,
    params: DirectionalMakerParams,
    ctx: StrategyContext
  ): void {
    const sp = this.getScalingParams(params);
    const prev = this.custom.currentBaseSize ?? sp.min_bid_size;
    const hasInventory = completed.upInventory > 0 || completed.downInventory > 0;
    const paired = Math.min(completed.upInventory, completed.downInventory) > 0;

    let next = prev;
    if (hasInventory && paired) {
      next = Math.min(sp.max_bid_size, prev + sp.ramp_increment);
    } else if (hasInventory && !paired) {
      next = Math.max(sp.min_bid_size, Math.round(prev * sp.ramp_decay));
    }
    // Zero inventory = no change (window expired without fills)

    if (next !== prev) {
      ctx.log(
        `RAMP: ${prev} → ${next} (${paired ? "paired" : "one-sided"})`,
        { level: "signal", symbol: completed.cryptoSymbol, phase: "ramp" } as never
      );
    }
    this.custom.currentBaseSize = next;
  }
}

registerStrategy("scaling-safe-maker", () => new ScalingSafeMakerStrategy());
