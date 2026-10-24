"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CheckIcon,
  CopyIcon,
  GlobeIcon,
  InfoIcon,
  Loader2Icon,
  LockIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { HintIcon } from "@/components/ui/hint-icon";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { useSecurityCheck, type SecurityPort, type SecurityReport } from "@/hooks/use-security-check";
import { useWatch } from "@/hooks/use-watch";
import { CardFoot } from "@/components/ui/card-foot";
import { SaveButton } from "@/components/ui/save-button";
import { SegmentedField, SEGMENTED } from "@/components/ui/segmented-field";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

const K = "securityCheck";
const CARD = "@container/card gap-5 rounded-card border-0 bg-surface py-6 shadow-sm";
const PAD = "px-7";
const ITEM = "bg-surface-container flex flex-col gap-2 rounded-card px-4 py-3 @lg/card:flex-row @lg/card:items-center @lg/card:justify-between";
const KNOWN_SERVICES = ["ssh", "telnet", "web", "web_https", "dns", "console", "rayhunter", "bridge_monitor", "adb", "ftp", "dns_privacy", "upnp"];

type Severity = "fail" | "warn" | "ok";

function portSeverity(p: SecurityPort): Severity {
  if (!p.open) return "ok";
  return p.public ? "fail" : "warn";
}

function deviceIssues(r: SecurityReport) {
  return (r.device.adb === "on" ? 1 : 0) + (r.device.cell_guard ? 0 : 1);
}

function SeverityBadge({ s, label }: { s: Severity; label: string }) {
  if (s === "ok")
    return (
      <Badge variant="success">
        <CheckCircle2Icon className="size-3" aria-hidden />
        {label}
      </Badge>
    );
  return (
    <Badge variant={s === "fail" ? "destructive" : "warning"}>
      {s === "fail" ? <ShieldAlertIcon className="size-3" aria-hidden /> : <TriangleAlertIcon className="size-3" aria-hidden />}
      {label}
    </Badge>
  );
}

