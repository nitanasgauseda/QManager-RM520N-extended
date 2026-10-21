"use client";

import { useEffect, useRef } from "react";
import type * as Leaflet from "leaflet";
import "leaflet/dist/leaflet.css";

import type { LatLon } from "@/lib/tower-geo";

// Leaflet is imperative and touches `window` on import, so it loads inside an
// effect and the map is rebuilt from props, never from React state.

export type MapMode = "view" | "set_home" | "move_tower";
export type BaseLayer = "map" | "satellite";

export interface MapTower {
  key: string;
  at: LatLon;
  /** Plain text for the popup; escaped before it reaches the DOM. */
  label: string;
}

export interface MapViewProps {
  home: LatLon | null;
  serving: (MapTower & { corrected: boolean }) | null;
  others: MapTower[];
  /** Timing-advance distance, metres: drawn as a ring around home. */
  taRadiusM: number | null;
  mode: MapMode;
  layer: BaseLayer;
  /** Fires for a map click in any mode but "view". */
  onMapClick: (p: LatLon) => void;
  /** Fires when the serving tower marker is dropped in "move_tower" mode. */
  onTowerDrag: (p: LatLon) => void;
  ariaLabel: string;
}

const LT_CENTER: [number, number] = [55.17, 23.88];

const TILES: Record<BaseLayer, { url: string; attribution: string; maxZoom: number }> = {
  map: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
    maxZoom: 19,
  },
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
    maxZoom: 19,
  },
};
const OCID_ATTRIBUTION =
  'Towers &copy; <a href="https://opencellid.org" target="_blank" rel="noreferrer">OpenCelliD</a> CC BY-SA 4.0';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const DOT = (cls: string, size: number) =>
  `<span class="block rounded-full border-2 border-white shadow ${cls}" style="width:${size}px;height:${size}px"></span>`;

export function MapView(props: MapViewProps) {
  const el = useRef<HTMLDivElement>(null);
  const L = useRef<typeof Leaflet | null>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const tiles = useRef<Leaflet.TileLayer | null>(null);
  const overlay = useRef<Leaflet.LayerGroup | null>(null);
  const fitted = useRef(0);
  const latest = useRef(props);

  useEffect(() => {
    latest.current = props;
  });

  // Create once.
  useEffect(() => {
    let cancelled = false;
    void import("leaflet").then((mod) => {
      if (cancelled || !el.current || map.current) return;
      const lf = (mod.default ?? mod) as typeof Leaflet;
      L.current = lf;
      const m = lf.map(el.current, { zoomControl: true, attributionControl: true });
      m.setView(LT_CENTER, 7);
      m.attributionControl.addAttribution(OCID_ATTRIBUTION);
      m.on("click", (e: Leaflet.LeafletMouseEvent) => {
        if (latest.current.mode !== "view") latest.current.onMapClick({ lat: e.latlng.lat, lon: e.latlng.lng });
      });
      overlay.current = lf.layerGroup().addTo(m);
      map.current = m;
      draw();
    });
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
    };
  }, []);

  // Base layer.
  useEffect(() => {
    const lf = L.current;
    const m = map.current;
    if (!lf || !m) return;
    tiles.current?.remove();
    const t = TILES[props.layer];
    tiles.current = lf.tileLayer(t.url, { attribution: t.attribution, maxZoom: t.maxZoom }).addTo(m);
  }, [props.layer]);

  // Overlay, redrawn from props on every render that changes them.
  useEffect(() => {
    draw();
  }, [props.home, props.serving, props.others, props.taRadiusM, props.mode]);

  function draw() {
    const lf = L.current;
    const m = map.current;
    const g = overlay.current;
    if (!lf || !m || !g) return;
    if (!tiles.current) {
      const t = TILES[latest.current.layer];
      tiles.current = lf.tileLayer(t.url, { attribution: t.attribution, maxZoom: t.maxZoom }).addTo(m);
    }
    g.clearLayers();
    const { home, serving, others, taRadiusM, mode } = latest.current;

    for (const o of others) {
      lf.circleMarker([o.at.lat, o.at.lon], {
        radius: 5,
        weight: 1.5,
        className: "stroke-on-surface-variant fill-surface-container-high",
        fillOpacity: 0.9,
      })
        .bindPopup(escapeHtml(o.label))
        .addTo(g);
    }

    if (home && taRadiusM) {
      lf.circle([home.lat, home.lon], {
        radius: taRadiusM,
        weight: 2,
        dashArray: "6 6",
        className: "stroke-primary fill-primary",
        fillOpacity: 0.06,
        interactive: false,
      }).addTo(g);
    }

    if (home && serving) {
      lf.polyline(
        [
          [home.lat, home.lon],
          [serving.at.lat, serving.at.lon],
        ],
        { weight: 3, className: "stroke-primary", interactive: false },
      ).addTo(g);
    }

    if (serving) {
      const marker = lf
        .marker([serving.at.lat, serving.at.lon], {
          draggable: mode === "move_tower",
          keyboard: true,
          icon: lf.divIcon({
            className: "",
            html: DOT(serving.corrected ? "bg-success" : "bg-primary", mode === "move_tower" ? 26 : 20),
            iconSize: [26, 26],
            iconAnchor: [13, 13],
          }),
          zIndexOffset: 1000,
        })
        .bindPopup(escapeHtml(serving.label))
        .addTo(g);
      marker.on("dragend", () => {
        const p = marker.getLatLng();
        latest.current.onTowerDrag({ lat: p.lat, lon: p.lng });
      });
    }

    if (home) {
      lf.marker([home.lat, home.lon], {
        interactive: false,
        icon: lf.divIcon({
          className: "",
          html: DOT("bg-warning", 18),
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        }),
        zIndexOffset: 900,
      }).addTo(g);
    }

    // Refit only when a new kind of point appears (home or tower), never on a redraw.
    const pts: [number, number][] = [];
    if (home) pts.push([home.lat, home.lon]);
    if (serving) pts.push([serving.at.lat, serving.at.lon]);
    if (pts.length > fitted.current) {
      if (pts.length === 2) m.fitBounds(pts, { padding: [48, 48], maxZoom: 16 });
      else m.setView(pts[0], 14);
      fitted.current = pts.length;
    }
    m.getContainer().style.cursor = mode === "view" ? "" : "crosshair";
  }

  return (
    <div
      ref={el}
      role="region"
      aria-label={props.ariaLabel}
      className="isolate z-0 h-[22rem] w-full overflow-hidden rounded-card @3xl/main:h-[32rem]"
    />
  );
}

export default MapView;
