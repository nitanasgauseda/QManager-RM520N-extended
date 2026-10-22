"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CheckIcon,
  DownloadIcon,
  InfoIcon,
  Loader2Icon,
  MinusCircleIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CardFoot } from "@/components/ui/card-foot";
import { SaveButton } from "@/components/ui/save-button";
import { SegmentedField, SEGMENTED } from "@/components/ui/segmented-field";
import { Skeleton } from "@/components/ui/skeleton";
import { useCellGuard, type CellGuardState } from "@/hooks/use-cell-guard";
import { cn } from "@/lib/utils";

const K = "cellGuard";
const CARD = "@container/card gap-5 rounded-card border-0 bg-surface py-6 shadow-sm";
const PAD = "px-7";
const ROW = "flex items-center justify-between gap-4 rounded-pill bg-surface-container px-4 py-[0.6875rem]";
const ROW_WRAP = "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-card bg-surface-container px-4 py-2";
const ROW_LABEL = "shrink-0 text-[0.8125rem] font-semibold leading-5 text-on-surface-variant";
const ROW_VALUE = "min-w-0 truncate text-right text-[0.8125rem] font-semibold leading-5 tabular-nums";
const LEARN_OPTIONS = ["0", "24", "72"] as const;

const glyph = (className: string) => (
  <CheckIcon size={SEGMENTED.GLYPH} className={className} aria-hidden="true" />
);

function Row({ label, value, children, wrap }: { label: string; value?: string; children?: React.ReactNode; wrap?: boolean }) {
  return (
    <div className={wrap ? ROW_WRAP : ROW}>
      <span className={ROW_LABEL}>{label}</span>
      {children ?? <span className={ROW_VALUE}>{value || "—"}</span>}
    </div>
  );
}

function fmtTime(epochSec: number, locale: string) {
  return new Date(epochSec * 1000).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" });
}

