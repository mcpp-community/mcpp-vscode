/**
 * Capability probing and invocation for the C++ Modules extension.
 *
 * Pure: the only VS Code-shaped things it needs arrive through
 * `CapabilityEnvironment`, which is exactly what the extension host supplies and
 * what the tests fake.
 *
 * Why probing is two-level:
 *
 * - **Static** — `packageJSON.contributes.commands` says which ids mcppls
 *   declares. It costs nothing and never runs anything. A command the static
 *   read cannot see is *greyed out*, not hidden, so a wrong read cannot remove a
 *   feature.
 * - **Runtime** — the first real use calls the command once and classifies the
 *   failure. `command '…' not found` means the capability is gone for this
 *   session; anything else is a failure of that one call and does not remove the
 *   feature.
 *
 * We deliberately do **not** probe by calling every command at activation:
 * `selectContext`, `showModuleGraph` and `showLogs` are UI commands with side
 * effects, and probing them would open pickers and panels. `commands.getCommands()`
 * is not used either — whether it lists a contributed-but-unactivated command is
 * not guaranteed across VS Code versions.
 */

import { CAPABILITIES, MCPPLS_EXTENSION_ID, capability } from "./contract";

export interface CapabilityEnvironment {
  /** `vscode.extensions.getExtension(id) !== undefined`. */
  extensionInstalled(id: string): boolean;
  /** Declared command ids, from the extension's `package.json`. */
  declaredCommands?(id: string): readonly string[] | undefined;
  /** Activate the dependency before the first forward, when VS Code has not. */
  activateExtension?(id: string): Thenable<unknown>;
  executeCommand<T>(command: string, ...args: unknown[]): Thenable<T>;
}

export type CapabilityState = "available" | "declared" | "undeclared" | "missing" | "unavailable";

export interface CapabilityStatus {
  key: string;
  state: CapabilityState;
  /** The command chosen for this capability, when there is one. */
  command?: string;
}

export type InvokeState = "completed" | "unavailable" | "missing" | "failed";

export interface InvokeResult {
  state: InvokeState;
  capabilityKey: string;
  /** The command that ran, when one ran. */
  command?: string;
  /** Error text from the failed call, verbatim. */
  error?: string;
  /**
   * Whatever the command answered with, when it answered with anything.
   *
   * A few mcppls commands return a path — `mcppls.exportDiagnosticBundle`
   * resolves to the zip it wrote (`exportDiagnosticBundle(): Promise<string |
   * undefined>` upstream) — and that is the only reliable way to point at the
   * file afterwards. Most commands return nothing, and the caller must treat this
   * as unknown: it is passed on untouched, never parsed.
   */
  value?: unknown;
}

/** `command 'x' not found` in the several spellings VS Code has used. */
const NOT_FOUND = /command\s+(?:['"`][^'"`]+['"`]\s+)?not found|not registered|no such command/i;

export function classifyCommandError(error: unknown): "missing" | "failed" {
  const message = error instanceof Error ? error.message : String(error);
  return NOT_FOUND.test(message) ? "missing" : "failed";
}

export class CapabilityRegistry {
  private readonly statuses = new Map<string, CapabilityStatus>();

  public constructor(private readonly environment: CapabilityEnvironment) {
    this.probe();
  }

  /** Re-read the static declaration; called when extensions are installed, enabled or updated. */
  public invalidate(): void {
    this.statuses.clear();
    this.probe();
  }

  public status(key: string): CapabilityStatus {
    return this.statuses.get(key) ?? { key, state: "unavailable" };
  }

  /** Capabilities whose first command is believed usable right now. */
  public availableKeys(): string[] {
    return [...this.statuses.values()]
      .filter((status) => status.state === "available" || status.state === "declared")
      .map((status) => status.key);
  }

  /** True when the user should not be offered the capability. */
  public isGone(key: string): boolean {
    const state = this.status(key).state;
    return state === "unavailable" || state === "missing";
  }

  /** True when the capability exists but the static read could not confirm it: grey out, do not hide. */
  public isUnconfirmed(key: string): boolean {
    return this.status(key).state === "undeclared";
  }

  private probe(): void {
    const installed = this.environment.extensionInstalled(MCPPLS_EXTENSION_ID);
    const declared = installed ? this.environment.declaredCommands?.(MCPPLS_EXTENSION_ID) : undefined;
    for (const entry of CAPABILITIES) {
      if (entry.kind === "readState") {
        // State comes from `extension.exports`, which cannot be inspected without
        // activating; the reader decides and reports for itself.
        this.statuses.set(entry.key, { key: entry.key, state: installed ? "declared" : "unavailable" });
        continue;
      }
      if (!installed) {
        this.statuses.set(entry.key, { key: entry.key, state: "unavailable" });
        continue;
      }
      if (declared === undefined) {
        // No static information: assume the first command works until a call says otherwise.
        this.statuses.set(entry.key, { key: entry.key, state: "declared", command: entry.commands[0] });
        continue;
      }
      const command = entry.commands.find((candidate) => declared.includes(candidate));
      this.statuses.set(
        entry.key,
        command === undefined
          ? { key: entry.key, state: "undeclared" }
          : { key: entry.key, state: "declared", command },
      );
    }
  }

  /**
   * Run a capability, activating the dependency first. Returns the command that
   * ran so the caller can name it in a log line.
   */
  public async invoke(key: string, ...args: unknown[]): Promise<InvokeResult> {
    const entry = capability(key);
    if (entry === undefined) {
      return { state: "failed", capabilityKey: key, error: `unknown capability ${key}` };
    }
    if (!this.environment.extensionInstalled(MCPPLS_EXTENSION_ID)) {
      return { state: "unavailable", capabilityKey: key };
    }
    const known = this.status(key);
    if (known.state === "missing") {
      // Remembered from an earlier call: do not ask VS Code again.
      return { state: "missing", capabilityKey: key };
    }
    if (known.state === "unavailable") {
      return { state: "unavailable", capabilityKey: key };
    }

    // Candidate chain: prefer the first command the probe could confirm.
    const status = known;
    const candidate = status.command ?? entry.commands[0];
    if (candidate === undefined) {
      return { state: "failed", capabilityKey: key, error: `capability ${key} has no command` };
    }

    try {
      await this.environment.activateExtension?.(MCPPLS_EXTENSION_ID);
      const value = await this.environment.executeCommand(candidate, ...args);
      this.statuses.set(key, { key, state: "available", command: candidate });
      return {
        state: "completed",
        capabilityKey: key,
        command: candidate,
        ...(value === undefined ? {} : { value }),
      };
    } catch (error) {
      const failure = classifyCommandError(error);
      if (failure === "missing") {
        // This command does not exist in the installed version: try the next
        // candidate once, then remember.
        const next = entry.commands.find((other) => other !== candidate);
        if (next !== undefined) {
          try {
            const value = await this.environment.executeCommand(next, ...args);
            this.statuses.set(key, { key, state: "available", command: next });
            return {
              state: "completed",
              capabilityKey: key,
              command: next,
              ...(value === undefined ? {} : { value }),
            };
          } catch (second) {
            if (classifyCommandError(second) === "missing") {
              this.statuses.set(key, { key, state: "missing" });
              return { state: "missing", capabilityKey: key, command: candidate };
            }
            return { state: "failed", capabilityKey: key, command: next, error: messageOf(second) };
          }
        }
        this.statuses.set(key, { key, state: "missing" });
        return { state: "missing", capabilityKey: key, command: candidate };
      }
      return { state: "failed", capabilityKey: key, command: candidate, error: messageOf(error) };
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
