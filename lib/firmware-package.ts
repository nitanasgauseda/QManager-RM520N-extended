// Quectel firmware revision parsing, e.g. "RM520NEUAAR03A04M4G_01.200.01.200".
// Pure and display-only: the flash itself happens off-device (QFirehose over USB).

export interface FirmwareRevision {
  /** Module family, e.g. "RM520N". */
  model: string;
  /** Hardware variant code: "GL", "EU", ... Packages never cross variants. */
  variant: string;
  /** Base build, e.g. [3, 4] for R03A04. */
  base: [number, number];
  /** Optional application build, e.g. [1, 200, 1, 200]. */
  app: number[] | null;
  /** Normalized display string. */
  text: string;
}

const REVISION =
  /(RM\d{3}[A-Z])([A-Z]{2})(?:AA)?R(\d{2})A(\d{2})M\dG(?:_(\d{2})\.(\d{3})\.(\d{2})\.(\d{3}))?/i;

export function parseFirmwareRevision(input: string | null | undefined): FirmwareRevision | null {
  if (!input) return null;
  const m = REVISION.exec(input.trim());
  if (!m) return null;
  const app = m[5] ? [m[5], m[6], m[7], m[8]].map(Number) : null;
  return {
    model: m[1].toUpperCase(),
    variant: m[2].toUpperCase(),
    base: [Number(m[3]), Number(m[4])],
    app,
    text: m[0].toUpperCase(),
  };
}

function compareParts(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

export type PackageVerdict =
  | { kind: "unrecognized" }
  | { kind: "unknown_installed"; pkg: FirmwareRevision }
  | { kind: "wrong_model"; pkg: FirmwareRevision; installed: FirmwareRevision }
  | { kind: "wrong_variant"; pkg: FirmwareRevision; installed: FirmwareRevision }
  | { kind: "newer" | "older" | "same"; pkg: FirmwareRevision; installed: FirmwareRevision };

/** Is this package safe to consider for the installed firmware, and is it an upgrade? */
export function checkPackage(packageName: string, installedFirmware: string): PackageVerdict {
  const pkg = parseFirmwareRevision(packageName);
  if (!pkg) return { kind: "unrecognized" };
  const installed = parseFirmwareRevision(installedFirmware);
  if (!installed) return { kind: "unknown_installed", pkg };
  if (pkg.model !== installed.model) return { kind: "wrong_model", pkg, installed };
  if (pkg.variant !== installed.variant) return { kind: "wrong_variant", pkg, installed };
  let c = compareParts(pkg.base, installed.base);
  // A package without an application build is compared on the base build only.
  if (c === 0 && pkg.app && installed.app) c = compareParts(pkg.app, installed.app);
  return { kind: c > 0 ? "newer" : c < 0 ? "older" : "same", pkg, installed };
}
