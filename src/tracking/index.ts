import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { Tracker } from "./types.js";
import { MemoryTracker } from "./memory.js";
import { PostgresTracker } from "./postgres.js";

export type {
  Tracker,
  OrderRecord,
  PositionSnapshot,
  PositionRow,
  DecisionRecord,
} from "./types.js";

/**
 * Build the tracker: Supabase/Postgres when DATABASE_URL is set (falling back to
 * in-memory if the connection fails — tracking must never block trading), else
 * in-memory.
 */
export async function createTracker(
  config: Config,
  logger: Logger,
): Promise<Tracker> {
  if (config.databaseUrl) {
    try {
      return await PostgresTracker.connect(config.databaseUrl, logger);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        "track: postgres connect failed — using in-memory tracker",
      );
    }
  }
  return new MemoryTracker(logger);
}
