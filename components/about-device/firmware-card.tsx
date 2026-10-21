"use client";

import * as React from "react";
import {
  CheckCircle2Icon,
  CopyIcon,
  HelpCircleIcon,
  InfoIcon,
  TriangleAlertIcon,
  XCircleIcon,
} from "lucide-react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tag } from "@/components/ui/tag";
import { copyText } from "@/lib/clipboard";
import { checkPackage, parseFirmwareRevision, type PackageVerdict } from "@/lib/firmware-package";
import { staggerItem } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { AboutDeviceData } from "@/types/about-device";

import { Group, GroupStack, SlotRow, ValueRow } from "./metric-rows";
import {
  CARD_DESC,
  CARD_PAD,
  CARD_SHELL,
  CARD_TITLE,
  GROUP_LABEL,
  type AboutView,
} from "./shapes";

const K = "aboutDevice.firmware";
const INPUT_ID = "firmware-package-name";
const FLASH_COMMAND = "sudo ./QFirehose -f ./<firmware-folder>";

const VERDICT: Record<
  PackageVerdict["kind"],
  { variant: BadgeVariant; Icon: typeof CheckCircle2Icon }
> = {
  newer: { variant: "success", Icon: CheckCircle2Icon },
  same: { variant: "info", Icon: InfoIcon },
  older: { variant: "warning", Icon: TriangleAlertIcon },
  wrong_variant: { variant: "destructive", Icon: XCircleIcon },
  wrong_model: { variant: "destructive", Icon: XCircleIcon },
  unrecognized: { variant: "muted", Icon: HelpCircleIcon },
  unknown_installed: { variant: "muted", Icon: HelpCircleIcon },
};

/** The build with an application suffix carries more detail, so prefer it. */
function installedRevision(data: AboutDeviceData | null): string {
  if (!data) return "";
  const candidates = [data.system.openwrt_version, data.device.firmware];
  return (
    candidates.find((c) => parseFirmwareRevision(c)?.app) ??
    candidates.find((c) => parseFirmwareRevision(c)) ??
    data.device.firmware ??
    ""
  );
}

export interface FirmwareCardProps {
  view: AboutView;
  data: AboutDeviceData | null;
}

/**
 * Firmware updates are flashed from a computer over USB: this modem runs the
 * page, so it cannot flash itself. The card checks a package name before that.
 */
export function FirmwareCard({ view, data }: FirmwareCardProps): React.JSX.Element | null {
  const { t } = useTranslation("common");
  const [pkgName, setPkgName] = React.useState("");

  if (view !== "loaded" || !data) return null;

  const installed = installedRevision(data);
  const parsed = parseFirmwareRevision(installed);
  const verdict = pkgName.trim() ? checkPackage(pkgName, installed) : null;

  const handleCopy = async () => {
    if (await copyText(FLASH_COMMAND)) toast.success(t(`${K}.copied`));
    else toast.error(t(`${K}.copy_failed`));
  };

  return (
    <motion.div variants={staggerItem}>
      <Card className={CARD_SHELL}>
        <CardHeader className={CARD_PAD}>
          <CardTitle className={CARD_TITLE}>{t(`${K}.title`)}</CardTitle>
          <CardDescription className={CARD_DESC}>{t(`${K}.description`)}</CardDescription>
        </CardHeader>

        <CardContent className={cn(CARD_PAD, "grid grid-cols-1 gap-6 *:min-w-0 @3xl/card:grid-cols-2")}>
          <GroupStack>
            <Group>
              <ValueRow label={t(`${K}.installed`)} value={installed} mono />
              <SlotRow label={t(`${K}.variant`)}>
                <Tag variant="neutral">{parsed?.variant ?? "—"}</Tag>
              </SlotRow>
            </Group>

            <div className="flex flex-col gap-2">
              <label htmlFor={INPUT_ID} className={GROUP_LABEL}>
                {t(`${K}.check_label`)}
              </label>
              <Input
                id={INPUT_ID}
                value={pkgName}
                onChange={(e) => setPkgName(e.target.value)}
                placeholder={parsed ? `${parsed.model}${parsed.variant}AAR03A04M4G_01.200.01.200` : ""}
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-sm"
                aria-describedby={verdict ? `${INPUT_ID}-verdict` : undefined}
              />
              {verdict ? (
                <div id={`${INPUT_ID}-verdict`} aria-live="polite" className="flex flex-col gap-1.5">
                  <Badge variant={VERDICT[verdict.kind].variant}>
                    {React.createElement(VERDICT[verdict.kind].Icon, { className: "size-3" })}
                    {t(`${K}.verdict.${verdict.kind}.chip`)}
                  </Badge>
                  <p className="text-on-surface-variant text-sm text-pretty">
                    {t(`${K}.verdict.${verdict.kind}.text`, {
                      pkg: "pkg" in verdict ? verdict.pkg.variant : "",
                      installed: "installed" in verdict ? verdict.installed.variant : "",
                    })}
                  </p>
                </div>
              ) : (
                <p className="text-on-surface-variant text-sm text-pretty">{t(`${K}.check_hint`)}</p>
              )}
            </div>
          </GroupStack>

          <div className="flex flex-col gap-3">
            <span className={GROUP_LABEL}>{t(`${K}.steps_label`)}</span>
            <ol className="text-on-surface flex list-decimal flex-col gap-2 pl-5 text-sm leading-relaxed">
              <li>{t(`${K}.steps.download`, { variant: parsed?.variant ?? "" })}</li>
              <li>{t(`${K}.steps.connect`)}</li>
              <li>
                {t(`${K}.steps.run`)}
                <div className="mt-2 flex items-center gap-2">
                  <code className="bg-surface-container min-w-0 flex-1 overflow-x-auto rounded-field px-3 py-2 font-mono text-xs whitespace-nowrap">
                    {FLASH_COMMAND}
                  </code>
                  <Button
                    type="button"
                    variant="tonal-neutral"
                    size="icon"
                    onClick={handleCopy}
                    aria-label={t(`${K}.copy`)}
                  >
                    <CopyIcon className="size-4" aria-hidden />
                  </Button>
                </div>
              </li>
              <li>{t(`${K}.steps.after`)}</li>
            </ol>
            <Badge variant="warning" className="whitespace-normal text-left">
              <TriangleAlertIcon className="size-3" aria-hidden />
              {t(`${K}.warning`)}
            </Badge>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

export default FirmwareCard;
