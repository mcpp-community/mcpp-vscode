/**
 * `mcpp.toml` editing: structural completion plus manifest diagnostics.
 *
 * Both are pure text analysis — no mcpp process, no language server — so they
 * keep working in a restricted workspace, which is what
 * `capabilities.untrustedWorkspaces: limited` promises.
 */

import * as vscode from "vscode";

import { t } from "../i18n/t";

import { computeMcppTomlCompletions } from "./completion";
import { analyseManifest, type DiagnosticSettings, type Severity } from "./diagnostics";
import { hoverAt } from "./hover";
import { definitionAt } from "./navigation";

export const MCPP_TOML_LANGUAGE = "mcpp-toml";

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

function completionItemKind(kind: "section" | "template"): vscode.CompletionItemKind {
  return kind === "section" ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.Snippet;
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
        provideCompletionItems(document, position) {
          if (!completionEnabled()) {
            return undefined;
          }
          const lines: string[] = [];
          for (let line = 0; line <= position.line; line += 1) {
            lines.push(document.lineAt(line).text);
          }
          return computeMcppTomlCompletions(lines, position.line, position.character).map((suggestion) => {
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
      "[",
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
