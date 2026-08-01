// Sender: turn a file into an endless fountain-coded QR stream.
// Supports 1, 2, 3, or 4 simultaneous QR code lanes for max throughput.

import QRCode from "qrcode";
import { LTEncoder } from "../shared/fountain";
import { HEADER_LEN, fnv1a, packFrame, type FrameHeader } from "../shared/protocol";

const MARGIN = 4; // quiet-zone modules
const LOOKAHEAD = 3;

const canvas = document.getElementById("qr") as HTMLCanvasElement;
const specs = document.getElementById("specs")!;

const cfgFile = document.getElementById("cfg-file") as HTMLInputElement;
const cfgLanes = document.getElementById("cfg-lanes") as HTMLSelectElement;
const cfgFps = document.getElementById("cfg-fps") as HTMLSelectElement;
const cfgBytes = document.getElementById("cfg-bytes") as HTMLSelectElement;
const cfgEcc = document.getElementById("cfg-ecc") as HTMLSelectElement;
const cfgSize = document.getElementById("cfg-size") as HTMLInputElement;

const payloadCache = new Map<string, Uint8Array>();
let generation = 0; // bumped on every restart; stale loops see it and die

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

async function main() {
  // Re-bound all settings to trigger stream restarts
  for (const el of [cfgFile, cfgLanes, cfgFps, cfgBytes, cfgEcc, cfgSize]) {
    el.addEventListener("change", () => void startStream());
  }
  
  specs.textContent = `Awaiting file upload...`;
  
  try {
    await (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<unknown> } })
      .wakeLock?.request("screen");
  } catch {
    /* fine without it */
  }
}

async function startStream() {
  const file = cfgFile.files?.[0];
  if (!file) return;

  const gen = ++generation;
  
  const payload = await loadPayload(file);
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
    fileName: file.name, 
  };

  let version: number | undefined; 
  let modules = 0;
  let scale = 1;
  const staging = document.createElement("canvas");
  const queue: ImageData[] = [];
  let nextSeq = 0;

  // Grid dimensions based on lanes
  const cols = lanes === 1 ? 1 : 2;
  const rows = lanes > 2 ? 2 : (lanes === 2 ? 1 : 1);

  const sizeCanvas = () => {
    const dpr = window.devicePixelRatio || 1;
    const total = modules + 2 * MARGIN;
    const cssBudget = Math.min(0.9 * Math.min(window.innerWidth, window.innerHeight), displayPx);
    
    // Scale so the largest dimension (cols or rows) fits in the budget
    const maxGridSize = Math.max(cols, rows) * total;
    scale = Math.max(1, Math.floor((cssBudget * dpr) / maxGridSize));
    
    staging.width = total;
    staging.height = total;
    
    canvas.width = cols * total * scale;
    canvas.height = rows * total * scale;
    canvas.style.width = `${(cols * total * scale) / dpr}px`;
    canvas.style.height = `${(rows * total * scale) / dpr}px`;
  };

  const makeFrame = (): ImageData => {
    const bytes = packFrame({ ...header, seq: nextSeq }, encoder.encode(nextSeq));
    nextSeq++;
    const qr = QRCode.create([{ data: bytes, mode: "byte" } as unknown as QRCode.QRCodeSegment], {
      errorCorrectionLevel: ecc,
      version,
      maskPattern: 4,
    });
    
    if (version === undefined) {
      version = qr.version;
      modules = qr.modules.size;
      sizeCanvas();
      specs.textContent =
        `${lanes} Lane(s) @ ${txFps} FPS · ${frameBytes} B/frame · V${version} · ECC ${ecc} · ` +
        `${Math.round(payload.length / 1024)} KB · K=${encoder.k}`;
    }
    
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

  const pump = () => {
    if (gen !== generation) return; 
    try {
      // Buffer enough frames for all lanes simultaneously
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
    
    // Make sure we have enough frames in the queue to fill our lanes
    if (queue.length < lanes) {
      nextAt = now + interval;
      return;
    }

    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height); // clear canvas

    const total = modules + 2 * MARGIN;
    
    // Position offsets for up to 4 quadrants
    const positions = [
      { x: 0, y: 0 },         // Top-Left
      { x: 1, y: 0 },         // Top-Right
      { x: 0, y: 1 },         // Bottom-Left
      { x: 1, y: 1 },         // Bottom-Right
    ];

    // Pop and draw `lanes` amount of frames onto the canvas grid
    for (let i = 0; i < lanes; i++) {
      const img = queue.shift();
      if (!img) break;
      
      staging.getContext("2d")!.putImageData(img, 0, 0);
      
      const pos = positions[i];
      if (!pos) break; // <-- TypeScript fix applied here
      
      const dx = pos.x * total * scale;
      const dy = pos.y * total * scale;
      const dw = total * scale;
      const dh = total * scale;
      
      ctx.drawImage(staging, 0, 0, total, total, dx, dy, dw, dh);
    }
    
    nextAt += interval;
    if (now - nextAt > 3 * interval) nextAt = now + interval; 
  };
  requestAnimationFrame(tick);
}

void main();