function PortsCard({ r, api }: { r: SecurityReport; api: ReturnType<typeof useSecurityCheck> }) {
  const { t } = useTranslation("common");
  // One row per port: IPv4 and IPv6 results side by side.
  const groups = new Map<string, SecurityPort[]>();
  for (const p of r.ports) {
    const k = `${p.proto}/${p.port}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const rows = [...groups.values()].sort((a, b) => a[0].port - b[0].port);

  const toggle = async (p: SecurityPort, block: boolean) => {
    const res = await api.setBlocked(p, block);
    const name = t(`${K}.service.${KNOWN_SERVICES.includes(p.service) ? p.service : "other"}`, { port: p.port });
    if (res.ok) toast.success(t(block ? `${K}.toast.blocked` : `${K}.toast.unblocked`, { name }));
    else toast.error(t(`${K}.errors.save_failed`));
  };

  return (
    <Card className={CARD}>
      <CardHeader className={PAD}>
        <CardTitle className="text-lg leading-tight">{t(`${K}.ports.title`)}</CardTitle>
        <CardDescription className="text-on-surface-variant text-sm">{t(`${K}.ports.description`)}</CardDescription>
      </CardHeader>
      <CardContent className={cn(PAD, "flex flex-col gap-[0.3125rem]")}>
        <div className="flex flex-wrap gap-x-6 gap-y-1 px-1 pb-2 text-sm">
          <span>
            <span className="text-on-surface-variant">IPv4 </span>
            <span className="font-mono text-[0.8125rem]">{r.wan.ipv4 || "—"}</span>
            {r.wan.ipv4 ? (
              <span className="text-on-surface-variant">
                {" "}
                · {r.wan.ipv4_public ? t(`${K}.ports.public`) : t(`${K}.ports.cgnat`)}
              </span>
            ) : null}
          </span>
          <span>
            <span className="text-on-surface-variant">IPv6 </span>
            <span className="font-mono text-[0.8125rem] break-all">{r.wan.ipv6 || "—"}</span>
            {r.wan.ipv6 ? <span className="text-on-surface-variant"> · {t(`${K}.ports.public`)}</span> : null}
          </span>
        </div>
        {!r.wan.firewall_readable ? (
          <p className="text-on-surface-variant px-1 text-sm">{t(`${K}.ports.no_firewall`)}</p>
        ) : null}
        {!r.wan.ipv4 && !r.wan.ipv6 ? (
          <p className="text-on-surface-variant px-1 py-2 text-sm">{t(`${K}.ports.offline`)}</p>
        ) : rows.length === 0 ? (
          <div className="py-2">
            <Badge variant="success">
              <CheckCircle2Icon className="size-3" aria-hidden />
              {t(`${K}.ports.none`)}
            </Badge>
          </div>
        ) : (
          rows.map((ps) => {
            const p = ps[0];
            const worst: Severity = ps.some((x) => portSeverity(x) === "fail")
              ? "fail"
              : ps.some((x) => portSeverity(x) === "warn")
                ? "warn"
                : "ok";
            const ours = ps.some((x) => x.blocked_by_qmanager);
            const busy = api.busy === `${p.proto}/${p.port}`;
            return (
              <div key={`${p.proto}/${p.port}`} className={ITEM}>
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-sm font-semibold">
                    {t(`${K}.service.${KNOWN_SERVICES.includes(p.service) ? p.service : "other"}`, { port: p.port })}
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Tag>
                      {p.proto.toUpperCase()} {p.port}
                    </Tag>
                    {ps.map((x) => (
                      <Tag key={x.family}>{`IPv${x.family} ${x.open ? t(`${K}.ports.open`) : t(`${K}.ports.closed`)}`}</Tag>
                    ))}
                    {ps.some((x) => x.uncertain) ? (
                      <HintIcon label={t(`${K}.ports.uncertain_label`)} tone="warning">
                        {t(`${K}.ports.uncertain`)}
                      </HintIcon>
                    ) : null}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2.5">
                  <SeverityBadge
                    s={worst}
                    label={
                      worst === "ok"
                        ? ours
                          ? t(`${K}.ports.closed_by_us`)
                          : t(`${K}.ports.closed`)
                        : worst === "fail"
                          ? t(`${K}.ports.reachable`)
                          : t(`${K}.ports.reachable_carrier`)
                    }
                  />
                  {worst !== "ok" ? (
                    <Button type="button" size="sm" disabled={api.busy !== null} onClick={() => void toggle(p, true)}>
                      {busy ? <Loader2Icon className="size-3.5 motion-safe:animate-spin" aria-hidden /> : <LockIcon className="size-3.5" aria-hidden />}
                      {t(`${K}.ports.block`)}
                    </Button>
                  ) : ours ? (
                    <Button type="button" variant="ghost" size="sm" disabled={api.busy !== null} onClick={() => void toggle(p, false)}>
                      {t(`${K}.ports.unblock`)}
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
        <p className="text-on-surface-variant px-1 pt-2 text-sm text-pretty">{t(`${K}.ports.note`)}</p>
      </CardContent>
    </Card>
  );
}

function DeviceRow({
  ok,
  info,
  title,
  text,
  children,
}: {
  ok: boolean;
  info?: boolean;
  title: string;
  text: string;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation("common");
  return (
    <div className="bg-surface-container flex flex-col gap-2 rounded-card px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold">{title}</span>
        {ok ? (
          <Badge variant="success">
            <CheckCircle2Icon className="size-3" aria-hidden />
            {t(`${K}.device.good`)}
          </Badge>
        ) : info ? (
          <Badge variant="info">
            <InfoIcon className="size-3" aria-hidden />
            {t(`${K}.device.note`)}
          </Badge>
        ) : (
          <Badge variant="warning">
            <TriangleAlertIcon className="size-3" aria-hidden />
            {t(`${K}.device.attention`)}
          </Badge>
        )}
      </div>
      <p className="text-on-surface-variant text-sm text-pretty">{text}</p>
      {children}
    </div>
  );
}

function DeviceCard({ r }: { r: SecurityReport }) {
  const { t } = useTranslation("common");
  const d = r.device;
  const copy = async () => {
    if (await copyText(d.adb_fix)) toast.success(t(`${K}.toast.copied`));
    else toast.error(t(`${K}.errors.copy_failed`));
  };
  const link = "text-primary-on-surface text-sm font-medium underline-offset-4 hover:underline";
  return (
    <Card className={CARD}>
      <CardHeader className={PAD}>
        <CardTitle className="text-lg leading-tight">{t(`${K}.device.title`)}</CardTitle>
        <CardDescription className="text-on-surface-variant text-sm">{t(`${K}.device.description`)}</CardDescription>
      </CardHeader>
      <CardContent className={cn(PAD, "flex flex-col gap-[0.3125rem]")}>
        <DeviceRow
          ok={d.adb !== "on"}
          info={d.adb === "unknown"}
          title={t(`${K}.device.adb_title`)}
          text={d.adb === "on" ? t(`${K}.device.adb_on`) : d.adb === "off" ? t(`${K}.device.adb_off`) : t(`${K}.device.adb_unknown`)}
        >
          {d.adb === "on" && d.adb_fix ? (
            <div className="flex flex-wrap items-center gap-2">
              <code className="bg-surface rounded-field px-2 py-1 font-mono text-xs break-all">{d.adb_fix}</code>
              <Button type="button" variant="ghost" size="sm" onClick={() => void copy()}>
                <CopyIcon className="size-3.5" aria-hidden />
                {t(`${K}.device.copy`)}
              </Button>
              <Link href="/system-settings/at-terminal" className={link}>
                {t(`${K}.device.open_terminal`)}
              </Link>
            </div>
          ) : null}
        </DeviceRow>
        <DeviceRow ok title={t(`${K}.device.login_title`)} text={t(`${K}.device.login_text`)}>
          <Link href="/system-settings/activity-log" className={link}>
            {t(`${K}.device.open_activity`)}
          </Link>
        </DeviceRow>
        <DeviceRow
          ok={d.cell_guard}
          title={t(`${K}.device.cell_guard_title`)}
          text={d.cell_guard ? t(`${K}.device.cell_guard_on`) : t(`${K}.device.cell_guard_off`)}
        >
          {!d.cell_guard ? (
            <Link href="/monitoring/cell-guard" className={link}>
              {t(`${K}.device.open_cell_guard`)}
            </Link>
          ) : null}
        </DeviceRow>
        <DeviceRow
          ok={d.encrypted_dns}
          info={!d.encrypted_dns}
          title={t(`${K}.device.dns_title`)}
          text={d.encrypted_dns ? t(`${K}.device.dns_on`) : t(`${K}.device.dns_off`)}
        >
          {!d.encrypted_dns ? (
            <Link href="/local-network/dns-privacy" className={link}>
              {t(`${K}.device.open_dns`)}
            </Link>
          ) : null}
        </DeviceRow>
        {d.web_console ? (
          <DeviceRow ok={false} info title={t(`${K}.device.console_title`)} text={t(`${K}.device.console_on`)} />
        ) : null}
        {!d.https ? <DeviceRow ok={false} info title={t(`${K}.device.https_title`)} text={t(`${K}.device.https_off`)} /> : null}
      </CardContent>
    </Card>
  );
}

const ROW = "flex items-center justify-between gap-4 rounded-pill bg-surface-container px-4 py-[0.6875rem]";
const ROW_LABEL = "shrink-0 text-[0.8125rem] font-semibold leading-5 text-on-surface-variant";

function PublicIpCard() {
  const { t, i18n } = useTranslation("common");
  const w = useWatch();
  const savedOn = w.state?.config.public_ip.enabled ?? true;
  const [on, setOn] = useState(savedOn);
  const [prev, setPrev] = useState(savedOn);
  if (savedOn !== prev) {
    setPrev(savedOn);
    setOn(savedOn);
  }
  if (!w.state) return null;
  const ip = w.state.public_ip;
  const dirty = on !== savedOn;

  const onSave = async () => {
    const r = await w.save({ ...w.state!.config, public_ip: { enabled: on } });
    if (r.ok) toast.success(t(`${K}.pubip.toast_saved`));
    else toast.error(t(`${K}.pubip.save_failed`));
  };
  const onCheck = async () => {
    const r = await w.checkIp();
    if (r.ok) toast.success(t(`${K}.pubip.toast_checking`));
    else toast.error(t(`${K}.pubip.save_failed`));
  };

  return (
    <Card className={CARD}>
      <CardHeader className={PAD}>
        <CardTitle className="text-lg leading-tight">{t(`${K}.pubip.title`)}</CardTitle>
        <CardDescription className="text-on-surface-variant text-sm">{t(`${K}.pubip.description`)}</CardDescription>
      </CardHeader>
      <CardContent className={cn(PAD, "flex flex-col gap-[0.3125rem]")}>
        <div className={ROW}>
          <span className={ROW_LABEL}>{t(`${K}.pubip.public`)}</span>
          <span className="min-w-0 truncate font-mono text-[0.8125rem] font-semibold">{ip?.public_ipv4 ?? "—"}</span>
        </div>
        <div className={ROW}>
          <span className={ROW_LABEL}>{t(`${K}.pubip.modem`)}</span>
          <span className="min-w-0 truncate font-mono text-[0.8125rem] font-semibold">{ip?.wan_ipv4 || "—"}</span>
        </div>
        {ip?.cgnat === true ? (
          <div className="flex flex-wrap items-center gap-2 px-1 pt-2">
            <Badge variant="info">
              <GlobeIcon className="size-3" aria-hidden />
              {t(`${K}.pubip.cgnat`)}
            </Badge>
            <span className="text-on-surface-variant text-sm text-pretty">{t(`${K}.pubip.cgnat_text`)}</span>
          </div>
        ) : ip?.cgnat === false ? (
          <div className="flex flex-wrap items-center gap-2 px-1 pt-2">
            <Badge variant="warning">
              <TriangleAlertIcon className="size-3" aria-hidden />
              {t(`${K}.pubip.direct`)}
            </Badge>
            <span className="text-on-surface-variant text-sm text-pretty">{t(`${K}.pubip.direct_text`)}</span>
          </div>
        ) : ip?.error ? (
          <p className="text-on-surface-variant px-1 pt-2 text-sm">{t(`${K}.pubip.failed`)}</p>
        ) : null}
        {ip?.checked_at ? (
          <p className="text-on-surface-variant px-1 text-xs tabular-nums">
            {t(`${K}.pubip.checked`, {
              time: new Date(ip.checked_at * 1000).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" }),
            })}
          </p>
        ) : null}
        <div className={cn(ROW, "mt-2")}>
          <span className={ROW_LABEL}>{t(`${K}.pubip.enabled`)}</span>
          <SegmentedField
            value={on ? "on" : "off"}
            onValueChange={(v) => setOn(v === "on")}
            options={[
              { value: "on", label: t("state.on") },
              { value: "off", label: t("state.off") },
            ]}
            ariaLabel={t(`${K}.pubip.enabled`)}
            breakpoint="never"
            glyph={(c: string) => <CheckIcon size={SEGMENTED.GLYPH} className={c} aria-hidden="true" />}
          />
        </div>
        <p className="text-on-surface-variant px-1 pt-1 text-xs text-pretty">{t(`${K}.pubip.hint`)}</p>
      </CardContent>
      <CardFoot
        className={PAD}
        actions={
          <>
            <Button type="button" variant="ghost" size="action" disabled={!savedOn || w.busy !== null} onClick={() => void onCheck()}>
              <RefreshCwIcon className="size-4" aria-hidden />
              {t(`${K}.pubip.check_now`)}
            </Button>
            <SaveButton
              type="button"
              size="action"
              label={t(`${K}.pubip.save`)}
              isSaving={w.busy === "save"}
              saved={false}
              disabled={!dirty || w.busy !== null}
              onClick={() => void onSave()}
            />
          </>
        }
      />
    </Card>
  );
}

function OnOffRow({ label, hint, value, onChange }: { label: string; hint: string; value: boolean; onChange: (v: boolean) => void }) {
  const { t } = useTranslation("common");
  return (
    <div className="flex flex-col gap-1">
      <div className={ROW}>
        <span className={ROW_LABEL}>{label}</span>
        <SegmentedField
          value={value ? "on" : "off"}
          onValueChange={(v) => onChange(v === "on")}
          options={[
            { value: "on", label: t("state.on") },
            { value: "off", label: t("state.off") },
          ]}
          ariaLabel={label}
          breakpoint="never"
          glyph={(c: string) => <CheckIcon size={SEGMENTED.GLYPH} className={c} aria-hidden="true" />}
        />
      </div>
      <p className="text-on-surface-variant px-1 pb-2 text-xs text-pretty">{hint}</p>
    </div>
  );
}

function PrivacyCard({ r, api }: { r: SecurityReport; api: ReturnType<typeof useSecurityCheck> }) {
  const { t } = useTranslation("common");
  const saved = r.privacy ?? { stealth: false, lan_ipv6: true, stealth_active: false, lan_ipv6_off_active: false };
  const key = `${saved.stealth}/${saved.lan_ipv6}`;
  const [draft, setDraft] = useState({ stealth: saved.stealth, lan_ipv6: saved.lan_ipv6 });
  const [prev, setPrev] = useState(key);
  if (key !== prev) {
    setPrev(key);
    setDraft({ stealth: saved.stealth, lan_ipv6: saved.lan_ipv6 });
  }
  const dirty = draft.stealth !== saved.stealth || draft.lan_ipv6 !== saved.lan_ipv6;
  const notApplied = (saved.stealth && !saved.stealth_active) || (!saved.lan_ipv6 && !saved.lan_ipv6_off_active);

  const onSave = async () => {
    const res = await api.setPrivacy(draft);
    if (res.ok) toast.success(t(`${K}.privacy.toast_saved`));
    else toast.error(t(`${K}.errors.save_failed`));
  };

  return (
    <Card className={CARD}>
      <CardHeader className={PAD}>
        <CardTitle className="text-lg leading-tight">{t(`${K}.privacy.title`)}</CardTitle>
        <CardDescription className="text-on-surface-variant text-sm">{t(`${K}.privacy.description`)}</CardDescription>
      </CardHeader>
      <CardContent className={cn(PAD, "flex flex-col gap-[0.3125rem]")}>
        <OnOffRow
          label={t(`${K}.privacy.stealth`)}
          hint={t(`${K}.privacy.stealth_hint`)}
          value={draft.stealth}
          onChange={(v) => setDraft((d) => ({ ...d, stealth: v }))}
        />
        <OnOffRow
          label={t(`${K}.privacy.lan_ipv6`)}
          hint={t(`${K}.privacy.lan_ipv6_hint`)}
          value={draft.lan_ipv6}
          onChange={(v) => setDraft((d) => ({ ...d, lan_ipv6: v }))}
        />
      </CardContent>
      <CardFoot
        className={PAD}
        status={
          notApplied && !dirty ? (
            <Badge variant="warning">
              <TriangleAlertIcon className="size-3" aria-hidden />
              {t(`${K}.privacy.not_applied`)}
            </Badge>
          ) : undefined
        }
        actions={
          <>
            {dirty ? (
              <Button
                type="button"
                variant="ghost"
                size="action"
                disabled={api.busy !== null}
                onClick={() => setDraft({ stealth: saved.stealth, lan_ipv6: saved.lan_ipv6 })}
              >
                {t(`${K}.privacy.discard`)}
              </Button>
            ) : null}
            <SaveButton
              type="button"
              size="action"
              label={t(`${K}.privacy.save`)}
              isSaving={api.busy === "privacy"}
              saved={false}
              disabled={!dirty || api.busy !== null}
              onClick={() => void onSave()}
            />
          </>
        }
      />
    </Card>
  );
}

export default function SecurityCheckComponent() {
  const { t, i18n } = useTranslation("common");
  const api = useSecurityCheck();
  const r = api.report;

  const failing = r ? r.ports.filter((p) => portSeverity(p) === "fail").length : 0;
  const warning = r ? r.ports.filter((p) => portSeverity(p) === "warn").length + deviceIssues(r) : 0;

  return (
    <div className="@container/main flex flex-col gap-5 p-2">
      <div className="flex flex-col gap-5 @3xl/main:flex-row @3xl/main:items-end">
        <div className="flex max-w-[41rem] flex-col gap-1.5">
          <h1 className="text-3xl font-bold tracking-[-0.02em]">{t(`${K}.page.title`)}</h1>
          <p className="text-on-surface-variant text-sm leading-relaxed text-pretty">{t(`${K}.page.description`)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 @3xl/main:ml-auto">
          {r ? (
            <span className="text-on-surface-variant text-xs tabular-nums">
              {t(`${K}.page.checked`, {
                time: new Date(r.checked_at * 1000).toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" }),
              })}
            </span>
          ) : null}
          <Button type="button" variant="outline" size="action" disabled={api.busy !== null} onClick={() => void api.run()}>
            <RefreshCwIcon className="size-4" aria-hidden />
            {t(`${K}.page.run`)}
          </Button>
        </div>
      </div>

      {api.isLoading && !r ? (
        <div className="grid grid-cols-1 gap-5 @3xl/main:grid-cols-2" aria-busy="true">
          <Skeleton className="h-96 rounded-card" />
          <Skeleton className="h-96 rounded-card" />
        </div>
      ) : !r ? (
        <Card className={CARD}>
          <CardContent className={cn(PAD, "flex flex-col items-start gap-3")}>
            <Badge variant="destructive">
              <AlertCircleIcon className="size-3" aria-hidden />
              {t(`${K}.errors.load_failed`)}
            </Badge>
            <Button type="button" variant="tonal-neutral" size="action" onClick={() => void api.run()}>
              {t(`${K}.page.retry`)}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="bg-surface flex flex-wrap items-center gap-3 rounded-card px-5 py-4 shadow-sm">
            {failing > 0 ? (
              <Badge variant="destructive">
                <ShieldAlertIcon className="size-3" aria-hidden />
                {t(`${K}.summary.fail`, { count: failing })}
              </Badge>
            ) : warning > 0 ? (
              <Badge variant="warning">
                <TriangleAlertIcon className="size-3" aria-hidden />
                {t(`${K}.summary.warn`, { count: warning })}
              </Badge>
            ) : (
              <Badge variant="success">
                <ShieldCheckIcon className="size-3" aria-hidden />
                {t(`${K}.summary.ok`)}
              </Badge>
            )}
            <span className="text-sm text-pretty">
              {failing > 0 ? t(`${K}.summary.fail_text`) : warning > 0 ? t(`${K}.summary.warn_text`) : t(`${K}.summary.ok_text`)}
            </span>
          </div>
          <div className="grid grid-cols-1 items-start gap-5 *:min-w-0 @3xl/main:grid-cols-2">
            <div className="flex flex-col gap-5">
              <PortsCard r={r} api={api} />
              <PrivacyCard r={r} api={api} />
            </div>
            <div className="flex flex-col gap-5">
              <DeviceCard r={r} />
              <PublicIpCard />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
