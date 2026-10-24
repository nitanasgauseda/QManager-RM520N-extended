"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/auth-fetch";

// Poller watch checks: roaming (alert, optional data block) and the public IP / carrier NAT check.
const CGI = "/cgi-bin/quecmanager/monitoring/watch.sh";
const POLL_MS = 30_000;

export interface WatchConfig {
  roaming: { alert: boolean; block: boolean };
  public_ip: { enabled: boolean };
}

export interface WatchState {
  config: WatchConfig;
  roaming: { state: "home" | "roaming" | "unknown"; since: number; blocked: boolean } | null;
  public_ip: {
    checked_at: number;
    public_ipv4: string | null;
    wan_ipv4: string;
    cgnat: boolean | null;
    error: string | null;
  } | null;
}

export type WatchResult = { ok: true } | { ok: false; code: string };

export function useWatch() {
  const [state, setState] = useState<WatchState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await authFetch(CGI);
      const json = await res.json();
      if (!mounted.current) return;
      if (!json?.success) throw new Error(json?.detail ?? "failed");
      setState(json as WatchState);
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

  const post = useCallback(
    async (body: Record<string, unknown>, tag: string): Promise<WatchResult> => {
      setBusy(tag);
      try {
        const res = await authFetch(CGI, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        await load();
        return json?.success ? { ok: true } : { ok: false, code: json?.error ?? "failed" };
      } catch {
        return { ok: false, code: "failed" };
      } finally {
        if (mounted.current) setBusy(null);
      }
    },
    [load],
  );

  const save = useCallback((config: WatchConfig) => post({ action: "save", ...config }, "save"), [post]);
  const checkIp = useCallback(() => post({ action: "check_ip" }, "check_ip"), [post]);

  return { state, error, busy, refresh: load, save, checkIp };
}
