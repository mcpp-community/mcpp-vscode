/**
 * `mcpp.toml` editing: structural completion plus manifest diagnostics.
 *
 * Both are pure text analysis — no mcpp process, no language server — so they
 * keep working in a restricted workspace, which is what
 * `capabilities.untrustedWorkspaces: limited` promises.
 */

import * as vscode from "vscode";

import { computeMcppTomlCompletions } from "./completion";
import { analyseManifest, type DiagnosticSettings, type Severity } from "./diagnostics";

export const MCPP_TOML_LANGUAGE = "mcpp-toml";

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
