import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runTests } from "@vscode/test-electron";

import { STUB_VARIANTS, stubExtensionJs, stubPackageJson, type StubVariant } from "./mcpplsStub";

/**
 * One Extension Host run per mcppls variant. Each run gets its own extensions
 * directory and user data, so a variant cannot leak into the next one, and the
 * only thing that differs between them is which commands the stub offers.
 */
async function runVariant(repositoryRoot: string, fixtureRoot: string, variant: StubVariant): Promise<void> {
  const tempRoot = mkdtempSync(join(tmpdir(), `mcpp-vscode-e2e-${variant}-`));
  const userDataDir = join(tempRoot, "user-data");
  const extensionsDir = join(tempRoot, "extensions");
  const workspaceDir = join(tempRoot, "project");
  const fakeMcpp = join(tempRoot, "mcpp");
  const mcppLogPath = join(tempRoot, "mcpp.log");
  const mcpplsLogPath = join(tempRoot, "mcppls.log");
  const mcpplsStub = join(extensionsDir, "sunrisepeak.mcpp-language-server-0.0.0");

  mkdirSync(userDataDir, { recursive: true });
  mkdirSync(extensionsDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(mcpplsStub, { recursive: true });
  copyFileSync(join(fixtureRoot, "fake-mcpp.js"), fakeMcpp);
  chmodSync(fakeMcpp, 0o755);
  writeFileSync(join(mcpplsStub, "package.json"), stubPackageJson(variant));
  writeFileSync(join(mcpplsStub, "extension.js"), stubExtensionJs(variant));
  copyFileSync(join(fixtureRoot, "project/mcpp.toml"), join(workspaceDir, "mcpp.toml"));
  copyFileSync(join(fixtureRoot, "project/main.cpp"), join(workspaceDir, "main.cpp"));

  try {
    await runTests({
      version: "1.91.0",
      extensionDevelopmentPath: repositoryRoot,
      extensionTestsPath: join(repositoryRoot, "dist/test/e2e/suite/index.js"),
      launchArgs: [
        workspaceDir,
        "--user-data-dir",
        userDataDir,
        "--extensions-dir",
        extensionsDir,
        "--disable-updates",
        "--skip-welcome",
        "--disable-workspace-trust",
      ],
      extensionTestsEnv: {
        MCPP_E2E_FAKE_MCPP: fakeMcpp,
        MCPP_E2E_LOG: mcppLogPath,
        MCPP_E2E_MCPPLS_LOG: mcpplsLogPath,
        MCPP_E2E_STUB: variant,
      },
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const repositoryRoot = resolve(__dirname, "../../..");
  const fixtureRoot = join(repositoryRoot, "test/e2e/fixtures");
  // `MCPP_E2E_STUB=partial` runs one variant; unset runs them all.
  const requested = process.env.MCPP_E2E_STUB;
  const variants = requested === undefined
    ? STUB_VARIANTS
    : STUB_VARIANTS.filter((variant) => variant === requested);

  if (variants.length === 0) {
    throw new Error(`MCPP_E2E_STUB=${requested} is not one of ${STUB_VARIANTS.join(", ")}`);
  }

  for (const variant of variants) {
    console.log(`e2e: running the extension host against the "${variant}" mcppls stub`);
    await runVariant(repositoryRoot, fixtureRoot, variant);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
