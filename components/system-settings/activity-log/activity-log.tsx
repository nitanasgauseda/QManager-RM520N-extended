"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AlertCircleIcon,
  CheckIcon,
  LogInIcon,
  LogOutIcon,
  PencilIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  Trash2Icon,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CardFoot } from "@/components/ui/card-foot";
import { SegmentedField, SEGMENTED } from "@/components/ui/segmented-field";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuditLog, type AuditEntry } from "@/hooks/use-security-check";
import { cn } from "@/lib/utils";

const K = "activityLog";
const CARD = "@container/card gap-5 rounded-card border-0 bg-surface py-6 shadow-sm";
const PAD = "px-7";
const AREAS = ["cellular", "network", "monitoring", "system", "at_cmd", "auth", "profiles", "scenarios", "bands", "tower", "frequency", "settings", "vpn"];
type Filter = "all" | "logins" | "changes";

const glyph = (className: string) => <CheckIcon size={SEGMENTED.GLYPH} className={className} aria-hidden="true" />;

/** "cellular/tower_map.sh" -> area key + a readable page name. */
function describe(what: string) {
  const [area, file = ""] = what.split("/");
  const name = file.replace(/\.sh$/, "").replace(/_/g, " ");
  return { area: AREAS.includes(area) ? area : "other", name: name.charAt(0).toUpperCase() + name.slice(1) };
}

function EntryIcon({ e }: { e: AuditEntry }) {
  const cls = "mt-0.5 size-4 flex-none";
  if (e.kind === "login" && e.what !== "ok") return <ShieldAlertIcon className={cn(cls, "text-warning")} aria-hidden />;
  if (e.kind === "login") return <LogInIcon className={cn(cls, "text-on-surface-variant")} aria-hidden />;
  if (e.kind === "logout") return <LogOutIcon className={cn(cls, "text-on-surface-variant")} aria-hidden />;
  return <PencilIcon className={cn(cls, "text-on-surface-variant")} aria-hidden />;
}

