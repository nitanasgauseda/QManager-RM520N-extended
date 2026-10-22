"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  ActivityIcon,
  AlertCircleIcon,
  ArrowRightIcon,
  CheckIcon,
  CircleDotIcon,
  LightbulbIcon,
  RefreshCwIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { HintIcon } from "@/components/ui/hint-icon";
import { SegmentedField, SEGMENTED } from "@/components/ui/segmented-field";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { useChartSeriesMotion } from "@/hooks/use-chart-motion";
import { useLongHistory, type HistoryCell, type HistoryRange, type LongHistory } from "@/hooks/use-insights";
import { cn } from "@/lib/utils";

const K = "longHistory";
const CARD = "@container/card gap-5 rounded-card border-0 bg-surface py-6 shadow-sm";
const PAD = "px-7";
const TICK_INK =
  "[&_.recharts-cartesian-axis-tick_text]:fill-on-surface-variant [&_.recharts-cartesian-axis-tick_text]:tabular-nums [&_.recharts-cartesian-axis-tick_text]:text-[0.6875rem] [&_.recharts-cartesian-axis-tick_text]:font-medium";
const RANGES: HistoryRange[] = ["24h", "7d", "30d"];
/** A cell needs this much time on it before the advisor trusts its averages. */
const ADVISOR_MIN_MINUTES = 30;
/** Average SINR gain worth suggesting a lock for. */
const ADVISOR_GAIN_DB = 3;

const glyph = (className: string) => <CheckIcon size={SEGMENTED.GLYPH} className={className} aria-hidden="true" />;

function tickFormatter(range: HistoryRange, locale: string) {
  return (v: number) => {
    const d = new Date(v * 1000);
    return range === "24h"
      ? d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString(locale, { day: "numeric", month: "numeric" });
  };
}

function fmtWhen(v: number, locale: string) {
  return new Date(v * 1000).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" });
}

function fmtHours(minutes: number) {
  return minutes < 90 ? `${minutes} min` : `${(minutes / 60).toFixed(minutes < 600 ? 1 : 0)} h`;
}

function fmtBytes(b: number) {
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}

/** Signal over time: one chart per metric so dBm and dB never share an axis. */
function MetricChart({
  data,
  range,
  series,
  unit,
  ariaLabel,
}: {
  data: LongHistory;
  range: HistoryRange;
  series: { key: keyof LongHistory["points"][number]; label: string; color: string }[];
  unit: string;
  ariaLabel: string;
}) {
  const { i18n } = useTranslation("common");
  const motion = useChartSeriesMotion();
  const present = series.filter((s) => data.points.some((p) => typeof p[s.key] === "number"));
  const config = useMemo(
    () => Object.fromEntries(present.map((s) => [s.key, { label: s.label, color: s.color }])) satisfies ChartConfig,
    [present],
  );
  if (present.length === 0) return null;
  const fmt = tickFormatter(range, i18n.language);
  return (
    <div className="flex flex-col gap-2">
      <div className="relative h-48" role="img" aria-label={ariaLabel}>
        <ChartContainer config={config} className={cn("absolute inset-0 aspect-auto", TICK_INK)}>
          <LineChart data={data.points} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              tickFormatter={fmt}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={28}
            />
            <YAxis
              width={44}
              tickLine={false}
              axisLine={false}
              tickMargin={6}
              domain={["auto", "auto"]}
              allowDecimals={false}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) => {
                    const t = payload?.[0]?.payload?.t as number | undefined;
                    return t ? fmtWhen(t, i18n.language) : "";
                  }}
                  formatter={(value, name) => (
                    <div className="flex w-full items-center justify-between gap-4">
                      <span className="text-on-surface-variant">{config[name as string]?.label ?? name}</span>
                      <span className="font-semibold tabular-nums">
                        {value} {unit}
                      </span>
                    </div>
                  )}
                />
              }
            />
            {present.map((s) => (
              <Line
                key={s.key}
                dataKey={s.key}
                type="monotone"
                stroke={`var(--color-${s.key})`}
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                {...motion}
              />
            ))}
          </LineChart>
        </ChartContainer>
      </div>
      <div className="text-on-surface-variant flex flex-wrap items-center gap-4 text-xs font-medium">
        {present.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-[3px] w-3.5 rounded-pill" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
        <span>{unit}</span>
      </div>
    </div>
  );
}

