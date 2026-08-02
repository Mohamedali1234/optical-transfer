// QR decode worker: zxing-cpp compiled to WASM. (Safari has never shipped
// BarcodeDetector — WebKit bug 281848 — so WASM is the only portable way.)
// One frame in flight per worker; the main thread drops frames when all
// workers are busy. Frames are disposable — the fountain doesn't care.

import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import { MARGIN, SWATCH_MODULES, SWATCH_COUNT, SWATCH_PATCHES, qrSizeFromVersion } from "../shared/layout";

prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) =>
      path.endsWith(".wasm") ? wasmUrl : prefix + path,
  },
});

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

const READ_OPTS = { formats: ["QRCode"] as ("QRCode")[], maxNumberOfSymbols: 4 };

const extract = (x: { isValid: boolean; bytes?: Uint8Array }) =>
  x.isValid && x.bytes && x.bytes.length > 0;

interface Point { x: number; y: number; }
interface Position { topLeft: Point; topRight: Point; bottomLeft: Point; bottomRight: Point; }

// Running per-channel black/white reference levels, tracked from the swatch
// band and used to linearly stretch each plane before it hits zxing. Starts
// as a no-op (0..255) so calibration only ever helps once it has real data.
const calib = {
  r: { lo: 0, hi: 255 },
  g: { lo: 0, hi: 255 },
  b: { lo: 0, hi: 255 },
};
const CALIB_EMA = 0.15; // smoothing factor per successful reading

function stretch(v: number, lo: number, hi: number): number {
  if (hi - lo < 10) return v; // degenerate/uncalibrated — leave untouched
  return Math.max(0, Math.min(255, ((v - lo) * 255) / (hi - lo)));
}

/** Averages a small window around (x, y) for noise robustness. */
function sampleRGB(src: Uint8ClampedArray, w: number, h: number, x: number, y: number) {
  let r = 0, g = 0, b = 0, n = 0;
  const R = 2;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const px = Math.round(x + dx);
      const py = Math.round(y + dy);
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const o = (py * w + px) * 4;
      r += src[o]!; g += src[o + 1]!; b += src[o + 2]!;
      n++;
    }
  }
  return n > 0 ? { r: r / n, g: g / n, b: b / n } : null;
}

/** Any single successful decode gives us the tile's exact geometry via its
 * own corner points — from there the calibration band's patch centers are a
 * fixed offset away in module units, regardless of camera framing/distance. */
function updateCalibration(src: Uint8ClampedArray, w: number, h: number, position: Position, version: string) {
  const v = parseInt(version, 10);
  if (!Number.isFinite(v) || v <= 0) return;
  const size = qrSizeFromVersion(v);

  const { topLeft, topRight, bottomLeft } = position;
  const rightX = (topRight.x - topLeft.x) / size;
  const rightY = (topRight.y - topLeft.y) / size;
  const downX = (bottomLeft.x - topLeft.x) / size;
  const downY = (bottomLeft.y - topLeft.y) / size;

  const bandY = size + MARGIN + SWATCH_MODULES / 2;
  const patchSpan = (size + 2 * MARGIN) / SWATCH_COUNT;

  let black: { r: number; g: number; b: number } | null = null;
  let white: { r: number; g: number; b: number } | null = null;

  for (let i = 0; i < SWATCH_COUNT; i++) {
    const patch = SWATCH_PATCHES[i]!;
    const colX = -MARGIN + (i + 0.5) * patchSpan;
    const px = topLeft.x + colX * rightX + bandY * downX;
    const py = topLeft.y + colX * rightY + bandY * downY;
    const sample = sampleRGB(src, w, h, px, py);
    if (!sample) continue;
    if (patch[0] === 0 && patch[1] === 0 && patch[2] === 0) black = sample;
    if (patch[0] === 255 && patch[1] === 255 && patch[2] === 255) white = sample;
  }
  if (!black || !white) return;

  const blend = (cur: number, measured: number) => cur * (1 - CALIB_EMA) + measured * CALIB_EMA;
  calib.r.lo = blend(calib.r.lo, black.r); calib.r.hi = blend(calib.r.hi, white.r);
  calib.g.lo = blend(calib.g.lo, black.g); calib.g.hi = blend(calib.g.hi, white.g);
  calib.b.lo = blend(calib.b.lo, black.b); calib.b.hi = blend(calib.b.hi, white.b);
}

/** Splits an RGBA buffer into 3 single-channel grayscale images (one per
 * color plane), applying the running per-channel calibration stretch.
 * zxing only ever sees luma, so a raw color capture just decodes as noise —
 * each plane has to be promoted to its own R=G=B image and decoded
 * independently before the fountain layer ever sees the bytes. */
function splitPlanes(src: Uint8ClampedArray, w: number, h: number) {
  const n = w * h;
  const r = new Uint8ClampedArray(n * 4);
  const g = new Uint8ClampedArray(n * 4);
  const b = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const rv = stretch(src[o]!, calib.r.lo, calib.r.hi);
    const gv = stretch(src[o + 1]!, calib.g.lo, calib.g.hi);
    const bv = stretch(src[o + 2]!, calib.b.lo, calib.b.hi);
    r[o] = r[o + 1] = r[o + 2] = rv; r[o + 3] = 255;
    g[o] = g[o + 1] = g[o + 2] = gv; g[o + 3] = 255;
    b[o] = b[o + 1] = b[o + 2] = bv; b[o + 3] = 255;
  }
  return [new ImageData(r, w, h), new ImageData(g, w, h), new ImageData(b, w, h)];
}

ctx.onmessage = async (e: MessageEvent) => {
  const { id, buf, w, h, colorMode } = e.data as {
    id: number; buf: ArrayBuffer; w: number; h: number; colorMode?: boolean;
  };
  try {
    let bytesList: Uint8Array[];
    if (colorMode) {
      const src = new Uint8ClampedArray(buf);
      const planes = splitPlanes(src, w, h);
      const perPlane = await Promise.all(planes.map((p) => readBarcodes(p, READ_OPTS)));
      const flat = perPlane.flat();
      bytesList = flat.filter(extract).map((x) => x.bytes!);

      // One successful decode is enough to refresh calibration from this
      // frame — the swatch band shares the same tile geometry. Sampled from
      // the ORIGINAL buffer, not the already-stretched planes.
      const withGeometry = flat.find(
        (x): x is typeof x & { position: Position; version: string } =>
          x.isValid && !!(x as { position?: unknown }).position && !!(x as { version?: unknown }).version,
      );
      if (withGeometry) updateCalibration(src, w, h, withGeometry.position, withGeometry.version);
    } else {
      const img = new ImageData(new Uint8ClampedArray(buf), w, h);
      const results = await readBarcodes(img, READ_OPTS);
      bytesList = results.filter(extract).map((x) => x.bytes!);
    }
    ctx.postMessage({ id, bytesList: bytesList.length > 0 ? bytesList : null });
  } catch {
    ctx.postMessage({ id, bytesList: null });
  }
};

// warm the WASM so the first real frame doesn't pay instantiation
void readBarcodes(new ImageData(8, 8), { formats: ["QRCode"] })
  .catch(() => undefined)
  .then(() => ctx.postMessage({ id: -1, bytesList: null }));
