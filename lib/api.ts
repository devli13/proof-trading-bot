import type { StatsResponse, StatusResponse, BotDetail, ChangeRow, Range, TradeAnalysisResponse } from "./types.js";

/** Fetch the fleet stats for a window. Throws on network/abort (caller handles). */
export async function fetchStats(range: Range, signal?: AbortSignal): Promise<StatsResponse> {
  const r = await fetch(`/api/stats?range=${range}`, { signal, cache: "no-store" });
  return (await r.json()) as StatsResponse;
}

export async function fetchStatus(signal?: AbortSignal): Promise<StatusResponse> {
  const r = await fetch(`/api/status`, { signal, cache: "no-store" });
  return (await r.json()) as StatusResponse;
}

export async function fetchBotDetail(bot: string, signal?: AbortSignal): Promise<BotDetail> {
  const r = await fetch(`/api/stats?bot=${encodeURIComponent(bot)}`, { signal, cache: "no-store" });
  return (await r.json()) as BotDetail;
}

export async function fetchChangelog(signal?: AbortSignal): Promise<{ ok: boolean; changes: ChangeRow[] }> {
  const r = await fetch(`/api/stats?changes=1`, { signal, cache: "no-store" });
  return (await r.json()) as { ok: boolean; changes: ChangeRow[] };
}

export async function fetchTradeAnalysis(hours = 24, signal?: AbortSignal): Promise<TradeAnalysisResponse> {
  const r = await fetch(`/api/trade-analysis?hours=${hours}`, { signal, cache: "no-store" });
  return (await r.json()) as TradeAnalysisResponse;
}
