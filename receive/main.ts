// Receiver: camera → WASM QR decode in workers → fountain decoder → file.
// Includes hardware benchmarking to auto-tune optimal workers and capture resolution.

import { LTDecoder } from "../shared/fountain";
import { fnv1a, parseFrame } from "../shared/protocol";
import { Filesystem, Directory } from "@capacitor/filesystem";

const OVERHEAD_EST = 1.18; // expected frames ≈ K × this (robust-soliton ε)

const startBtn = document.getElementById("start") as HTMLButtonElement;
const benchBtn = document.getElementById("benchmark") as HTMLButtonElement;
const video = document.getElementById("video") as HTMLVideoElement;
const preview = document.getElementById("preview")!;
const stats = document.getElementById("stats")!;
const progressEl = document.getElementById("progress")!;
const bar = document.getElementById("bar")!;
const result = document.getElementById("result")!;
const settings = document.getElementById("settings") as HTMLDetailsElement;
const metricsEl = document.getElementById("metrics")!;
const metric = (id: string) => document.getElementById(id)!;

let stream: MediaStream | null = null;
let decoder: LTDecoder | null = null;
let sessionId = 0;
let startTs = 0;
let captureGen = 0;
let done = false;
let currentFileName = "download.bin";
let colorModeOn = false;

const workers: Worker[] = [];
const busy: boolean[] = [];
const captureTimes: number[] = [];
const decodeTimes: number[] = [];

startBtn.onclick = () => void start();
benchBtn.onclick = () => void runBenchmark();

// --- HARDWARE BENCHMARK ENGINE ---
async function runBenchmark() {
  benchBtn.disabled = true;
  startBtn.disabled = true;
  stats.textContent = "⚡ Running hardware benchmark... Please wait.";

  const testWidth = 1280;
  const testHeight = 960;
  // Create a synthetic test image buffer
  const dummyCanvas = document.createElement("canvas");
  dummyCanvas.width = testWidth;
  dummyCanvas.height = testHeight;
  const ctx = dummyCanvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, testWidth, testHeight);
  const imgData = ctx.getImageData(0, 0, testWidth, testHeight);

  // Test with 3 workers to gauge CPU throughput
  const benchWorker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  
  const measureSpeed = (workersCount: number): Promise<number> => {
    return new Promise((resolve) => {
      let completed = 0;
      const start = performance.now();
      const iterations = 5;

      benchWorker.onmessage = (e) => {
        if (e.data.id === -1) return; // ignore warm-up
        completed++;
        if (completed >= iterations) {
          const duration = performance.now() - start;
          resolve(iterations / (duration / 1000)); // returns decodes per second
        }
      };

      for (let i = 0; i < iterations; i++) {
        benchWorker.postMessage({ id: i, buf: imgData.data.buffer.slice(0), w: testWidth, h: testHeight });
      }
    });
  };

  const score = await measureSpeed(3);
  benchWorker.terminate();

  // Auto-tune settings based on benchmark score (decodes per second)
  const widthSelect = document.getElementById("cfg-width") as HTMLSelectElement;
  const workerSelect = document.getElementById("cfg-workers") as HTMLSelectElement;

  if (score > 25) {
    // High-end device (Flagship phone)
    widthSelect.value = "1920";
    workerSelect.value = "3";
    stats.textContent = `⚡ Benchmark complete: High-end hardware detected! Set to 1920px @ 3 workers.`;
  } else if (score > 12) {
    // Mid-range device
    widthSelect.value = "1280";
    workerSelect.value = "2";
    stats.textContent = `⚡ Benchmark complete: Balanced profile selected (1280px @ 2 workers).`;
  } else {
    // Budget or older device (prevent overheating/lag)
    widthSelect.value = "960";
    workerSelect.value = "1";
    stats.textContent = `⚡ Benchmark complete: Low-overhead profile selected (960px @ 1 worker).`;
  }

  benchBtn.disabled = false;
  startBtn.disabled = false;
}
// ---------------------------------

