"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/auth-fetch";

// Resources page: CPU and memory per process, read from /proc by monitoring/resources.sh.
const CGI = "/cgi-bin/quecmanager/monitoring/resources.sh";
const POLL_MS = 5_000;

export interface ResourceProcess {
  pid: number;
  name: string;
  state: string;
  /** null on the first read: CPU is measured between two reads. */
  cpu_pct: number | null;
  rss_kb: number;
}

export interface ResourcesSnapshot {
  cpu_pct: number | null;
  measured: boolean;
  mem: { total_kb: number; available_kb: number; free_kb: number; cached_kb: number };
  load: [number, number, number];
  uptime: number;
  processes: number;
  flash: { mount: string; total_kb: number; used_kb: number }[];
  top: ResourceProcess[];
}

export function useResources() {
  const [data, setData] = useState<ResourcesSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await authFetch(CGI);
      const json = await res.json();
      if (!mounted.current) return;
      if (!json?.success) throw new Error(json?.detail ?? "failed");
      setData(json as ResourcesSnapshot);
      setError(null);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "failed");
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

  return { data, error, refresh: load };
}
