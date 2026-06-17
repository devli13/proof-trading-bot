import pino from "pino";
import pretty from "pino-pretty";

export type Logger = pino.Logger;

/**
 * Pretty console logs by default; set LOG_JSON=1 for structured JSON
 * (recommended for Vercel / production log aggregation). Uses pino-pretty as a
 * synchronous stream (no worker thread) so it stays tsx/serverless-safe.
 */
export function createLogger(level = "info"): Logger {
  const json = ["1", "true", "yes"].includes(
    (process.env.LOG_JSON ?? "").toLowerCase(),
  );
  if (json) return pino({ level });
  return pino(
    { level },
    pretty({ colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" }),
  );
}