async function start() {
  if (!navigator.mediaDevices?.getUserMedia) {
    stats.textContent =
      "✗ camera needs a secure context — this page must be served over " +
      "https to use the camera from another device (npm run dev:https).";
    return;
  }
  const captureWidth = Number((document.getElementById("cfg-width") as HTMLSelectElement).value);
  const captureFps = Number((document.getElementById("cfg-capfps") as HTMLSelectElement).value);
  const workerCount = Number((document.getElementById("cfg-workers") as HTMLSelectElement).value);
  colorModeOn = (document.getElementById("cfg-color-rx") as HTMLSelectElement).value === "on";
  
  settings.style.display = "none";
  startBtn.style.display = "none";
  benchBtn.style.display = "none";
  preview.style.display = "block";
  metricsEl.style.display = "grid";

  const base: MediaTrackConstraints = {
    facingMode: "environment",
    width: { ideal: captureWidth },
    height: { ideal: Math.round((captureWidth * 3) / 4) },
  };
  try {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...base, frameRate: { exact: captureFps } },
      });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...base, frameRate: { ideal: captureFps } },
      });
    }
  } catch (err) {
    stats.textContent = `✗ camera: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }
  video.srcObject = stream;
  await video.play().catch(() => undefined);
  stats.textContent = `camera ${stream.getVideoTracks()[0]?.getSettings().width}×${stream.getVideoTracks()[0]?.getSettings().height}@${stream.getVideoTracks()[0]?.getSettings().frameRate} — searching for a stream…`;

  // === MULTI-LANE WORKER SETUP ===
  for (let i = 0; i < workerCount; i++) {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const slot = i;
    w.onmessage = (e: MessageEvent) => {
      const { id, bytesList } = e.data as { id: number; bytesList: Uint8Array[] | null };
      if (id === -1) return; // warm-up
      busy[slot] = false;
      
      if (bytesList && bytesList.length > 0) {
        for (const bytes of bytesList) {
          onDecoded(bytes);
        }
      }
    };
    workers.push(w);
    busy.push(false);
  }

  captureGen++;
  scheduleFrame(captureGen);
  setInterval(updateStats, 500);
  try {
    await (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<unknown> } })
      .wakeLock?.request("screen");
  } catch {
    /* fine */
  }
}

type VideoRVFC = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };

function scheduleFrame(gen: number) {
  if (done || gen !== captureGen) return;
  const v = video as VideoRVFC;
  const next = () => {
    if (done || gen !== captureGen) return;
    captureFrame();
    scheduleFrame(gen);
  };
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(next);
  else requestAnimationFrame(next);
}

const grab = document.createElement("canvas");
let frameId = 0;

function captureFrame() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  captureTimes.push(performance.now());
  const slot = busy.indexOf(false);
  if (slot === -1) return; // all workers busy — drop frame
  if (grab.width !== vw || grab.height !== vh) {
    grab.width = vw;
    grab.height = vh;
  }
  const ctx = grab.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(video, 0, 0);
  const img = ctx.getImageData(0, 0, vw, vh);
  busy[slot] = true;
  workers[slot]!.postMessage(
    { id: frameId++, buf: img.data.buffer, w: vw, h: vh, colorMode: colorModeOn },
    [img.data.buffer],
  );
}

function onDecoded(bytes: Uint8Array) {
  decodeTimes.push(performance.now());
  const parsed = parseFrame(bytes);
  if (!parsed || done) return;
  const { header, block } = parsed;
  
  if (header.fileName) {
    currentFileName = header.fileName;
  }

  if (!decoder || sessionId !== header.sessionId) {
    decoder = new LTDecoder(header.k, header.blockLen, header.sessionId, header.totalLen);
    sessionId = header.sessionId;
    startTs = performance.now();
    progressEl.style.display = "block";
  }
  decoder.addFrame(header.seq, block);
  const progress = Math.min(0.99, decoder.framesNew / (decoder.k * OVERHEAD_EST));
  bar.style.width = `${(progress * 100).toFixed(1)}%`;

  if (decoder.isComplete) {
    const payload = decoder.assemble()!;
    const seconds = (performance.now() - startTs) / 1000;
    const ok = fnv1a(payload) === header.payloadFnv;
    finish(payload, ok, seconds, header.totalLen);
  }
}

function uint8ArrayToBase64(bytes: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = reader.result as string;
      resolve(res.split(',')[1] || '');
    };
    reader.onerror = reject;
    reader.readAsDataURL(new Blob([bytes.buffer as ArrayBuffer]));
  });
}

async function finish(payload: Uint8Array, hashOk: boolean, seconds: number, totalLen: number) {
  done = true;
  captureGen++;
  stream?.getTracks().forEach((t) => t.stop());
  preview.style.display = "none";
  bar.style.width = "100%";
  const kb = Math.round(totalLen / 1024);
  const rate = (totalLen / 1024 / seconds).toFixed(1);
  stats.textContent = `${kb} KB in ${seconds.toFixed(1)} s · ${rate} KB/s · hash ${hashOk ? "verified ✓" : "MISMATCH ✗"}`;
  
  const heading = document.createElement("div");
  heading.className = "done";
  heading.textContent = "Transfer Complete! Saving file automatically...";
  result.append(heading);

  try {
    const base64Data = await uint8ArrayToBase64(payload);
    
    await Filesystem.writeFile({
      path: currentFileName,
      data: base64Data,
      directory: Directory.Documents,
      recursive: true,
    });

    heading.textContent = `Saved successfully: Documents/${currentFileName}`;

    const uriResult = await Filesystem.getUri({
      directory: Directory.Documents,
      path: currentFileName,
    });

    const openButton = document.createElement("button");
    openButton.className = "download-btn";
    openButton.textContent = `Open ${currentFileName}`;
    openButton.style.display = "block";
    openButton.style.marginTop = "15px";
    openButton.style.padding = "12px 24px";
    openButton.style.background = "#2563eb";
    openButton.style.color = "#ffffff";
    openButton.style.border = "none";
    openButton.style.borderRadius = "8px";
    openButton.style.fontWeight = "bold";
    openButton.style.cursor = "pointer";

    openButton.onclick = () => {
      window.open(uriResult.uri, '_blank');
    };
    result.append(openButton);

    window.open(uriResult.uri, '_blank');

  } catch (err) {
    console.error('Auto-save error:', err);
    heading.textContent = `Error saving file: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function updateStats() {
  if (done) return;
  const now = performance.now();
  const prune = (a: number[]) => {
    while (a.length > 0 && a[0]! < now - 2000) a.shift();
  };
  prune(captureTimes);
  prune(decodeTimes);
  metric("m-cap").textContent = (captureTimes.length / 2).toFixed(0);
  metric("m-dec").textContent = (decodeTimes.length / 2).toFixed(1);
  if (!decoder) return;
  const elapsed = (now - startTs) / 1000;
  const kbs = (decoder.framesNew * decoder.blockLen) / OVERHEAD_EST / 1024 / Math.max(0.1, elapsed);
  metric("m-rate").textContent = `${kbs.toFixed(1)} KB/s`;
  metric("m-time").textContent = `${elapsed.toFixed(0)} s`;
  metric("m-frames").textContent = `${decoder.framesNew}/${decoder.framesDup}`;
  metric("m-k").textContent = String(decoder.k);
  metric("m-block").textContent = `${decoder.blockLen} B`;
  metric("m-payload").textContent = `${Math.round(decoder.totalLen / 1024)} KB`;
}
