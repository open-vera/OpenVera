import { describe, expect, it } from "vitest";
import {
  buildPaletteVariants,
  isCustomPaletteId,
  pixelsFromRgba,
  rgbToHex,
  sampleDominantColors,
  type Rgb,
} from "@/theme";

function paint(pixels: Rgb[], count: number): Rgb[] {
  const out: Rgb[] = [];
  for (let i = 0; i < count; i += 1) out.push(pixels[i % pixels.length]);
  return out;
}

describe("extract-palette", () => {
  it("samples dominant colors with separation", () => {
    const dominant = sampleDominantColors(
      paint(
        [
          { r: 10, g: 10, b: 14 },
          { r: 200, g: 70, b: 90 },
          { r: 170, g: 190, b: 220 },
          { r: 12, g: 12, b: 16 },
        ],
        200,
      ),
      4,
    );
    expect(dominant.length).toBeGreaterThanOrEqual(3);
    expect(rgbToHex(dominant[0])).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("builds four distinct custom variants from sample colors", () => {
    const variants = buildPaletteVariants([
      { r: 18, g: 16, b: 22 },
      { r: 196, g: 92, b: 106 },
      { r: 176, g: 196, b: 222 },
      { r: 201, g: 164, b: 92 },
    ]);
    expect(variants.map((v) => v.id)).toEqual(["dark", "light", "vivid", "soft"]);
    expect(variants[0].scheme).toBe("dark");
    expect(variants[1].scheme).toBe("light");
    expect(variants[0].preview[0]).not.toBe(variants[1].preview[0]);
    expect(variants[0].colors.accent).not.toBe(variants[2].colors.bg);
    expect(isCustomPaletteId("vivid")).toBe(true);
    expect(isCustomPaletteId("neon")).toBe(false);
  });

  it("reads rgba buffers while skipping transparent pixels", () => {
    const rgba = Uint8ClampedArray.from([
      10, 20, 30, 255, 1, 2, 3, 10, 200, 100, 80, 255,
    ]);
    const pixels = pixelsFromRgba(rgba, 1);
    expect(pixels).toHaveLength(2);
    expect(pixels[0]).toEqual({ r: 10, g: 20, b: 30 });
  });
});
