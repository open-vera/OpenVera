import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import {
  applyPartnerTheme,
  clampWallpaperBlur,
  clampWallpaperOpacity,
  isWallpaperMode,
  readStoredThemeId,
  readStoredWallpaperDataUrl,
  type WallpaperMode,
} from "./theme";
import "./styles/app.css";

function bootAppearance() {
  let wallpaperMode: WallpaperMode = "theme";
  let wallpaperOpacity = 0.28;
  let wallpaperBlur = 0;
  try {
    const raw = window.localStorage.getItem("partner:ui-settings");
    if (raw) {
      const parsed = JSON.parse(raw) as {
        wallpaperMode?: unknown;
        wallpaperOpacity?: unknown;
        wallpaperBlur?: unknown;
      };
      if (isWallpaperMode(parsed.wallpaperMode)) {
        wallpaperMode = parsed.wallpaperMode;
      }
      if (typeof parsed.wallpaperOpacity === "number") {
        wallpaperOpacity = clampWallpaperOpacity(parsed.wallpaperOpacity);
      }
      if (typeof parsed.wallpaperBlur === "number") {
        wallpaperBlur = clampWallpaperBlur(parsed.wallpaperBlur);
      }
    }
  } catch {
    // ignore corrupt boot settings
  }
  applyPartnerTheme(readStoredThemeId(), {
    mode: wallpaperMode,
    customDataUrl: readStoredWallpaperDataUrl(),
    opacity: wallpaperOpacity,
    blur: wallpaperBlur,
  });
}

bootAppearance();

const app = createApp(App);
app.use(createPinia());
app.mount("#app");
