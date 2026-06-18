import type { Config } from "../config.js";
import type { Strategy } from "./types.js";
import { MarketMakerStrategy } from "./market-maker.js";
import { ParityArbStrategy } from "./parity-arb.js";

export type { Strategy, StrategyContext } from "./types.js";

/** Build the configured strategy set (STRATEGIES env, comma-separated). */
export function buildStrategies(config: Config): Strategy[] {
  const out: Strategy[] = [];
  for (const name of config.strategies) {
    switch (name) {
      case "market-maker":
        out.push(new MarketMakerStrategy(config.mmMarket));
        break;
      case "parity-arb":
        out.push(new ParityArbStrategy());
        break;
      default:
        // unknown strategy name — ignored (logged by the caller if desired)
        break;
    }
  }
  return out;
}
