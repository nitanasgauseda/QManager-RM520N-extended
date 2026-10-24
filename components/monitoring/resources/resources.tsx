"use client";

import { useTranslation } from "react-i18next";
import { AlertCircleIcon, GaugeIcon, RefreshCwIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricBar } from "@/components/ui/metric-bar";
import { Skeleton } from "@/components/ui/skeleton";
import { useResources, type ResourcesSnapshot } from "@/hooks/use-resources";
import { cn } from "@/lib/utils";

const K = "resources";
const CARD = "@container/card gap-5 rounded-card border-0 bg-surface py-6 shadow-sm";
const PAD = "px-7";
const ROW = "flex items-center justify-between gap-4 rounded-pill bg-surface-container px-4 py-[0.6875rem]";
const ROW_LABEL = "shrink-0 text-[0.8125rem] font-semibold leading-5 text-on-surface-variant";
const ROW_VALUE = "min-w-0 truncate text-right text-[0.8125rem] font-semibold leading-5 tabular-nums";
/** CPU above this for a whole read is worth a chip: the modem has one core. */
const CPU_WARN = 80;
const MEM_WARN = 85;

const mb = (kb: number) => `${(kb / 1024).toFixed(kb < 10_240 ? 1 : 0)} MB`;

function Row({ label, value, children }: { label: string; value?: string; children?: React.ReactNode }) {
  return (
    <div className={ROW}>
      <span className={ROW_LABEL}>{label}</span>
      {children ?? <span className={ROW_VALUE}>{value}</span>}
    </div>
  );
}

function fmtUptime(s: number, t: (k: string, o?: Record<string, unknown>) => string) {
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  return d > 0 ? t(`${K}.uptime_dh`, { d, h }) : t(`${K}.uptime_hm`, { h, m });
}

function NowCard({ data }: { data: ResourcesSnapshot }) {
  const { t, i18n } = useTranslation("common");
  const nf1 = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const used = data.mem.total_kb - data.mem.available_kb;
  const memPct = data.mem.total_kb > 0 ? Math.round((used * 100) / data.mem.total_kb) : 0;
  const cpu = data.cpu_pct;
  return (
    <Card className={CARD}>
      <CardHeader className={PAD}>
        <CardTitle className="text-lg leading-tight">{t(`${K}.now.title`)}</CardTitle>
        <CardDescription className="text-on-surface-variant text-sm">{t(`${K}.now.description`)}</CardDescription>
      </CardHeader>
      <CardContent className={cn(PAD, "flex flex-col gap-5")}>
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-on-surface-variant text-sm font-semibold">{t(`${K}.now.cpu`)}</span>
            {cpu !== null && cpu >= CPU_WARN ? (
              <Badge variant="warning">
                <GaugeIcon className="size-3" aria-hidden />
                {t(`${K}.now.busy`, { pct: Math.round(cpu) })}
              </Badge>
            ) : (
              <span className="text-2xl font-bold tabular-nums">{cpu === null ? "—" : `${Math.round(cpu)} %`}</span>
            )}
          </div>
          <MetricBar value={cpu} max={100} warnAt={CPU_WARN} dangerAt={95} />
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-on-surface-variant text-sm font-semibold">{t(`${K}.now.memory`)}</span>
            <span className="text-2xl font-bold tabular-nums">
              {mb(used)}
              <small className="text-on-surface-variant ml-1 text-sm font-semibold">/ {mb(data.mem.total_kb)}</small>
            </span>
          </div>
          <MetricBar value={memPct} max={100} warnAt={MEM_WARN} dangerAt={95} />
        </div>
        <div className="flex flex-col gap-[0.3125rem]">
          <Row label={t(`${K}.now.available`)} value={mb(data.mem.available_kb)} />
          <Row
            label={t(`${K}.now.load`)}
            value={data.load.map((v) => nf1.format(v)).join(" · ")}
          />
          <Row label={t(`${K}.now.processes`)} value={String(data.processes)} />
          <Row label={t(`${K}.now.uptime`)} value={fmtUptime(data.uptime, t)} />
        </div>
      </CardContent>
    </Card>
  );
}

