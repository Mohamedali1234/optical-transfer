// QR decode worker: zxing-cpp compiled to WASM. (Safari has never shipped
// BarcodeDetector — WebKit bug 281848 — so WASM is the only portable way.)
// One frame in flight per worker; the main thread drops frames when all
// workers are busy. Frames are disposable — the fountain doesn't care.

import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";

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

/** Splits an RGBA buffer into 3 single-channel grayscale images (one per
 * color plane). zxing only ever sees luma, so a raw color capture just
 * decodes as noise — each plane has to be promoted to its own R=G=B image
 * and decoded independently before the fountain layer ever sees the bytes. */
function splitPlanes(buf: ArrayBuffer, w: number, h: number) {
  const src = new Uint8ClampedArray(buf);
  const n = w * h;
  const r = new Uint8ClampedArray(n * 4);
  const g = new Uint8ClampedArray(n * 4);
  const b = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const rv = src[o]!, gv = src[o + 1]!, bv = src[o + 2]!;
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
      const planes = splitPlanes(buf, w, h);
      const perPlane = await Promise.all(planes.map((p) => readBarcodes(p, READ_OPTS)));
      bytesList = perPlane.flat().filter(extract).map((x) => x.bytes!);
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
