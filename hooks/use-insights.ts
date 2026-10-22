"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/auth-fetch";
import type { MutationResult } from "@/types/mutation-result";

// Data-plan limit, temperature alerts and signal-history settings (written by the poller's insights.sh).
const CGI = "/cgi-bin/quecmanager/monitoring/insights.sh";
const HISTORY_CGI = "/cgi-bin/quecmanager/monitoring/signal_history.sh";
const POLL_MS = 30_000;

export interface InsightsConfig {
  data_limit: { enabled: boolean; limit_gb: number; billing_day: number; warn_pct: number };
  temperature: { enabled: boolean; alert_c: number };
  history: { enabled: boolean; days: number };
}

export interface InsightsStatus {
  updated: number;
  data_limit: {
    enabled: boolean;
    used_bytes: number | null;
    limit_bytes: number | null;
    percent: number | null;
    cycle_start: number | null;
    cycle_next: number | null;
    days_left: number | null;
  };
  temperature: { current: number | null; alerting: boolean };
}

export interface InsightsState {
  config: InsightsConfig;
  status: InsightsStatus | null;
}

export interface InsightsSave {
  data_limit: InsightsConfig["data_limit"] & { used_gb?: string };
  temperature: InsightsConfig["temperature"];
  history: InsightsConfig["history"];
}

export interface InsightsResult extends MutationResult {
  code: string | null;
}

export function useInsights() {
  const [state, setState] = useState<InsightsState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await authFetch(CGI);
      const json = await res.json();
      if (!mounted.current) return;
      if (!json?.success) throw new Error(json?.detail ?? "failed");
      setState({ config: json.config, status: json.status ?? null });
      setError(null);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "failed");
    } finally {
      if (mounted.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, [load]);

  const save = useCallback(
    async (body: InsightsSave): Promise<InsightsResult> => {
      setIsSaving(true);
      try {
        const res = await authFetch(CGI, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "save", ...body }),
        });
        const json = await res.json();
        if (json?.success) {
          await load();
          return { ok: true, error: null, code: null };
        }
        return { ok: false, error: json?.detail ?? "failed", code: json?.error ?? null };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "failed", code: null };
      } finally {
        if (mounted.current) setIsSaving(false);
      }
    },
    [load],
  );

  return { state, isLoading, error, isSaving, refresh: load, save };
}

// --- Long-term signal history ------------------------------------------------------

export type HistoryRange = "24h" | "7d" | "30d";

export interface HistoryPointRaw {
  t: number;
  lrsrp?: number;
  lsinr?: number;
  nrsrp?: number;
  nsinr?: number;
  temp?: number;
  temp_max?: number;
  dl_mbps?: number;
  ul_mbps?: number;
  rx_bytes: number;
  tx_bytes: number;
}

export interface HistoryCell {
  net: string;
  lband: string;
  pci: string;
  enb: string;
  nband: string;
  minutes: number;
  last: number;
  rsrp?: number;
  rsrq?: number;
  sinr?: number;
  nr_sinr?: number;
  busy_minutes?: number;
  busy_dl_mbps?: number;
  peak_dl_mbps: number;
}

export interface LongHistory {
  range: HistoryRange;
  bucket_s: number;
  points: HistoryPointRaw[];
  cells: HistoryCell[];
  minutes: number;
  days_stored: number;
  bytes_stored: number;
}

export function useLongHistory(range: HistoryRange) {
  const [data, setData] = useState<LongHistory | null>(null);
  const [error, setError] = useState<{ range: HistoryRange; message: string } | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async (r: HistoryRange) => {
    try {
      const res = await authFetch(`${HISTORY_CGI}?range=${r}`);
      const json = await res.json();
      if (!mounted.current) return;
      if (!json?.success) throw new Error(json?.detail ?? "failed");
      setData(json as LongHistory);
      setError(null);
    } catch (e) {
      if (mounted.current) setError({ range: r, message: e instanceof Error ? e.message : "failed" });
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    // The fetch sets state only after its await.
    void load(range);
    const id = setInterval(() => void load(range), 5 * 60_000);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, [load, range]);

  const current = data?.range === range ? data : null;
  const err = error?.range === range ? error.message : null;
  return { data: current, isLoading: !current && !err, error: err, refresh: () => load(range) };
}
