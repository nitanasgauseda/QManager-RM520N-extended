"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircleIcon, CheckIcon, RefreshCwIcon, WifiOffIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SegmentedField, SEGMENTED } from "@/components/ui/segmented-field";
import { Skeleton } from "@/components/ui/skeleton";
import { useOutages, type OutageRange, type OutageStats } from "@/hooks/use-outages";
import { cn } from "@/lib/utils";

const K = "outages";
const CARD = "@container/card gap-5 rounded-card border-0 bg-surface py-6 shadow-sm";
const PAD = "px-7";
const ROW = "flex items-center justify-between gap-4 rounded-pill bg-surface-container px-4 py-[0.6875rem]";
const ROW_LABEL = "shrink-0 text-[0.8125rem] font-semibold leading-5 text-on-surface-variant";
const ROW_VALUE = "min-w-0 truncate text-right text-[0.8125rem] font-semibold leading-5 tabular-nums";

const glyph = (className: string) => <CheckIcon size={SEGMENTED.GLYPH} className={className} aria-hidden="true" />;

type T = (k: string, o?: Record<string, unknown>) => string;

function fmtDur(s: number, t: T) {
  if (s < 60) return t(`${K}.dur_s`, { n: Math.max(0, Math.round(s)) });
  const m = Math.round(s / 60);
  if (m < 60) return t(`${K}.dur_m`, { n: m });
  const h = Math.floor(m / 60);
  return t(`${K}.dur_hm`, { h, m: m % 60 });
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className={ROW}>
      <span className={ROW_LABEL}>{label}</span>
      <span className={ROW_VALUE}>{value}</span>
    </div>
  );
}

function SummaryCard({ d }: { d: OutageStats }) {
  const { t, i18n } = useTranslation("common");
  const nf = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  return (
    <Card className={CARD}>
      <CardHeader className={PAD}>
        <CardTitle className="text-lg leading-tight">{t(`${K}.summary.title`)}</CardTitle>
        <CardDescription className="text-on-surface-variant text-sm">{t(`${K}.summary.description`, { days: d.days })}</CardDescription>
      </CardHeader>
      <CardContent className={cn(PAD, "flex flex-col gap-[0.3125rem]")}>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <span className="text-3xl font-bold tabular-nums">{nf.format(d.availability_pct)} %</span>
          {d.ongoing ? (
            <Badge variant="destructive">
              <WifiOffIcon className="size-3" aria-hidden />
              {t(`${K}.summary.ongoing`, {
                time: new Date(d.ongoing.since * 1000).toLocaleTimeString(i18n.language, { timeStyle: "short" }),
              })}
            </Badge>
          ) : (
            <span className="text-on-surface-variant text-sm font-semibold">{t(`${K}.summary.available`)}</span>
          )}
        </div>
        <Row label={t(`${K}.summary.count`)} value={String(d.count)} />
        <Row label={t(`${K}.summary.downtime`)} value={d.downtime_s > 0 ? fmtDur(d.downtime_s, t) : "—"} />
        <Row label={t(`${K}.summary.longest`)} value={d.longest_s > 0 ? fmtDur(d.longest_s, t) : "—"} />
      </CardContent>
    </Card>
  );
}

