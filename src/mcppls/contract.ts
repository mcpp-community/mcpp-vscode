/**
 * The C++ Modules language service we depend on, as **data**.
 *
 * Everything this extension knows about `sunrisepeak.mcpp-language-server`
 * (mcppls) lives here: its extension id, the commands we forward, and how badly
 * each one needs confirming. No `vscode` import, so the table is unit-testable
 * and `tools/` can read it.
 *
 * Two rules this file exists to keep:
 *
 * 1. **Our own commands never use the `mcppls.` prefix.** mcppls's S3 spec
 *    (S3-5.6-3) forbids a client from registering a command id the server
 *    advertises: `vscode-languageclient` registers those itself, and a collision
 *    stops the language client from starting. See `.agents/docs/mcppls-integration.md`.
 * 2. **Nothing here writes an `mcppls.*` setting.** The only settings we ever
 *    touch are our own `mcpp.*`. The two commands that change mcppls state
 *    (`turnOn/turnOffInWorkspace`) are mcppls's own, and the user triggers them.
 */

export const MCPPLS_EXTENSION_ID = "sunrisepeak.mcpp-language-server";

/**
 * The version range this build was written against. Used for a **notice** only:
 * a command that disappears is detected by calling it, not by reading a version,
 * because a version number cannot predict a rename.
 */
export const VERIFIED_MCPPLS_RANGE = ">=0.0.4";

export type CapabilityKind = "forward" | "readState";

/** How much ceremony an action needs before it runs. */
export type Danger = "none" | "confirm" | "destructive";

export interface Capability {
  key: string;
  kind: CapabilityKind;
  /** English; the UI resolves it through `src/i18n/t.ts`. */
  title: string;
  /** Candidate command ids, most preferred first. Empty for `readState`. */
  commands: readonly string[];
  /** Always false: losing mcppls must never disable mcpp's own features. */
  required: boolean;
  danger: Danger;
  /** Shown when the capability is gone; says what still works. */
  degradedHint: string;
  /** Extra sentence for a destructive action, spelling out what it does *not* touch. */
  confirmHint?: string;
}

