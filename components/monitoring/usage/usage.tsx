"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CheckIcon,
  MinusCircleIcon,
  ThermometerIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CardFoot } from "@/components/ui/card-foot";
import { Input } from "@/components/ui/input";
import { MetricBar } from "@/components/ui/metric-bar";
import { SaveButton } from "@/components/ui/save-button";
import { SegmentedField, SEGMENTED } from "@/components/ui/segmented-field";
import { Skeleton } from "@/components/ui/skeleton";
import { useInsights, type InsightsConfig, type InsightsSave, type InsightsState } from "@/hooks/use-insights";
import { cn } from "@/lib/utils";

const K = "usage";
const CARD = "@container/card gap-5 rounded-card border-0 bg-surface py-6 shadow-sm";
const PAD = "px-7";
const ROW = "flex items-center justify-between gap-4 rounded-pill bg-surface-container px-4 py-[0.6875rem]";
const ROW_WRAP = "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-card bg-surface-container px-4 py-2";
const ROW_LABEL = "shrink-0 text-[0.8125rem] font-semibold leading-5 text-on-surface-variant";
const ROW_VALUE = "min-w-0 truncate text-right text-[0.8125rem] font-semibold leading-5 tabular-nums";
const INPUT = "bg-surface h-9 w-24 text-right text-sm tabular-nums aria-invalid:ring-[3px] aria-invalid:ring-destructive/50";

const WARN_OPTIONS = ["80", "90"] as const;
const DAYS_OPTIONS = ["7", "30", "90"] as const;

const glyph = (className: string) => <CheckIcon size={SEGMENTED.GLYPH} className={className} aria-hidden="true" />;

function Row({ label, value, children, wrap }: { label: string; value?: string; children?: React.ReactNode; wrap?: boolean }) {
  return (
    <div className={wrap ? ROW_WRAP : ROW}>
      <span className={ROW_LABEL}>{label}</span>
      {children ?? <span className={ROW_VALUE}>{value || "—"}</span>}
    </div>
  );
}

