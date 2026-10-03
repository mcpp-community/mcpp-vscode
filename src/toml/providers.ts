/**
 * `mcpp.toml` editing: structural completion plus manifest diagnostics.
 *
 * Both are pure text analysis — no mcpp process, no language server — so they
 * keep working in a restricted workspace, which is what
 * `capabilities.untrustedWorkspaces: limited` promises.
 *
 * The one exception is dependency-version completion
 * (`mcpp.toml.indexCompletion`, off by default): it runs `mcpp search`, which may
 * use the network. Everything about *that* decision lives here — the two
 * settings, workspace trust, the timeout and the session cache — while
 * `./completion` stays pure and `../cli/search` stays the one place that parses
 * mcpp's human-readable output.
 */

import * as vscode from "vscode";

import { runMcpp } from "../cli/process";
import {
  indexCompletionRequest,
  parseSearchOutput,
  withDeadline,
  type PackageVersion,
} from "../cli/search";
import { read } from "../config/access";
import { t } from "../i18n/t";

import { computeMcppTomlCompletionsWithIndex } from "./completion";
import { analyseManifest, type DiagnosticSettings, type Severity } from "./diagnostics";
import { hoverAt } from "./hover";
import { definitionAt } from "./navigation";

export const MCPP_TOML_LANGUAGE = "mcpp-toml";

/**
 * The session cache §3.3.2 asks for: at most one `mcpp search <name>
 * --all-versions` per package per session. Empty results are cached too — a
 * package the index does not know must not be queried on every keystroke.
 */
const indexVersions = new Map<string, readonly PackageVersion[]>();

let indexNoticeShown = false;

/** The plan's one-time notice: this feature runs mcpp and may use the network. */
function noticeIndexQuery(): void {
  if (indexNoticeShown) {
    return;
  }
  indexNoticeShown = true;
  void vscode.window.showInformationMessage(
    t("Completing dependency versions runs `mcpp search`, which may use the network."),
  );
}

/**
 * Versions for one dependency, or none. Every failure mode — the setting off, an
 * untrusted workspace, a non-zero exit, a timeout, output the parser does not
 * recognise — degrades to an empty list; nothing here surfaces an error.
 */
async function resolveIndexVersions(
  document: vscode.TextDocument,
  name: string,
): Promise<readonly PackageVersion[]> {
  const request = indexCompletionRequest(name, {
    enabled: read<boolean>("mcpp.toml.indexCompletion"),
    trusted: vscode.workspace.isTrusted,
    // VS Code exposes no offline flag and this extension never probes the
    // network, so "offline" is discovered the only honest way: the query fails
    // and degrades to no candidates. The term stays in `shouldSearch`'s contract
    // (and its tests) so a future signal can fill it in without a shape change.
    offline: false,
    timeoutSeconds: read<number>("mcpp.toml.indexCompletionTimeoutSeconds"),
  });
  if (request === undefined) {
    return [];
  }

  // The cache is consulted *after* the switches, so turning the setting off (or
  // losing trust) stops suggestions immediately instead of serving a hit.
  const cached = indexVersions.get(name);
  if (cached !== undefined) {
    return cached;
  }
  noticeIndexQuery();

  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  const cwd = folder?.uri.fsPath ?? vscode.Uri.joinPath(document.uri, "..").fsPath;
  const executable = (read<string>("mcpp.path") ?? "").trim() || "mcpp";
  // The process gets the setting's timeout and the promise a short grace period,
  // so a process that refuses to die still cannot hold the editor past it.
  const result = await withDeadline(
    runMcpp(vscode.workspace.isTrusted, executable, request.args, cwd, { timeoutMs: request.timeoutMs }),
    request.timeoutMs + 250,
  );
  const versions =
    result === undefined || result.exitCode !== 0 ? [] : parseSearchOutput(result.stdout);
  indexVersions.set(name, versions);
  return versions;
}

function linesOf(document: vscode.TextDocument): string[] {
  const lines: string[] = [];
  for (let line = 0; line < document.lineCount; line += 1) {
    lines.push(document.lineAt(line).text);
  }
  return lines;
}

/**
 * The line index of `[package]` in a neighbouring manifest, for `path = "…"`.
 * The file system belongs to the caller, which is why navigation takes a callback.
 */
function packageHeaderLine(uri: vscode.Uri, relative: string): number | undefined {
  try {
    const target = vscode.Uri.joinPath(uri, "..", relative, "mcpp.toml");
    const bytes = require("node:fs").readFileSync(target.fsPath, "utf8") as string;
    const index = bytes.split(/\r?\n/).findIndex((line) => /^\s*\[\s*package\s*\]\s*$/.test(line));
    return index === -1 ? undefined : index;
  } catch {
    return undefined;
  }
}

function completionItemKind(kind: "section" | "template" | "version"): vscode.CompletionItemKind {
  switch (kind) {
    case "section":
      return vscode.CompletionItemKind.Folder;
    case "version":
      return vscode.CompletionItemKind.Value;
    default:
      return vscode.CompletionItemKind.Snippet;
  }
}

