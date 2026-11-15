"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/auth-fetch";

// On-demand snapshot from the root poller: the CGI asks for one, the poller answers within a cycle.
const CGI = "/cgi-bin/quecmanager/system/net_snapshot.sh";
const FRESH_S = 5;
const RETRY_MS = 1500;
const MAX_TRIES = 12;

export interface FwBlockedRow {
  /** port: a closed port; ping: echo requests hidden by stealth; lan6: unsolicited IPv6 to LAN devices */
  kind: "port" | "ping" | "lan6";
  proto: string;
  port: number | null;
  packets: number;
  bytes: number;
}
export interface FwBlocked {
  ok: boolean;
  rows: FwBlockedRow[];
}

export interface ConnDest {
  dst: string;
  port: number | null;
  proto: string;
  connections: number;
  bytes: number;
}
export interface ConnClient {
  src: string;
  connections: number;
  bytes: number;
  top: ConnDest[];
}
export interface Connections {
  ok: boolean;
  bytes_counted: boolean;
  clients: ConnClient[];
}

export function useNetSnapshot<T>(kind: "fw" | "ct") {
  const [data, setData] = useState<T | null>(null);
  const [pending, setPending] = useState(true);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (tries = 0): Promise<void> => {
      if (timer.current) clearTimeout(timer.current);
      setPending(true);
      try {
        const res = await authFetch(`${CGI}?kind=${kind}`);
        const json = await res.json();
        if (!mounted.current) return;
        if (!json?.success) throw new Error("failed");
        if (json.data) setData(json.data as T);
        setFailed(false);
        const fresh = json.age !== null && json.age <= FRESH_S;
        if (fresh || tries >= MAX_TRIES) {
          setPending(false);
          if (!fresh && !json.data) setFailed(true);
          return;
        }
        timer.current = setTimeout(() => void load(tries + 1), RETRY_MS);
      } catch {
        if (!mounted.current) return;
        setFailed(true);
        setPending(false);
      }
    },
    [kind],
  );

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  return { data, pending, failed, refresh: () => void load() };
}