export const CAPABILITIES: readonly Capability[] = [
  {
    key: "refresh",
    kind: "forward",
    title: "Refresh the C++ Modules build description",
    commands: ["mcppls.reloadBuildDescription", "mcppls.restartServer"],
    required: false,
    danger: "none",
    degradedHint:
      "The build finished, but the language service could not be refreshed. Run \"C++ Modules: Restart Language Server\" from the Command Palette.",
  },
  {
    key: "selectContext",
    kind: "forward",
    title: "Select the C++ Modules analysis context",
    commands: ["mcppls.selectContext"],
    required: false,
    danger: "none",
    degradedHint: "Installed C++ Modules does not offer a context picker; analysis uses the default context.",
  },
  {
    key: "moduleGraph",
    kind: "forward",
    title: "Show the module graph",
    commands: ["mcppls.showModuleGraph"],
    required: false,
    danger: "none",
    degradedHint: "Installed C++ Modules does not offer a module graph.",
  },
  {
    key: "logs",
    kind: "forward",
    title: "Show the C++ Modules log",
    commands: ["mcppls.showLogs"],
    required: false,
    danger: "none",
    degradedHint: "Installed C++ Modules does not offer a log command; look for its output channel in the Output view.",
  },
  {
    key: "readState",
    kind: "readState",
    title: "C++ Modules state",
    commands: [],
    required: false,
    danger: "none",
    degradedHint: "Installed C++ Modules does not expose its state; only the actions below are available.",
  },
  {
    key: "restartServer",
    kind: "forward",
    title: "Restart the C++ Modules language server",
    commands: ["mcppls.restartServer"],
    required: false,
    danger: "none",
    degradedHint: "Installed C++ Modules does not offer a restart command.",
  },
  {
    key: "restartEngine",
    kind: "forward",
    title: "Restart the C++ semantic engine",
    commands: ["mcppls.restartClangd"],
    required: false,
    danger: "confirm",
    degradedHint: "Installed C++ Modules does not offer an engine restart.",
    confirmHint: "The semantic engine restarts; module preparation starts over and may take a while.",
  },
  {
    key: "resetCache",
    kind: "forward",
    title: "Reset this workspace's C++ Modules cache",
    commands: ["mcppls.resetWorkspaceCache"],
    required: false,
    danger: "destructive",
    degradedHint: "Installed C++ Modules does not offer a cache reset.",
    confirmHint:
      "This discards the language server's model cache for this workspace and prepares it again, which can take minutes. mcpp's own build cache and the project's target/ directory are not touched.",
  },
  {
    key: "report",
    kind: "forward",
    title: "Collect a C++ Modules diagnostic report",
    commands: ["mcppls.collectReport"],
    required: false,
    danger: "none",
    degradedHint: "Installed C++ Modules does not offer a report command.",
  },
  {
    key: "diagnosticBundle",
    kind: "forward",
    title: "Export a C++ Modules diagnostic bundle",
    commands: ["mcppls.exportDiagnosticBundle"],
    required: false,
    danger: "none",
    degradedHint: "Installed C++ Modules does not offer a diagnostic bundle.",
  },
  {
    key: "runBuildTool",
    kind: "forward",
    title: "Run the build tool in a terminal",
    commands: ["mcppls.runBuildToolInTerminal"],
    required: false,
    danger: "confirm",
    degradedHint: "Installed C++ Modules does not offer this action.",
    confirmHint: "The build tool runs in an integrated terminal, with its normal side effects.",
  },
  {
    key: "manageConflicts",
    kind: "forward",
    title: "Manage other C++ language features",
    commands: ["mcppls.turnOffOtherCppFeatures", "mcppls.restoreOtherCppFeatures"],
    required: false,
    danger: "confirm",
    degradedHint: "Installed C++ Modules does not offer conflict handling.",
    confirmHint: "This changes settings belonging to other C++ extensions, at their own keys. C++ Modules performs the change.",
  },
  {
    key: "toggleInWorkspace",
    kind: "forward",
    title: "Enable or disable C++ Modules in this workspace",
    commands: ["mcppls.turnOffInWorkspace", "mcppls.turnOnInWorkspace"],
    required: false,
    danger: "confirm",
    degradedHint: "Installed C++ Modules does not offer a per-workspace switch.",
    confirmHint: "This writes mcppls.enable, a setting owned by the C++ Modules extension.",
  },
  {
    key: "installTools",
    kind: "forward",
    title: "Install the C++ Modules command line tools",
    commands: ["mcppls.installCommandLineTools"],
    required: false,
    danger: "confirm",
    degradedHint: "Installed C++ Modules does not offer a command line tools installer.",
    confirmHint: "This may install system packages the language server needs.",
  },
  {
    key: "review",
    kind: "forward",
    title: "Review workspace changes",
    commands: ["mcppls.review.run", "mcppls.review.clear"],
    required: false,
    danger: "none",
    degradedHint: "Installed C++ Modules does not offer its review commands here.",
  },
];

const BY_KEY = new Map(CAPABILITIES.map((capability) => [capability.key, capability]));

export function capability(key: string): Capability | undefined {
  return BY_KEY.get(key);
}

/** The commands mcppls must declare for a capability to be usable at all. */
export function commandsOf(key: string): readonly string[] {
  return BY_KEY.get(key)?.commands ?? [];
}

/**
 * The capability table's own invariants (must be empty).
 *
 * The "our ids never use the mcppls prefix" rule is checked where our ids live
 * (`src/commands/ids.ts`); this covers the forward table itself.
 */
export function capabilityProblems(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of CAPABILITIES) {
    if (seen.has(entry.key)) {
      problems.push(`duplicate capability ${entry.key}`);
    }
    seen.add(entry.key);
    if (entry.required) {
      problems.push(`${entry.key} is marked required; losing the language service must not disable mcpp features`);
    }
    if (entry.kind === "forward" && entry.commands.length === 0) {
      problems.push(`forward capability ${entry.key} has no command`);
    }
    if (entry.kind === "readState" && entry.commands.length > 0) {
      problems.push(`readState capability ${entry.key} must not name a command`);
    }
    for (const command of entry.commands) {
      if (!command.startsWith("mcppls.")) {
        problems.push(`${entry.key} forwards ${command}, which is not an mcppls. command`);
      }
    }
    if (entry.danger !== "none" && entry.confirmHint === undefined) {
      problems.push(`${entry.key} needs confirmation but has no confirmHint`);
    }
  }
  return problems;
}
