"use client";

import * as React from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import CellularPageHeader from "@/components/cellular/page-header";
import ConditionScreen from "@/components/cellular/condition-screen";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { MaterialSymbol } from "@/components/ui/material-symbol";
import { Skeleton } from "@/components/ui/skeleton";
import { useEsim, type EsimProfile } from "@/hooks/use-esim";
import { staggerContainer, staggerItem } from "@/lib/motion";
import { cn } from "@/lib/utils";

import {
  CARD_FOOTNOTE,
  CARD_PAD,
  CARD_SHELL,
  CARD_TITLE,
  FIELD_SHELL,
  PAGE_ROOT,
  PILL_ACTION_GLYPH,
  ROW_GROUP,
  SETTING_ROW,
} from "../shapes";

const K = "esim";
const KNOWN_ERRORS = [
  "no_euicc",
  "modem_busy",
  "esim_busy",
  "server_failed",
  "timeout",
  "invalid_code",
  "invalid_name",
  "not_installed",
];

function useErrorText() {
  const { t } = useTranslation("cellular");
  return (code: string) => t(`${K}.errors.${KNOWN_ERRORS.includes(code) ? code : "failed"}`);
}

function profileTitle(p: EsimProfile) {
  return p.nickname || p.name || p.provider || p.iccid;
}