export default function ActivityLogComponent() {
  const { t, i18n } = useTranslation("common");
  const log = useAuditLog();
  const [filter, setFilter] = useState<Filter>("all");
  const [confirm, setConfirm] = useState(false);

  const rows = useMemo(
    () =>
      (log.entries ?? []).filter((e) =>
        filter === "all" ? true : filter === "logins" ? e.kind === "login" || e.kind === "logout" : e.kind === "change",
      ),
    [log.entries, filter],
  );
  const failed = (log.entries ?? []).filter((e) => e.kind === "login" && e.what !== "ok").length;

  const fmt = (ts: number) => new Date(ts * 1000).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" });

  const title = (e: AuditEntry) => {
    if (e.kind === "login") return t(`${K}.login.${e.what === "ok" || e.what === "failed" || e.what === "locked" ? e.what : "ok"}`);
    if (e.kind === "logout") return t(`${K}.logout`);
    const d = describe(e.what);
    // Prefer the page name from the sidebar when the script is named after it (custom_dns, cell_guard, ...).
    const base = e.what.split("/").pop()?.replace(/\.sh$/, "") ?? "";
    const alias: Record<string, string> = { insights: "usage", security: "security_check", audit: "activity_log" };
    const navKey = `items.${alias[base] ?? base}`;
    const name = i18n.exists(navKey, { ns: "sidebar" }) ? t(navKey, { ns: "sidebar" }) : d.name;
    return `${t(`${K}.area.${d.area}`)} · ${name}`;
  };

  const onClear = async () => {
    setConfirm(false);
    if (await log.clear()) toast.success(t(`${K}.toast.cleared`));
    else toast.error(t(`${K}.errors.clear_failed`));
  };

  return (
    <div className="@container/main flex flex-col gap-5 p-2">
      <div className="flex flex-col gap-5 @3xl/main:flex-row @3xl/main:items-end">
        <div className="flex max-w-[41rem] flex-col gap-1.5">
          <h1 className="text-3xl font-bold tracking-[-0.02em]">{t(`${K}.page.title`)}</h1>
          <p className="text-on-surface-variant text-sm leading-relaxed text-pretty">{t(`${K}.page.description`)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5 @3xl/main:ml-auto">
          <SegmentedField
            value={filter}
            onValueChange={(v) => setFilter(v as Filter)}
            options={[
              { value: "all", label: t(`${K}.filter.all`) },
              { value: "logins", label: t(`${K}.filter.logins`) },
              { value: "changes", label: t(`${K}.filter.changes`) },
            ]}
            ariaLabel={t(`${K}.filter.label`)}
            breakpoint="never"
            glyph={glyph}
          />
          <Button type="button" variant="outline" size="action" onClick={() => void log.refresh()}>
            <RefreshCwIcon className="size-4" aria-hidden />
            {t(`${K}.page.refresh`)}
          </Button>
        </div>
      </div>

      <Card className={CARD}>
        <CardHeader className={PAD}>
          <CardTitle className="text-lg leading-tight">{t(`${K}.card.title`)}</CardTitle>
          <CardDescription className="text-on-surface-variant text-sm">{t(`${K}.card.description`, { max: log.max })}</CardDescription>
        </CardHeader>
        <CardContent className={cn(PAD, "flex max-h-[40rem] flex-col gap-[0.3125rem] overflow-y-auto")}>
          {log.entries === null && !log.error ? (
            <>
              <Skeleton className="h-14 rounded-card" />
              <Skeleton className="h-14 rounded-card" />
              <Skeleton className="h-14 rounded-card" />
            </>
          ) : log.entries === null ? (
            <div className="flex flex-col items-start gap-3 py-2">
              <Badge variant="destructive">
                <AlertCircleIcon className="size-3" aria-hidden />
                {t(`${K}.errors.load_failed`)}
              </Badge>
              <Button type="button" variant="tonal-neutral" size="action" onClick={() => void log.refresh()}>
                {t(`${K}.page.retry`)}
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <p className="text-on-surface-variant py-4 text-sm">{t(`${K}.empty`)}</p>
          ) : (
            rows.map((e, i) => (
              <div key={`${e.t}-${i}`} className="bg-surface-container flex items-start gap-3 rounded-card px-4 py-3">
                <EntryIcon e={e} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-medium break-words">
                    {title(e)}
                    {e.kind === "change" && e.detail ? (
                      <span className="text-on-surface-variant font-mono text-xs"> · {e.detail}</span>
                    ) : null}
                  </span>
                  <span className="text-on-surface-variant text-xs tabular-nums">
                    {fmt(e.t)}
                    {e.ip ? (
                      <>
                        {" · "}
                        <span className="font-mono">{e.ip}</span>
                      </>
                    ) : null}
                  </span>
                </div>
              </div>
            ))
          )}
        </CardContent>
        <CardFoot
          className={PAD}
          status={
            failed > 0 ? (
              <Badge variant="warning">
                <ShieldAlertIcon className="size-3" aria-hidden />
                {t(`${K}.failed_count`, { n: failed })}
              </Badge>
            ) : (
              <span className="text-on-surface-variant text-pretty">
                {t(`${K}.alert_hint`)}{" "}
                <Link href="/monitoring/alerts" className="text-primary-on-surface font-medium underline-offset-4 hover:underline">
                  {t(`${K}.alert_link`)}
                </Link>
              </span>
            )
          }
          actions={
            <Button
              type="button"
              variant="ghost"
              size="action"
              disabled={log.busy || !log.entries?.length}
              onClick={() => setConfirm(true)}
            >
              <Trash2Icon className="size-4" aria-hidden />
              {t(`${K}.clear`)}
            </Button>
          }
        />
      </Card>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(`${K}.confirm.title`)}</AlertDialogTitle>
            <AlertDialogDescription>{t(`${K}.confirm.description`)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(`${K}.confirm.cancel`)}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onClear()}>{t(`${K}.clear`)}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
