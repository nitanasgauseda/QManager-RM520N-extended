"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/auth-fetch";

// Security Check: runs only when asked (page load or "Check again"); nothing polls.
const CGI = "/cgi-bin/quecmanager/system/security.sh";
const AUDIT_CGI = "/cgi-bin/quecmanager/system/audit.sh";

export interface SecurityPort {
  proto: "tcp" | "udp";
  port: number;
  family: 4 | 6;
  service: string;
  open: boolean;
  uncertain: boolean;
  public: boolean;
  blocked_by_qmanager: boolean;
}

export interface SecurityReport {
  checked_at: number;
  wan: { ipv4: string; ipv6: string; ipv4_public: boolean; ipv6_public: boolean; firewall_readable: boolean };
  ports: SecurityPort[];
  device: {
    adb: "on" | "off" | "unknown";
    adb_fix: string;
    web_console: boolean;
    https: boolean;
    cell_guard: boolean;
    encrypted_dns: boolean;
  };
  privacy?: { stealth: boolean; lan_ipv6: boolean; stealth_active: boolean; lan_ipv6_off_active: boolean };
}

export type SecurityResult = { ok: true } | { ok: false; code: string };

export function useSecurityCheck() {
  const [report, setReport] = useState<SecurityReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const mounted = useRef(true);

  const run = useCallback(async () => {
    try {
      const res = await authFetch(CGI);
      const json = await res.json();
      if (!mounted.current) return;
      if (!json?.success) throw new Error(json?.detail ?? "failed");
      setReport(json as SecurityReport);
      setError(null);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "failed");
    } finally {
      if (mounted.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void run();
    return () => {
      mounted.current = false;
    };
  }, [run]);

  const setBlocked = useCallback(
    async (p: Pick<SecurityPort, "proto" | "port">, block: boolean): Promise<SecurityResult> => {
      setBusy(`${p.proto}/${p.port}`);
      try {
        const res = await authFetch(CGI, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: block ? "block_port" : "unblock_port", proto: p.proto, port: p.port }),
        });
        const json = await res.json();
        await run();
        return json?.success ? { ok: true } : { ok: false, code: json?.error ?? "failed" };
      } catch {
        return { ok: false, code: "failed" };
      } finally {
        if (mounted.current) setBusy(null);
      }
    },
    [run],
  );

  const setPrivacy = useCallback(
    async (v: { stealth: boolean; lan_ipv6: boolean }): Promise<SecurityResult> => {
      setBusy("privacy");
      try {
        const res = await authFetch(CGI, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "set_privacy", ...v }),
        });
        const json = await res.json();
        await run();
        return json?.success ? { ok: true } : { ok: false, code: json?.error ?? "failed" };
      } catch {
        return { ok: false, code: "failed" };
      } finally {
        if (mounted.current) setBusy(null);
      }
    },
    [run],
  );

  return { report, isLoading, error, busy, run, setBlocked, setPrivacy };
}

// --- Activity log -----------------------------------------------------------------

export interface AuditEntry {
  t: number;
  kind: "login" | "logout" | "change";
  what: string;
  detail: string;
  ip: string;
}

export function useAuditLog() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [max, setMax] = useState(500);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await authFetch(AUDIT_CGI);
      const json = await res.json();
      if (!mounted.current) return;
      if (!json?.success) throw new Error(json?.detail ?? "failed");
      setEntries(Array.isArray(json.entries) ? json.entries : []);
      if (typeof json.max === "number") setMax(json.max);
      setError(null);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "failed");
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const clear = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    try {
      const res = await authFetch(AUDIT_CGI, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear" }),
      });
      const json = await res.json();
      await load();
      return !!json?.success;
    } catch {
      return false;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [load]);

  return { entries, max, error, busy, refresh: load, clear };
}
