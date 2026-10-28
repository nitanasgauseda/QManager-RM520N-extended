"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/auth-fetch";
import type { MutationResult } from "@/types/mutation-result";

// Cell Guard: fake base station heuristics plus the optional Rayhunter daemon.
const CGI = "/cgi-bin/quecmanager/monitoring/cell_guard.sh";
const POLL_MS = 15_000;
const POLL_INSTALL_MS = 2_000;

export interface CellGuardFinding {
  timestamp: number;
  type: "suspicious_cell" | "new_cell" | "suspicious_sms";
  message: string;
  severity: "info" | "warning" | "error";
}

export interface RayhunterWarning {
  severity: "Low" | "Medium" | "High";
  message: string;
  at: string | null;
}

export interface CellGuardState {
  config: { enabled: boolean; learn_hours: number; rayhunter: boolean; sms_guard: boolean; jam_guard: boolean };
  status: {
    enabled: boolean;
    learning: boolean;
    since: number | null;
    known_cells: number;
    last_finding: string;
    updated: number;
  } | null;
  findings: CellGuardFinding[];
  rayhunter: {
    installed: boolean;
    version: string;
    running: boolean;
    diag_present: boolean;
    install: { status: "idle" | "running" | "complete" | "error"; message?: string };
    log: string;
    live: {
      recording: string | null;
      started: string | null;
      size_bytes: number | null;
      recordings: number;
      warnings: RayhunterWarning[];
    } | null;
  };
}

export interface CellGuardResult extends MutationResult {
  code: string | null;
}

export function useCellGuard() {
  const [state, setState] = useState<CellGuardState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await authFetch(CGI);
      const json = await res.json();
      if (!mounted.current) return;
      if (!json?.success) throw new Error(json?.detail ?? "failed");
      setState(json as CellGuardState);
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

  const installing = state?.rayhunter.install.status === "running";
  useEffect(() => {
    const id = setInterval(() => void load(), installing ? POLL_INSTALL_MS : POLL_MS);
    return () => clearInterval(id);
  }, [load, installing]);

  const act = useCallback(
    async (action: string, extra: Record<string, unknown> = {}): Promise<CellGuardResult> => {
      setBusy(action);
      try {
        const res = await authFetch(CGI, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ...extra }),
        });
        const json = await res.json();
        await load();
        if (json?.success) return { ok: true, error: null, code: null };
        return { ok: false, error: json?.detail ?? "failed", code: json?.error ?? null };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "failed", code: null };
      } finally {
        if (mounted.current) setBusy(null);
      }
    },
    [load],
  );

  return { state, isLoading, error, busy, refresh: load, act };
}
