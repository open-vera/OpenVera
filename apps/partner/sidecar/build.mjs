import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/partner-sidecar.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["chromium-bidi/*", "fsevents", "*.node", "ws"],
  // esbuild turns `require()` inside bundled CJS into a shim that throws
  // "Dynamic require of X is not supported" under ESM. Handing it a real
  // require keeps CJS dependencies loadable instead of crashing at startup.
  banner: {
    js: 'import{createRequire as __createRequire}from"node:module";var require=__createRequire(import.meta.url);',
  },
});
