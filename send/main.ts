// Sender: turn a file into an endless fountain-coded QR stream.
// Supports 1, 2, 3, or 4 simultaneous QR code lanes with a responsive phone-friendly grid.

import QRCode from "qrcode";
import { LTEncoder } from "../shared/fountain";
import { HEADER_LEN, fnv1a, packFrame, type FrameHeader } from "../shared/protocol";
import { MARGIN, SWATCH_MODULES, SWATCH_COUNT, SWATCH_PATCHES } from "../shared/layout";

const LOOKAHEAD = 3;

const canvas = document.getElementById("qr") as HTMLCanvasElement;
const specs = document.getElementById("specs")!;

const cfgFile = document.getElementById("cfg-file") as HTMLInputElement;
const cfgImgSize = document.getElementById("cfg-imgsize") as HTMLSelectElement;
const cfgLanes = document.getElementById("cfg-lanes") as HTMLSelectElement;
const cfgFps = document.getElementById("cfg-fps") as HTMLSelectElement;
const cfgBytes = document.getElementById("cfg-bytes") as HTMLSelectElement;
const cfgEcc = document.getElementById("cfg-ecc") as HTMLSelectElement;
const cfgSize = document.getElementById("cfg-size") as HTMLInputElement;
const cfgColor = document.getElementById("cfg-color") as HTMLSelectElement;

const payloadCache = new Map<string, Uint8Array>();
let generation = 0; // bumped on every restart; stale loops see it and die

// --- WAKE LOCK MANAGER ---
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      await (navigator as any).wakeLock.request('screen');
    }
  } catch (err) {
    /* fine without it */
  }
}

// Automatically re-request if you switch tabs and come back
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    requestWakeLock();
  }
});
// -------------------------

async function loadPayload(source: string | File): Promise<Uint8Array | null> {
  if (source instanceof File) {
    return new Uint8Array(await source.arrayBuffer());
  }
  
  const hit = payloadCache.get(source);
  if (hit) return hit;
  const res = await fetch(source);
  if (!res.ok) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  payloadCache.set(source, bytes);
  return bytes;
}

const IMG_SIZE_PRESETS: Record<string, { maxDim: number; quality: number } | undefined> = {
  large: { maxDim: 1920, quality: 0.85 },
  medium: { maxDim: 1280, quality: 0.8 },
  small: { maxDim: 800, quality: 0.72 },
};

/** Downscales + re-compresses an image file before it ever reaches the
 * fountain encoder. Fewer payload bytes means fewer QR frames, which is the
 * single biggest lever on total transfer time — much bigger than tuning fps
 * or lanes. Only touches actual image files; everything else, and "original",
 * passes straight through. Always outputs JPEG (so transparency is lost —
 * fine for photos, not for icons/screenshots with transparent backgrounds). */
async function shrinkImageIfNeeded(
  file: File,
  preset: string,
): Promise<{ bytes: Uint8Array; name: string } | null> {
  const cfg = IMG_SIZE_PRESETS[preset];
  if (!cfg || !file.type.startsWith("image/")) return null;

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, cfg.maxDim / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1 && file.type === "image/jpeg") {
      bitmap.close();
      return null; // already small enough and already JPEG — nothing to gain
    }
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const cctx = canvas.getContext("2d")!;
    cctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();

    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", cfg.quality),
    );
    if (!blob || blob.size >= file.size) return null; // no actual win, skip

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const name = `${file.name.replace(/\.[^./]+$/, "")}.jpg`;
    return { bytes, name };
  } catch {
    return null; // unsupported format (e.g. some HEIC) — fall back to original
  }
}

async function main() {
  const imgSizeRow = document.getElementById("cfg-imgsize-row") as HTMLElement;
  const syncImgSizeVisibility = () => {
    const file = cfgFile.files?.[0];
    imgSizeRow.style.display = file && file.type.startsWith("image/") ? "" : "none";
  };
  cfgFile.addEventListener("change", syncImgSizeVisibility);
  syncImgSizeVisibility();

  // Re-bound all settings to trigger stream restarts
  for (const el of [cfgFile, cfgImgSize, cfgLanes, cfgFps, cfgBytes, cfgEcc, cfgSize, cfgColor]) {
    el.addEventListener("change", () => void startStream());
  }
  
  specs.textContent = `Awaiting file upload...`;
}

