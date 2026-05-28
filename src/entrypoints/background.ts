// WXT background entrypoint (MV3 module service worker). All runtime code lives
// in initBackground(); listeners must be registered synchronously inside it
// (single eager chunk — no dynamic import before registration, no top-level
// await). `type: "module"` matches legacy/manifest.json.
import { initBackground } from "@/background";

export default defineBackground({
  type: "module",
  main: initBackground,
});
