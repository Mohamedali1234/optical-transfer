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

---

##  OpticDrop: Quick & Easy Guide

A simple, plain-English guide to every setting in OpticDrop and the best choices to make for a smooth transfer.
1. Select File
 * What it is: The file you want to send.
 * Best choice: Whatever file you need to share. (If it's a photo, the next setting becomes available).
2. Image Size
 * What it is: Shrinks big photos before sending them so they finish way faster.
 * Best choice: Medium or Small. Smaller file size means it transfers in a fraction of the time.
3. Lanes
 * What it is: How many QR codes flash on the screen at the same time.
 * Best choice:
   * Use 1 Lane if you're using an older phone or have shaky hands.
   * Use 2 to 4 Lanes for maximum speed when both phones are close and steady.
4. Speed (FPS)
 * What it is: How fast the QR codes cycle on the screen.
 * Best choice: 10 to 15 FPS. Going too fast can cause the receiving phone's camera to miss frames and slow things down.
5. Bytes per Frame
 * What it is: How much data is packed into each QR code.
 * Best choice: Leave it on default. If the receiving camera is struggling to read the codes, lower this number to make the patterns simpler.
6. Error Correction (ECC)
 * What it is: The QR code's built-in safety backup.
 * Best choice: Low. OpticDrop handles safety checks on its own, so keeping the QR code patterns simple helps the camera scan them much faster.
7. Color Mode
 * What it is: Packs extra data using Red, Green, and Blue colors to triple your speed.
 * Best choice:
   * Turn ON for super-fast transfers in good lighting with modern screens.
   * Turn OFF if you are in a dark room, dealing with screen glare, or the colors look washed out.
