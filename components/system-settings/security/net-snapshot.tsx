"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircleIcon, ChevronDownIcon, Loader2Icon, RefreshCwIcon, ShieldCheckIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useLanDevices } from "@/hooks/use-lan-devices";
import { useNetSnapshot, type Connections, type FwBlocked, type FwBlockedRow } from "@/hooks/use-net-snapshot";
import { formatBytes } from "@/types/modem-status";
import { cn } from "@/lib/utils";

const CARD = "@container/card gap-5 rounded-card border-0 bg-surface py-6 shadow-sm";
const PAD = "px-7";
const ROW = "flex items-center justify-between gap-4 rounded-pill bg-surface-container px-4 py-[0.6875rem]";
const ROW_LABEL = "min-w-0 truncate text-[0.8125rem] font-semibold leading-5 text-on-surface-variant";
const ROW_VALUE = "shrink-0 text-right text-[0.8125rem] font-semibold tabular-nums";
const MAX_CLIENTS = 10;

function Shell({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <Card className={CARD}>
      <CardHeader className={PAD}>
        <CardTitle className="text-lg leading-tight">{title}</CardTitle>
        <CardDescription className="text-on-surface-variant text-sm">{description}</CardDescription>
      </CardHeader>
      <CardContent className={cn(PAD, "flex flex-col gap-[0.3125rem]")}>{children}</CardContent>
    </Card>
  );
}

function Footer({ pending, onRefresh }: { pending: boolean; onRefresh: () => void }) {
  const { t } = useTranslation("common");
  return (
    <div className="mt-2 flex justify-end">
      <Button type="button" variant="tonal-neutral" size="action" disabled={pending} onClick={onRefresh}>
        <RefreshCwIcon className={cn("size-4", pending && "animate-spin")} aria-hidden />
        {t("securityCheck.snapshot.refresh")}
      </Button>
    </div>
  );
}

function Status({ pending, failed }: { pending: boolean; failed: boolean }) {
  const { t } = useTranslation("common");
  if (pending) return <Loader2Icon className="text-on-surface-variant size-4 animate-spin" aria-hidden />;
  if (!failed) return null;
  return (
    <Badge variant="destructive" className="self-start">
      <AlertCircleIcon className="size-3" aria-hidden />
      {t("securityCheck.snapshot.failed")}
    </Badge>
  );
}

export function BlockedCard() {
  const { t } = useTranslation("common");
  const K = "securityCheck.blocked";
  const { data, pending, failed, refresh } = useNetSnapshot<FwBlocked>("fw");
  const rows = [...(data?.rows ?? [])].filter((r) => r.packets > 0).sort((a, b) => b.packets - a.packets);
  const total = rows.reduce((n, r) => n + r.packets, 0);
  const label = (r: FwBlockedRow) =>
    r.kind === "ping" ? t(`${K}.ping`) : r.kind === "lan6" ? t(`${K}.lan6`) : t(`${K}.port`, { proto: r.proto.toUpperCase(), port: r.port ?? "—" });

  return (
    <Shell title={t(`${K}.title`)} description={t(`${K}.description`)}>
      {!data ? (
        <Status pending={pending} failed={failed} />
      ) : !data.ok ? (
        <Badge variant="destructive" className="self-start">
          <AlertCircleIcon className="size-3" aria-hidden />
          {t("securityCheck.snapshot.failed")}
        </Badge>
      ) : rows.length === 0 ? (
        <Badge variant="success" className="self-start">
          <ShieldCheckIcon className="size-3" aria-hidden />
          {t(`${K}.none`)}
        </Badge>
      ) : (
        <>
          <div className={ROW}>
            <span className={ROW_LABEL}>{t(`${K}.total`)}</span>
            <span className={ROW_VALUE}>{total.toLocaleString()}</span>
          </div>
          {rows.map((r) => (
            <div key={`${r.kind}-${r.proto}-${r.port}`} className={ROW}>
              <span className={ROW_LABEL}>{label(r)}</span>
              <span className={ROW_VALUE}>{r.packets.toLocaleString()}</span>
            </div>
          ))}
        </>
      )}
      <Footer pending={pending} onRefresh={refresh} />
    </Shell>
  );
}

export function ConnectionsCard() {
  const { t } = useTranslation("common");
  const K = "securityCheck.conns";
  const { data, pending, failed, refresh } = useNetSnapshot<Connections>("ct");
  const { devices } = useLanDevices();
  const [open, setOpen] = useState<string | null>(null);
  const names = new Map(devices.filter((d) => d.hostname).map((d) => [d.ip, d.hostname]));
  const clients = [...(data?.clients ?? [])].sort((a, b) => b.connections - a.connections).slice(0, MAX_CLIENTS);
  const bytes = data?.bytes_counted === true;

  return (
    <Shell title={t(`${K}.title`)} description={t(`${K}.description`)}>
      {!data ? (
        <Status pending={pending} failed={failed} />
      ) : !data.ok ? (
        <Badge variant="destructive" className="self-start">
          <AlertCircleIcon className="size-3" aria-hidden />
          {t(`${K}.unavailable`)}
        </Badge>
      ) : clients.length === 0 ? (
        <Badge variant="muted" className="self-start">
          <AlertCircleIcon className="size-3" aria-hidden />
          {t(`${K}.none`)}
        </Badge>
      ) : (
        clients.map((c) => {
          const name = names.get(c.src);
          const isOpen = open === c.src;
          return (
            <div key={c.src} className="flex flex-col gap-[0.3125rem]">
              <button
                type="button"
                className={cn(ROW, "w-full text-left")}
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : c.src)}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ChevronDownIcon
                    className={cn("text-on-surface-variant size-4 shrink-0", isOpen && "rotate-180")}
                    aria-hidden
                  />
                  <span className={cn(ROW_LABEL, !name && "font-mono")}>{name ?? c.src}</span>
                </span>
                <span className={cn(ROW_VALUE, "flex gap-3")}>
                  <span>{t(`${K}.count`, { n: c.connections })}</span>
                  {bytes ? <span>{formatBytes(c.bytes)}</span> : null}
                </span>
              </button>
              {isOpen ? (
                <ul className="flex flex-col gap-1 px-4 pb-1">
                  {name ? <li className="text-on-surface-variant font-mono text-xs">{c.src}</li> : null}
                  {c.top.map((d) => (
                    <li key={`${d.dst}-${d.port}-${d.proto}`} className="flex items-center justify-between gap-4 text-[0.8125rem]">
                      <span className="min-w-0 truncate font-mono">{d.dst}</span>
                      <span className="text-on-surface-variant flex shrink-0 gap-3 tabular-nums">
                        <span>
                          {d.proto.toUpperCase()}
                          {d.port !== null ? ` ${d.port}` : ""}
                        </span>
                        <span>{t(`${K}.count`, { n: d.connections })}</span>
                        {bytes ? <span>{formatBytes(d.bytes)}</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })
      )}
      <Footer pending={pending} onRefresh={refresh} />
    </Shell>
  );
}