export default function CellGuardComponent() {
  const { t, i18n } = useTranslation("common");
  const cg = useCellGuard();

  const header = (
    <div className="flex flex-col gap-5 @3xl/main:flex-row @3xl/main:items-end">
      <div className="flex max-w-[41rem] flex-col gap-1.5">
        <h1 className="text-3xl font-bold tracking-[-0.02em]">{t(`${K}.page.title`)}</h1>
        <p className="text-on-surface-variant text-sm leading-relaxed text-pretty">{t(`${K}.page.description`)}</p>
      </div>
      <div className="@3xl/main:ml-auto">
        <Button type="button" variant="outline" size="action" onClick={() => void cg.refresh()}>
          <RefreshCwIcon className="size-4" aria-hidden />
          {t(`${K}.page.refresh`)}
        </Button>
      </div>
    </div>
  );

  if (cg.isLoading && !cg.state) {
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
  if (!cg.state) {
    return (
      <div className="@container/main flex flex-col gap-5 p-2">
        {header}
        <Card className={CARD}>
          <CardContent className={cn(PAD, "flex flex-col items-start gap-3")}>
            <Badge variant="destructive">
              <AlertCircleIcon className="size-3" aria-hidden />
              {t(`${K}.errors.load_failed`)}
            </Badge>
            <Button type="button" variant="tonal-neutral" size="action" onClick={() => void cg.refresh()}>
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
      <div className="grid grid-cols-1 gap-5 *:min-w-0 @3xl/main:grid-cols-2">
        <DetectionCard state={cg.state} act={cg.act} busy={cg.busy} locale={i18n.language} />
        <FindingsCard state={cg.state} locale={i18n.language} />
      </div>
      <RayhunterCard state={cg.state} act={cg.act} busy={cg.busy} />
    </div>
  );
}

type Act = ReturnType<typeof useCellGuard>["act"];

function DetectionCard({ state, act, busy, locale }: { state: CellGuardState; act: Act; busy: string | null; locale: string }) {
  const { t } = useTranslation("common");
  const [enabled, setEnabled] = useState(state.config.enabled);
  const [learn, setLearn] = useState(String(state.config.learn_hours));
  // Re-seed when the saved values move (render-phase, not an effect).
  const sig = `${state.config.enabled}|${state.config.learn_hours}`;
  const [prevSig, setPrevSig] = useState(sig);
  if (sig !== prevSig) {
    setPrevSig(sig);
    setEnabled(state.config.enabled);
    setLearn(String(state.config.learn_hours));
  }
  const dirty = enabled !== state.config.enabled || learn !== String(state.config.learn_hours);
  const s = state.status;
  const learningUntil = s?.since ? s.since + state.config.learn_hours * 3600 : null;

  const save = async () => {
    const r = await act("save", { enabled, learn_hours: learn });
    if (r.ok) toast.success(t(`${K}.toast.saved`));
    else toast.error(t(`${K}.errors.save_failed`));
  };
  const reset = async () => {
    const r = await act("reset_baseline");
    if (r.ok) toast.success(t(`${K}.toast.baseline_reset`));
    else toast.error(t(`${K}.errors.save_failed`));
  };

  return (
    <Card className={CARD}>
      <CardHeader className={PAD}>
        <CardTitle className="text-lg leading-tight">{t(`${K}.detection.title`)}</CardTitle>
        <CardDescription className="text-on-surface-variant text-sm">{t(`${K}.detection.description`)}</CardDescription>
      </CardHeader>
      <CardContent className={cn(PAD, "flex flex-col gap-[0.3125rem]")}>
        <Row label={t(`${K}.detection.enabled`)} wrap>
          <SegmentedField
            value={enabled ? "on" : "off"}
            onValueChange={(v) => setEnabled(v === "on")}
            options={[
              { value: "on", label: t("state.on") },
              { value: "off", label: t("state.off") },
            ]}
            ariaLabel={t(`${K}.detection.enabled`)}
            breakpoint="never"
            glyph={glyph}
          />
        </Row>
        <Row label={t(`${K}.detection.learn`)} wrap>
          <SegmentedField
            value={learn}
            onValueChange={(v) => setLearn(v)}
            options={LEARN_OPTIONS.map((h) => ({ value: h, label: t(`${K}.detection.learn_${h}`), numeric: true }))}
            ariaLabel={t(`${K}.detection.learn`)}
            breakpoint="never"
            glyph={glyph}
          />
        </Row>
        <Row label={t(`${K}.detection.state`)}>
          {!state.config.enabled ? (
            <Badge variant="muted">
              <MinusCircleIcon className="size-3" aria-hidden />
              {t(`${K}.detection.state_off`)}
            </Badge>
          ) : s?.learning ? (
            <Badge variant="info">
              <Loader2Icon className="size-3" aria-hidden />
              {learningUntil
                ? t(`${K}.detection.state_learning_until`, { time: fmtTime(learningUntil, locale) })
                : t(`${K}.detection.state_learning`)}
            </Badge>
          ) : (
            <Badge variant="success">
              <CheckCircle2Icon className="size-3" aria-hidden />
              {t(`${K}.detection.state_watching`)}
            </Badge>
          )}
        </Row>
        <Row label={t(`${K}.detection.known`)} value={String(s?.known_cells ?? 0)} />
        <p className="text-on-surface-variant pt-2 text-sm text-pretty">
          {t(`${K}.detection.protect_tip`)}{" "}
          <Link href="/cellular/settings" className="text-primary-on-surface font-medium underline-offset-4 hover:underline">
            {t(`${K}.detection.protect_link`)}
          </Link>
        </p>
      </CardContent>
      <CardFoot
        className={PAD}
        status={dirty ? <span className="text-on-surface font-medium">{t(`${K}.detection.unsaved`)}</span> : null}
        actions={
          <>
            <Button type="button" variant="tonal-neutral" size="action" disabled={busy !== null} onClick={() => void reset()}>
              {t(`${K}.detection.reset`)}
            </Button>
            <SaveButton
              type="button"
              size="action"
              label={t(`${K}.detection.save`)}
              isSaving={busy === "save"}
              saved={false}
              disabled={!dirty || busy !== null}
              onClick={() => void save()}
            />
          </>
        }
      />
    </Card>
  );
}

function FindingsCard({ state, locale }: { state: CellGuardState; locale: string }) {
  const { t } = useTranslation("common");
  const rows = state.findings;
  return (
    <Card className={CARD}>
      <CardHeader className={PAD}>
        <CardTitle className="text-lg leading-tight">{t(`${K}.findings.title`)}</CardTitle>
        <CardDescription className="text-on-surface-variant text-sm">{t(`${K}.findings.description`)}</CardDescription>
      </CardHeader>
      <CardContent className={cn(PAD, "flex max-h-[26rem] flex-col gap-[0.3125rem] overflow-y-auto")}>
        {rows.length === 0 ? (
          <div className="flex items-center gap-2 py-6">
            <Badge variant="success">
              <CheckCircle2Icon className="size-3" aria-hidden />
              {t(`${K}.findings.none`)}
            </Badge>
          </div>
        ) : (
          rows.map((f, i) => (
            <div key={`${f.timestamp}-${i}`} className="flex items-start gap-3 rounded-card bg-surface-container px-4 py-3">
              {f.severity === "warning" ? (
                <TriangleAlertIcon className="text-warning mt-0.5 size-4 flex-none" aria-label={t(`${K}.findings.warning`)} />
              ) : (
                <InfoIcon className="text-on-surface-variant mt-0.5 size-4 flex-none" aria-label={t(`${K}.findings.info`)} />
              )}
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium text-pretty break-words">{f.message}</span>
                <span className="text-on-surface-variant text-xs tabular-nums">{fmtTime(f.timestamp, locale)}</span>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function RayhunterCard({ state, act, busy }: { state: CellGuardState; act: Act; busy: string | null }) {
  const { t } = useTranslation("common");
  const rh = state.rayhunter;
  const installing = rh.install.status === "running";
  const run = async (action: string, okKey: string) => {
    const r = await act(action);
    if (r.ok) toast.success(t(`${K}.toast.${okKey}`));
    else toast.error(t(`${K}.rayhunter.errors.${r.code ?? "failed"}`, { defaultValue: t(`${K}.rayhunter.errors.failed`) }));
  };
  const live = rh.live;

  return (
    <Card className={CARD}>
      <CardHeader className={PAD}>
        <CardTitle className="text-lg leading-tight">{t(`${K}.rayhunter.title`)}</CardTitle>
        <CardDescription className="text-on-surface-variant text-sm text-pretty">{t(`${K}.rayhunter.description`)}</CardDescription>
      </CardHeader>
      <CardContent className={cn(PAD, "grid grid-cols-1 gap-5 *:min-w-0 @3xl/card:grid-cols-2")}>
        <div className="flex flex-col gap-[0.3125rem]">
          <Row label={t(`${K}.rayhunter.installed`)}>
            {rh.installed ? (
              <Badge variant="info">
                <CheckCircle2Icon className="size-3" aria-hidden />
                {rh.version || t(`${K}.rayhunter.yes`)}
              </Badge>
            ) : (
              <Badge variant="muted">
                <MinusCircleIcon className="size-3" aria-hidden />
                {t(`${K}.rayhunter.not_installed`)}
              </Badge>
            )}
          </Row>
          <Row label={t(`${K}.rayhunter.diag`)}>
            {rh.diag_present ? (
              <Badge variant="success">
                <CheckCircle2Icon className="size-3" aria-hidden />
                {t(`${K}.rayhunter.diag_yes`)}
              </Badge>
            ) : (
              <Badge variant="warning">
                <TriangleAlertIcon className="size-3" aria-hidden />
                {t(`${K}.rayhunter.diag_no`)}
              </Badge>
            )}
          </Row>
          <Row label={t(`${K}.rayhunter.service`)}>
            {rh.running ? (
              <Badge variant="success">
                <CheckCircle2Icon className="size-3" aria-hidden />
                {t(`${K}.rayhunter.running`)}
              </Badge>
            ) : (
              <Badge variant="muted">
                <MinusCircleIcon className="size-3" aria-hidden />
                {t(`${K}.rayhunter.stopped`)}
              </Badge>
            )}
          </Row>
          {live ? (
            <Row label={t(`${K}.rayhunter.recording`)} value={live.recording ?? t(`${K}.rayhunter.no_recording`)} />
          ) : null}
          {!rh.diag_present ? (
            <p className="text-on-surface-variant pt-2 text-sm text-pretty">{t(`${K}.rayhunter.diag_note`)}</p>
          ) : null}
          {installing || rh.install.status === "error" ? (
            <div className="flex items-center gap-2 pt-2">
              <Badge variant={installing ? "info" : "destructive"}>
                {installing ? (
                  <Loader2Icon className="size-3 motion-safe:animate-spin" aria-hidden />
                ) : (
                  <AlertCircleIcon className="size-3" aria-hidden />
                )}
                {rh.install.message ?? ""}
              </Badge>
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-[0.3125rem]">
          {rh.diag_present || live ? (
            <span className="text-on-surface-variant px-1 text-[0.6875rem] font-semibold tracking-[0.09em] uppercase">
              {t(`${K}.rayhunter.warnings`)}
            </span>
          ) : null}
          {!rh.diag_present && !live ? null : !live || live.warnings.length === 0 ? (
            <p className="text-on-surface-variant px-1 text-sm">
              {rh.running ? t(`${K}.rayhunter.no_warnings`) : t(`${K}.rayhunter.not_running_hint`)}
            </p>
          ) : (
            live.warnings.map((w, i) => (
              <div key={i} className="flex items-start gap-3 rounded-card bg-surface-container px-4 py-3">
                <ShieldAlertIcon
                  className={cn("mt-0.5 size-4 flex-none", w.severity === "High" ? "text-destructive" : "text-warning")}
                  aria-hidden
                />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium break-words">{w.message}</span>
                  <span className="text-on-surface-variant text-xs">
                    {w.severity}
                    {w.at ? ` · ${w.at.replace("T", " ").slice(0, 16)}` : ""}
                  </span>
                </div>
              </div>
            ))
          )}
          {rh.installed && rh.log ? (
            <details className="pt-2">
              <summary className="text-on-surface-variant cursor-pointer text-sm">{t(`${K}.rayhunter.log`)}</summary>
              <pre className="bg-surface-container mt-2 max-h-48 overflow-auto rounded-field p-3 font-mono text-xs whitespace-pre-wrap break-all">
                {rh.log}
              </pre>
            </details>
          ) : null}
        </div>
      </CardContent>
      <CardFoot
        className={PAD}
        status={<span className="text-on-surface-variant text-pretty">{t(`${K}.rayhunter.foot`)}</span>}
        actions={
          !rh.installed ? (
            <Button type="button" size="action" disabled={installing || busy !== null} onClick={() => void run("rayhunter_install", "install_started")}>
              {installing ? <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden /> : <DownloadIcon className="size-4" aria-hidden />}
              {installing ? t(`${K}.rayhunter.installing`) : t(`${K}.rayhunter.install`)}
            </Button>
          ) : (
            <>
              <Button type="button" variant="ghost" size="action" disabled={busy !== null} onClick={() => void run("rayhunter_uninstall", "uninstalled")}>
                <Trash2Icon className="size-4" aria-hidden />
                {t(`${K}.rayhunter.uninstall`)}
              </Button>
              {state.config.rayhunter ? (
                <Button type="button" variant="tonal-neutral" size="action" disabled={busy !== null} onClick={() => void run("rayhunter_disable", "disabled")}>
                  {t(`${K}.rayhunter.disable`)}
                </Button>
              ) : (
                <Button
                  type="button"
                  size="action"
                  disabled={busy !== null || !rh.diag_present}
                  title={!rh.diag_present ? t(`${K}.rayhunter.errors.no_diag`) : undefined}
                  onClick={() => void run("rayhunter_enable", "enabled")}
                >
                  {t(`${K}.rayhunter.enable`)}
                </Button>
              )}
            </>
          )
        }
      />
    </Card>
  );
}
