import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyPartnerWallpaper,
  applyColorTokens,
  BUILTIN_WALLPAPERS,
  chromeFillPercent,
  clampWallpaperBlur,
  clampWallpaperOpacity,
  LIGHT_SCHEME_MIN_CHROME_FILL,
  LIGHT_SCHEME_MIN_PANEL_FROST,
  panelFrostPx,
  isBuiltinWallpaperId,
  isWallpaperMode,
  resolveWallpaper,
  THEME_REGISTRY,
  themeDefaultWallpaper,
} from "@/theme";

describe("partner wallpapers", () => {
  beforeEach(() => {
    vi.stubGlobal("document", {
      documentElement: {
        dataset: {} as DOMStringMap,
        style: {
          colorScheme: "",
          props: {} as Record<string, string>,
          setProperty(name: string, value: string) {
            this.props[name] = value;
          },
          removeProperty(name: string) {
            delete this.props[name];
          },
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clamps wallpaper opacity and blur independently", () => {
    expect(clampWallpaperOpacity(0.01)).toBe(0.05);
    expect(clampWallpaperOpacity(0.9)).toBe(0.9);
    expect(clampWallpaperOpacity(1.4)).toBe(1);
    expect(clampWallpaperOpacity("bad")).toBe(0.28);
    expect(clampWallpaperBlur(-3)).toBe(0);
    expect(clampWallpaperBlur(12)).toBe(12);
    expect(clampWallpaperBlur(99)).toBe(40);
  });

  it("resolves theme builtin textures from the theme registry", () => {
    expect(themeDefaultWallpaper("book")?.id).toBe("book");
    expect(themeDefaultWallpaper("inkwash")?.id).toBe("inkwash");
    expect(themeDefaultWallpaper("worldcup")?.id).toBe("worldcup");
    expect(themeDefaultWallpaper("ayaka-night")?.id).toBe("ayaka-night");
    expect(themeDefaultWallpaper("ayaka-frost")?.id).toBe("ayaka-frost");
    expect(themeDefaultWallpaper("cursor")).toBeNull();

    const book = resolveWallpaper({
      mode: "theme",
      customDataUrl: null,
      opacity: 0.3,
      themeBuiltin: BUILTIN_WALLPAPERS.book,
    });
    expect(book.image).toContain("data:image/svg+xml");
    expect(book.blend).toBe("multiply");
    expect(book.opacity).toBe(0.3);

    const worldcup = resolveWallpaper({
      mode: "theme",
      customDataUrl: null,
      opacity: 0.24,
      themeBuiltin: BUILTIN_WALLPAPERS.worldcup,
    });
    expect(worldcup.image).toContain("/wallpapers/worldcup.png");
    expect(worldcup.blend).toBe("normal");
  });

  it("resolves an explicitly selected builtin wallpaper", () => {
    const night = resolveWallpaper({
      mode: "ayaka-night",
      customDataUrl: null,
      opacity: 0.26,
      themeBuiltin: BUILTIN_WALLPAPERS.book,
    });
    expect(night.image).toContain("/wallpapers/ayaka-night.png");
    expect(night.opacity).toBe(0.26);

    const frost = resolveWallpaper({
      mode: "ayaka-frost",
      customDataUrl: null,
      opacity: 0.2,
    });
    expect(frost.image).toContain("/wallpapers/ayaka-frost.png");
  });

  it("prefers custom wallpaper data url", () => {
    const custom = resolveWallpaper({
      mode: "custom",
      customDataUrl: "data:image/jpeg;base64,abc",
      opacity: 0.2,
      themeBuiltin: BUILTIN_WALLPAPERS.book,
    });
    expect(custom.image).toBe('url("data:image/jpeg;base64,abc")');
    expect(custom.blend).toBe("normal");
  });

  it("disables wallpaper in none mode", () => {
    const none = resolveWallpaper({
      mode: "none",
      customDataUrl: "data:image/jpeg;base64,abc",
      opacity: 0.4,
      themeBuiltin: BUILTIN_WALLPAPERS.inkwash,
    });
    expect(none.image).toBeNull();
    expect(none.opacity).toBe(0);
  });

  it("validates wallpaper modes", () => {
    expect(isWallpaperMode("theme")).toBe(true);
    expect(isWallpaperMode("custom")).toBe(true);
    expect(isWallpaperMode("ayaka-night")).toBe(true);
    expect(isWallpaperMode("ayaka-frost")).toBe(true);
    expect(isBuiltinWallpaperId("worldcup")).toBe(true);
    expect(isWallpaperMode("auto")).toBe(false);
    expect(isBuiltinWallpaperId("auto")).toBe(false);
  });

  it("keeps denser chrome and panel frost for light schemes", () => {
    expect(chromeFillPercent(1, "dark")).toBe(8);
    expect(chromeFillPercent(1, "light")).toBe(LIGHT_SCHEME_MIN_CHROME_FILL);
    expect(chromeFillPercent(0.05, "light")).toBeGreaterThan(90);
    expect(panelFrostPx(0, "dark")).toBe(0);
    expect(panelFrostPx(0, "light")).toBe(LIGHT_SCHEME_MIN_PANEL_FROST);
    expect(panelFrostPx(20, "light")).toBe(20);
  });

  it("makes chrome glassier at full intensity and restores solids when off", () => {
    const props: Record<string, string> = {};
    const style = {
      setProperty(name: string, value: string) {
        props[name] = value;
      },
      getPropertyValue(name: string) {
        return props[name] ?? "";
      },
    };
    vi.stubGlobal("document", {
      documentElement: {
        dataset: {} as DOMStringMap,
        style,
      },
    });

    applyColorTokens(THEME_REGISTRY["ayaka-night"].colors, style as CSSStyleDeclaration);
    applyPartnerWallpaper({
      image: 'url("/wallpapers/ayaka-night.png")',
      size: "cover",
      repeat: "no-repeat",
      blend: "normal",
      opacity: 1,
      blur: 18,
    });
    expect(props["--bg"]).toBe("color-mix(in srgb, var(--bg-solid) 8%, transparent)");
    expect(props["--chrome-fill"]).toBe("8%");
    expect(props["--wallpaper-opacity"]).toBe("1");
    expect(props["--wallpaper-blur"]).toBe("18px");
    expect(props["--panel-frost"]).toBe("18px");
    expect((document.documentElement.dataset as DOMStringMap).wallpaperBlur).toBe("on");
    expect((document.documentElement.dataset as DOMStringMap).panelFrost).toBe("on");

    applyPartnerWallpaper(
      {
        image: 'url("/wallpapers/ayaka-night.png")',
        size: "cover",
        repeat: "no-repeat",
        blend: "normal",
        opacity: 1,
        blur: 0,
      },
      "light",
    );
    expect(props["--chrome-fill"]).toBe(`${LIGHT_SCHEME_MIN_CHROME_FILL}%`);
    expect(props["--wallpaper-blur"]).toBe("0px");
    expect(props["--panel-frost"]).toBe(`${LIGHT_SCHEME_MIN_PANEL_FROST}px`);
    expect((document.documentElement.dataset as DOMStringMap).wallpaperBlur).toBe("off");
    expect((document.documentElement.dataset as DOMStringMap).panelFrost).toBe("on");

    applyPartnerWallpaper({
      image: 'url("/wallpapers/ayaka-night.png")',
      size: "cover",
      repeat: "no-repeat",
      blend: "normal",
      opacity: 0.5,
      blur: 0,
    });
    expect(props["--wallpaper-opacity"]).toBe("1");
    expect(props["--wallpaper-blur"]).toBe("0px");
    expect(props["--panel-frost"]).toBe("0px");
    expect((document.documentElement.dataset as DOMStringMap).wallpaperBlur).toBe("off");
    expect((document.documentElement.dataset as DOMStringMap).panelFrost).toBe("off");

    applyPartnerWallpaper({
      image: null,
      size: "cover",
      repeat: "no-repeat",
      blend: "normal",
      opacity: 0,
      blur: 0,
    });
    expect(props["--bg"]).toBe(THEME_REGISTRY["ayaka-night"].colors.bg);
    expect((document.documentElement.dataset as DOMStringMap).wallpaperBlur).toBe("off");
  });
});
