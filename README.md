# OpticDrop ⚡👁️

*Air-gapped, high-speed optical file transfer via fountain-coded QR streams.*

---

## 🚀 Overview

**OpticDrop** is a high-performance, completely offline file transfer system designed for maximum security and zero infrastructure dependency. By leveraging client-side WebAssembly (`zxing-cpp`), modern camera streams, and Fountain Codes (LT Codes), OpticDrop allows you to beam any file between devices using **pure light**—no Wi-Fi, no Bluetooth, cellular networks, or internet connection required.

---

## ⚙️ How It Works

1. **Fragmentation & Fountain Coding (Sender):** The sender selects a file, which is optionally compressed if it's an image. The binary payload is broken down using LT Codes into an *endless* stream of unique, randomized QR frames. Because of fountain coding, the receiver never has to capture frames in a strict sequential order—any combination of successfully read packets contributes to reconstructing the file.
2. **Multi-Lane & Color Multiplexing:** To push data speeds as high as possible through a screen, OpticDrop supports 1 to 4 simultaneous QR lanes organized in a responsive grid. It also features an advanced **Color Multiplexing mode** that packs three independent data streams into the Red, Green, and Blue bitplanes of a single QR code, paired with an adaptive calibration swatch band to instantly correct white-balance drift.
3. **Real-Time Optical Decoding (Receiver):** The receiver's camera viewfinder continuously scans the incoming stream. Multi-threaded Web Workers running compiled WASM decode the visual frames concurrently, tracking real-time progress until enough unique packets are gathered to flawlessly reconstruct and auto-save the original file.

---

## ✨ Core Features

* **100% Air-Gapped & Secure:** Operates entirely client-side with zero network tracking, local network discovery, or cloud handshakes.
* **Fountain-Coded Resilience:** Dropped frames, glare, or momentary misalignments never break the transfer. Every frame is a self-contained randomized piece of the puzzle.
* **Multi-Lane Grid Layout:** Adapts dynamically to screen size and device orientation, supporting 1, 2, 3, or 4 parallel visual transmission channels.
* **High-Throughput Color Mode:** Triples effective bandwidth by multiplexing data across RGB channels with automatic color calibration.