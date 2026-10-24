"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/auth-fetch";

// Outage statistics from the log the poller keeps (monitoring/outages.sh).
const CGI = "/cgi-bin/quecmanager/monitoring/outages.sh";
const POLL_MS = 60_000;

export type OutageRange = 7 | 30 | 90;

export interface OutageStats {
  days: number;
  now: number;
  ongoing: { since: number } | null;
  count: number;
  downtime_s: number;
  longest_s: number;
  availability_pct: number;
  /** Outages that started in each local hour of the day, 0-23. */
  by_hour: number[];
  by_hour_s: number[];
  cells: { enb: string; count: number; downtime_s: number }[];
  recent: { start: number; end: number; enb: string; net: string }[];
}

export function useOutages(range: OutageRange) {
  const [data, setData] = useState<OutageStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await authFetch(`${CGI}?days=${range}`);
      const json = await res.json();
      if (!mounted.current) return;
      if (!json?.success) throw new Error(json?.detail ?? "failed");
      setData(json as OutageStats);
      setError(null);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "failed");
    }
  }, [range]);

  useEffect(() => {
    mounted.current = true;
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, [load]);

  return { data, error, refresh: load };
}
