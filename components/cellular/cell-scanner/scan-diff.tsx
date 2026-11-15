"use client";

import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { MaterialSymbol } from "@/components/ui/material-symbol";
import { Tag } from "@/components/ui/tag";
import type { CellScanDiff, CellScanDiffCell } from "@/types/cell-scanner";

import { BADGE_GLYPH_SIZE, SCAN_RESULTS_CARD, SECTION_HEAD } from "./shapes";

const ROW = "flex items-center justify-between gap-4 rounded-pill bg-surface-container px-4 py-[0.6875rem]";
const MAX_ROWS = 20;

function CellRow({ c, gone }: { c: CellScanDiffCell; gone: boolean }) {
  const { t } = useTranslation("cellular");
  return (
    <li className={ROW}>
      <span className="flex min-w-0 items-center gap-2">
        {gone ? (
          <Badge variant="muted">
            <MaterialSymbol name="do_not_disturb_on" size={BADGE_GLYPH_SIZE} />
            {t("cell_scanner.diff.gone_chip")}
          </Badge>
        ) : (
          <Badge variant="info">
            <MaterialSymbol name="add" size={BADGE_GLYPH_SIZE} />
            {t("cell_scanner.diff.new_chip")}
          </Badge>
        )}
        <span className="min-w-0 truncate text-[0.8125rem] font-semibold">{c.provider}</span>
        <Tag variant={c.networkType === "NR5G" ? "nr" : "lte"} className="shrink-0">{c.networkType === "NR5G" ? `n${c.band}` : `B${c.band}`}</Tag>
      </span>
      <span className="text-on-surface-variant flex shrink-0 gap-3 text-[0.8125rem] font-semibold tabular-nums">
        <span>{t("cell_scanner.diff.pci", { pci: c.pci })}</span>
        <span>{t(c.networkType === "NR5G" ? "cell_scanner.diff.nrarfcn" : "cell_scanner.diff.earfcn", { earfcn: c.earfcn })}</span>
      </span>
    </li>
  );
}

export default function ScanDiffCard({ diff }: { diff: CellScanDiff }) {
  const { t, i18n } = useTranslation("cellular");
  const when =
    diff.previous_at !== null
      ? new Date(diff.previous_at * 1000).toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short" })
      : null;
  const rows = [...diff.new.map((c) => ({ c, gone: false })), ...diff.gone.map((c) => ({ c, gone: true }))];

  return (
    <Card className={SCAN_RESULTS_CARD}>
      <div className={SECTION_HEAD.ROOT}>
        <div className={SECTION_HEAD.TITLES}>
          <CardTitle as="h2" className={SECTION_HEAD.TITLE}>
            {t("cell_scanner.diff.title")}
          </CardTitle>
          <CardDescription className={SECTION_HEAD.DESC}>
            {when ? t("cell_scanner.diff.description_at", { when }) : t("cell_scanner.diff.description")}
          </CardDescription>
        </div>
      </div>
      {rows.length === 0 ? (
        <Badge variant="success" className="self-start">
          <MaterialSymbol name="check_circle" size={BADGE_GLYPH_SIZE} />
          {t("cell_scanner.diff.same")}
        </Badge>
      ) : (
        <ul className="flex flex-col gap-[0.3125rem]">
          {rows.slice(0, MAX_ROWS).map(({ c, gone }) => (
            <CellRow key={`${gone ? "g" : "n"}-${c.networkType}-${c.earfcn}-${c.pci}-${c.provider}`} c={c} gone={gone} />
          ))}
        </ul>
      )}
    </Card>
  );
}
