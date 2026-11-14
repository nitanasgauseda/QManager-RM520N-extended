"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AlertCircleIcon, CheckCircle2Icon, CheckIcon, InfoIcon, Loader2Icon, MinusCircleIcon, TriangleAlertIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SegmentedField, SEGMENTED } from "@/components/ui/segmented-field";
import { useSimCard, type SimPinAction } from "@/hooks/use-sim-card";
import { cn } from "@/lib/utils";

const S = "securityCheck.sim";
const CARD = "@container/card gap-5 rounded-card border-0 bg-surface py-6 shadow-sm";
const PAD = "px-7";
const ROW = "flex items-center justify-between gap-4 rounded-pill bg-surface-container px-4 py-[0.6875rem]";
const ROW_LABEL = "shrink-0 text-[0.8125rem] font-semibold leading-5 text-on-surface-variant";
const ROW_VALUE = "min-w-0 truncate text-right text-[0.8125rem] font-semibold";
const PIN_RE = /^[0-9]{4,8}$/;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={ROW}>
      <span className={ROW_LABEL}>{label}</span>
      {children}
    </div>
  );
}

export function SimCardCard() {
  const { t } = useTranslation("common");
  const { sim, failed, busy, act } = useSimCard();
  const [pin, setPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [changing, setChanging] = useState(false);
  const [remember, setRemember] = useState(true);

  const run = async (action: SimPinAction) => {
    const r = await act(action, { pin, new_pin: changing ? newPin : undefined, remember });
    if (r.ok) {
      toast.success(t(`${S}.toast.${action}`));
      setPin("");
      setNewPin("");
      setChanging(false);
    } else if (r.code === "wrong_pin") {
      toast.error(t(`${S}.errors.wrong_pin`, { n: r.retries ?? "—" }));
    } else {
      toast.error(t(`${S}.errors.${r.code}`, { defaultValue: t(`${S}.errors.failed`) }));
    }
  };

  if (!sim) {
    return (
      <Card className={CARD}>
        <CardHeader className={PAD}>
          <CardTitle className="text-lg leading-tight">{t(`${S}.title`)}</CardTitle>
          <CardDescription className="text-on-surface-variant text-sm">{t(`${S}.description`)}</CardDescription>
        </CardHeader>
        <CardContent className={PAD}>
          {failed ? (
            <Badge variant="destructive">
              <AlertCircleIcon className="size-3" aria-hidden />
              {t(`${S}.errors.load_failed`)}
            </Badge>
          ) : (
            <Loader2Icon className="text-on-surface-variant size-4 animate-spin" aria-hidden />
          )}
        </CardContent>
      </Card>
    );
  }

  const left = sim.pin_retries;
  const lastTry = left !== null && left <= 1;
  const blocked = sim.state === "puk" || lastTry || left === null;
  const pinOk = PIN_RE.test(pin) && (!changing || PIN_RE.test(newPin));
  const glyph = (c: string) => <CheckIcon size={SEGMENTED.GLYPH} className={c} aria-hidden="true" />;

  return (
    <Card className={CARD}>
      <CardHeader className={PAD}>
        <CardTitle className="text-lg leading-tight">{t(`${S}.title`)}</CardTitle>
        <CardDescription className="text-on-surface-variant text-sm">{t(`${S}.description`)}</CardDescription>
      </CardHeader>
      <CardContent className={cn(PAD, "flex flex-col gap-[0.3125rem]")}>
        <Row label={t(`${S}.operator`)}>
          <span className={ROW_VALUE}>{sim.spn ?? "—"}</span>
        </Row>
        <Row label={t(`${S}.smsc`)}>
          <span className={cn(ROW_VALUE, "font-mono")}>{sim.smsc ?? "—"}</span>
        </Row>
        <Row label={t(`${S}.pin`)}>
          {sim.state === "puk" ? (
            <Badge variant="destructive">
              <AlertCircleIcon className="size-3" aria-hidden />
              {t(`${S}.state_puk`)}
            </Badge>
          ) : sim.state === "pin" ? (
            <Badge variant="warning">
              <TriangleAlertIcon className="size-3" aria-hidden />
              {t(`${S}.state_locked`)}
            </Badge>
          ) : sim.pin_enabled ? (
            <Badge variant="success">
              <CheckCircle2Icon className="size-3" aria-hidden />
              {t(`${S}.pin_on`)}
            </Badge>
          ) : (
            <Badge variant="warning">
              <TriangleAlertIcon className="size-3" aria-hidden />
              {t(`${S}.pin_off`)}
            </Badge>
          )}
        </Row>
        <Row label={t(`${S}.attempts`)}>
          <span className={cn(ROW_VALUE, "tabular-nums")}>
            {left === null ? "—" : t(`${S}.attempts_value`, { pin: left, puk: sim.puk_retries ?? "—" })}
          </span>
        </Row>
        {sim.pin_enabled ? (
          <Row label={t(`${S}.auto_unlock`)}>
            {sim.auto_unlock_stopped ? (
              <Badge variant="destructive">
                <AlertCircleIcon className="size-3" aria-hidden />
                {t(`${S}.auto_stopped`)}
              </Badge>
            ) : sim.remembered ? (
              <Badge variant="info">
                <InfoIcon className="size-3" aria-hidden />
                {t(`${S}.auto_on`)}
              </Badge>
            ) : (
              <Badge variant="muted">
                <MinusCircleIcon className="size-3" aria-hidden />
                {t(`${S}.auto_off`)}
              </Badge>
            )}
          </Row>
        ) : null}

        <div className="bg-surface-container mt-2 flex flex-col gap-3 rounded-card px-4 py-3">
          {sim.state === "puk" ? (
            <p className="text-sm text-pretty">{t(`${S}.puk_hint`)}</p>
          ) : lastTry ? (
            <p className="text-sm text-pretty">{t(`${S}.last_try_hint`)}</p>
          ) : left === null ? (
            <p className="text-sm text-pretty">{t(`${S}.unknown_hint`)}</p>
          ) : (
            <>
              <p className="text-on-surface-variant text-sm text-pretty">
                {sim.state === "pin" ? t(`${S}.unlock_hint`) : sim.pin_enabled ? t(`${S}.on_hint`) : t(`${S}.off_hint`)}
              </p>
              <div className="flex flex-col gap-2 @md/card:flex-row">
                <Input
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={8}
                  placeholder={changing ? t(`${S}.current_pin`) : t(`${S}.pin_placeholder`)}
                  aria-label={changing ? t(`${S}.current_pin`) : t(`${S}.pin_placeholder`)}
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, ""))}
                  host="container"
                  className="h-10 px-3 tabular-nums"
                />
                {changing ? (
                  <Input
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={8}
                    placeholder={t(`${S}.new_pin`)}
                    aria-label={t(`${S}.new_pin`)}
                    value={newPin}
                    onChange={(e) => setNewPin(e.target.value.replace(/[^0-9]/g, ""))}
                    host="container"
                    className="h-10 px-3 tabular-nums"
                  />
                ) : null}
              </div>
              {sim.state === "pin" || !sim.pin_enabled || changing ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-on-surface-variant text-[0.8125rem] font-semibold">{t(`${S}.remember`)}</span>
                  <SegmentedField
                    value={remember ? "on" : "off"}
                    onValueChange={(v) => setRemember(v === "on")}
                    options={[
                      { value: "on", label: t("state.on") },
                      { value: "off", label: t("state.off") },
                    ]}
                    ariaLabel={t(`${S}.remember`)}
                    breakpoint="never"
                    glyph={glyph}
                  />
                </div>
              ) : null}
              <div className="flex flex-wrap justify-end gap-2">
                {sim.state === "pin" ? (
                  <Button type="button" size="action" disabled={busy || !pinOk} onClick={() => void run("unlock")}>
                    {t(`${S}.unlock`)}
                  </Button>
                ) : sim.pin_enabled ? (
                  changing ? (
                    <>
                      <Button type="button" variant="ghost" size="action" disabled={busy} onClick={() => setChanging(false)}>
                        {t(`${S}.cancel`)}
                      </Button>
                      <Button type="button" size="action" disabled={busy || !pinOk} onClick={() => void run("change")}>
                        {t(`${S}.change`)}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button type="button" variant="tonal-neutral" size="action" disabled={busy} onClick={() => setChanging(true)}>
                        {t(`${S}.change`)}
                      </Button>
                      <Button type="button" variant="tonal-neutral" size="action" disabled={busy || !pinOk} onClick={() => void run("disable")}>
                        {t(`${S}.turn_off`)}
                      </Button>
                    </>
                  )
                ) : (
                  <Button type="button" size="action" disabled={busy || !pinOk || blocked} onClick={() => void run("enable")}>
                    {t(`${S}.turn_on`)}
                  </Button>
                )}
              </div>
              {sim.pin_enabled && sim.remembered && !changing ? (
                <div className="flex justify-end">
                  <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void run("forget")}>
                    {t(`${S}.forget`)}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
