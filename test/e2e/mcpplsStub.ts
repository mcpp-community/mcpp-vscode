/**
 * The C++ Modules extension, faked for the Extension Host tests.
 *
 * Five variants, because the promise is that *any* version of the dependency
 * keeps this extension usable — a full one, one that only offers the old restart,
 * one that renamed its command, one that exposes no state API, and one whose
 * state API throws. The stub is generated rather than checked in five times so
 * the command list has a single source here.
 */

export type StubVariant = "full" | "partial" | "renamed" | "noapi" | "throwing";

export const STUB_VARIANTS: readonly StubVariant[] = ["full", "partial", "renamed", "noapi", "throwing"];

/** Every command id this extension forwards, as the real extension registers them. */
const COMMANDS = [
  "mcppls.restartServer",
  "mcppls.reloadBuildDescription",
  "mcppls.selectContext",
  "mcppls.showModuleGraph",
  "mcppls.showLogs",
  "mcppls.restartClangd",
  "mcppls.resetWorkspaceCache",
  "mcppls.collectReport",
  "mcppls.exportDiagnosticBundle",
  "mcppls.runBuildToolInTerminal",
  "mcppls.turnOffOtherCppFeatures",
  "mcppls.restoreOtherCppFeatures",
  "mcppls.turnOffInWorkspace",
  "mcppls.turnOnInWorkspace",
  "mcppls.installCommandLineTools",
  "mcppls.review.run",
  "mcppls.review.clear",
];

function commandsFor(variant: StubVariant): string[] {
  switch (variant) {
    case "partial":
      return ["mcppls.restartServer"];
    case "renamed":
      return ["mcppls.restartServer2"];
    default:
      return COMMANDS;
  }
}

/** A ready status, shaped as S3 documents it. */
const READY_STATUS = JSON.stringify({
  state: "ready",
  project: { root: "file:///e2e", source: "mcpp", level: 3, tier: 1 },
  profile: { kind: "build-toolchain", compiler: "clang 22.1.8", stdlib: "libc++ 22.1.8", target: "x86_64-linux-gnu" },
  engine: { name: "clangd", version: "23.1.0" },
  engines: [{ name: "clangd", version: "23.1.0", role: "core", state: "ready" }],
});

export function stubPackageJson(variant: StubVariant): string {
  return `${JSON.stringify(
    {
      name: "mcpp-language-server",
      displayName: "C++ Modules Language Server stub",
      version: "0.0.0",
      publisher: "sunrisepeak",
      engines: { vscode: "^1.91.0" },
      main: "./extension.js",
      activationEvents: commandsFor(variant).map((command) => `onCommand:${command}`),
      contributes: { commands: commandsFor(variant).map((command) => ({ command, title: command })) },
    },
    null,
    2,
  )}\n`;
}

export function stubExtensionJs(variant: StubVariant): string {
  const commands = JSON.stringify(commandsFor(variant), null, 2);
  const stateBody =
    variant === "throwing"
      ? `throw new Error("the stub state reader always throws");`
      : `return ${READY_STATUS};`;
  const exportsBody =
    variant === "noapi"
      ? `module.exports = { activate };`
      : `module.exports = { activate };`;
  const apiReturn = variant === "noapi" ? "" : `  return { lastStatus: () => { ${stateBody} }, statusBarText: () => "ready" };`;

  return `const fs = require("node:fs");
const vscode = require("vscode");

// Records every forwarded call so the suite can assert what this extension asked for.
function record(command) {
  const logPath = process.env.MCPP_E2E_MCPPLS_LOG;
  if (typeof logPath === "string") {
    fs.appendFileSync(logPath, command + "\\n");
  }
}

function activate(context) {
  for (const command of ${commands}) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, () => {
        record(command);
        return undefined;
      }),
    );
  }
${apiReturn}
}

${exportsBody}
`;
}