function ProfileRow({
  p,
  api,
  onRename,
  onDelete,
}: {
  p: EsimProfile;
  api: ReturnType<typeof useEsim>;
  onRename: (p: EsimProfile) => void;
  onDelete: (p: EsimProfile) => void;
}) {
  const { t } = useTranslation("cellular");
  const errText = useErrorText();
  const enabled = p.state === "enabled";
  const working = api.busy?.endsWith(`:${p.iccid}`) ?? false;

  const toggle = async () => {
    const r = await api.act(enabled ? "disable" : "enable", p.iccid);
    if (r.ok) toast.success(t(enabled ? `${K}.toast.disabled` : `${K}.toast.enabled`, { name: profileTitle(p) }));
    else toast.error(errText(r.code));
  };

  return (
    <div className={SETTING_ROW.ROOT}>
      <div className={SETTING_ROW.TEXT}>
        <div className={SETTING_ROW.LABEL_ROW}>
          <span className={cn(SETTING_ROW.LABEL, "min-w-0 truncate")}>{profileTitle(p)}</span>
          {enabled ? (
            <Badge variant="success">
              <MaterialSymbol name="check_circle" filled size={12} />
              {t(`${K}.profile.active`)}
            </Badge>
          ) : (
            <Badge variant="muted">
              <MaterialSymbol name="block" size={12} />
              {t(`${K}.profile.inactive`)}
            </Badge>
          )}
        </div>
        <span className={SETTING_ROW.CONSEQUENCE}>
          {p.provider && p.provider !== profileTitle(p) ? `${p.provider} · ` : ""}
          <span className="font-mono">{p.iccid}</span>
        </span>
      </div>
      <div className={cn(SETTING_ROW.CONTROL, "flex-wrap gap-2")}>
        <Button
          type="button"
          size="sm"
          variant={enabled ? "tonal-neutral" : "default"}
          disabled={api.busy !== null || api.job?.running === true}
          onClick={() => void toggle()}
        >
          {working && api.busy?.startsWith(enabled ? "disable" : "enable") ? (
            <MaterialSymbol name="progress_activity" size={PILL_ACTION_GLYPH} className="motion-safe:animate-spin" />
          ) : (
            <MaterialSymbol name="power_settings_new" size={PILL_ACTION_GLYPH} />
          )}
          {enabled ? t(`${K}.actions.disable`) : t(`${K}.actions.enable`)}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={api.busy !== null || api.job?.running === true}
          onClick={() => onRename(p)}
        >
          <MaterialSymbol name="edit" size={PILL_ACTION_GLYPH} />
          {t(`${K}.actions.rename`)}
        </Button>
        {!enabled ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={api.busy !== null || api.job?.running === true}
            onClick={() => onDelete(p)}
          >
            <MaterialSymbol name="delete" size={PILL_ACTION_GLYPH} />
            {t(`${K}.actions.delete`)}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ProfilesCard({ api }: { api: ReturnType<typeof useEsim> }) {
  const { t, i18n } = useTranslation("cellular");
  const errText = useErrorText();
  const [renaming, setRenaming] = React.useState<EsimProfile | null>(null);
  const [newName, setNewName] = React.useState("");
  const [deleting, setDeleting] = React.useState<EsimProfile | null>(null);
  const s = api.state;

  const onRefresh = async () => {
    await api.refresh();
  };
  const onRename = async () => {
    const p = renaming;
    if (!p) return;
    setRenaming(null);
    const r = await api.act("nickname", p.iccid, newName.trim());
    if (r.ok) toast.success(t(`${K}.toast.renamed`));
    else toast.error(errText(r.code));
  };
  const onDelete = async () => {
    const p = deleting;
    if (!p) return;
    setDeleting(null);
    const r = await api.act("delete", p.iccid);
    if (r.ok) toast.success(t(`${K}.toast.deleted`, { name: profileTitle(p) }));
    else toast.error(errText(r.code));
  };

  let body: React.ReactNode;
  if (api.isLoading && !s) {
    body = (
      <div className={ROW_GROUP.ROOT} aria-busy="true">
        <Skeleton className={cn(SETTING_ROW.HEIGHT, "rounded-field")} />
        <Skeleton className={cn(SETTING_ROW.HEIGHT, "rounded-field")} />
      </div>
    );
  } else if (!api.available) {
    body = (
      <ConditionScreen
        tone="neutral"
        glyph="sim_card"
        ariaRole="status"
        title={t(`${K}.states.not_installed.title`)}
        description={t(`${K}.states.not_installed.description`)}
      />
    );
  } else if (api.error && !s) {
    body = (
      <ConditionScreen
        tone="destructive"
        glyph="error"
        ariaRole="alert"
        title={t(`${K}.states.error.title`)}
        description={t(`${K}.states.error.description`)}
        onRetry={() => void onRefresh()}
        retryLabel={t("common:actions.retry")}
      />
    );
  } else if (!s || !s.euicc) {
    const busyRead = s?.error === "modem_busy" || s?.error === "timeout";
    body = (
      <ConditionScreen
        tone="neutral"
        glyph={busyRead ? "help" : "sim_card"}
        ariaRole="status"
        title={t(busyRead ? `${K}.states.busy.title` : `${K}.states.no_euicc.title`)}
        description={t(busyRead ? `${K}.states.busy.description` : `${K}.states.no_euicc.description`)}
        onRetry={() => void onRefresh()}
        retryLabel={t(`${K}.actions.refresh`)}
        disabled={api.busy !== null}
      />
    );
  } else {
    body = (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 text-sm">
          <span className="text-on-surface-variant">{t(`${K}.eid`)}</span>
          <span className="min-w-0 font-mono text-[0.8125rem] break-all">{s.eid ?? "—"}</span>
        </div>
        {typeof s.free_bytes === "number" ? (
          <div className="flex flex-wrap items-center justify-between gap-x-4 px-1 text-sm">
            <span className="text-on-surface-variant">{t(`${K}.free`)}</span>
            <span className="tabular-nums">{t(`${K}.free_value`, { kb: Math.round(s.free_bytes / 1024) })}</span>
          </div>
        ) : null}
        {s.profiles.length === 0 ? (
          <p className="text-on-surface-variant px-1 py-2 text-sm">{t(`${K}.empty`)}</p>
        ) : (
          <div className={ROW_GROUP.ROOT}>
            {s.profiles.map((p, i) => (
              <React.Fragment key={p.iccid}>
                {i > 0 ? <div className={ROW_GROUP.DIVIDER} /> : null}
                <ProfileRow
                  p={p}
                  api={api}
                  onRename={(x) => {
                    setNewName(x.nickname ?? "");
                    setRenaming(x);
                  }}
                  onDelete={setDeleting}
                />
              </React.Fragment>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <Card className={CARD_SHELL}>
      <CardHeader className={CARD_PAD}>
        <CardTitle className={CARD_TITLE}>{t(`${K}.card.title`)}</CardTitle>
        <CardDescription>{t(`${K}.card.description`)}</CardDescription>
      </CardHeader>
      <CardContent className={CARD_PAD}>{body}</CardContent>
      {s?.euicc ? (
        <CardFoot
          className={CARD_PAD}
          status={
            <span className="text-on-surface-variant text-xs tabular-nums">
              {t(`${K}.checked`, {
                time: new Date(s.checked_at * 1000).toLocaleTimeString(i18n.language, {
                  hour: "2-digit",
                  minute: "2-digit",
                }),
              })}
            </span>
          }
          actions={
            <Button
              type="button"
              variant="ghost"
              size="action"
              disabled={api.busy !== null || api.job?.running === true}
              onClick={() => void onRefresh()}
            >
              <MaterialSymbol
                name={api.busy === "refresh" ? "progress_activity" : "refresh"}
                size={PILL_ACTION_GLYPH}
                className={api.busy === "refresh" ? "motion-safe:animate-spin" : undefined}
              />
              {t(`${K}.actions.refresh`)}
            </Button>
          }
        />
      ) : null}

      <Dialog open={renaming !== null} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(`${K}.rename.title`)}</DialogTitle>
            <DialogDescription>{t(`${K}.rename.description`)}</DialogDescription>
          </DialogHeader>
          <Input
            value={newName}
            maxLength={64}
            onChange={(e) => setNewName(e.target.value)}
            className={FIELD_SHELL}
            aria-label={t(`${K}.rename.title`)}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setRenaming(null)}>
              {t("common:actions.cancel")}
            </Button>
            <Button type="button" disabled={newName.trim().length === 0} onClick={() => void onRename()}>
              {t(`${K}.actions.rename`)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(`${K}.delete.title`, { name: deleting ? profileTitle(deleting) : "" })}</AlertDialogTitle>
            <AlertDialogDescription>{t(`${K}.delete.description`)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void onDelete()}>
              {t(`${K}.actions.delete`)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function DownloadCard({ api }: { api: ReturnType<typeof useEsim> }) {
  const { t } = useTranslation("cellular");
  const errText = useErrorText();
  const [code, setCode] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const running = api.job?.running === true;
  const valid = /^lpa:1\$/i.test(code.trim());

  // Toast once when a download this page watched finishes (never for a result loaded on mount).
  const wasRunning = React.useRef<boolean | null>(null);
  React.useEffect(() => {
    const prev = wasRunning.current;
    wasRunning.current = running;
    if (prev !== true || running || !api.job?.result) return;
    if (api.job.result.success) {
      setCode("");
      setConfirm("");
      toast.success(t(`${K}.toast.downloaded`), { id: "esim-download" });
    } else {
      toast.error(errText(api.job.result.error ?? "failed"), { id: "esim-download" });
    }
  }, [running, api.job, t, errText]);

  const onDownload = async () => {
    const r = await api.download(code.trim(), confirm.trim());
    if (r.ok) toast.success(t(`${K}.toast.download_started`));
    else toast.error(errText(r.code));
  };

  if (!api.state?.euicc) return null;
  return (
    <Card className={CARD_SHELL}>
      <CardHeader className={CARD_PAD}>
        <CardTitle className={CARD_TITLE}>{t(`${K}.add.title`)}</CardTitle>
        <CardDescription>{t(`${K}.add.description`)}</CardDescription>
      </CardHeader>
      <CardContent className={cn(CARD_PAD, "flex flex-col gap-4")}>
        <Field className="gap-2">
          <FieldLabel htmlFor="esim-code" className="text-sm font-semibold">
            {t(`${K}.add.code`)}
          </FieldLabel>
          <Input
            id="esim-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="LPA:1$smdp.example.com$ABCD-1234"
            className={cn(FIELD_SHELL, "font-mono")}
            autoComplete="off"
            spellCheck={false}
            disabled={running}
            aria-invalid={code.trim() !== "" && !valid}
          />
          <span className="text-on-surface-variant text-xs text-pretty">{t(`${K}.add.code_hint`)}</span>
        </Field>
        <Field className="gap-2">
          <FieldLabel htmlFor="esim-confirm" className="text-sm font-semibold">
            {t(`${K}.add.confirm`)}
          </FieldLabel>
          <Input
            id="esim-confirm"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className={cn(FIELD_SHELL, "max-w-xs")}
            autoComplete="off"
            disabled={running}
          />
        </Field>
      </CardContent>
      <CardFoot
        className={CARD_PAD}
        status={
          running ? (
            <span className="text-on-surface-variant flex items-center gap-2 text-sm">
              <MaterialSymbol name="progress_activity" size={16} className="motion-safe:animate-spin" />
              {t(`${K}.add.running`)}
            </span>
          ) : undefined
        }
        actions={
          <Button
            type="button"
            size="action"
            disabled={!valid || running || api.busy !== null}
            onClick={() => void onDownload()}
          >
            <MaterialSymbol name="download" size={PILL_ACTION_GLYPH} />
            {t(`${K}.actions.download`)}
          </Button>
        }
      />
    </Card>
  );
}

export function EsimComponent() {
  const { t } = useTranslation("cellular");
  const api = useEsim();

  return (
    <div className={PAGE_ROOT}>
      <CellularPageHeader title={t(`${K}.page.title`)} description={t(`${K}.page.description`)} />
      <motion.div className="flex flex-col gap-3" initial="hidden" animate="visible" variants={staggerContainer}>
        <motion.div variants={staggerItem}>
          <ProfilesCard api={api} />
        </motion.div>
        <motion.div variants={staggerItem}>
          <DownloadCard api={api} />
        </motion.div>
        <motion.div variants={staggerItem} className={CARD_FOOTNOTE.ROOT}>
          <span aria-hidden="true" className={CARD_FOOTNOTE.DISC}>
            <MaterialSymbol name="info" filled size={CARD_FOOTNOTE.GLYPH} />
          </span>
          <p className={CARD_FOOTNOTE.BODY}>{t(`${K}.page.note`)}</p>
        </motion.div>
      </motion.div>
    </div>
  );
}

export default EsimComponent;