async function startStream() {
  const file = cfgFile.files?.[0];
  if (!file) return;

  // Grab the wake lock now that the user has interacted by picking a file!
  requestWakeLock();

  const gen = ++generation;
  
  const shrunk = await shrinkImageIfNeeded(file, cfgImgSize.value);
  const payload = shrunk ? shrunk.bytes : await loadPayload(file);
  if (!payload) {
    specs.textContent = `✗ couldn't load ${file.name}`;
    return;
  }
  
  if (gen !== generation) return; 
  
  const lanes = Number(cfgLanes.value);
  const txFps = Number(cfgFps.value);
  const frameBytes = Number(cfgBytes.value);
  const ecc = cfgEcc.value as "L" | "M" | "Q" | "H";
  const displayPx = Number(cfgSize.value);
  const colorMode = cfgColor.value === "on";
  const shrinkNote = shrunk
    ? ` · shrunk ${Math.round(file.size / 1024)}→${Math.round(payload.length / 1024)} KB`
    : "";

  const sessionId = (Math.floor(Math.random() * 0xffff) + 1) & 0xffff;
  const blockLen = frameBytes - HEADER_LEN;
  const encoder = new LTEncoder(payload, blockLen, sessionId);
  
  const header: FrameHeader = {
    sessionId,
    seq: 0,
    k: encoder.k,
    blockLen,
    totalLen: payload.length,
    payloadFnv: fnv1a(payload),
    fileName: shrunk ? shrunk.name : file.name, 
  };

  let version: number | undefined; 
  let modules = 0;
  
  // Responsive grid variables
  let scale = 1;
  let cols = 1;
  let rows = 1;
  let positions: {x: number, y: number}[] = [];

  const staging = document.createElement("canvas");
  const queue: ImageData[] = [];
  let nextSeq = 0;

  // Color mode tiles are taller than wide (QR + margin, plus a calibration
  // swatch band underneath); mono tiles stay square as before.
  const tileDims = () => {
    const qrTotal = modules + 2 * MARGIN;
    const tileW = qrTotal;
    const tileH = colorMode ? qrTotal + SWATCH_MODULES : qrTotal;
    return { qrTotal, tileW, tileH };
  };

  const sizeCanvas = () => {
    const dpr = window.devicePixelRatio || 1;
    const { tileW, tileH } = tileDims();
    
    const isPortrait = window.innerHeight > window.innerWidth;

    // Smart layout based on phone orientation
    if (lanes === 1) {
      cols = 1; 
      rows = 1;
    } else if (lanes === 2) {
      cols = isPortrait ? 1 : 2; // Stack vertically if phone is upright
      rows = isPortrait ? 2 : 1; 
    } else {
      cols = 2; // 3 or 4 lanes always form a 2x2 grid
      rows = 2; 
    }

    // Build the position map dynamically based on rows and columns
    positions = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        positions.push({ x, y });
      }
    }
    
    // Maximize space: allow stretching up to 95% of the physical window dimensions
    const maxW = window.innerWidth * 0.95;
    const maxH = window.innerHeight * 0.95;

    const budgetW = Math.min(maxW, displayPx * cols);
    const budgetH = Math.min(maxH, displayPx * rows);

    const scaleX = (budgetW * dpr) / (cols * tileW);
    const scaleY = (budgetH * dpr) / (rows * tileH);
    
    scale = Math.max(1, Math.floor(Math.min(scaleX, scaleY)));
    
    staging.width = tileW;
    staging.height = tileH;
    
    canvas.width = cols * tileW * scale;
    canvas.height = rows * tileH * scale;
    canvas.style.width = `${canvas.width / dpr}px`;
    canvas.style.height = `${canvas.height / dpr}px`;
  };

  const makeQr = (bytes: Uint8Array) =>
    QRCode.create([{ data: bytes, mode: "byte" } as unknown as QRCode.QRCodeSegment], {
      errorCorrectionLevel: ecc,
      version,
      maskPattern: 4,
    });

  const onFirstFrame = (v: number, m: number, throughputNote: string) => {
    version = v;
    modules = m;
    sizeCanvas();
    // Auto-resize when you rotate your phone!
    window.addEventListener('resize', sizeCanvas);
    specs.textContent =
      `${lanes} Lane(s) @ ${txFps} FPS · ${frameBytes} B/frame · V${version} · ECC ${ecc} · ` +
      `${Math.round(payload.length / 1024)} KB · K=${encoder.k}${shrinkNote}${throughputNote}`;
  };

  const makeFrameMono = (): ImageData => {
    const bytes = packFrame({ ...header, seq: nextSeq }, encoder.encode(nextSeq));
    nextSeq++;
    const qr = makeQr(bytes);

    if (version === undefined) onFirstFrame(qr.version, qr.modules.size, "");

    const size = qr.modules.size;
    const data = qr.modules.data;
    const total = size + 2 * MARGIN;
    const img = new ImageData(total, total);
    const px = new Uint32Array(img.data.buffer);
    px.fill(0xffffffff);
    for (let y = 0; y < size; y++) {
      const row = (y + MARGIN) * total + MARGIN;
      const src = y * size;
      for (let x = 0; x < size; x++) {
        if (data[src + x]) px[row + x] = 0xff000000;
      }
    }
    return img;
  };

  // Packs 3 independent fountain frames (seq, seq+1, seq+2) into the R/G/B
  // bitplanes of one code — same screen footprint, ~3x the data. The
  // receiver must split channels back out before handing each to zxing,
  // since a raw color image just decodes as grayscale mush. A calibration
  // band (black/white/R/G/B patches) below the code lets the receiver
  // correct for white-balance drift using the QR's own decoded geometry.
  const makeFrameColor = (): ImageData => {
    const bytes0 = packFrame({ ...header, seq: nextSeq }, encoder.encode(nextSeq));
    const bytes1 = packFrame({ ...header, seq: nextSeq + 1 }, encoder.encode(nextSeq + 1));
    const bytes2 = packFrame({ ...header, seq: nextSeq + 2 }, encoder.encode(nextSeq + 2));
    nextSeq += 3;

    const qr0 = makeQr(bytes0);
    const qr1 = makeQr(bytes1);
    const qr2 = makeQr(bytes2);

    if (version === undefined) {
      onFirstFrame(qr0.version, qr0.modules.size, " · ×3 color planes + calibration band (receiver must match)");
    }

    const size = qr0.modules.size;
    const d0 = qr0.modules.data;
    const d1 = qr1.modules.data;
    const d2 = qr2.modules.data;
    const qrTotal = size + 2 * MARGIN;
    const tileH = qrTotal + SWATCH_MODULES;
    const img = new ImageData(qrTotal, tileH);
    const px = img.data;
    px.fill(255); // white background on every channel, alpha included
    for (let y = 0; y < size; y++) {
      const row = (y + MARGIN) * qrTotal + MARGIN;
      const src = y * size;
      for (let x = 0; x < size; x++) {
        const o = (row + x) * 4;
        px[o] = d0[src + x] ? 0 : 255;
        px[o + 1] = d1[src + x] ? 0 : 255;
        px[o + 2] = d2[src + x] ? 0 : 255;
        px[o + 3] = 255;
      }
    }

    // Calibration band: SWATCH_COUNT solid patches spanning the tile width,
    // directly beneath the QR + quiet zone.
    const patchW = Math.ceil(qrTotal / SWATCH_COUNT);
    for (let y = qrTotal; y < tileH; y++) {
      const row = y * qrTotal;
      for (let x = 0; x < qrTotal; x++) {
        const patch = SWATCH_PATCHES[Math.min(SWATCH_COUNT - 1, Math.floor(x / patchW))]!;
        const o = (row + x) * 4;
        px[o] = patch[0];
        px[o + 1] = patch[1];
        px[o + 2] = patch[2];
        px[o + 3] = 255;
      }
    }
    return img;
  };

  const makeFrame = colorMode ? makeFrameColor : makeFrameMono;

  const pump = () => {
    if (gen !== generation) {
      window.removeEventListener('resize', sizeCanvas);
      return;
    }
    try {
      while (queue.length < LOOKAHEAD * lanes) queue.push(makeFrame());
    } catch (err) {
      specs.textContent = `✗ ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    setTimeout(pump, 0);
  };
  pump();

  const interval = 1000 / txFps;
  let nextAt = performance.now();
  
  const tick = (now: number) => {
    if (gen !== generation) return;
    requestAnimationFrame(tick);
    if (now < nextAt) return;
    
    if (queue.length < lanes) {
      nextAt = now + interval;
      return;
    }

    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const { tileW, tileH } = tileDims();
    
    // Pop and draw `lanes` amount of frames onto the dynamic grid
    for (let i = 0; i < lanes; i++) {
      const img = queue.shift();
      if (!img) break;
      
      staging.getContext("2d")!.putImageData(img, 0, 0);
      
      const pos = positions[i];
      if (!pos) break;
      
      const dx = pos.x * tileW * scale;
      const dy = pos.y * tileH * scale;
      const dw = tileW * scale;
      const dh = tileH * scale;
      
      ctx.drawImage(staging, 0, 0, tileW, tileH, dx, dy, dw, dh);
    }
    
    nextAt += interval;
    if (now - nextAt > 3 * interval) nextAt = now + interval; 
  };
  requestAnimationFrame(tick);
}

void main();