function HoursCard({ d }: { d: OutageStats }) {
  const { t } = useTranslation("common");
  const max = Math.max(1, ...d.by_hour_s);
  const worst = d.by_hour_s.indexOf(Math.max(...d.by_hour_s));
  return (
    <Card className={CARD}>
      <CardHeader className={PAD}>
        <CardTitle className="text-lg leading-tight">{t(`${K}.hours.title`)}</CardTitle>
        <CardDescription className="text-on-surface-variant text-sm">{t(`${K}.hours.description`)}</CardDescription>
      </CardHeader>
      <CardContent className={cn(PAD, "flex flex-col gap-3")}>
        <div className="flex h-32 items-end gap-[3px]" role="img" aria-label={t(`${K}.hours.title`)}>
          {d.by_hour_s.map((s, h) => (
            <div
              key={h}
              className="bg-surface-container flex h-full min-w-0 flex-1 items-end overflow-hidden rounded-[3px]"
              title={t(`${K}.hours.bar`, { h, n: d.by_hour[h], dur: fmtDur(s, t) })}
            >
              <div className="bg-on-surface-variant/60 w-full rounded-[3px]" style={{ height: `${(s / max) * 100}%` }} />
            </div>
          ))}
        </div>
        <div className="text-on-surface-variant flex justify-between text-xs tabular-nums">
          <span>0</span>
          <span>6</span>
          <span>12</span>
          <span>18</span>
          <span>23</span>
        </div>
        {d.count > 0 ? (
          <p className="text-on-surface-variant text-sm text-pretty">
            {t(`${K}.hours.worst`, { from: worst, to: (worst + 1) % 24 })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CellsCard({ d }: { d: OutageStats }) {
  const { t } = useTranslation("common");
  return (
    <Card className={CARD}>
      <CardHeader className={PAD}>
        <CardTitle className="text-lg leading-tight">{t(`${K}.cells.title`)}</CardTitle>
        <CardDescription className="text-on-surface-variant text-sm">{t(`${K}.cells.description`)}</CardDescription>
      </CardHeader>
      <CardContent className={cn(PAD, "flex flex-col gap-[0.3125rem]")}>
        {d.cells.length === 0 ? (
          <p className="text-on-surface-variant text-sm">{t(`${K}.none`)}</p>
        ) : (
          d.cells.map((c) => (
            <div key={c.enb} className={ROW}>
              <span className={ROW_LABEL}>{c.enb === "-" ? t(`${K}.cells.unknown`) : `eNB ${c.enb}`}</span>
              <span className={ROW_VALUE}>
                {t(`${K}.cells.value`, { n: c.count, dur: fmtDur(c.downtime_s, t) })}
              </span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function RecentCard({ d }: { d: OutageStats }) {
  const { t, i18n } = useTranslation("common");
  const fmt = (e: number) => new Date(e * 1000).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" });
  return (
    <Card className={CARD}>
      <CardHeader className={PAD}>
        <CardTitle className="text-lg leading-tight">{t(`${K}.recent.title`)}</CardTitle>
        <CardDescription className="text-on-surface-variant text-sm">{t(`${K}.recent.description`)}</CardDescription>
      </CardHeader>
      <CardContent className={cn(PAD, "flex max-h-[32rem] flex-col gap-[0.3125rem] overflow-y-auto")}>
        {d.recent.length === 0 ? (
          <p className="text-on-surface-variant text-sm">{t(`${K}.none`)}</p>
        ) : (
          d.recent.map((o) => (
            <div key={`${o.start}-${o.end}`} className={ROW}>
              <span className="text-[0.8125rem] font-semibold tabular-nums">{fmt(o.start)}</span>
              <span className="text-on-surface-variant min-w-0 truncate text-right text-[0.8125rem] font-semibold tabular-nums">
                {fmtDur(o.end - o.start, t)}
                {o.enb !== "-" ? ` · eNB ${o.enb}` : ""}
              </span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

export default function OutagesComponent() {
  const { t } = useTranslation("common");
  const [range, setRange] = useState<OutageRange>(30);
  const { data, error, refresh } = useOutages(range);

  const header = (
    <div className="flex flex-col gap-5 @3xl/main:flex-row @3xl/main:items-end">
      <div className="flex max-w-[41rem] flex-col gap-1.5">
        <h1 className="text-3xl font-bold tracking-[-0.02em]">{t(`${K}.page.title`)}</h1>
        <p className="text-on-surface-variant text-sm leading-relaxed text-pretty">{t(`${K}.page.description`)}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2.5 @3xl/main:ml-auto">
        <SegmentedField
          value={String(range)}
          onValueChange={(v) => setRange(Number(v) as OutageRange)}
          options={[
            { value: "7", label: t(`${K}.range.7`) },
            { value: "30", label: t(`${K}.range.30`) },
            { value: "90", label: t(`${K}.range.90`) },
          ]}
          ariaLabel={t(`${K}.range.label`)}
          breakpoint="never"
          glyph={glyph}
        />
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
          <Skeleton className="h-72 rounded-card" />
          <Skeleton className="h-72 rounded-card" />
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
          <SummaryCard d={data} />
          <CellsCard d={data} />
        </div>
        <div className="flex flex-col gap-5">
          <HoursCard d={data} />
          <RecentCard d={data} />
        </div>
      </div>
    </div>
  );
}
