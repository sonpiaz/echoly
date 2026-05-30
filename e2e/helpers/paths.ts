import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
export const extensionRoot = path.resolve(e2eDir, "../..");
export const extensionBuildDir = path.join(extensionRoot, ".output/chrome-mv3-dev");

export function assertExtensionBuild(): string {
  const manifest = path.join(extensionBuildDir, "manifest.json");
  if (!fs.existsSync(manifest)) {
    throw new Error(
      `Extension build missing at ${extensionBuildDir}. Run: cd extension && npm run build:e2e`,
    );
  }
  return extensionBuildDir;
}
