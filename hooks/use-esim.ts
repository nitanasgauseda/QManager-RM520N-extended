"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/auth-fetch";

// eSIM profiles through lpac. Reads the eSIM on first load and on "Refresh"; polls only while a download runs.
const CGI = "/cgi-bin/quecmanager/cellular/esim.sh";

export interface EsimProfile {
  iccid: string;
  state: "enabled" | "disabled" | string;
  nickname: string | null;
  provider: string | null;
  name: string | null;
  class: string | null;
}

export interface EsimState {
  checked_at: number;
  euicc: boolean;
  error: string | null;
  eid: string | null;
  free_bytes: number | null;
  profiles: EsimProfile[];
}

export interface EsimJob {
  running: boolean;
  started?: number;
  updated?: number;
  step?: string;
  result?: { success: boolean; error?: string; detail?: string };
}

export type EsimResult = { ok: true } | { ok: false; code: string };
export type EsimAction = "enable" | "disable" | "delete" | "nickname";

export function useEsim() {
  const [available, setAvailable] = useState(true);
  const [state, setState] = useState<EsimState | null>(null);
  const [job, setJob] = useState<EsimJob | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async (refresh = false) => {
    try {
      const res = await authFetch(refresh ? `${CGI}?refresh=1` : CGI);
      const json = await res.json();
      if (!mounted.current) return;
      if (!json?.success) throw new Error(json?.error ?? "failed");
      setAvailable(json.available !== false);
      setState(json.state ?? null);
      setJob(json.job ?? null);
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
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const running = job?.running === true;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => void load(), 2000);
    return () => clearInterval(id);
  }, [running, load]);

  const refresh = useCallback(async () => {
    setBusy("refresh");
    await load(true);
    if (mounted.current) setBusy(null);
  }, [load]);

  const post = useCallback(
    async (body: Record<string, unknown>, key: string): Promise<EsimResult> => {
      setBusy(key);
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

  const act = useCallback(
    (action: EsimAction, iccid: string, name?: string) =>
      post({ action, iccid, ...(name !== undefined ? { name } : {}) }, `${action}:${iccid}`),
    [post],
  );

  const download = useCallback(
    (code: string, confirm: string) => post({ action: "download", code, confirm }, "download"),
    [post],
  );

  return { available, state, job, isLoading, error, busy, refresh, act, download };
}
