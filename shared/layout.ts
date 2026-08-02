// Shared geometry for the color-mode calibration swatch band. The sender
// draws a strip of reference patches directly beneath each QR code's quiet
// zone; the receiver locates that strip using the QR's own decoded corner
// points (position.topLeft/topRight/bottomLeft), so it works regardless of
// how the phone is framed — no fixed screen mapping assumed.
//
// Sender and receiver must agree on every constant here, or the receiver
// will sample the wrong pixels.

export const MARGIN = 4; // quiet-zone modules around each QR
export const SWATCH_MODULES = 6; // height of the calibration band, in module units
export const SWATCH_COUNT = 5;

/** [R, G, B] for each patch, left to right. */
export const SWATCH_PATCHES: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [255, 255, 255],
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
];

/** Standard QR size formula: modules per side = 17 + 4 * version. */
export function qrSizeFromVersion(version: number): number {
  return 17 + 4 * version;
}