function ChartSkeleton() {
  return <Skeleton className="h-48 w-full rounded-tile" />;
}

function cellScore(c: HistoryCell) {
  return c.sinr ?? c.nr_sinr ?? -99;
}

function CellLabel({ c }: { c: HistoryCell }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {c.lband ? <Tag variant="lte">{c.lband}</Tag> : null}
      {c.nband ? <Tag variant="nr">{c.nband}</Tag> : null}
      <span className="text-on-surface-variant text-xs tabular-nums">
        {c.enb ? `eNB ${c.enb}` : ""}
        {c.pci ? ` · PCI ${c.pci}` : ""}
      </span>
    </span>
  );
}

function AdvisorCard({ data, locale }: { data: LongHistory | null; locale: string }) {
  const { t } = useTranslation("common");
  if (!data) {
    return (
      <Card className={CARD}>
        <CardHeader className={PAD}>
          <CardTitle className="text-lg leading-tight">{t(`${K}.advisor.title`)}</CardTitle>
          <CardDescription className="text-on-surface-variant text-sm">{t(`${K}.advisor.description`)}</CardDescription>
        </CardHeader>
        <CardContent className={cn(PAD, "flex flex-col gap-2")}>
          <Skeleton className="h-14 rounded-card" />
          <Skeleton className="h-14 rounded-card" />
        </CardContent>
      </Card>
    );
  }
  const cells = data.cells.filter((c) => c.minutes >= ADVISOR_MIN_MINUTES);
  const current = data.cells.reduce<HistoryCell | null>((a, c) => (!a || c.last > a.last ? c : a), null);
  const best = cells.reduce<HistoryCell | null>((a, c) => (!a || cellScore(c) > cellScore(a) ? c : a), null);
  const suggest =
    best && current && best !== current && cellScore(best) - cellScore(current) >= ADVISOR_GAIN_DB ? best : null;
  const sorted = [...cells].sort((a, b) => cellScore(b) - cellScore(a));

  return (
    <Card className={CARD}>
      <CardHeader className={PAD}>
        <CardTitle className="text-lg leading-tight">{t(`${K}.advisor.title`)}</CardTitle>
        <CardDescription className="text-on-surface-variant text-sm">{t(`${K}.advisor.description`)}</CardDescription>
      </CardHeader>
      <CardContent className={cn(PAD, "flex flex-col gap-[0.3125rem]")}>
        {sorted.length === 0 ? (
          <p className="text-on-surface-variant py-4 text-sm text-pretty">{t(`${K}.advisor.empty`)}</p>
        ) : (
          <>
            {suggest ? (
              <div className="bg-primary-container text-on-primary-container mb-2 flex flex-col gap-2 rounded-card px-4 py-3">
                <span className="flex items-center gap-2 text-sm font-semibold">
                  <LightbulbIcon className="size-4 flex-none" aria-hidden />
                  {t(`${K}.advisor.suggest_title`)}
                </span>
                <span className="text-sm text-pretty">
                  {t(`${K}.advisor.suggest_body`, {
                    cell: [suggest.lband, suggest.nband].filter(Boolean).join(" + ") + (suggest.pci ? ` PCI ${suggest.pci}` : ""),
                    gain: (cellScore(suggest) - cellScore(current!)).toFixed(1),
                  })}
                </span>
                <span className="flex flex-wrap gap-3 text-sm font-medium">
                  <Link href="/cellular/cell-locking" className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
                    {t(`${K}.advisor.lock_band`)}
                    <ArrowRightIcon className="size-3.5" aria-hidden />
                  </Link>
                  <Link
                    href="/cellular/cell-locking/tower-locking"
                    className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
                  >
                    {t(`${K}.advisor.lock_tower`)}
                    <ArrowRightIcon className="size-3.5" aria-hidden />
                  </Link>
                </span>
              </div>
            ) : current && best === current ? (
              <div className="mb-2 flex">
                <Badge variant="success">
                  <CheckIcon className="size-3" aria-hidden />
                  {t(`${K}.advisor.on_best`)}
                </Badge>
              </div>
            ) : null}
            {sorted.slice(0, 8).map((c) => (
              <div
                key={`${c.net}|${c.lband}|${c.pci}|${c.enb}|${c.nband}`}
                className="bg-surface-container flex flex-col gap-2 rounded-card px-4 py-3 @lg/card:flex-row @lg/card:items-center @lg/card:justify-between"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <CellLabel c={c} />
                  <span className="text-on-surface-variant text-xs tabular-nums">
                    {t(`${K}.advisor.time_on`, { time: fmtHours(c.minutes) })} · {fmtWhen(c.last, locale)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.8125rem] font-semibold tabular-nums">
                  {c === current ? (
                    <Badge variant="info">
                      <CircleDotIcon className="size-3" aria-hidden />
                      {t(`${K}.advisor.current`)}
                    </Badge>
                  ) : null}
                  {typeof c.sinr === "number" ? <span>SINR {c.sinr} dB</span> : null}
                  {typeof c.nr_sinr === "number" ? <span>NR SINR {c.nr_sinr} dB</span> : null}
                  {typeof c.rsrp === "number" ? <span className="text-on-surface-variant">{c.rsrp} dBm</span> : null}
                  {typeof c.busy_dl_mbps === "number" ? (
                    <span className="text-on-surface-variant">↓ {c.busy_dl_mbps} Mbps</span>
                  ) : null}
                </div>
              </div>
            ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function SignalHistoryComponent() {
  const { t, i18n } = useTranslation("common");
  const [range, setRange] = useState<HistoryRange>("24h");
  const h = useLongHistory(range);
  const data = h.data;

  const header = (
    <div className="flex flex-col gap-5 @3xl/main:flex-row @3xl/main:items-end">
      <div className="flex max-w-[41rem] flex-col gap-1.5">
        <h1 className="text-3xl font-bold tracking-[-0.02em]">{t(`${K}.page.title`)}</h1>
        <p className="text-on-surface-variant text-sm leading-relaxed text-pretty">{t(`${K}.page.description`)}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2.5 @3xl/main:ml-auto">
        <SegmentedField
          value={range}
          onValueChange={(v) => setRange(v as HistoryRange)}
          options={RANGES.map((r) => ({ value: r, label: t(`${K}.range.${r}`), numeric: true }))}
          ariaLabel={t(`${K}.range.label`)}
          breakpoint="never"
          glyph={glyph}
        />
        <Button type="button" variant="outline" size="action" onClick={() => void h.refresh()}>
          <RefreshCwIcon className="size-4" aria-hidden />
          {t(`${K}.page.refresh`)}
        </Button>
      </div>
    </div>
  );

  const empty = data && data.points.length === 0;
  const totals = data
    ? data.points.reduce((a, p) => ({ rx: a.rx + p.rx_bytes, tx: a.tx + p.tx_bytes }), { rx: 0, tx: 0 })
    : null;

  return (
    <div className="@container/main flex flex-col gap-5 p-2">
      {header}
      {h.error && !data ? (
        <Card className={CARD}>
          <CardContent className={cn(PAD, "flex flex-col items-start gap-3")}>
            <Badge variant="destructive">
              <AlertCircleIcon className="size-3" aria-hidden />
              {t(`${K}.errors.load_failed`)}
            </Badge>
            <Button type="button" variant="tonal-neutral" size="action" onClick={() => void h.refresh()}>
              {t(`${K}.page.retry`)}
            </Button>
          </CardContent>
        </Card>
      ) : empty ? (
        <Card className={CARD}>
          <CardContent className={cn(PAD, "flex flex-col items-start gap-3 py-4")}>
            <Badge variant="info">
              <ActivityIcon className="size-3" aria-hidden />
              {t(`${K}.empty.title`)}
            </Badge>
            <p className="text-on-surface-variant text-sm text-pretty">{t(`${K}.empty.description`)}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-5 *:min-w-0 @5xl/main:grid-cols-2">
          <Card className={CARD}>
            <CardHeader className={PAD}>
              <CardTitle className="text-lg leading-tight">{t(`${K}.signal.title`)}</CardTitle>
              <CardDescription className="text-on-surface-variant text-sm">{t(`${K}.signal.description`)}</CardDescription>
            </CardHeader>
            <CardContent className={cn(PAD, "flex flex-col gap-6")}>
              {data ? (
                <>
                  <MetricChart
                    data={data}
                    range={range}
                    unit="dBm"
                    ariaLabel={t(`${K}.signal.rsrp_aria`)}
                    series={[
                      { key: "lrsrp", label: "LTE RSRP", color: "var(--chart-lte)" },
                      { key: "nrsrp", label: "5G RSRP", color: "var(--chart-nr)" },
                    ]}
                  />
                  <MetricChart
                    data={data}
                    range={range}
                    unit="dB"
                    ariaLabel={t(`${K}.signal.sinr_aria`)}
                    series={[
                      { key: "lsinr", label: "LTE SINR", color: "var(--chart-lte)" },
                      { key: "nsinr", label: "5G SINR", color: "var(--chart-nr)" },
                    ]}
                  />
                </>
              ) : (
                <>
                  <ChartSkeleton />
                  <ChartSkeleton />
                </>
              )}
            </CardContent>
          </Card>

          <Card className={CARD}>
            <CardHeader className={PAD}>
              <CardTitle className="text-lg leading-tight">{t(`${K}.traffic.title`)}</CardTitle>
              <CardDescription className="text-on-surface-variant text-sm">{t(`${K}.traffic.description`)}</CardDescription>
            </CardHeader>
            <CardContent className={cn(PAD, "flex flex-col gap-6")}>
              {data && totals ? (
                <>
                  <div className="flex flex-wrap gap-x-8 gap-y-2">
                    <div className="flex flex-col">
                      <span className="text-on-surface-variant text-[0.6875rem] font-semibold tracking-[0.09em] uppercase">
                        {t(`${K}.traffic.downloaded`)}
                      </span>
                      <span className="text-2xl font-bold tabular-nums">{fmtBytes(totals.rx)}</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-on-surface-variant text-[0.6875rem] font-semibold tracking-[0.09em] uppercase">
                        {t(`${K}.traffic.uploaded`)}
                      </span>
                      <span className="text-2xl font-bold tabular-nums">{fmtBytes(totals.tx)}</span>
                    </div>
                  </div>
                  <MetricChart
                    data={data}
                    range={range}
                    unit="Mbps"
                    ariaLabel={t(`${K}.traffic.aria`)}
                    series={[
                      { key: "dl_mbps", label: t(`${K}.traffic.download`), color: "var(--downlink)" },
                      { key: "ul_mbps", label: t(`${K}.traffic.upload`), color: "var(--uplink)" },
                    ]}
                  />
                  <MetricChart
                    data={data}
                    range={range}
                    unit="°C"
                    ariaLabel={t(`${K}.traffic.temp_aria`)}
                    series={[
                      { key: "temp", label: t(`${K}.traffic.temp_avg`), color: "var(--on-surface-variant)" },
                      { key: "temp_max", label: t(`${K}.traffic.temp_max`), color: "var(--warning)" },
                    ]}
                  />
                </>
              ) : (
                <>
                  <Skeleton className="h-12 w-48 rounded-inline" />
                  <ChartSkeleton />
                  <ChartSkeleton />
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {!empty && !(h.error && !data) ? <AdvisorCard data={data} locale={i18n.language} /> : null}

      {data ? (
        <p className="text-on-surface-variant flex items-center gap-1.5 px-1 text-xs">
          {t(`${K}.storage`, { days: data.days_stored, size: fmtBytes(data.bytes_stored) })}
          <HintIcon label={t(`${K}.storage_hint_label`)}>{t(`${K}.storage_hint`)}</HintIcon>
          <Link href="/monitoring/usage" className="text-primary-on-surface ml-1 font-medium underline-offset-4 hover:underline">
            {t(`${K}.storage_link`)}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
