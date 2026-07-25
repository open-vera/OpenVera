import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyPartnerTheme,
  isAppThemeId,
  isLightTheme,
  normalizeThemeId,
  resolveThemeId,
  THEME_REGISTRY,
} from "@/theme";

function stubDocument() {
  const root = {
    dataset: {} as DOMStringMap,
    style: {
      colorScheme: "",
      props: {} as Record<string, string>,
      setProperty(name: string, value: string) {
        this.props[name] = value;
      },
      getPropertyValue(name: string) {
        return this.props[name] ?? "";
      },
      removeProperty(name: string) {
        delete this.props[name];
      },
    },
    removeAttribute(name: string) {
      if (name === "data-theme") {
        delete this.dataset.theme;
      }
    },
  };
  vi.stubGlobal("document", { documentElement: root });
  vi.stubGlobal("window", {
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
    matchMedia: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
  return root;
}

describe("partner themes", () => {
  let root: ReturnType<typeof stubDocument>;

  beforeEach(() => {
    root = stubDocument();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes legacy theme ids", () => {
    expect(normalizeThemeId("dark")).toBe("github-dark");
    expect(normalizeThemeId("light")).toBe("github-light");
    expect(normalizeThemeId("book")).toBe("book");
    expect(normalizeThemeId("unknown")).toBe("system");
  });

  it("resolves system theme from prefers-color-scheme", () => {
    expect(resolveThemeId("system", false)).toBe("github-dark");
    expect(resolveThemeId("system", true)).toBe("github-light");
    expect(resolveThemeId("inkwash", true)).toBe("inkwash");
  });

  it("applies palette tokens through the shared color mechanism", () => {
    const resolved = applyPartnerTheme("github-dark", { mode: "none" });
    expect(resolved).toBe("github-dark");
    expect(root.dataset.theme).toBe("github-dark");
    expect(root.dataset.colorScheme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
    expect(root.style.props["--bg"]).toBe("#0d1117");
    expect(root.style.props["--tab-indicator"]).toBe("#f78166");
    expect(root.style.props["--accent"]).toBe("#58a6ff");
  });

  it("marks light themes for color-scheme and wallpaper", () => {
    expect(isLightTheme("book")).toBe(true);
    expect(isLightTheme("inkwash")).toBe(true);
    expect(isLightTheme("worldcup")).toBe(true);
    expect(isLightTheme("graphite")).toBe(false);
    applyPartnerTheme("book", { mode: "theme", opacity: 0.3 });
    expect(root.style.colorScheme).toBe("light");
    expect(root.dataset.wallpaper).toBe("on");
    expect(root.style.props["--bg-solid"]).toBe("#c7b69a");
    expect(root.style.props["--bg"]).toContain("color-mix");
    expect(root.style.props["--bg"]).toContain("var(--bg-solid)");
  });

  it("validates theme ids", () => {
    expect(isAppThemeId("system")).toBe(true);
    expect(isAppThemeId("cursor")).toBe(true);
    expect(isAppThemeId("book")).toBe(true);
    expect(isAppThemeId("inkwash")).toBe(true);
    expect(isAppThemeId("worldcup")).toBe(true);
    expect(isAppThemeId("ayaka-night")).toBe(true);
    expect(isAppThemeId("ayaka-frost")).toBe(true);
    expect(isAppThemeId("custom")).toBe(true);
    expect(isAppThemeId("dark")).toBe(false);
  });

  it("applies ayaka themes with matching wallpapers", () => {
    applyPartnerTheme("ayaka-night", { mode: "theme", opacity: 0.26 });
    expect(root.dataset.theme).toBe("ayaka-night");
    expect(root.style.colorScheme).toBe("dark");
    expect(root.style.props["--accent"]).toBe("#c45c6a");
    expect(root.dataset.wallpaper).toBe("on");

    applyPartnerTheme("ayaka-frost", { mode: "theme", opacity: 0.2 });
    expect(root.dataset.theme).toBe("ayaka-frost");
    expect(root.style.colorScheme).toBe("light");
    expect(root.style.props["--accent"]).toBe("#e091a3");
  });

  it("applies custom light palettes as light color-scheme with denser glass", () => {
    const light = THEME_REGISTRY["github-light"].colors;
    applyPartnerTheme("custom", {
      mode: "ayaka-night",
      opacity: 1,
      customColors: light,
      customScheme: "light",
    });
    expect(root.dataset.theme).toBe("custom");
    expect(root.dataset.colorScheme).toBe("light");
    expect(root.style.colorScheme).toBe("light");
    expect(root.style.props["--chrome-fill"]).toBe("84%");
    expect(root.style.props["--bg"]).toContain("84%");
    expect(root.style.props["--panel-frost"]).toBe("14px");
    expect(root.dataset.panelFrost).toBe("on");
  });
});
