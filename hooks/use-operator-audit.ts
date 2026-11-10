"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/auth-fetch";

// What the SIM lets the operator do, and whether the operator edits plain HTTP. Runs only when asked.
const CGI = "/cgi-bin/quecmanager/system/operator_audit.sh";

export interface SimAudit {
  readable: boolean;
  /** The SIM accepts commands sent to it by SMS. */
  sms_download?: boolean;
  cb_download?: boolean;
  call_control?: boolean;
  sms_control?: boolean;
  /** The SIM carries standalone-5G data. */
  sa_ready?: boolean;
  /** The subscriber number is encrypted on a standalone 5G network. */
  id_privacy?: boolean;
  id_privacy_in_sim?: boolean;
}

export type HeaderVerdict = "clean" | "identity" | "proxy" | "modified" | "unexpected";
export interface HeaderTest {
  result: HeaderVerdict;
  /** Names of the added headers; values never leave the modem. */
  headers: string[];
}
export type HeaderTestResult = { ok: true; test: HeaderTest } | { ok: false; code: string };

export function useOperatorAudit() {
  const [sim, setSim] = useState<SimAudit | null>(null);
  const [failed, setFailed] = useState(false);
  const [test, setTest] = useState<HeaderTest | null>(null);
  const [testing, setTesting] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await authFetch(CGI);
      const json = await res.json();
      if (!mounted.current) return;
      if (!json?.success || !json.sim) throw new Error("failed");
      setSim(json.sim as SimAudit);
      setFailed(false);
    } catch {
      if (mounted.current) setFailed(true);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const runHeaderTest = useCallback(async (): Promise<HeaderTestResult> => {
    setTesting(true);
    try {
      const res = await authFetch(CGI, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "header_test" }),
      });
      const json = await res.json();
      if (!json?.success) return { ok: false, code: json?.error ?? "failed" };
      const t: HeaderTest = { result: json.result, headers: Array.isArray(json.headers) ? json.headers : [] };
      if (mounted.current) setTest(t);
      return { ok: true, test: t };
    } catch {
      return { ok: false, code: "failed" };
    } finally {
      if (mounted.current) setTesting(false);
    }
  }, []);

  return { sim, failed, test, testing, runHeaderTest };
}
