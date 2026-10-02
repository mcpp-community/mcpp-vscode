/**
 * `mcpp: Environment Self-check` — one copyable snapshot.
 *
 * The point is to answer the questions a support thread always asks, in one
 * place: which versions, which protocol, what mcppls can do, what the state is,
 * which settings were changed. Pure, so the layout is testable and the extension
 * host only has to gather the input.
 */

import { formatBytes, formatCount } from "../util/format";

export interface SelfCheckInput {
  extensionVersion: string;
  vscodeVersion: string;
  platform: string;
  languagePreference: string;
  trusted: boolean;
  workspaceRoots: readonly string[];
  projectRoot?: string;
  mcppPath: string;
  mcppProbe?: {
    version?: string;
    envelopeMax?: number;
    kinds: readonly string[];
    effects?: Record<string, readonly string[]>;
  };
  mcppls: {
    installed: boolean;
    version?: string;
    enabled: boolean;
    state: string;
    capabilities: ReadonlyArray<{ key: string; state: string; command?: string }>;
  };
  cache?: { totalBytes: number; entries: number; incomplete?: number };
  changedSettings: ReadonlyArray<{ key: string; value: unknown; source: string }>;
  lastRefresh?: { at: string; state: string; command?: string };
}

function line(label: string, value: string): string {
  return `  ${label.padEnd(14)}${value}`;
}

/**
 * The snapshot. It says "unknown" where something could not be read — an empty
 * field reads as "nothing is wrong", which is the opposite of the truth.
 */
export function buildSelfCheckText(input: SelfCheckInput): string {
  const lines: string[] = [];
  lines.push(`mcpp-vscode ${input.extensionVersion} · VS Code ${input.vscodeVersion} · ${input.platform}`);
  lines.push(line("Language", input.languagePreference));
  lines.push(line("Workspace", `${input.trusted ? "trusted" : "NOT trusted"} · ${input.workspaceRoots.length} root(s)`));
  for (const root of input.workspaceRoots) {
    lines.push(line("  folder", root));
  }
  lines.push(line("Project", input.projectRoot ?? "no mcpp.toml found"));

  lines.push("");
  lines.push("mcpp");
  lines.push(line("path", input.mcppPath));
  const probe = input.mcppProbe;
  if (probe === undefined) {
    lines.push(line("version", "unknown (mcpp --protocol-version did not answer)"));
  } else {
    lines.push(line("version", probe.version ?? "unknown"));
    lines.push(line("envelope", probe.envelopeMax === undefined ? "unknown" : String(probe.envelopeMax)));
    lines.push(line("kinds", probe.kinds.length === 0 ? "none advertised" : probe.kinds.join(", ")));
  }

  lines.push("");
  lines.push("C++ Modules (mcppls)");
  lines.push(line("installed", input.mcppls.installed ? "yes" : "no"));
  lines.push(line("version", input.mcppls.version ?? "unknown"));
  lines.push(line("enabled", input.mcppls.enabled ? "yes" : "disabled in this workspace"));
  lines.push(line("state", input.mcppls.state));
  for (const capability of input.mcppls.capabilities) {
    lines.push(line(`  ${capability.key}`, `${capability.state}${capability.command === undefined ? "" : ` → ${capability.command}`}`));
  }
  lines.push(line("last refresh", input.lastRefresh === undefined ? "never" : `${input.lastRefresh.state} at ${input.lastRefresh.at}${input.lastRefresh.command === undefined ? "" : ` (${input.lastRefresh.command})`}`));

  lines.push("");
  lines.push("Cache");
  if (input.cache === undefined) {
    lines.push(line("shared", "not read"));
  } else {
    lines.push(line("shared", `${formatBytes(input.cache.totalBytes)} · ${formatCount(input.cache.entries)} entries${input.cache.incomplete === undefined ? "" : ` · ${input.cache.incomplete} incomplete`}`));
  }

  lines.push("");
  lines.push(`Settings changed from their default (${input.changedSettings.length})`);
  if (input.changedSettings.length === 0) {
    lines.push(line("", "none"));
  } else {
    for (const entry of input.changedSettings) {
      lines.push(line(`  ${entry.source}`, `${entry.key} = ${JSON.stringify(entry.value)}`));
    }
  }
  return lines.join("\n");
}