function FlashCard({ data }: { data: ResourcesSnapshot }) {
  const { t } = useTranslation("common");
  return (
    <Card className={CARD}>
      <CardHeader className={PAD}>
        <CardTitle className="text-lg leading-tight">{t(`${K}.flash.title`)}</CardTitle>
        <CardDescription className="text-on-surface-variant text-sm">{t(`${K}.flash.description`)}</CardDescription>
      </CardHeader>
      <CardContent className={cn(PAD, "flex flex-col gap-5")}>
        {data.flash.length === 0 ? (
          <p className="text-on-surface-variant text-sm">{t(`${K}.flash.none`)}</p>
        ) : (
          data.flash.map((f) => {
            const pct = f.total_kb > 0 ? Math.round((f.used_kb * 100) / f.total_kb) : 0;
            return (
              <div key={f.mount} className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="font-mono text-sm">{f.mount}</span>
                  <span className="text-sm font-semibold tabular-nums">
                    {mb(f.used_kb)} <span className="text-on-surface-variant">/ {mb(f.total_kb)}</span>
                  </span>
                </div>
                <MetricBar value={pct} max={100} warnAt={85} dangerAt={95} />
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

function ProcessCard({ data }: { data: ResourcesSnapshot }) {
  const { t, i18n } = useTranslation("common");
  const nf1 = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  return (
    <Card className={CARD}>
      <CardHeader className={PAD}>
        <CardTitle className="text-lg leading-tight">{t(`${K}.procs.title`)}</CardTitle>
        <CardDescription className="text-on-surface-variant text-sm">{t(`${K}.procs.description`)}</CardDescription>
      </CardHeader>
      <CardContent className={cn(PAD, "flex flex-col gap-[0.3125rem]")}>
        <div className="text-on-surface-variant flex items-center gap-3 px-4 text-[0.6875rem] font-semibold tracking-[0.09em] uppercase">
          <span className="min-w-0 flex-1">{t(`${K}.procs.name`)}</span>
          <span className="w-16 text-right">{t(`${K}.procs.cpu`)}</span>
          <span className="w-20 text-right">{t(`${K}.procs.memory`)}</span>
        </div>
        {data.top.map((p) => (
          <div key={p.pid} className="bg-surface-container flex items-center gap-3 rounded-pill px-4 py-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={`PID ${p.pid}`}>
              {p.name}
            </span>
            <span className="w-16 text-right text-[0.8125rem] font-semibold tabular-nums">
              {p.cpu_pct === null ? "—" : `${nf1.format(p.cpu_pct)} %`}
            </span>
            <span className="text-on-surface-variant w-20 text-right text-[0.8125rem] font-semibold tabular-nums">
              {p.rss_kb > 0 ? mb(p.rss_kb) : "—"}
            </span>
          </div>
        ))}
        {!data.measured ? <p className="text-on-surface-variant px-1 pt-2 text-xs">{t(`${K}.procs.first_read`)}</p> : null}
      </CardContent>
    </Card>
  );
}

export default function ResourcesComponent() {
  const { t } = useTranslation("common");
  const { data, error, refresh } = useResources();

  const header = (
    <div className="flex flex-col gap-5 @3xl/main:flex-row @3xl/main:items-end">
      <div className="flex max-w-[41rem] flex-col gap-1.5">
        <h1 className="text-3xl font-bold tracking-[-0.02em]">{t(`${K}.page.title`)}</h1>
        <p className="text-on-surface-variant text-sm leading-relaxed text-pretty">{t(`${K}.page.description`)}</p>
      </div>
      <div className="@3xl/main:ml-auto">
        <Button type="button" variant="outline" size="action" onClick={() => void refresh()}>
          <RefreshCwIcon className="size-4" aria-hidden />
          {t(`${K}.page.refresh`)}
        </Button>
      </div>
    </div>
  );

  if (!data && !error) {
    return (
      <div className="@container/main flex flex-col gap-5 p-2" aria-busy="true">
        {header}
        <div className="grid grid-cols-1 gap-5 @3xl/main:grid-cols-2">
          <Skeleton className="h-80 rounded-card" />
          <Skeleton className="h-80 rounded-card" />
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="@container/main flex flex-col gap-5 p-2">
        {header}
        <Card className={CARD}>
          <CardContent className={cn(PAD, "flex flex-col items-start gap-3")}>
            <Badge variant="destructive">
              <AlertCircleIcon className="size-3" aria-hidden />
              {t(`${K}.errors.load_failed`)}
            </Badge>
            <Button type="button" variant="tonal-neutral" size="action" onClick={() => void refresh()}>
              {t(`${K}.page.retry`)}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="@container/main flex flex-col gap-5 p-2">
      {header}
      <div className="grid grid-cols-1 items-start gap-5 *:min-w-0 @3xl/main:grid-cols-2">
        <div className="flex flex-col gap-5">
          <NowCard data={data} />
          <FlashCard data={data} />
        </div>
        <ProcessCard data={data} />
      </div>
    </div>
  );
}
