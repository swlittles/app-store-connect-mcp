import { open } from "node:fs/promises";
import type { ScreenshotDisplayType } from "../asc/types.js";

/** Reads the pixel size of a PNG or JPEG from its header. Returns undefined for other formats. */
export async function imageSize(path: string): Promise<{ width: number; height: number } | undefined> {
  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const b = buf.subarray(0, bytesRead);
    if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) {
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return undefined;
        const marker = b[i + 1]!;
        const length = b.readUInt16BE(i + 2);
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        i += 2 + length;
      }
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

/**
 * Portrait sizes Apple accepts for the display types people use most (landscape is the same
 * sizes rotated). Only used for warnings: Apple's processing is the final word.
 */
const KNOWN_SIZES: Partial<Record<ScreenshotDisplayType, [number, number][]>> = {
  APP_IPHONE_67: [
    [1320, 2868],
    [1290, 2796],
    [1260, 2736],
  ],
  APP_IPHONE_65: [
    [1242, 2688],
    [1284, 2778],
  ],
  APP_IPHONE_55: [[1242, 2208]],
  APP_IPAD_PRO_3GEN_129: [
    [2064, 2752],
    [2048, 2732],
  ],
  APP_IPAD_PRO_129: [[2048, 2732]],
  APP_DESKTOP: [
    [1280, 800],
    [1440, 900],
    [2560, 1600],
    [2880, 1800],
  ],
};

/** Returns a warning if the image is a size Apple is unlikely to accept for this display type. */
export async function checkScreenshotSize(path: string, displayType: ScreenshotDisplayType): Promise<string | undefined> {
  const sizes = KNOWN_SIZES[displayType];
  if (!sizes) return undefined;
  const size = await imageSize(path).catch(() => undefined);
  if (!size) return `${path.split("/").pop()}: not a PNG or JPEG Apple can use`;
  const ok = sizes.some(([w, h]) => (size.width === w && size.height === h) || (size.width === h && size.height === w));
  if (ok) return undefined;
  return `${path.split("/").pop()} is ${size.width}×${size.height}, but ${displayType} expects ${sizes.map(([w, h]) => `${w}×${h}`).join(" or ")} (or rotated). Apple will probably reject it.`;
}
