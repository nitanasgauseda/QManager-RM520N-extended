"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/auth-fetch";
import type { LatLon, TowerIndex } from "@/lib/tower-geo";
import type { MutationResult } from "@/types/mutation-result";

// Tower Map state: home position, saved tower corrections and the local OpenCelliD index.
const CGI = "/cgi-bin/quecmanager/cellular/tower_map.sh";

export interface TowerDbSummary {
  mcc: number;
  generated: string;
  /** "opencellid" (the user's own key, daily export) or "mirror" */
  source: string;
  built: number;
  towers: number;
}

export interface ScanCell {
  /** "LTE" or "NR5G" */
  type: string;
  mcc: number;
  mnc: number;
  /** Full cell identity (ECI / NCI), decimal */
  cell: number;
  pci: number;
  band: number;
  rsrp: number;
  provider: string;
}

export interface TowerMapState {
  home: LatLon | null;
  overrides: Record<string, LatLon>;
  databases: TowerDbSummary[];
  /** An OpenCelliD key is saved; the key itself never leaves the modem. */
  hasToken: boolean;
  attribution: string;
  /** The last Cell Scanner sweep, kept across reboots. */
  scan: { at: number; cells: ScanCell[] } | null;
}

export interface TowerMutationResult extends MutationResult {
  /** CGI error slug, null on success or a transport failure. */
  code: string | null;
}

async function post(body: Record<string, unknown>): Promise<TowerMutationResult & { json?: unknown }> {
  try {
    const res = await authFetch(CGI, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (json?.success) return { ok: true, error: null, code: null, json };
    return { ok: false, error: json?.detail ?? "failed", code: json?.error ?? null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "failed", code: null };
  }
}

export function useTowerMap(mcc: number | null) {
  const [state, setState] = useState<TowerMapState | null>(null);
  const [index, setIndex] = useState<TowerIndex | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadState = useCallback(async () => {
    try {
      const res = await authFetch(CGI);
      const json = await res.json();
      if (!mounted.current) return;
      if (!json?.success) throw new Error(json?.detail ?? "failed");
      setState({
        home: json.home ?? null,
        overrides: json.overrides ?? {},
        databases: json.databases ?? [],
        hasToken: json.has_token === true,
        attribution: json.attribution ?? "",
        scan: json.scan && Array.isArray(json.scan.cells) ? json.scan : null,
      });
      setError(null);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "failed");
    } finally {
      if (mounted.current) setIsLoading(false);
    }
  }, []);

  const loadIndex = useCallback(async (m: number) => {
    try {
      const res = await authFetch(`${CGI}?towers=${m}`);
      const json = await res.json();
      if (!mounted.current) return;
      setIndex(Array.isArray(json?.towers) ? (json as TowerIndex) : null);
    } catch {
      if (mounted.current) setIndex(null);
    }
  }, []);

  useEffect(() => {
    // Initial fetch; setState happens after the await, never synchronously in the effect.
    void loadState();
  }, [loadState]);

  const hasDb = !!state?.databases.some((d) => d.mcc === mcc);
  useEffect(() => {
    if (mcc !== null && hasDb) void loadIndex(mcc);
  }, [mcc, hasDb, loadIndex]);

  const updateDb = useCallback(async (): Promise<TowerMutationResult> => {
    if (mcc === null) return { ok: false, error: "no_mcc", code: "invalid_mcc" };
    setIsUpdating(true);
    const r = await post({ action: "update_db", mcc: String(mcc) });
    if (r.ok) {
      await loadState();
      await loadIndex(mcc);
    }
    if (mounted.current) setIsUpdating(false);
    return r;
  }, [mcc, loadState, loadIndex]);

  const saveHome = useCallback(
    async (p: LatLon) => {
      const r = await post({ action: "save_home", lat: p.lat.toFixed(6), lon: p.lon.toFixed(6) });
      if (r.ok && mounted.current) setState((s) => (s ? { ...s, home: p } : s));
      return r;
    },
    [],
  );

  const setOverride = useCallback(async (key: string, p: LatLon) => {
    const r = await post({ action: "set_override", key, lat: p.lat.toFixed(6), lon: p.lon.toFixed(6) });
    if (r.ok && mounted.current)
      setState((s) => (s ? { ...s, overrides: { ...s.overrides, [key]: p } } : s));
    return r;
  }, []);

  const clearOverride = useCallback(async (key: string) => {
    const r = await post({ action: "clear_override", key });
    if (r.ok && mounted.current)
      setState((s) => {
        if (!s) return s;
        const rest = { ...s.overrides };
        delete rest[key];
        return { ...s, overrides: rest };
      });
    return r;
  }, []);

  const saveToken = useCallback(async (token: string) => {
    const r = await post({ action: "save_token", token });
    if (r.ok && mounted.current) setState((s) => (s ? { ...s, hasToken: true } : s));
    return r;
  }, []);

  const clearToken = useCallback(async () => {
    const r = await post({ action: "clear_token" });
    if (r.ok && mounted.current) setState((s) => (s ? { ...s, hasToken: false } : s));
    return r;
  }, []);

  return {
    state,
    index,
    isLoading,
    error,
    isUpdating,
    hasDb,
    refresh: loadState,
    updateDb,
    saveHome,
    setOverride,
    clearOverride,
    saveToken,
    clearToken,
  };
}

export type UseTowerMapReturn = ReturnType<typeof useTowerMap>;
