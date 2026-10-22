"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ConditionScreen } from "@/components/cellular/condition-screen";
import { simPlmnFromImsi } from "@/components/cellular/cell-scanner/sim-plmn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MaterialSymbol } from "@/components/ui/material-symbol";
import { SegmentedField, SEGMENTED } from "@/components/ui/segmented-field";
import { Skeleton } from "@/components/ui/skeleton";
import { useModemStatus } from "@/hooks/use-modem-status";
import { useTowerMap } from "@/hooks/use-tower-map";
import {
  bearingDeg,
  cellMapperUrl,
  compassPoint,
  distanceM,
  magneticBearing,
  taAgreement,
  towerIdFromCell,
  towerKey,
  type LatLon,
} from "@/lib/tower-geo";
import { Tag } from "@/components/ui/tag";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { calculateLteDistance, calculateNrDistance } from "@/types/modem-status";

import type { BaseLayer, MapMode, MapTower } from "./map-view";

const MapView = dynamic(() => import("./map-view"), {
  ssr: false,
  loading: () => <Skeleton className="h-[22rem] w-full rounded-card @3xl/main:h-[32rem]" />,
});

const K = "tower_map";
const NEARBY_M = 25_000;

const CARD = "@container/card gap-5 rounded-card border-0 bg-surface py-6 shadow-sm";
const PAD = "px-7";
const ROW = "flex items-center justify-between gap-4 rounded-pill bg-surface-container px-4 py-[0.6875rem]";
const ROW_LABEL = "text-[0.8125rem] font-semibold leading-5 text-on-surface-variant";
const ROW_VALUE = "min-w-0 truncate text-right text-[0.8125rem] font-semibold leading-5 tabular-nums";

function fmtDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10_000 ? 2 : 1)} km`;
}

interface ScannedTower {
  key: string;
  r: "L" | "N";
  mnc: number;
  id: number;
  provider: string;
  bands: number[];
  rsrp: number;
  at: LatLon | null;
}

function Row({ label, value, children }: { label: string; value?: string; children?: React.ReactNode }) {
  return (
    <div className={ROW}>
      <span className={cn(ROW_LABEL, "shrink-0")}>{label}</span>
      {children ?? <span className={ROW_VALUE}>{value || "—"}</span>}
    </div>
  );
}

export default function TowerMapComponent() {
  const { t, i18n } = useTranslation("cellular");
  const { data, isLoading: statusLoading, error: statusError } = useModemStatus();

  const plmn = simPlmnFromImsi(data?.device?.imsi);
  const mcc = plmn?.mcc ?? null;
  const mnc = plmn?.mncs[0] ?? null;
  const tm = useTowerMap(mcc);

  const [mode, setMode] = useState<MapMode>("view");
  const [aimKey, setAimKey] = useState<string | null>(null);
  const [layer, setLayer] = useState<BaseLayer>("map");

  // Serving cell identity: the NR gNB in SA, the LTE eNB otherwise (NSA anchors on LTE).
  const isSA = data?.network?.type === "5G-SA";
  const radio: "L" | "N" = isSA && data?.nr?.enodeb_id ? "N" : "L";
  const servingId = radio === "N" ? (data?.nr?.enodeb_id ?? null) : (data?.lte?.enodeb_id ?? null);
  const taKm = radio === "N" ? calculateNrDistance(data?.nr?.ta ?? null) : calculateLteDistance(data?.lte?.ta ?? null);
  const taM = taKm !== null ? taKm * 1000 : null;
  const key = mcc !== null && mnc !== null && servingId !== null ? towerKey(mcc, mnc, servingId) : null;

  const home = tm.state?.home ?? null;
  const override = key ? tm.state?.overrides[key] : undefined;
  const row = useMemo(
    () => tm.index?.towers.find((r) => r.r === radio && r.m === mnc && r.e === servingId) ?? null,
    [tm.index, radio, mnc, servingId],
  );
  const towerAt: LatLon | null = override ?? (row ? { lat: row.la, lon: row.lo } : null);
  const source: "yours" | "database" | "missing" = override ? "yours" : row ? "database" : "missing";

  const dist = home && towerAt ? distanceM(home, towerAt) : null;
  const bearing = home && towerAt ? bearingDeg(home, towerAt) : null;
  const agreement = dist !== null && taM !== null ? taAgreement(dist, taM) : null;
  const idLabel = radio === "N" ? "gNB" : "eNB";

  const towerLabel = (id: number, at: LatLon, prefix: string = idLabel) => {
    if (!home) return `${prefix} ${id}`;
    const b = bearingDeg(home, at);
    return `${prefix} ${id} · ${fmtDistance(distanceM(home, at))} · ${Math.round(b)}° ${compassPoint(b)}`;
  };

  const serving = useMemo(
    () =>
      towerAt && servingId !== null && key
        ? { key, at: towerAt, label: towerLabel(servingId, towerAt), corrected: source === "yours" }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [towerAt?.lat, towerAt?.lon, servingId, key, source, home?.lat, home?.lon],
  );

  const others: MapTower[] = useMemo(() => {
    const centre = home ?? towerAt;
    if (!tm.index || mnc === null || mcc === null || !centre) return [];
    return tm.index.towers
      .filter((r) => r.m === mnc && !(r.r === radio && r.e === servingId))
      .map((r) => {
        const k = towerKey(mcc, mnc, r.e);
        const at = tm.state?.overrides[k] ?? { lat: r.la, lon: r.lo };
        return { key: `${r.r}-${k}`, at, label: towerLabel(r.e, at) };
      })
      .filter((o) => distanceM(centre, o.at) <= NEARBY_M);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tm.index, tm.state?.overrides, mnc, mcc, radio, servingId, home?.lat, home?.lon, towerAt?.lat, towerAt?.lon]);

  // Towers from the last Cell Scanner sweep, located through the same index and corrections.
  const indexMap = useMemo(() => {
    const m = new Map<string, { lat: number; lon: number }>();
    for (const r of tm.index?.towers ?? []) m.set(`${r.r}|${r.m}|${r.e}`, { lat: r.la, lon: r.lo });
    return m;
  }, [tm.index]);

  const scanned: ScannedTower[] = useMemo(() => {
    const cells = tm.state?.scan?.cells ?? [];
    if (mcc === null) return [];
    const groups = new Map<string, ScannedTower>();
    for (const c of cells) {
      if (c.mcc !== mcc || !c.cell) continue;
      const r: "L" | "N" = c.type === "NR5G" ? "N" : "L";
      const id = towerIdFromCell(r, c.cell);
      const k = `${r}-${towerKey(mcc, c.mnc, id)}`;
      const g = groups.get(k) ?? { key: k, r, mnc: c.mnc, id, provider: c.provider, bands: [], rsrp: c.rsrp, at: null };
      if (c.band && !g.bands.includes(c.band)) g.bands.push(c.band);
      if (c.rsrp > g.rsrp) g.rsrp = c.rsrp;
      groups.set(k, g);
    }
    const out = [...groups.values()];
    for (const g of out) {
      g.bands.sort((a, b) => a - b);
      g.at = tm.state?.overrides[towerKey(mcc, g.mnc, g.id)] ?? indexMap.get(`${g.r}|${g.mnc}|${g.id}`) ?? null;
    }
    return out.sort((a, b) => b.rsrp - a.rsrp);
  }, [tm.state?.scan, tm.state?.overrides, indexMap, mcc]);

  const scannedOnMap: MapTower[] = useMemo(
    () =>
      scanned
        .filter((g) => g.at)
        .map((g) => ({
          key: `scan-${g.key}`,
          at: g.at!,
          label: `${g.provider} · ${towerLabel(g.id, g.at!, g.r === "N" ? "gNB" : "eNB")} · ${g.rsrp} dBm`,
        })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scanned, home?.lat, home?.lon],
  );
  const aim = scanned.find((g) => g.key === aimKey && g.at)?.at ?? null;

  // --- Handlers (each finished mutation toasts once) ---------------------------
  const onMapClick = async (p: LatLon) => {
    if (mode === "set_home") {
      const r = await tm.saveHome(p);
      if (r.ok) toast.success(t(`${K}.toast.home_saved`));
      else toast.error(t(`${K}.toast.save_failed`));
      setMode("view");
    } else if (mode === "move_tower" && key) {
      await placeTower(p);
    }
  };
  const placeTower = async (p: LatLon) => {
    if (!key) return;
    const r = await tm.setOverride(key, p);
    if (r.ok) toast.success(t(`${K}.toast.tower_saved`));
    else toast.error(t(`${K}.toast.save_failed`));
    setMode("view");
  };
  const resetTower = async () => {
    if (!key) return;
    const r = await tm.clearOverride(key);
    if (r.ok) toast.success(t(`${K}.toast.tower_reset`));
    else toast.error(t(`${K}.toast.save_failed`));
  };
  const updateDb = async () => {
    const r = await tm.updateDb();
    if (r.ok) toast.success(t(`${K}.toast.db_updated`));
    else toast.error(t(`${K}.db.errors.${r.code ?? "download_failed"}`, { defaultValue: t(`${K}.db.errors.download_failed`) }));
  };

  // --- Conditions ----------------------------------------------------------------
  const header = (
    <div className="flex max-w-[41rem] flex-col gap-1.5">
      <h1 className="text-3xl font-bold tracking-[-0.02em]">{t(`${K}.page.title`)}</h1>
      <p className="text-on-surface-variant text-sm leading-relaxed text-pretty">{t(`${K}.page.description`)}</p>
    </div>
  );

  if ((statusLoading && !data) || (tm.isLoading && !tm.state)) {
    return (
      <div className="@container/main flex flex-col gap-5 p-2" aria-busy="true">
        {header}
        <Skeleton className="h-[22rem] w-full rounded-card @3xl/main:h-[32rem]" />
      </div>
    );
  }
  if (tm.error && !tm.state) {
    return (
      <div className="@container/main flex flex-col gap-5 p-2">
        {header}
        <ConditionScreen
          tone="destructive"
          glyph="error"
          ariaRole="alert"
          title={t(`${K}.condition.load_failed_title`)}
          description={t(`${K}.condition.load_failed_desc`)}
          onRetry={() => void tm.refresh()}
          retryLabel={t(`${K}.condition.retry`)}
        />
      </div>
    );
  }
  if (!plmn) {
    return (
      <div className="@container/main flex flex-col gap-5 p-2">
        {header}
        <ConditionScreen
          tone="neutral"
          glyph="sim_card_alert"
          ariaRole="status"
          title={t(`${K}.condition.no_sim_title`)}
          description={statusError ? t(`${K}.condition.load_failed_desc`) : t(`${K}.condition.no_sim_desc`)}
        />
      </div>
    );
  }

  const db = tm.state?.databases.find((d) => d.mcc === mcc) ?? null;
  const modeHint =
    mode === "set_home"
      ? t(`${K}.map.hint_home`)
      : mode === "move_tower"
        ? towerAt
          ? t(`${K}.map.hint_move`)
          : t(`${K}.map.hint_place`)
        : !home
          ? t(`${K}.map.hint_no_home`)
          : null;

  return (
    <div className="@container/main flex flex-col gap-5 p-2">
      {header}

      <Card className={CARD}>
        <CardHeader className={cn(PAD, "flex flex-wrap items-center justify-between gap-3")}>
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle className="text-lg leading-tight">{t(`${K}.map.title`)}</CardTitle>
            <CardDescription className="text-on-surface-variant text-sm">{t(`${K}.map.description`)}</CardDescription>
          </div>
          <SegmentedField
            value={layer}
            onValueChange={(v) => setLayer(v as BaseLayer)}
            options={[
              { value: "map", label: t(`${K}.map.layer_map`) },
              { value: "satellite", label: t(`${K}.map.layer_satellite`) },
            ]}
            ariaLabel={t(`${K}.map.layer_label`)}
            breakpoint="never"
            glyph={(className) => (
              <MaterialSymbol name="check" filled size={SEGMENTED.GLYPH} aria-hidden="true" className={className} />
            )}
          />
        </CardHeader>
        <CardContent className={cn(PAD, "flex flex-col gap-3")}>
          <MapView
            home={home}
            serving={serving}
            others={others}
            scanned={scannedOnMap}
            aim={aim}
            taRadiusM={taM}
            mode={mode}
            layer={layer}
            onMapClick={(p) => void onMapClick(p)}
            onTowerDrag={(p) => void placeTower(p)}
            ariaLabel={t(`${K}.map.aria`)}
          />
          <div className="flex flex-wrap items-center gap-2.5">
            <Button
              type="button"
              size="action"
              variant={mode === "set_home" ? "default" : "tonal-neutral"}
              onClick={() => setMode(mode === "set_home" ? "view" : "set_home")}
            >
              <MaterialSymbol name="my_location" size={18} />
              {t(`${K}.map.set_home`)}
            </Button>
            {key ? (
              <Button
                type="button"
                size="action"
                variant={mode === "move_tower" ? "default" : "tonal-neutral"}
                onClick={() => setMode(mode === "move_tower" ? "view" : "move_tower")}
              >
                <MaterialSymbol name="edit" size={18} />
                {towerAt ? t(`${K}.map.move_tower`) : t(`${K}.map.place_tower`)}
              </Button>
            ) : null}
            {override ? (
              <Button type="button" size="action" variant="ghost" onClick={() => void resetTower()}>
                <MaterialSymbol name="restart_alt" size={18} />
                {t(`${K}.map.reset_tower`)}
              </Button>
            ) : null}
            {modeHint ? <p className="text-on-surface-variant text-sm text-pretty">{modeHint}</p> : null}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-5 *:min-w-0 @3xl/main:grid-cols-2">
        <Card className={CARD}>
          <CardHeader className={PAD}>
            <CardTitle className="text-lg leading-tight">{t(`${K}.serving.title`)}</CardTitle>
            <CardDescription className="text-on-surface-variant text-sm">{t(`${K}.serving.description`)}</CardDescription>
          </CardHeader>
          <CardContent className={cn(PAD, "flex flex-col gap-[0.3125rem]")}>
            {servingId === null ? (
              <p className="text-on-surface-variant text-sm">{t(`${K}.serving.no_cell`)}</p>
            ) : (
              <>
                <Row label={t(`${K}.serving.tower`)} value={`${idLabel} ${servingId} · ${data?.network?.carrier || `${mcc}-${mnc}`}`} />
                <Row label={t(`${K}.serving.position`)}>
                  <Badge variant={source === "yours" ? "success" : source === "database" ? "info" : "warning"}>
                    <MaterialSymbol name={source === "yours" ? "check_circle" : source === "database" ? "info" : "warning"} size={12} />
                    {t(`${K}.serving.source.${source}`)}
                  </Badge>
                </Row>
                <Row label={t(`${K}.serving.distance`)} value={dist !== null ? fmtDistance(dist) : ""} />
                <Row
                  label={t(`${K}.serving.measured`)}
                  value={taM !== null ? `${fmtDistance(taM)} (TA ${radio === "N" ? data?.nr?.ta : data?.lte?.ta})` : ""}
                />
                {agreement ? (
                  <Row label={t(`${K}.serving.check`)}>
                    <Badge variant={agreement === "agrees" ? "success" : "warning"}>
                      <MaterialSymbol name={agreement === "agrees" ? "check_circle" : "warning"} size={12} />
                      {t(`${K}.serving.agreement.${agreement}`)}
                    </Badge>
                  </Row>
                ) : null}
                <Row
                  label={t(`${K}.serving.azimuth`)}
                  value={bearing !== null ? `${Math.round(bearing)}° ${compassPoint(bearing)}` : ""}
                />
                <Row
                  label={t(`${K}.serving.compass`)}
                  value={bearing !== null ? `≈ ${Math.round(magneticBearing(bearing))}°` : ""}
                />
                {agreement === "off" ? (
                  <p className="text-on-surface-variant pt-1 text-sm text-pretty">{t(`${K}.serving.off_hint`)}</p>
                ) : null}
                {mcc !== null && mnc !== null ? (
                  <a
                    href={cellMapperUrl(mcc, mnc, towerAt ?? home ?? { lat: 55.17, lon: 23.88 }, radio === "N")}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary-on-surface inline-flex items-center gap-1 pt-2 text-sm font-medium underline-offset-4 hover:underline"
                  >
                    {t(`${K}.serving.cellmapper`)}
                    <MaterialSymbol name="open_in_new" size={14} />
                  </a>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>

        <Card className={CARD}>
          <CardHeader className={PAD}>
            <CardTitle className="text-lg leading-tight">{t(`${K}.db.title`)}</CardTitle>
            <CardDescription className="text-on-surface-variant text-sm">{t(`${K}.db.description`)}</CardDescription>
          </CardHeader>
          <CardContent className={cn(PAD, "flex flex-col gap-[0.3125rem]")}>
            <Row label={t(`${K}.db.towers`)} value={db ? String(db.towers) : t(`${K}.db.none`)} />
            <Row label={t(`${K}.db.updated`)} value={db?.generated ? db.generated.slice(0, 10) : ""} />
            <Row label={t(`${K}.db.corrections`)} value={String(Object.keys(tm.state?.overrides ?? {}).length)} />
            <div className="flex flex-wrap items-center gap-2.5 pt-2">
              <Button type="button" size="action" onClick={() => void updateDb()} disabled={tm.isUpdating}>
                <MaterialSymbol name={tm.isUpdating ? "progress_activity" : "download"} size={18} className={tm.isUpdating ? "motion-safe:animate-spin" : undefined} />
                {tm.isUpdating ? t(`${K}.db.updating`) : db ? t(`${K}.db.update`) : t(`${K}.db.download`)}
              </Button>
            </div>
            <p className="text-on-surface-variant pt-1 text-xs text-pretty">{t(`${K}.db.coverage_note`)}</p>
            <p className="text-on-surface-variant text-xs">{tm.state?.attribution}</p>
          </CardContent>
        </Card>
      </div>

      <Card className={CARD}>
        <CardHeader className={PAD}>
          <CardTitle className="text-lg leading-tight">{t(`${K}.scan.title`)}</CardTitle>
          <CardDescription className="text-on-surface-variant text-sm">
            {tm.state?.scan
              ? t(`${K}.scan.description_at`, {
                  time: new Date(tm.state.scan.at * 1000).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" }),
                })
              : t(`${K}.scan.description`)}
          </CardDescription>
        </CardHeader>
        <CardContent className={cn(PAD, "flex flex-col gap-[0.3125rem]")}>
          {scanned.length === 0 ? (
            <p className="text-on-surface-variant py-2 text-sm text-pretty">
              {t(`${K}.scan.empty`)}{" "}
              <Link href="/cellular/cell-scanner" className="text-primary-on-surface font-medium underline-offset-4 hover:underline">
                {t(`${K}.scan.open_scanner`)}
              </Link>
            </p>
          ) : (
            scanned.map((g) => {
              const d = home && g.at ? distanceM(home, g.at) : null;
              const b = home && g.at ? bearingDeg(home, g.at) : null;
              const selected = aimKey === g.key;
              return (
                <div
                  key={g.key}
                  className={cn(
                    "flex flex-col gap-2 rounded-card px-4 py-3 @2xl/card:flex-row @2xl/card:items-center @2xl/card:justify-between",
                    selected ? "bg-primary-container text-on-primary-container" : "bg-surface-container",
                  )}
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
                      <span className="truncate">{g.provider}</span>
                      <span className="text-[0.8125rem] font-medium tabular-nums opacity-80">
                        {g.r === "N" ? "gNB" : "eNB"} {g.id}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      {g.bands.map((band) => (
                        <Tag key={band} variant={g.r === "N" ? "nr" : "lte"}>
                          {g.r === "N" ? `n${band}` : `B${band}`}
                        </Tag>
                      ))}
                      <span className="text-xs font-semibold tabular-nums">{g.rsrp} dBm</span>
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[0.8125rem] font-semibold tabular-nums">
                    {!g.at ? (
                      <Badge variant="muted">
                        <MaterialSymbol name="location_on" size={12} />
                        {t(`${K}.scan.not_in_db`)}
                      </Badge>
                    ) : d !== null && b !== null ? (
                      <>
                        <span>{fmtDistance(d)}</span>
                        <span>
                          {Math.round(b)}° {compassPoint(b)}
                        </span>
                        <span className="opacity-80">
                          {t(`${K}.scan.compass_short`, { deg: Math.round(magneticBearing(b)) })}
                        </span>
                      </>
                    ) : (
                      <span className="opacity-80">{t(`${K}.scan.set_home_first`)}</span>
                    )}
                    {g.at && home ? (
                      <Button
                        type="button"
                        size="action"
                        variant={selected ? "default" : "tonal-neutral"}
                        onClick={() => setAimKey(selected ? null : g.key)}
                        aria-pressed={selected}
                      >
                        <MaterialSymbol name="explore" size={18} />
                        {selected ? t(`${K}.scan.aiming`) : t(`${K}.scan.aim`)}
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
