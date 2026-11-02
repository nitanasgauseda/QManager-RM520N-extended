"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { CheckCircle2Icon, CheckIcon, CircleDashedIcon, CircleOffIcon, RouterIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CardFoot } from "@/components/ui/card-foot";
import { Input } from "@/components/ui/input";
import { SaveButton } from "@/components/ui/save-button";
import { SegmentedField, SEGMENTED } from "@/components/ui/segmented-field";
import { Skeleton } from "@/components/ui/skeleton";
import { useWatch } from "@/hooks/use-watch";
import { cn } from "@/lib/utils";

import { CARD_PAD, CARD_SHELL, CARD_TITLE, ROW, ROW_GROUP } from "./shapes";

const K = "ethernet.router";
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function StateBadge({ state }: { state: "up" | "down" | "unknown" | "off" }) {
  const { t } = useTranslation("common");
  if (state === "up")
    return (
      <Badge variant="success">
        <CheckCircle2Icon className="size-3" aria-hidden />
        {t(`${K}.state.up`)}
      </Badge>
    );
  if (state === "down")
    return (
      <Badge variant="destructive">
        <RouterIcon className="size-3" aria-hidden />
        {t(`${K}.state.down`)}
      </Badge>
    );
  if (state === "off")
    return (
      <Badge variant="muted">
        <CircleOffIcon className="size-3" aria-hidden />
        {t(`${K}.state.off`)}
      </Badge>
    );
  return (
    <Badge variant="muted">
      <CircleDashedIcon className="size-3" aria-hidden />
      {t(`${K}.state.unknown`)}
    </Badge>
  );
}

export function RouterWatchCard() {
  const { t, i18n } = useTranslation("common");
  const w = useWatch();
  const saved = w.state?.config.router ?? { alert: true, address: "" };
  const key = `${saved.alert}/${saved.address}`;
  const [draft, setDraft] = React.useState(saved);
  const [prev, setPrev] = React.useState(key);
  if (key !== prev) {
    setPrev(key);
    setDraft(saved);
  }

  if (!w.state) {
    return <Skeleton className="h-72 rounded-card" aria-busy="true" />;
  }

  const status = w.state.router;
  const addr = draft.address.trim();
  const addrBad = addr !== "" && !IPV4.test(addr);
  const dirty = draft.alert !== saved.alert || addr !== saved.address;

  const onSave = async () => {
    const r = await w.save({ ...w.state!.config, router: { alert: draft.alert, address: addr } });
    if (r.ok) toast.success(t(`${K}.toast_saved`));
    else toast.error(t(r.code === "invalid_address" ? `${K}.address_invalid` : `${K}.save_failed`));
  };

  const since =
    status && status.since > 0 && (status.state === "up" || status.state === "down")
      ? new Date(status.since * 1000).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" })
      : null;

  return (
    <Card className={CARD_SHELL}>
      <CardHeader className={CARD_PAD}>
        <CardTitle className={CARD_TITLE}>{t(`${K}.title`)}</CardTitle>
        <CardDescription>{t(`${K}.description`)}</CardDescription>
      </CardHeader>
      <CardContent className={cn(CARD_PAD, "flex flex-col gap-3")}>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-1 text-sm">
          <span className="flex min-w-0 items-center gap-2">
            <span className="text-on-surface-variant">{t(`${K}.router`)}</span>
            <span className="min-w-0 truncate font-mono text-[0.8125rem]">{status?.address || "—"}</span>
          </span>
          <span className="flex items-center gap-2">
            {since ? <span className="text-on-surface-variant text-xs tabular-nums">{t(`${K}.since`, { time: since })}</span> : null}
            <StateBadge state={status?.state ?? "unknown"} />
          </span>
        </div>
        {status?.state === "unknown" && !status.address ? (
          <p className="text-on-surface-variant px-1 text-sm text-pretty">{t(`${K}.not_found`)}</p>
        ) : null}

        <div className={ROW_GROUP}>
          <div className={ROW.ROOT}>
            <div className={ROW.TEXT}>
              <span className={ROW.LABEL}>{t(`${K}.alert`)}</span>
              <span className={ROW.CONSEQUENCE}>{t(`${K}.alert_hint`)}</span>
            </div>
            <div className={ROW.CONTROL}>
              <SegmentedField
                value={draft.alert ? "on" : "off"}
                onValueChange={(v) => setDraft((d) => ({ ...d, alert: v === "on" }))}
                options={[
                  { value: "on", label: t("state.on") },
                  { value: "off", label: t("state.off") },
                ]}
                ariaLabel={t(`${K}.alert`)}
                breakpoint="never"
                glyph={(c: string) => <CheckIcon size={SEGMENTED.GLYPH} className={c} aria-hidden="true" />}
              />
            </div>
          </div>
          <div className="bg-surface-container-high mx-4 h-px" />
          <div className={ROW.ROOT}>
            <div className={ROW.TEXT}>
              <label htmlFor="router-address" className={ROW.LABEL}>
                {t(`${K}.address`)}
              </label>
              <span className={cn(ROW.CONSEQUENCE, addrBad && "text-destructive-on-surface")}>
                {addrBad ? t(`${K}.address_invalid`) : t(`${K}.address_hint`)}
              </span>
            </div>
            <div className={ROW.CONTROL}>
              <Input
                id="router-address"
                value={draft.address}
                onChange={(e) => setDraft((d) => ({ ...d, address: e.target.value }))}
                placeholder={t(`${K}.address_auto`)}
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={addrBad}
                className="bg-surface w-full font-mono text-[0.84375rem] @2xl/card:w-[13.5rem]"
              />
            </div>
          </div>
        </div>
      </CardContent>
      <CardFoot
        className={CARD_PAD}
        actions={
          <>
            {dirty ? (
              <Button type="button" variant="ghost" size="action" disabled={w.busy !== null} onClick={() => setDraft(saved)}>
                {t(`${K}.discard`)}
              </Button>
            ) : null}
            <SaveButton
              type="button"
              size="action"
              label={t(`${K}.save`)}
              isSaving={w.busy === "save"}
              saved={false}
              disabled={!dirty || addrBad || w.busy !== null}
              onClick={() => void onSave()}
            />
          </>
        }
      />
    </Card>
  );
}

export default RouterWatchCard;