function OnOff({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  const { t } = useTranslation("common");
  return (
    <SegmentedField
      value={value ? "on" : "off"}
      onValueChange={(v) => onChange(v === "on")}
      options={[
        { value: "on", label: t("state.on") },
        { value: "off", label: t("state.off") },
      ]}
      ariaLabel={label}
      breakpoint="never"
      glyph={glyph}
    />
  );
}

function fmtGb(bytes: number) {
  const gb = bytes / 1073741824;
  return gb < 10 ? gb.toFixed(2) : gb.toFixed(1);
}

function fmtDate(epoch: number, locale: string) {
  return new Date(epoch * 1000).toLocaleDateString(locale, { dateStyle: "medium" });
}

/** Re-seed a draft when the saved value it was copied from changes (render-phase, not an effect). */
function useDraft<T>(saved: T) {
  const sig = JSON.stringify(saved);
  const [draft, setDraft] = useState<T>(saved);
  const [prev, setPrev] = useState(sig);
  if (sig !== prev) {
    setPrev(sig);
    setDraft(saved);
  }
  return [draft, setDraft, JSON.stringify(draft) !== sig] as const;
}

type Save = (body: InsightsSave) => ReturnType<ReturnType<typeof useInsights>["save"]>;

function errorKey(code: string | null) {
  switch (code) {
    case "invalid_limit":
    case "invalid_billing_day":
    case "invalid_used":
    case "invalid_temperature":
      return `${K}.errors.${code}`;
    default:
      return `${K}.errors.save_failed`;
  }
}

function DataPlanCard({ state, save, isSaving }: { state: InsightsState; save: Save; isSaving: boolean }) {
  const { t, i18n } = useTranslation("common");
  const saved = state.config.data_limit;
  const [d, setD, dirtyCfg] = useDraft({
    enabled: saved.enabled,
    limit: saved.limit_gb ? String(saved.limit_gb) : "",
    day: String(saved.billing_day),
    warn: String(saved.warn_pct),
  });
  const [used, setUsed] = useState("");
  const dirty = dirtyCfg || used.trim() !== "";
  const st = state.status?.data_limit;

  const limitOk = /^\d{1,6}$/.test(d.limit) && (!d.enabled || Number(d.limit) > 0);
  const dayOk = /^\d{1,2}$/.test(d.day) && Number(d.day) >= 1 && Number(d.day) <= 28;
  const usedOk = used.trim() === "" || /^\d{1,6}([.,]\d{1,2})?$/.test(used.trim());
  const valid = (limitOk || (!d.enabled && d.limit === "")) && dayOk && usedOk;

  const onSave = async () => {
    const r = await save({
      ...state.config,
      data_limit: {
        enabled: d.enabled,
        limit_gb: d.limit === "" ? 0 : Number(d.limit),
        billing_day: Number(d.day),
        warn_pct: Number(d.warn),
        ...(used.trim() !== "" ? { used_gb: used.trim().replace(",", ".") } : {}),
      },
    });
    if (r.ok) {
      setUsed("");
      toast.success(t(`${K}.toast.plan_saved`));
    } else toast.error(t(errorKey(r.code)));
  };

  const pct = st?.percent ?? null;
  const active = saved.enabled && st?.enabled && st.used_bytes !== null && st.limit_bytes;

  return (
    <Card className={CARD}>
      <CardHeader className={PAD}>
        <CardTitle className="text-lg leading-tight">{t(`${K}.plan.title`)}</CardTitle>
        <CardDescription className="text-on-surface-variant text-sm">{t(`${K}.plan.description`)}</CardDescription>
      </CardHeader>
      <CardContent className={cn(PAD, "flex flex-col gap-[0.3125rem]")}>
        {active ? (
          <div className="mb-3 flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-2xl font-bold tabular-nums">
                {fmtGb(st.used_bytes!)}
                <small className="text-on-surface-variant ml-1 text-sm font-semibold">
                  / {saved.limit_gb} GB
                </small>
              </span>
              {pct !== null && pct >= 100 ? (
                <Badge variant="destructive">
                  <AlertCircleIcon className="size-3" aria-hidden />
                  {t(`${K}.plan.used_up`)}
                </Badge>
              ) : pct !== null && pct >= saved.warn_pct ? (
                <Badge variant="warning">
                  <TriangleAlertIcon className="size-3" aria-hidden />
                  {t(`${K}.plan.percent`, { pct })}
                </Badge>
              ) : (
                <span className="text-on-surface-variant text-sm font-semibold tabular-nums">
                  {t(`${K}.plan.percent`, { pct: pct ?? 0 })}
                </span>
              )}
            </div>
            <MetricBar value={Math.min(pct ?? 0, 100)} max={100} warnAt={saved.warn_pct} dangerAt={100} />
            {st.cycle_next ? (
              <span className="text-on-surface-variant text-xs tabular-nums">
                {t(`${K}.plan.resets`, { date: fmtDate(st.cycle_next, i18n.language), days: st.days_left ?? 0 })}
              </span>
            ) : null}
          </div>
        ) : null}

        <Row label={t(`${K}.plan.enabled`)} wrap>
          <OnOff value={d.enabled} onChange={(v) => setD({ ...d, enabled: v })} label={t(`${K}.plan.enabled`)} />
        </Row>
        <Row label={t(`${K}.plan.size`)} wrap>
          <span className="flex items-center gap-2">
            <Input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              placeholder="50"
              value={d.limit}
              onChange={(e) => setD({ ...d, limit: e.target.value.trim() })}
              aria-label={t(`${K}.plan.size`)}
              aria-invalid={d.enabled && !limitOk}
              className={INPUT}
            />
            <span className="text-on-surface-variant text-sm">GB</span>
          </span>
        </Row>
        <Row label={t(`${K}.plan.billing_day`)} wrap>
          <Input
            type="text"
            inputMode="numeric"
            autoComplete="off"
            placeholder="1"
            value={d.day}
            onChange={(e) => setD({ ...d, day: e.target.value.trim() })}
            aria-label={t(`${K}.plan.billing_day`)}
            aria-invalid={!dayOk}
            className={INPUT}
          />
        </Row>
        <Row label={t(`${K}.plan.warn_at`)} wrap>
          <SegmentedField
            value={d.warn}
            onValueChange={(v) => setD({ ...d, warn: v })}
            options={WARN_OPTIONS.map((w) => ({ value: w, label: `${w} %`, numeric: true }))}
            ariaLabel={t(`${K}.plan.warn_at`)}
            breakpoint="never"
            glyph={glyph}
          />
        </Row>
        <Row label={t(`${K}.plan.used_so_far`)} wrap>
          <span className="flex items-center gap-2">
            <Input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder={st?.used_bytes != null && saved.enabled ? fmtGb(st.used_bytes) : "0"}
              value={used}
              onChange={(e) => setUsed(e.target.value)}
              aria-label={t(`${K}.plan.used_so_far`)}
              aria-invalid={!usedOk}
              className={INPUT}
            />
            <span className="text-on-surface-variant text-sm">GB</span>
          </span>
        </Row>
        <p className="text-on-surface-variant pt-2 text-sm text-pretty">
          {t(`${K}.plan.used_hint`)}{" "}
          <Link href="/monitoring/alerts" className="text-primary-on-surface font-medium underline-offset-4 hover:underline">
            {t(`${K}.alerts_link`)}
          </Link>
        </p>
      </CardContent>
      <CardFoot
        className={PAD}
        status={dirty ? <span className="text-on-surface font-medium">{t(`${K}.unsaved`)}</span> : null}
        actions={
          <>
            {dirty ? (
              <Button
                type="button"
                variant="ghost"
                size="action"
                onClick={() => {
                  setD({
                    enabled: saved.enabled,
                    limit: saved.limit_gb ? String(saved.limit_gb) : "",
                    day: String(saved.billing_day),
                    warn: String(saved.warn_pct),
                  });
                  setUsed("");
                }}
              >
                {t(`${K}.discard`)}
              </Button>
            ) : null}
            <SaveButton
              type="button"
              size="action"
              label={t(`${K}.save`)}
              isSaving={isSaving}
              saved={false}
              disabled={!dirty || !valid || isSaving}
              onClick={() => void onSave()}
            />
          </>
        }
      />
    </Card>
  );
}

function TemperatureCard({ state, save, isSaving }: { state: InsightsState; save: Save; isSaving: boolean }) {
  const { t } = useTranslation("common");
  const saved = state.config.temperature;
  const [d, setD, dirty] = useDraft({ enabled: saved.enabled, alert: String(saved.alert_c) });
  const st = state.status?.temperature;
  const alertOk = /^\d{2,3}$/.test(d.alert) && Number(d.alert) >= 50 && Number(d.alert) <= 100;

  const onSave = async () => {
    const r = await save({ ...state.config, temperature: { enabled: d.enabled, alert_c: Number(d.alert) } });
    if (r.ok) toast.success(t(`${K}.toast.temp_saved`));
    else toast.error(t(errorKey(r.code)));
  };

  return (
    <Card className={CARD}>
      <CardHeader className={PAD}>
        <CardTitle className="text-lg leading-tight">{t(`${K}.temp.title`)}</CardTitle>
        <CardDescription className="text-on-surface-variant text-sm">{t(`${K}.temp.description`)}</CardDescription>
      </CardHeader>
      <CardContent className={cn(PAD, "flex flex-col gap-[0.3125rem]")}>
        <Row label={t(`${K}.temp.current`)}>
          {st?.current == null ? (
            <span className={ROW_VALUE}>—</span>
          ) : st.alerting ? (
            <Badge variant="warning">
              <ThermometerIcon className="size-3" aria-hidden />
              {st.current} °C
            </Badge>
          ) : (
            <span className={ROW_VALUE}>{st.current} °C</span>
          )}
        </Row>
        <Row label={t(`${K}.temp.enabled`)} wrap>
          <OnOff value={d.enabled} onChange={(v) => setD({ ...d, enabled: v })} label={t(`${K}.temp.enabled`)} />
        </Row>
        <Row label={t(`${K}.temp.alert_at`)} wrap>
          <span className="flex items-center gap-2">
            <Input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              placeholder="75"
              value={d.alert}
              onChange={(e) => setD({ ...d, alert: e.target.value.trim() })}
              aria-label={t(`${K}.temp.alert_at`)}
              aria-invalid={!alertOk}
              className={INPUT}
            />
            <span className="text-on-surface-variant text-sm">°C</span>
          </span>
        </Row>
        <p className="text-on-surface-variant pt-2 text-sm text-pretty">{t(`${K}.temp.hint`)}</p>
      </CardContent>
      <CardFoot
        className={PAD}
        status={dirty ? <span className="text-on-surface font-medium">{t(`${K}.unsaved`)}</span> : null}
        actions={
          <SaveButton
            type="button"
            size="action"
            label={t(`${K}.save`)}
            isSaving={isSaving}
            saved={false}
            disabled={!dirty || !alertOk || isSaving}
            onClick={() => void onSave()}
          />
        }
      />
    </Card>
  );
}

function HistoryCard({ state, save, isSaving }: { state: InsightsState; save: Save; isSaving: boolean }) {
  const { t } = useTranslation("common");
  const saved = state.config.history;
  const [d, setD, dirty] = useDraft({ enabled: saved.enabled, days: String(saved.days) });
  const options = DAYS_OPTIONS.includes(d.days as (typeof DAYS_OPTIONS)[number])
    ? [...DAYS_OPTIONS]
    : [...DAYS_OPTIONS, d.days].sort((a, b) => Number(a) - Number(b));

  const onSave = async () => {
    const cfg: InsightsConfig = state.config;
    const r = await save({ ...cfg, history: { enabled: d.enabled, days: Number(d.days) } });
    if (r.ok) toast.success(t(`${K}.toast.history_saved`));
    else toast.error(t(errorKey(r.code)));
  };

  return (
    <Card className={CARD}>
      <CardHeader className={PAD}>
        <CardTitle className="text-lg leading-tight">{t(`${K}.history.title`)}</CardTitle>
        <CardDescription className="text-on-surface-variant text-sm">{t(`${K}.history.description`)}</CardDescription>
      </CardHeader>
      <CardContent className={cn(PAD, "flex flex-col gap-[0.3125rem]")}>
        <Row label={t(`${K}.history.enabled`)} wrap>
          <OnOff value={d.enabled} onChange={(v) => setD({ ...d, enabled: v })} label={t(`${K}.history.enabled`)} />
        </Row>
        <Row label={t(`${K}.history.keep`)} wrap>
          <SegmentedField
            value={d.days}
            onValueChange={(v) => setD({ ...d, days: v })}
            options={options.map((x) => ({ value: x, label: x, numeric: true }))}
            ariaLabel={t(`${K}.history.keep`)}
            breakpoint="never"
            glyph={glyph}
          />
        </Row>
        <p className="text-on-surface-variant pt-2 text-sm text-pretty">
          {t(`${K}.history.hint`)}{" "}
          <Link href="/monitoring/signal-history" className="text-primary-on-surface font-medium underline-offset-4 hover:underline">
            {t(`${K}.history.open`)}
          </Link>
        </p>
      </CardContent>
      <CardFoot
        className={PAD}
        status={
          saved.enabled ? (
            <Badge variant="success">
              <CheckCircle2Icon className="size-3" aria-hidden />
              {t(`${K}.history.recording`)}
            </Badge>
          ) : (
            <Badge variant="muted">
              <MinusCircleIcon className="size-3" aria-hidden />
              {t(`${K}.history.off`)}
            </Badge>
          )
        }
        actions={
          <SaveButton
            type="button"
            size="action"
            label={t(`${K}.save`)}
            isSaving={isSaving}
            saved={false}
            disabled={!dirty || isSaving}
            onClick={() => void onSave()}
          />
        }
      />
    </Card>
  );
}

export default function UsageComponent() {
  const { t } = useTranslation("common");
  const ins = useInsights();

  const header = (
    <div className="flex max-w-[41rem] flex-col gap-1.5">
      <h1 className="text-3xl font-bold tracking-[-0.02em]">{t(`${K}.page.title`)}</h1>
      <p className="text-on-surface-variant text-sm leading-relaxed text-pretty">{t(`${K}.page.description`)}</p>
    </div>
  );

  if (ins.isLoading && !ins.state) {
    return (
      <div className="@container/main flex flex-col gap-5 p-2" aria-busy="true">
        {header}
        <div className="grid grid-cols-1 gap-5 @3xl/main:grid-cols-2">
          <Skeleton className="h-96 rounded-card" />
          <Skeleton className="h-72 rounded-card" />
        </div>
      </div>
    );
  }
  if (!ins.state) {
    return (
      <div className="@container/main flex flex-col gap-5 p-2">
        {header}
        <Card className={CARD}>
          <CardContent className={cn(PAD, "flex flex-col items-start gap-3")}>
            <Badge variant="destructive">
              <AlertCircleIcon className="size-3" aria-hidden />
              {t(`${K}.errors.load_failed`)}
            </Badge>
            <Button type="button" variant="tonal-neutral" size="action" onClick={() => void ins.refresh()}>
              {t(`${K}.retry`)}
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
        <DataPlanCard state={ins.state} save={ins.save} isSaving={ins.isSaving} />
        <div className="flex flex-col gap-5">
          <TemperatureCard state={ins.state} save={ins.save} isSaving={ins.isSaving} />
          <HistoryCard state={ins.state} save={ins.save} isSaving={ins.isSaving} />
        </div>
      </div>
    </div>
  );
}