function severityOf(value: Severity | undefined, fallback: Severity): Severity {
  return value === "error" || value === "warning" || value === "info" || value === "off" ? value : fallback;
}

export function registerTomlProviders(
  context: vscode.ExtensionContext,
  /** `mcpp.toml.completion`: structure suggestions on or off. */
  completionEnabled: () => boolean,
  settings: () => DiagnosticSettings,
  /** `mcpp.toml.diagnostics.enabled`. */
  enabled: () => boolean,
  /** `mcpp.toml.hover` and `mcpp.toml.navigation`, which are independent switches. */
  hoverEnabled: () => boolean = () => true,
  navigationEnabled: () => boolean = () => true,
): void {
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { language: MCPP_TOML_LANGUAGE },
      {
        async provideCompletionItems(document, position) {
          if (!completionEnabled()) {
            return undefined;
          }
          const lines: string[] = [];
          for (let line = 0; line <= position.line; line += 1) {
            lines.push(document.lineAt(line).text);
          }
          const suggestions = await computeMcppTomlCompletionsWithIndex(
            lines,
            position.line,
            position.character,
            (name) => resolveIndexVersions(document, name),
          );
          return suggestions.map((suggestion) => {
            const item = new vscode.CompletionItem(suggestion.label, completionItemKind(suggestion.kind));
            item.detail = suggestion.detail;
            if (suggestion.documentation !== undefined) {
              item.documentation = new vscode.MarkdownString(suggestion.documentation);
            }
            if (suggestion.insertSnippet !== undefined) {
              item.insertText = new vscode.SnippetString(suggestion.insertSnippet);
            }
            item.range = new vscode.Range(
              position.line,
              suggestion.range.startCharacter,
              position.line,
              suggestion.range.endCharacter,
            );
            return item;
          });
        },
      },
      // `"` so a dependency version value is discoverable without Ctrl+Space;
      // every other trigger position falls straight through to no suggestions.
      "[",
      '"',
    ),
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ language: MCPP_TOML_LANGUAGE }, {
      provideHover(document, position) {
        if (!hoverEnabled()) {
          return undefined;
        }
        const info = hoverAt(linesOf(document), position.line, position.character);
        if (info === undefined) {
          return undefined;
        }
        const contents = [new vscode.MarkdownString(`**${info.title}**`), new vscode.MarkdownString(info.body)];
        if (info.documentation !== undefined) {
          contents.push(new vscode.MarkdownString(`[${t("Manifest reference")}](${info.documentation})`));
        }
        return new vscode.Hover(contents);
      },
    }),
    vscode.languages.registerDefinitionProvider({ language: MCPP_TOML_LANGUAGE }, {
      provideDefinition(document, position) {
        if (!navigationEnabled()) {
          return undefined;
        }
        const location = definitionAt(linesOf(document), position.line, position.character, (relative) =>
          packageHeaderLine(document.uri, relative),
        );
        if (location === undefined) {
          return undefined;
        }
        return new vscode.Location(document.uri, new vscode.Position(location.line, location.startCharacter));
      },
    }),
  );

  const collection = vscode.languages.createDiagnosticCollection("mcpp-manifest");
  context.subscriptions.push(collection);

  const refresh = (document: vscode.TextDocument): void => {
    if (document.languageId !== MCPP_TOML_LANGUAGE) {
      return;
    }
    if (!enabled()) {
      collection.delete(document.uri);
      return;
    }
    const lines: string[] = [];
    for (let line = 0; line < document.lineCount; line += 1) {
      lines.push(document.lineAt(line).text);
    }
    const diagnostics = analyseManifest(lines, settings()).map((entry) => {
      const range = new vscode.Range(
        Math.max(0, entry.line - 1),
        entry.startCharacter,
        Math.max(0, entry.line - 1),
        entry.endCharacter,
      );
      const diagnostic = new vscode.Diagnostic(range, entry.message, severityFor(entry.severity));
      diagnostic.code = entry.code;
      diagnostic.source = "mcpp";
      return diagnostic;
    });
    collection.set(document.uri, diagnostics);
  };

  for (const document of vscode.workspace.textDocuments) {
    refresh(document);
  }
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((event) => refresh(event.document)),
    vscode.workspace.onDidCloseTextDocument((document) => collection.delete(document.uri)),
    vscode.workspace.onDidChangeConfiguration(() => {
      for (const document of vscode.workspace.textDocuments) {
        refresh(document);
      }
    }),
  );
}

function severityFor(severity: "error" | "warning" | "info"): vscode.DiagnosticSeverity {
  switch (severity) {
    case "error":
      return vscode.DiagnosticSeverity.Error;
    case "warning":
      return vscode.DiagnosticSeverity.Warning;
    default:
      return vscode.DiagnosticSeverity.Information;
  }
}

/** The registry keys that shape manifest diagnostics, read in one place. */
export { severityOf };
