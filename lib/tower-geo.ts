// Geodesy for the Tower Map: spherical-earth math, accurate to well under 1% at the
// few-kilometre distances a serving cell sits at.

const R = 6371008.8; // mean earth radius, metres
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export interface LatLon {
  lat: number;
  lon: number;
}

/** Great-circle distance in metres. */
export function distanceM(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial true bearing from a to b, 0–360° clockwise from north. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** The point `distance` metres from `from` along true bearing `bearing`. */
export function destination(from: LatLon, bearing: number, distance: number): LatLon {
  const d = distance / R;
  const b = rad(bearing);
  const la1 = rad(from.lat);
  const lo1 = rad(from.lon);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
  const lo2 =
    lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { lat: deg(la2), lon: ((deg(lo2) + 540) % 360) - 180 };
}

/**
 * Magnetic declination for Lithuania, about +7 to +9° east in 2026 (WMM).
 * A compass reads true bearing minus this.
 */
export const LT_DECLINATION_DEG = 8;

export function magneticBearing(trueBearing: number, declination = LT_DECLINATION_DEG): number {
  return (trueBearing - declination + 360) % 360;
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export function compassPoint(bearing: number): string {
  return COMPASS[Math.round(bearing / 22.5) % 16];
}

/** LTE timing advance is quantised in 16·Ts steps: one step is 78.125 m of one-way distance. */
export const LTE_TA_STEP_M = 78.125;

export interface TowerRow {
  /** "L" LTE eNB, "N" NR gNB */
  r: "L" | "N";
  m: number;
  e: number;
  la: number;
  lo: number;
  /** sectors (cells) merged into this row */
  c: number;
  /** measurement samples */
  s: number;
  /** last update, epoch seconds */
  u: number;
  /** largest reported cell range, metres */
  g: number;
}

export interface TowerIndex {
  mcc: number;
  generated: string;
  built: number;
  towers: TowerRow[];
}

export const towerKey = (mcc: number, mnc: number, id: number) => `${mcc}-${mnc}-${id}`;

/** Distance check between where the database puts a tower and what timing advance measures. */
export function taAgreement(dbDistanceM: number, taDistanceM: number): "agrees" | "off" {
  // TA has one step of uncertainty plus multipath; beyond ~2 steps the position is suspect.
  return Math.abs(dbDistanceM - taDistanceM) <= Math.max(2 * LTE_TA_STEP_M, taDistanceM * 0.15)
    ? "agrees"
    : "off";
}

export function cellMapperUrl(mcc: number, mnc: number, at: LatLon, nr: boolean): string {
  const q = new URLSearchParams({
    MCC: String(mcc),
    MNC: String(mnc),
    type: nr ? "NR" : "LTE",
    latitude: at.lat.toFixed(5),
    longitude: at.lon.toFixed(5),
    zoom: "15",
  });
  return `https://www.cellmapper.net/map?${q.toString()}`;
}
