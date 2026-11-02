// Reads a QR code from a photo or screenshot. The browser's BarcodeDetector when it has one
// (Chrome on Android), otherwise jsQR, loaded only when needed.

const MAX_SIDE = 1600;

interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: ImageBitmap): Promise<DetectedBarcode[]>;
}
interface BarcodeDetectorCtor {
  new (opts: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

async function viaBarcodeDetector(bitmap: ImageBitmap): Promise<string | null> {
  const Ctor = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (!Ctor) return null;
  try {
    const formats = (await Ctor.getSupportedFormats?.()) ?? ["qr_code"];
    if (!formats.includes("qr_code")) return null;
    const found = await new Ctor({ formats: ["qr_code"] }).detect(bitmap);
    return found[0]?.rawValue ?? null;
  } catch {
    return null;
  }
}

async function viaJsQr(bitmap: ImageBitmap): Promise<string | null> {
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const { default: jsQR } = await import("jsqr");
  return jsQR(data, w, h, { inversionAttempts: "attemptBoth" })?.data ?? null;
}

/** The text in the first QR code found in the image, or null. */
export async function decodeQrFromFile(file: File): Promise<string | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    return (await viaBarcodeDetector(bitmap)) ?? (await viaJsQr(bitmap));
  } finally {
    bitmap.close();
  }
}
