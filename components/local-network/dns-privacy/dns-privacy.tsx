"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CheckIcon,
  Loader2Icon,
  LockIcon,
  MinusCircleIcon,
  RefreshCwIcon,
  ShieldOffIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CardFoot } from "@/components/ui/card-foot";
import { Checkbox } from "@/components/ui/checkbox";
import { HintIcon } from "@/components/ui/hint-icon";
import { Input } from "@/components/ui/input";
import { SaveButton } from "@/components/ui/save-button";
import { SegmentedField, SEGMENTED } from "@/components/ui/segmented-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  BLOCK_LISTS,
  DNS_PROVIDERS,
  MAX_DOMAINS,
  MAX_LISTS,
  useDnsPrivacy,
  type BlockListId,
  type DnsPrivacyState,
  type DnsProvider,
} from "@/hooks/use-dns-privacy";
import { cn } from "@/lib/utils";

const K = "dnsPrivacy";
const CARD = "@container/card gap-5 rounded-card border-0 bg-surface py-6 shadow-sm";
const PAD = "px-7";
const ROW = "flex items-center justify-between gap-4 rounded-pill bg-surface-container px-4 py-[0.6875rem]";
const ROW_WRAP = "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-card bg-surface-container px-4 py-2";
const ROW_LABEL = "shrink-0 text-[0.8125rem] font-semibold leading-5 text-on-surface-variant";
const ROW_VALUE = "min-w-0 truncate text-right text-[0.8125rem] font-semibold leading-5 tabular-nums";
const INPUT = "bg-surface h-9 w-44 text-sm aria-invalid:ring-[3px] aria-invalid:ring-destructive/50";
/** Bytes per listed name in the forwarder's packed set, for the estimate beside the lists. */
const BYTES_PER_NAME = 25;

const PROVIDER_NAME: Record<DnsProvider, string> = {
  quad9: "Quad9",
  cloudflare: "Cloudflare",
  google: "Google",
  adguard: "AdGuard",
  mullvad: "Mullvad",
  nextdns: "NextDNS",
  custom: "",
};

const glyph = (className: string) => <CheckIcon size={SEGMENTED.GLYPH} className={className} aria-hidden="true" />;

function Row({ label, value, children, wrap }: { label: string; value?: string; children?: React.ReactNode; wrap?: boolean }) {
  return (
    <div className={wrap ? ROW_WRAP : ROW}>
      <span className={ROW_LABEL}>{label}</span>
      {children ?? <span className={ROW_VALUE}>{value || "—"}</span>}
    </div>
  );
}

