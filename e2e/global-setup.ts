import { execSync } from "node:child_process";
import { assertApiHealthy } from "./helpers/dev-token.ts";
import { assertWebHealthy } from "./helpers/login-code.ts";
import { assertExtensionBuild, extensionRoot } from "./helpers/paths.ts";

export default async function globalSetup(): Promise<void> {
  await assertApiHealthy();
  await assertWebHealthy();

  if (process.env.PW_SKIP_EXTENSION_BUILD === "1") {
    assertExtensionBuild();
    return;
  }

  execSync("npm run build:e2e", {
    cwd: extensionRoot,
    stdio: "inherit",
    env: process.env,
  });
  assertExtensionBuild();
}
