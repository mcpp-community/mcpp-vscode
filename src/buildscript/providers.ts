/**
 * The one-line integration point for `build.mcpp` intelligence.
 *
 * `src/extension.ts` stays the only assembly point: it calls this function with
 * its real context and a severity reader, and gets completion, hover and
 * diagnostics for the `mcpp-build` language id in return. Nothing here reads a
 * setting or knows a configuration key — severity arrives as a function, so the
 * wiring step decides where it comes from.
 *
 * Everything shown comes from `api.ts` (the generated snapshot) or `modules.ts`;
 * nothing invokes a compiler, and no provider ever says "module not found". The
 * signature is deliberately narrow so the pure modules stay testable and this
 * file stays the only one that touches the `vscode` API.
 */
import type * as vscode from "vscode";

import { analyseBuildScript } from "./analysis";
import { API, directive } from "./api";
import { knownModule, knownModules, scanImports } from "./modules";

// The deliverable for this file is typed against `import type * as vscode`; the
// extension host is the only environment it runs in, so the value is required
// here rather than injected.
const vscodeApi = require("vscode") as typeof vscode;

const LANGUAGE = "mcpp-build";

const VS_SEVERITY: Record<"error" | "warning" | "info", vscode.DiagnosticSeverity> = {
  error: vscodeApi.DiagnosticSeverity.Error,
  warning: vscodeApi.DiagnosticSeverity.Warning,
  info: vscodeApi.DiagnosticSeverity.Information,
};

function toVscodeDiagnostics(
  document: vscode.TextDocument,
  severity: "warning" | "info",
): vscode.Diagnostic[] {
  return analyseBuildScript(document.getText().split(/\r?\n/), severity).map((entry) => {
    const diagnostic = new vscodeApi.Diagnostic(
      // The analyser reports 1-based line/column; `vscode.Position` is 0-based.
      new vscodeApi.Range(
        entry.line - 1,
        entry.startCharacter - 1,
        entry.line - 1,
        entry.endCharacter - 1,
      ),
      entry.message,
      VS_SEVERITY[entry.severity],
    );
    diagnostic.code = entry.code;
    diagnostic.source = "mcpp";
    return diagnostic;
  });
}

/** The `mcpp::name` on this line that covers `character`, if any. */
function symbolAt(line: string, character: number): string | undefined {
  const pattern = /mcpp::([A-Za-z_][A-Za-z0-9_]*)/g;
  for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) {
    if (character >= match.index && character <= match.index + match[0].length) {
      return match[1];
    }
  }
  return undefined;
}

function markdown(lines: readonly string[]): vscode.MarkdownString {
  return new vscodeApi.MarkdownString(lines.join("\n\n"));
}

export function registerBuildScriptProviders(
  context: { subscriptions: { push(...items: unknown[]): unknown } },
  severity: () => "warning" | "info" | "off",
): void {
  const selector: vscode.DocumentSelector = { language: LANGUAGE };
  const collection = vscodeApi.languages.createDiagnosticCollection(LANGUAGE);

  const refresh = (document: vscode.TextDocument): void => {
    if (document.languageId !== LANGUAGE) {
      return;
    }
    const level = severity();
    if (level === "off") {
      collection.delete(document.uri);
      return;
    }
    collection.set(document.uri, toVscodeDiagnostics(document, level));
  };

  const completion = vscodeApi.languages.registerCompletionItemProvider(selector, {
    provideCompletionItems(document, position) {
      const before = document.lineAt(position.line).text.slice(0, position.character);

      const afterImport = /\b(?:export\s+)?import\s+([A-Za-z0-9_.]*)$/.exec(before);
      if (afterImport !== null) {
        return knownModules()
          .filter((entry) => !entry.name.endsWith(".*") && entry.name.startsWith(afterImport[1]))
          .map((entry) => {
            const item = new vscodeApi.CompletionItem(
              entry.name,
              vscodeApi.CompletionItemKind.Module,
            );
            item.detail = "mcpp build-script module";
            item.documentation = markdown([entry.description]);
            return item;
          });
      }

      const afterScope = /mcpp::([A-Za-z_][A-Za-z0-9_]*)?$/.exec(before);
      if (afterScope !== null) {
        const typed = afterScope[1] ?? "";
        const names = API.directives.map((entry) => entry.wire.replace(/-/g, "_"));
        return names
          .filter((name, index) => names.indexOf(name) === index && name.startsWith(typed))
          .map((name) => {
            const item = new vscodeApi.CompletionItem(name, vscodeApi.CompletionItemKind.Function);
            item.detail = "mcpp build-script API";
            return item;
          });
      }

      return undefined;
    },
  });

  const hover = vscodeApi.languages.registerHoverProvider(selector, {
    provideHover(document, position) {
      const lines = document.getText().split(/\r?\n/);

      for (const site of scanImports(lines)) {
        if (
          site.line === position.line &&
          position.character >= site.startCharacter &&
          position.character <= site.endCharacter
        ) {
          const info = knownModule(site.module);
          if (info !== undefined) {
            return new vscodeApi.Hover(markdown([`**${info.name}**`, info.description]), undefined);
          }
        }
      }

      const name = symbolAt(document.lineAt(position.line).text, position.character);
      const entry = name === undefined ? undefined : directive(name.replace(/_/g, "-"));
      if (entry === undefined) {
        return undefined;
      }
      const details = [
        `**mcpp::${name}**`,
        `wire \`mcpp:${entry.wire}=\` · slot \`${entry.slot}\` · scope \`${entry.scope}\` · ` +
          `since protocol ${entry.since}`,
      ];
      if (entry.rules.length > 0) {
        details.push(`SPEC-007: ${entry.rules.join(", ")}`);
      }
      if (typeof entry.docsUrl === "string") {
        details.push(`[docs/30 — build.mcpp](${entry.docsUrl})`);
      }
      return new vscodeApi.Hover(markdown(details), undefined);
    },
  });

  const subscriptions = [
    collection,
    completion,
    hover,
    vscodeApi.workspace.onDidOpenTextDocument(refresh),
    vscodeApi.workspace.onDidChangeTextDocument((event) => refresh(event.document)),
    vscodeApi.workspace.onDidCloseTextDocument((document) => collection.delete(document.uri)),
  ];
  for (const document of vscodeApi.workspace.textDocuments) {
    refresh(document);
  }
  context.subscriptions.push(...subscriptions);
}
