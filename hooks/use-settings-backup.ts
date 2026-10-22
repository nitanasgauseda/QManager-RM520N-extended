"use client";

import { useCallback, useState } from "react";
import { authFetch } from "@/lib/auth-fetch";

// Settings backup: download a .tar.gz of QManager's settings, inspect an uploaded one, restore it.
const CGI = "/cgi-bin/quecmanager/system/backup.sh";
export const BACKUP_MAX_BYTES = 2 * 1024 * 1024;

export interface BackupManifest {
  format: number;
  app: string;
  version: string;
  model: string;
  created: number;
  files: number;
}

export interface BackupInspect {
  manifest: BackupManifest;
  files: string[];
}

export interface BackupRestore extends BackupInspect {
  restored: number;
  needs_reboot: boolean;
  secrets_missing: string[];
}

export type BackupOutcome<T> = { ok: true; data: T } | { ok: false; code: string };

async function upload<T>(action: "inspect" | "restore", file: Blob): Promise<BackupOutcome<T>> {
  if (file.size > BACKUP_MAX_BYTES) return { ok: false, code: "too_large" };
  try {
    const res = await authFetch(`${CGI}?action=${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    });
    const json = await res.json();
    if (json?.success) return { ok: true, data: json as T };
    return { ok: false, code: json?.error ?? "failed" };
  } catch {
    return { ok: false, code: "failed" };
  }
}

export function useSettingsBackup() {
  const [busy, setBusy] = useState<"download" | "inspect" | "restore" | null>(null);

  const download = useCallback(async (): Promise<BackupOutcome<string>> => {
    setBusy("download");
    try {
      const res = await authFetch(CGI);
      const type = res.headers.get("Content-Type") ?? "";
      if (!res.ok || !type.includes("gzip")) return { ok: false, code: "failed" };
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") ?? "";
      const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? "qmanager-settings.tar.gz";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return { ok: true, data: name };
    } catch {
      return { ok: false, code: "failed" };
    } finally {
      setBusy(null);
    }
  }, []);

  const inspect = useCallback(async (file: Blob) => {
    setBusy("inspect");
    try {
      return await upload<BackupInspect>("inspect", file);
    } finally {
      setBusy(null);
    }
  }, []);

  const restore = useCallback(async (file: Blob) => {
    setBusy("restore");
    try {
      return await upload<BackupRestore>("restore", file);
    } finally {
      setBusy(null);
    }
  }, []);

  return { busy, download, inspect, restore };
}
