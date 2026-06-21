import type { Config } from "../config.js";
import type { Strategy } from "./types.js";
import { MarketMakerStrategy } from "./market-maker.js";
import { ParityArbStrategy } from "./parity-arb.js";
import { DirectionalStrategy } from "./directional.js";
import { VolumeDriverStrategy } from "./volume-driver.js";
import { MaxProfitStrategy } from "./max-profit.js";
import { ConditionalMmStrategy } from "./conditional-mm.js";
import { BinaryMmStrategy } from "./binary-mm.js";

export type { Strategy, StrategyContext } from "./types.js";

/** Construct one strategy by name (or null if unknown). */
function makeStrategy(name: string, config: Config): Strategy | null {
  switch (name) {
    case "market-maker":
      return new MarketMakerStrategy(config.mmMarket);
    case "parity-arb":
      return new ParityArbStrategy();
    case "momentum":
      return new DirectionalStrategy("momentum", 1, config.dirMarket, config.dirWindow);
    case "mean-reversion":
      return new DirectionalStrategy("mean-reversion", -1, config.dirMarket, config.dirWindow);
    case "volume-driver":
      return new VolumeDriverStrategy(config.volMarket);
    case "conditional-mm":
      return new ConditionalMmStrategy(config.condRole);
    case "binary-mm":
      return new BinaryMmStrategy(config.binRole);
    case "max-profit":
      return new MaxProfitStrategy(
        new ParityArbStrategy(),
        new DirectionalStrategy("momentum", 1, config.dirMarket, config.dirWindow),
      );
    default:
      return null; // unknown strategy name — ignored
  }
}

/** Build the configured strategy set (STRATEGIES env, comma-separated). */
export function buildStrategies(config: Config): Strategy[] {
  const out: Strategy[] = [];
  for (const name of config.strategies) {
    const s = makeStrategy(name, config);
    if (s) out.push(s);
  }
  return out;
}
