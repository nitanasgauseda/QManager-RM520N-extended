"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  CheckCircle2Icon,
  DownloadIcon,
  FileArchiveIcon,
  KeyRoundIcon,
  Loader2Icon,
  TriangleAlertIcon,
  UploadIcon,
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
import {
  BACKUP_MAX_BYTES,
  useSettingsBackup,
  type BackupInspect,
  type BackupRestore,
} from "@/hooks/use-settings-backup";
import { cn } from "@/lib/utils";

const K = "backup";
const CARD = "@container/card gap-5 rounded-card border-0 bg-surface py-6 shadow-sm";
const PAD = "px-7";
const ROW = "flex items-center justify-between gap-4 rounded-pill bg-surface-container px-4 py-[0.6875rem]";
const ROW_LABEL = "shrink-0 text-[0.8125rem] font-semibold leading-5 text-on-surface-variant";
const ROW_VALUE = "min-w-0 truncate text-right text-[0.8125rem] font-semibold leading-5 tabular-nums";

const SECRET_WHERE: Record<string, string> = {
  telegram_bot_token: "/monitoring/alerts",
  email_app_password: "/monitoring/alerts",
  discord_bot_token: "/monitoring/discord-bot",
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className={ROW}>
      <span className={ROW_LABEL}>{label}</span>
      <span className={ROW_VALUE}>{value || "—"}</span>
    </div>
  );
}

function errorText(t: (k: string) => string, code: string) {
  switch (code) {
    case "too_large":
    case "not_a_backup":
    case "bad_member":
    case "write_failed":
      return t(`${K}.errors.${code}`);
    default:
      return t(`${K}.errors.failed`);
  }
}

function RebootDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation("common");
  const [isRebooting, setIsRebooting] = useState(false);
  const reboot = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsRebooting(true);
    fetch("/cgi-bin/quecmanager/system/reboot.sh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reboot" }),
      keepalive: true,
    }).catch(() => {});
    setTimeout(() => {
      sessionStorage.setItem("qm_rebooting", "1");
      document.cookie = "qm_logged_in=; Path=/; Max-Age=0";
      window.location.href = "/reboot/";
    }, 2000);
  };
  return (
    <AlertDialog open={open} onOpenChange={(next) => !isRebooting && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(`${K}.reboot.title`)}</AlertDialogTitle>
          <AlertDialogDescription>{t(`${K}.reboot.description`)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isRebooting}>{t(`${K}.reboot.later`)}</AlertDialogCancel>
          <AlertDialogAction disabled={isRebooting} onClick={reboot}>
            {isRebooting ? <Loader2Icon className="size-4 motion-safe:animate-spin" /> : null}
            {isRebooting ? t(`${K}.reboot.rebooting`) : t(`${K}.reboot.now`)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function BackupComponent() {
  const { t, i18n } = useTranslation("common");
  const b = useSettingsBackup();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<BackupInspect | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<BackupRestore | null>(null);
  const [reboot, setReboot] = useState(false);

  const onDownload = async () => {
    const r = await b.download();
    if (r.ok) toast.success(t(`${K}.toast.downloaded`));
    else toast.error(t(`${K}.errors.download_failed`));
  };

  const onPick = async (f: File | undefined) => {
    if (fileInput.current) fileInput.current.value = "";
    if (!f) return;
    setResult(null);
    setPreview(null);
    setFile(null);
    if (f.size > BACKUP_MAX_BYTES) {
      toast.error(t(`${K}.errors.too_large`));
      return;
    }
    const r = await b.inspect(f);
    if (r.ok) {
      setFile(f);
      setPreview(r.data);
    } else toast.error(errorText(t, r.code));
  };

  const onRestore = async () => {
    setConfirm(false);
    if (!file) return;
    const r = await b.restore(file);
    if (r.ok) {
      setResult(r.data);
      setPreview(null);
      setFile(null);
      toast.success(t(`${K}.toast.restored`, { n: r.data.restored }));
      setReboot(true);
    } else toast.error(errorText(t, r.code));
  };

  const fmt = (epoch: number) =>
    new Date(epoch * 1000).toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short" });

  return (
    <div className="@container/main flex flex-col gap-5 p-2">
      <div className="flex max-w-[41rem] flex-col gap-1.5">
        <h1 className="text-3xl font-bold tracking-[-0.02em]">{t(`${K}.page.title`)}</h1>
        <p className="text-on-surface-variant text-sm leading-relaxed text-pretty">{t(`${K}.page.description`)}</p>
      </div>

      <div className="grid grid-cols-1 items-start gap-5 *:min-w-0 @3xl/main:grid-cols-2">
        <Card className={CARD}>
          <CardHeader className={PAD}>
            <CardTitle className="text-lg leading-tight">{t(`${K}.save.title`)}</CardTitle>
            <CardDescription className="text-on-surface-variant text-sm">{t(`${K}.save.description`)}</CardDescription>
          </CardHeader>
          <CardContent className={cn(PAD, "flex flex-col gap-3")}>
            <div className="bg-surface-container flex flex-col gap-1.5 rounded-card px-4 py-3 text-sm">
              <span className="font-semibold">{t(`${K}.save.included_title`)}</span>
              <span className="text-on-surface-variant text-pretty">{t(`${K}.save.included`)}</span>
            </div>
            <div className="bg-surface-container flex items-start gap-3 rounded-card px-4 py-3 text-sm">
              <KeyRoundIcon className="text-on-surface-variant mt-0.5 size-4 flex-none" aria-hidden />
              <span className="text-on-surface-variant text-pretty">{t(`${K}.save.excluded`)}</span>
            </div>
          </CardContent>
          <CardFoot
            className={PAD}
            status={null}
            actions={
              <Button type="button" size="action" disabled={b.busy !== null} onClick={() => void onDownload()}>
                {b.busy === "download" ? (
                  <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden />
                ) : (
                  <DownloadIcon className="size-4" aria-hidden />
                )}
                {t(`${K}.save.download`)}
              </Button>
            }
          />
        </Card>

        <Card className={CARD}>
          <CardHeader className={PAD}>
            <CardTitle className="text-lg leading-tight">{t(`${K}.restore.title`)}</CardTitle>
            <CardDescription className="text-on-surface-variant text-sm">{t(`${K}.restore.description`)}</CardDescription>
          </CardHeader>
          <CardContent className={cn(PAD, "flex flex-col gap-[0.3125rem]")}>
            <input
              ref={fileInput}
              type="file"
              accept=".gz,.tgz,application/gzip"
              className="hidden"
              onChange={(e) => void onPick(e.target.files?.[0])}
            />
            {preview ? (
              <>
                <div className="mb-1 flex items-center gap-2">
                  <FileArchiveIcon className="text-on-surface-variant size-4" aria-hidden />
                  <span className="min-w-0 truncate font-mono text-[0.8125rem]">{file?.name}</span>
                </div>
                <Row label={t(`${K}.restore.created`)} value={preview.manifest.created ? fmt(preview.manifest.created) : ""} />
                <Row label={t(`${K}.restore.version`)} value={preview.manifest.version} />
                <Row label={t(`${K}.restore.model`)} value={preview.manifest.model} />
                <Row label={t(`${K}.restore.files`)} value={String(preview.files.length)} />
                <details className="pt-2">
                  <summary className="text-on-surface-variant cursor-pointer text-sm">{t(`${K}.restore.show_files`)}</summary>
                  <ul className="bg-surface-container mt-2 max-h-48 overflow-auto rounded-field p-3 font-mono text-xs leading-5">
                    {preview.files.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </details>
                <p className="text-on-surface-variant pt-2 text-sm text-pretty">{t(`${K}.restore.overwrite_note`)}</p>
              </>
            ) : result ? (
              <div className="flex flex-col gap-2">
                <Badge variant="success">
                  <CheckCircle2Icon className="size-3" aria-hidden />
                  {t(`${K}.restore.done`, { n: result.restored })}
                </Badge>
                {result.secrets_missing.length > 0 ? (
                  <div className="bg-surface-container flex flex-col gap-1.5 rounded-card px-4 py-3 text-sm">
                    <span className="flex items-center gap-2 font-semibold">
                      <TriangleAlertIcon className="text-warning size-4" aria-hidden />
                      {t(`${K}.restore.secrets_title`)}
                    </span>
                    <ul className="flex flex-col gap-1">
                      {result.secrets_missing.map((s) => (
                        <li key={s}>
                          <Link
                            href={SECRET_WHERE[s] ?? "/monitoring/alerts"}
                            className="text-primary-on-surface font-medium underline-offset-4 hover:underline"
                          >
                            {t(`${K}.secret.${s}`, { defaultValue: s })}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <p className="text-on-surface-variant text-sm text-pretty">{t(`${K}.restore.reboot_note`)}</p>
              </div>
            ) : (
              <p className="text-on-surface-variant py-2 text-sm text-pretty">{t(`${K}.restore.pick_hint`)}</p>
            )}
          </CardContent>
          <CardFoot
            className={PAD}
            status={null}
            actions={
              <>
                {preview ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="action"
                    disabled={b.busy !== null}
                    onClick={() => {
                      setPreview(null);
                      setFile(null);
                    }}
                  >
                    {t(`${K}.restore.cancel`)}
                  </Button>
                ) : null}
                {result && !preview ? (
                  <Button type="button" variant="tonal-neutral" size="action" onClick={() => setReboot(true)}>
                    {t(`${K}.reboot.now`)}
                  </Button>
                ) : null}
                {preview ? (
                  <Button type="button" size="action" disabled={b.busy !== null} onClick={() => setConfirm(true)}>
                    {b.busy === "restore" ? <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden /> : null}
                    {t(`${K}.restore.restore`)}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant={result ? "tonal-neutral" : "default"}
                    size="action"
                    disabled={b.busy !== null}
                    onClick={() => fileInput.current?.click()}
                  >
                    {b.busy === "inspect" ? (
                      <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden />
                    ) : (
                      <UploadIcon className="size-4" aria-hidden />
                    )}
                    {t(`${K}.restore.choose`)}
                  </Button>
                )}
              </>
            }
          />
        </Card>
      </div>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(`${K}.confirm.title`)}</AlertDialogTitle>
            <AlertDialogDescription>{t(`${K}.confirm.description`)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(`${K}.restore.cancel`)}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onRestore()}>{t(`${K}.restore.restore`)}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <RebootDialog open={reboot} onOpenChange={setReboot} />
    </div>
  );
}