function OnOff({ value, onChange, label, disabled }: { value: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  const { t } = useTranslation("common");
  return (
    <SegmentedField
      value={value ? "on" : "off"}
      onValueChange={(v) => !disabled && onChange(v === "on")}
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

const KNOWN_ERRORS = [
  "custom_dns_active",
  "not_installed",
  "unavailable",
  "daemon_failed",
  "apply_failed",
  "invalid_nextdns_id",
  "invalid_custom_host",
  "invalid_custom_ip",
  "too_many_lists",
  "no_lists",
  "invalid_allow",
  "invalid_deny",
  "too_many",
  "not_running",
];
const errorKey = (code: string) => `${K}.errors.${KNOWN_ERRORS.includes(code) ? code : "failed"}`;

const lines = (s: string) =>
  s
    .split(/[\n,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

function fmtMB(kb: number) {
  return `${(kb / 1024).toFixed(1)} MB`;
}

type Api = ReturnType<typeof useDnsPrivacy>;

function EncryptCard({ state, api }: { state: DnsPrivacyState; api: Api }) {
  const { t } = useTranslation("common");
  const saved = state.config.encrypt;
  const [d, setD, dirty] = useDraft(saved);
  const nidOk = d.provider !== "nextdns" || /^[a-z0-9]{4,16}$/.test(d.nextdns_id);
  const hostOk = d.provider !== "custom" || /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/i.test(d.custom_host.trim());
  const ipOk = d.provider !== "custom" || /^(\d{1,3}\.){3}\d{1,3}$/.test(d.custom_ip.trim());
  const valid = nidOk && hostOk && ipOk;
  const st = state.status;
  // Measured against the forwarder's own clock, so the page never compares two clocks.
  const fallbackRecent = !!st && st.upstream.fallback_at > 0 && st.updated - st.upstream.fallback_at < 300;

  const onSave = async () => {
    const r = await api.save({
      ...state.config,
      encrypt: { ...d, custom_host: d.custom_host.trim().toLowerCase(), custom_ip: d.custom_ip.trim() },
    });
    if (r.ok) toast.success(t(`${K}.toast.saved`));
    else toast.error(t(errorKey(r.code)));
  };

  return (
    <Card className={CARD}>
      <CardHeader className={PAD}>
        <CardTitle className="text-lg leading-tight">{t(`${K}.encrypt.title`)}</CardTitle>
        <CardDescription className="text-on-surface-variant text-sm">{t(`${K}.encrypt.description`)}</CardDescription>
      </CardHeader>
      <CardContent className={cn(PAD, "flex flex-col gap-[0.3125rem]")}>
        <Row label={t(`${K}.encrypt.enabled`)} wrap>
          <OnOff value={d.enabled} onChange={(v) => setD({ ...d, enabled: v })} label={t(`${K}.encrypt.enabled`)} />
        </Row>
        <Row label={t(`${K}.encrypt.provider`)} wrap>
          <Select value={d.provider} onValueChange={(v) => setD({ ...d, provider: v as DnsProvider })}>
            <SelectTrigger host="container" aria-label={t(`${K}.encrypt.provider`)} className="h-9 w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DNS_PROVIDERS.map((p) => (
                <SelectItem key={p} value={p}>
                  {p === "custom" ? t(`${K}.encrypt.custom`) : PROVIDER_NAME[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        {d.provider !== "custom" && d.provider !== "nextdns" ? (
          <p className="text-on-surface-variant px-1 pb-1 text-xs text-pretty">{t(`${K}.encrypt.about.${d.provider}`)}</p>
        ) : null}
        {d.provider === "nextdns" ? (
          <Row label={t(`${K}.encrypt.nextdns_id`)} wrap>
            <Input
              value={d.nextdns_id}
              onChange={(e) => setD({ ...d, nextdns_id: e.target.value.trim().toLowerCase() })}
              placeholder="abc123"
              autoComplete="off"
              aria-label={t(`${K}.encrypt.nextdns_id`)}
              aria-invalid={!nidOk}
              className={cn(INPUT, "font-mono")}
            />
          </Row>
        ) : null}
        {d.provider === "custom" ? (
          <>
            <Row label={t(`${K}.encrypt.custom_host`)} wrap>
              <Input
                value={d.custom_host}
                onChange={(e) => setD({ ...d, custom_host: e.target.value })}
                placeholder="dns.example.net"
                autoComplete="off"
                aria-label={t(`${K}.encrypt.custom_host`)}
                aria-invalid={!hostOk}
                className={cn(INPUT, "font-mono")}
              />
            </Row>
            <Row label={t(`${K}.encrypt.custom_ip`)} wrap>
              <Input
                value={d.custom_ip}
                onChange={(e) => setD({ ...d, custom_ip: e.target.value })}
                placeholder="203.0.113.53"
                inputMode="decimal"
                autoComplete="off"
                aria-label={t(`${K}.encrypt.custom_ip`)}
                aria-invalid={!ipOk}
                className={cn(INPUT, "font-mono")}
              />
            </Row>
          </>
        ) : null}
        <Row label={t(`${K}.encrypt.if_fails`)} wrap>
          <SegmentedField
            value={d.fallback ? "carrier" : "stop"}
            onValueChange={(v) => setD({ ...d, fallback: v === "carrier" })}
            options={[
              { value: "carrier", label: t(`${K}.encrypt.fallback_carrier`) },
              { value: "stop", label: t(`${K}.encrypt.fallback_stop`) },
            ]}
            ariaLabel={t(`${K}.encrypt.if_fails`)}
            breakpoint="never"
            glyph={glyph}
          />
        </Row>
        <p className="text-on-surface-variant pt-2 text-sm text-pretty">
          {d.fallback ? t(`${K}.encrypt.fallback_hint_carrier`) : t(`${K}.encrypt.fallback_hint_stop`)}
        </p>
      </CardContent>
      <CardFoot
        className={PAD}
        status={
          dirty ? (
            <span className="text-on-surface font-medium">{t(`${K}.unsaved`)}</span>
          ) : saved.enabled && st ? (
            !st.clock_ok ? (
              <Badge variant="warning">
                <TriangleAlertIcon className="size-3" aria-hidden />
                {t(`${K}.encrypt.state_clock`)}
              </Badge>
            ) : fallbackRecent ? (
              <Badge variant="warning">
                <TriangleAlertIcon className="size-3" aria-hidden />
                {t(`${K}.encrypt.state_fallback`)}
              </Badge>
            ) : (
              <Badge variant="success">
                <LockIcon className="size-3" aria-hidden />
                {t(`${K}.encrypt.state_on`, { provider: saved.provider === "custom" ? saved.custom_host : PROVIDER_NAME[saved.provider] })}
              </Badge>
            )
          ) : null
        }
        actions={
          <SaveButton
            type="button"
            size="action"
            label={t(`${K}.save`)}
            isSaving={api.busy === "save"}
            saved={false}
            disabled={!dirty || !valid || api.busy !== null}
            onClick={() => void onSave()}
          />
        }
      />
    </Card>
  );
}

function BlockCard({ state, api }: { state: DnsPrivacyState; api: Api }) {
  const { t, i18n } = useTranslation("common");
  const saved = state.config.block;
  const [d, setD, dirtyCfg] = useDraft({
    enabled: saved.enabled,
    lists: saved.lists,
    allow: saved.allow.join("\n"),
    deny: saved.deny.join("\n"),
  });
  const dirty = dirtyCfg;
  const total = BLOCK_LISTS.filter((l) => d.lists.includes(l.id)).reduce((a, l) => a + l.domains, 0);
  const capped = Math.min(total, MAX_DOMAINS);
  const valid = !d.enabled || d.lists.length > 0;
  const st = state.status;
  const nf = new Intl.NumberFormat(i18n.language);

  const toggle = (id: BlockListId, on: boolean) => {
    if (on && d.lists.length >= MAX_LISTS) return;
    setD({ ...d, lists: on ? [...d.lists, id] : d.lists.filter((x) => x !== id) });
  };

  const onSave = async () => {
    const r = await api.save({
      ...state.config,
      block: { enabled: d.enabled, lists: d.lists, allow: lines(d.allow), deny: lines(d.deny) },
    });
    if (r.ok) toast.success(t(`${K}.toast.saved`));
    else toast.error(t(errorKey(r.code)));
  };
  const onUpdate = async () => {
    const r = await api.updateLists();
    if (r.ok) toast.success(t(`${K}.toast.update_started`));
    else toast.error(t(errorKey(r.code)));
  };

  return (
    <Card className={CARD}>
      <CardHeader className={PAD}>
        <CardTitle className="text-lg leading-tight">{t(`${K}.block.title`)}</CardTitle>
        <CardDescription className="text-on-surface-variant text-sm">{t(`${K}.block.description`)}</CardDescription>
      </CardHeader>
      <CardContent className={cn(PAD, "flex flex-col gap-[0.3125rem]")}>
        <Row label={t(`${K}.block.enabled`)} wrap>
          <OnOff value={d.enabled} onChange={(v) => setD({ ...d, enabled: v })} label={t(`${K}.block.enabled`)} />
        </Row>
        <span className="text-on-surface-variant px-1 pt-3 text-[0.6875rem] font-semibold tracking-[0.09em] uppercase">
          {t(`${K}.block.lists`, { max: MAX_LISTS })}
        </span>
        {BLOCK_LISTS.map((l) => {
          const on = d.lists.includes(l.id);
          const live = st?.lists?.find((x) => x.id === l.id);
          return (
            <label
              key={l.id}
              className={cn(
                "bg-surface-container flex cursor-pointer items-start gap-3 rounded-card px-4 py-3",
                !on && d.lists.length >= MAX_LISTS && "cursor-not-allowed opacity-60",
              )}
            >
              <Checkbox
                checked={on}
                onCheckedChange={(v) => toggle(l.id, v === true)}
                disabled={!on && d.lists.length >= MAX_LISTS}
                className="mt-0.5"
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-x-2 text-sm font-semibold">
                  {t(`${K}.list.${l.id}.name`)}
                  <span className="text-on-surface-variant text-xs font-medium tabular-nums">
                    {t(`${K}.block.domains`, { n: nf.format(live?.domains || l.domains) })}
                  </span>
                </span>
                <span className="text-on-surface-variant text-xs text-pretty">{t(`${K}.list.${l.id}.about`)}</span>
                {saved.enabled && on && live?.error && live.error !== "not_downloaded" ? (
                  <span className="text-destructive-on-surface text-xs">{t(`${K}.block.list_error`)}</span>
                ) : saved.enabled && on && live?.error === "not_downloaded" ? (
                  <span className="text-on-surface-variant text-xs">{t(`${K}.block.list_pending`)}</span>
                ) : null}
              </span>
            </label>
          );
        })}
        <p className="text-on-surface-variant px-1 pt-1 text-xs tabular-nums">
          {t(`${K}.block.memory`, { mb: ((capped * BYTES_PER_NAME) / 1048576).toFixed(1) })}
          {total > MAX_DOMAINS ? ` ${t(`${K}.block.capped`, { n: nf.format(MAX_DOMAINS) })}` : ""}
        </p>
        <div className="grid grid-cols-1 gap-3 pt-3 @lg/card:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-[0.8125rem] font-semibold">
              {t(`${K}.block.allow`)}
              <HintIcon label={t(`${K}.block.allow`)}>{t(`${K}.block.allow_hint`)}</HintIcon>
            </span>
            <Textarea
              value={d.allow}
              onChange={(e) => setD({ ...d, allow: e.target.value })}
              rows={4}
              placeholder="example.com"
              className="bg-surface font-mono text-xs"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.8125rem] font-semibold">{t(`${K}.block.deny`)}</span>
            <Textarea
              value={d.deny}
              onChange={(e) => setD({ ...d, deny: e.target.value })}
              rows={4}
              placeholder="tracker.example"
              className="bg-surface font-mono text-xs"
            />
          </label>
        </div>
      </CardContent>
      <CardFoot
        className={PAD}
        status={
          dirty ? (
            <span className="text-on-surface font-medium">{t(`${K}.unsaved`)}</span>
          ) : saved.enabled && st ? (
            st.lists_updating || st.lists_loading ? (
              <Badge variant="info">
                <Loader2Icon className="size-3 motion-safe:animate-spin" aria-hidden />
                {t(`${K}.block.state_updating`)}
              </Badge>
            ) : st.domains_total > 0 ? (
              <Badge variant="success">
                <CheckCircle2Icon className="size-3" aria-hidden />
                {t(`${K}.block.state_on`, { n: nf.format(st.domains_total) })}
              </Badge>
            ) : (
              <Badge variant="warning">
                <TriangleAlertIcon className="size-3" aria-hidden />
                {t(`${K}.block.state_empty`)}
              </Badge>
            )
          ) : null
        }
        actions={
          <>
            {saved.enabled && state.service.healthy ? (
              <Button type="button" variant="tonal-neutral" size="action" disabled={api.busy !== null} onClick={() => void onUpdate()}>
                {t(`${K}.block.update`)}
              </Button>
            ) : null}
            <SaveButton
              type="button"
              size="action"
              label={t(`${K}.save`)}
              isSaving={api.busy === "save"}
              saved={false}
              disabled={!dirty || !valid || api.busy !== null}
              onClick={() => void onSave()}
            />
          </>
        }
      />
    </Card>
  );
}

function ActivityCard({ state, api }: { state: DnsPrivacyState; api: Api }) {
  const { t, i18n } = useTranslation("common");
  const st = state.status;
  const nf = new Intl.NumberFormat(i18n.language);
  if (!st) return null;
  const pct = st.stats.queries > 0 ? Math.round((st.stats.blocked * 100) / st.stats.queries) : 0;
  const onAllow = async (d: string) => {
    const r = await api.allow(d);
    if (r.ok) toast.success(t(`${K}.toast.allowed`, { domain: d }));
    else toast.error(t(errorKey(r.code)));
  };
  const top = st.top_blocked ?? [];
  return (
    <Card className={CARD}>
      <CardHeader className={PAD}>
        <CardTitle className="text-lg leading-tight">{t(`${K}.activity.title`)}</CardTitle>
        <CardDescription className="text-on-surface-variant text-sm">{t(`${K}.activity.description`)}</CardDescription>
      </CardHeader>
      <CardContent className={cn(PAD, "grid grid-cols-1 gap-5 *:min-w-0 @3xl/card:grid-cols-2")}>
        <div className="flex flex-col gap-[0.3125rem]">
          <Row label={t(`${K}.activity.queries`)} value={nf.format(st.stats.queries)} />
          <Row label={t(`${K}.activity.blocked`)} value={`${nf.format(st.stats.blocked)} · ${pct} %`} />
          <Row label={t(`${K}.activity.encrypted`)} value={nf.format(st.stats.encrypted)} />
          {st.stats.fallback > 0 ? <Row label={t(`${K}.activity.fallback`)} value={nf.format(st.stats.fallback)} /> : null}
          <Row label={t(`${K}.activity.latency`)} value={st.upstream.avg_ms ? `${st.upstream.avg_ms} ms` : ""} />
          <Row label={t(`${K}.activity.memory`)}>
            <span className="flex items-center gap-1.5">
              <span className={ROW_VALUE}>{st.mem_kb ? fmtMB(st.mem_kb) : "—"}</span>
              <HintIcon label={t(`${K}.activity.memory`)}>{t(`${K}.activity.memory_hint`)}</HintIcon>
            </span>
          </Row>
        </div>
        <div className="flex flex-col gap-[0.3125rem]">
          <span className="text-on-surface-variant px-1 text-[0.6875rem] font-semibold tracking-[0.09em] uppercase">
            {t(`${K}.activity.top`)}
          </span>
          {top.length === 0 ? (
            <p className="text-on-surface-variant px-1 text-sm">{t(`${K}.activity.none`)}</p>
          ) : (
            top.map((e) => (
              <div key={e.d} className="bg-surface-container flex items-center justify-between gap-3 rounded-pill py-1.5 pr-1.5 pl-4">
                <span className="min-w-0 truncate font-mono text-xs">{e.d}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="text-on-surface-variant text-xs tabular-nums">{nf.format(e.n)}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={api.busy !== null || state.config.block.allow.includes(e.d)}
                    onClick={() => void onAllow(e.d)}
                  >
                    {state.config.block.allow.includes(e.d) ? t(`${K}.activity.allowed`) : t(`${K}.activity.allow`)}
                  </Button>
                </span>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function DnsPrivacyComponent() {
  const { t } = useTranslation("common");
  const api = useDnsPrivacy();
  const state = api.state;

  const header = (
    <div className="flex flex-col gap-5 @3xl/main:flex-row @3xl/main:items-end">
      <div className="flex max-w-[41rem] flex-col gap-1.5">
        <h1 className="text-3xl font-bold tracking-[-0.02em]">{t(`${K}.page.title`)}</h1>
        <p className="text-on-surface-variant text-sm leading-relaxed text-pretty">{t(`${K}.page.description`)}</p>
      </div>
      <div className="@3xl/main:ml-auto">
        <Button type="button" variant="outline" size="action" onClick={() => void api.refresh()}>
          <RefreshCwIcon className="size-4" aria-hidden />
          {t(`${K}.page.refresh`)}
        </Button>
      </div>
    </div>
  );

  if (api.isLoading && !state) {
    return (
      <div className="@container/main flex flex-col gap-5 p-2" aria-busy="true">
        {header}
        <div className="grid grid-cols-1 gap-5 @3xl/main:grid-cols-2">
          <Skeleton className="h-96 rounded-card" />
          <Skeleton className="h-96 rounded-card" />
        </div>
      </div>
    );
  }
  if (!state) {
    return (
      <div className="@container/main flex flex-col gap-5 p-2">
        {header}
        <Card className={CARD}>
          <CardContent className={cn(PAD, "flex flex-col items-start gap-3")}>
            <Badge variant="destructive">
              <AlertCircleIcon className="size-3" aria-hidden />
              {t(`${K}.errors.load_failed`)}
            </Badge>
            <Button type="button" variant="tonal-neutral" size="action" onClick={() => void api.refresh()}>
              {t(`${K}.page.retry`)}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const svc = state.service;
  const wanted = state.config.encrypt.enabled || state.config.block.enabled;
  const notice = !svc.installed
    ? { tone: "warning" as const, text: t(`${K}.notice.not_installed`) }
    : !svc.available
      ? { tone: "warning" as const, text: t(`${K}.notice.unavailable`) }
      : svc.custom_dns_active
        ? { tone: "info" as const, text: t(`${K}.notice.custom_dns`), link: "/local-network/custom-dns" }
        : wanted && !svc.healthy
          ? { tone: "destructive" as const, text: t(`${K}.notice.stopped`) }
          : wanted && !svc.active_in_dnsmasq
            ? { tone: "warning" as const, text: t(`${K}.notice.paused`) }
            : null;

  return (
    <div className="@container/main flex flex-col gap-5 p-2">
      {header}
      {notice ? (
        <div className="bg-surface flex flex-wrap items-center gap-3 rounded-card px-5 py-3 shadow-sm">
          <Badge variant={notice.tone}>
            {notice.tone === "info" ? (
              <MinusCircleIcon className="size-3" aria-hidden />
            ) : notice.tone === "destructive" ? (
              <ShieldOffIcon className="size-3" aria-hidden />
            ) : (
              <TriangleAlertIcon className="size-3" aria-hidden />
            )}
            {t(`${K}.notice.title_${notice.tone}`)}
          </Badge>
          <span className="text-sm text-pretty">{notice.text}</span>
          {notice.link ? (
            <Link href={notice.link} className="text-primary-on-surface text-sm font-medium underline-offset-4 hover:underline">
              {t(`${K}.notice.open_custom_dns`)}
            </Link>
          ) : null}
        </div>
      ) : null}
      <div className="grid grid-cols-1 items-start gap-5 *:min-w-0 @3xl/main:grid-cols-2">
        <EncryptCard state={state} api={api} />
        <BlockCard state={state} api={api} />
      </div>
      <ActivityCard state={state} api={api} />
    </div>
  );
}
