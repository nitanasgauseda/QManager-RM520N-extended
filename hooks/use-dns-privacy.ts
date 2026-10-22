"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/auth-fetch";

// DNS Privacy: encrypted DNS (DNS over TLS) and ad/tracker blocking through qmanager_dnsguard.
const CGI = "/cgi-bin/quecmanager/network/dns_privacy.sh";
const POLL_MS = 15_000;

export type DnsProvider = "quad9" | "cloudflare" | "google" | "adguard" | "mullvad" | "nextdns" | "custom";
export type BlockListId = "hagezi_light" | "hagezi_normal" | "hagezi_pro" | "hagezi_tif_mini" | "stevenblack";

export const DNS_PROVIDERS: DnsProvider[] = ["quad9", "cloudflare", "mullvad", "adguard", "google", "nextdns", "custom"];

/** Approximate sizes, for the memory estimate shown beside each list. */
export const BLOCK_LISTS: { id: BlockListId; domains: number }[] = [
  { id: "hagezi_light", domains: 69_000 },
  { id: "hagezi_normal", domains: 171_000 },
  { id: "hagezi_pro", domains: 208_000 },
  { id: "hagezi_tif_mini", domains: 212_000 },
  { id: "stevenblack", domains: 74_000 },
];
export const MAX_LISTS = 3;
export const MAX_DOMAINS = 300_000;

export interface DnsPrivacyConfig {
  encrypt: {
    enabled: boolean;
    provider: DnsProvider;
    fallback: boolean;
    nextdns_id: string;
    custom_host: string;
    custom_ip: string;
  };
  block: { enabled: boolean; lists: BlockListId[]; allow: string[]; deny: string[] };
}

export interface DnsPrivacyStatus {
  updated: number;
  clock_ok: boolean;
  mem_kb: number;
  upstream: {
    kind: "dot" | "plain";
    provider: string;
    last_ok: number;
    last_error: string;
    last_error_at: number;
    fallback_at: number;
    avg_ms: number;
    carrier: string[] | null;
  };
  stats: { queries: number; blocked: number; encrypted: number; fallback: number; failed: number };
  domains_total: number;
  lists: { id: string; domains: number; updated: number; error?: string }[] | null;
  lists_loading: boolean;
  lists_updating: boolean;
  top_blocked: { d: string; n: number }[] | null;
  recent_blocked: { d: string; t: number }[] | null;
}

export interface DnsPrivacyState {
  config: DnsPrivacyConfig;
  service: {
    installed: boolean;
    running: boolean;
    healthy: boolean;
    active: boolean;
    active_ipv6: boolean;
    redirect_failed: boolean;
    custom_dns_active: boolean;
    dns_mode: string;
    available: boolean;
  };
  status: DnsPrivacyStatus | null;
}

export type DnsPrivacyResult = { ok: true } | { ok: false; code: string };

export function useDnsPrivacy() {
  const [state, setState] = useState<DnsPrivacyState | null>(null);
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
      setState(json as DnsPrivacyState);
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

  const post = useCallback(
    async (body: Record<string, unknown>, tag: string): Promise<DnsPrivacyResult> => {
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

  const save = useCallback((config: DnsPrivacyConfig) => post({ action: "save", ...config }, "save"), [post]);
  const updateLists = useCallback(() => post({ action: "update_lists" }, "update"), [post]);
  const allow = useCallback((domain: string) => post({ action: "allow", domain }, `allow:${domain}`), [post]);

  return { state, isLoading, error, busy, refresh: load, save, updateLists, allow };
}
