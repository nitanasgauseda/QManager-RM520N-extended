"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/auth-fetch";

// SIM card facts and SIM PIN actions. Read once on load and after each action; nothing polls.
const CGI = "/cgi-bin/quecmanager/cellular/sim_card.sh";

export interface SimCard {
  /** Operator name stored on the SIM. */
  spn: string | null;
  /** SMS centre number. */
  smsc: string | null;
  state: "ready" | "pin" | "puk" | "other" | "unknown";
  pin_enabled: boolean | null;
  pin_retries: number | null;
  puk_retries: number | null;
  /** A PIN is saved on the modem for unlocking after a restart. */
  remembered: boolean;
  /** The SIM refused the saved PIN, so automatic unlock is off until a PIN is saved again. */
  auto_unlock_stopped: boolean;
}

export type SimPinAction = "enable" | "disable" | "change" | "unlock" | "forget";
export type SimPinResult = { ok: true } | { ok: false; code: string; retries?: number | null };

export function useSimCard() {
  const [sim, setSim] = useState<SimCard | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await authFetch(CGI);
      const json = await res.json();
      if (!mounted.current) return;
      if (!json?.success) throw new Error("failed");
      setSim(json as SimCard);
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

  const act = useCallback(
    async (action: SimPinAction, body: { pin?: string; new_pin?: string; remember?: boolean } = {}): Promise<SimPinResult> => {
      setBusy(true);
      try {
        const res = await authFetch(CGI, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ...body }),
        });
        const json = await res.json();
        await load();
        return json?.success ? { ok: true } : { ok: false, code: json?.error ?? "failed", retries: json?.pin_retries ?? null };
      } catch {
        return { ok: false, code: "failed" };
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [load],
  );

  return { sim, failed, busy, act, reload: load };
}
