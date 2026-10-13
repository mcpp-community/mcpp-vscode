/**
 * The one-line integration point for `build.mcpp` intelligence.
 *
 * `src/extension.ts` stays the only assembly point: it calls this function with
 * its real context, a severity reader and a "does C++ Modules serve this
 * file" reader, and gets completion, hover and diagnostics for `build.mcpp`
 * in return. `build.mcpp` is an ordinary `cpp` document (C++ Modules compiles
 * it like any other unit), so the providers register on the `cpp` language with
 * a `build.mcpp` filename pattern. The severity reader is the one switch `src/extension.ts` already owns; the four boolean switches
 * (`mcpp.buildScript.{intelligence,diagnostics,snippets,imports.knownModules}`)
 * are resolved here through `settings.ts`, because that file is the only place
 * this extension can be told about them.
 *
 * So `mcpp.buildScript.intelligence = false` means **no** build.mcpp
 * intelligence — completion and hover return nothing, and diagnostics stop —
 * rather than merely skipping provider registration. `snippets` and
 * `imports.knownModules` each narrow one contribution of that layer and never
 * touch another: with `snippets` off, diagnostics and hover stay; with
 * `imports.knownModules` off, only the *completion list* of shipped modules
 * disappears, while hover keeps recognising `std`/`std.compat`/`mcpp.*` and
 * diagnostics never report any import as missing.
 *
 * While C++ Modules serves the file, what it answers better is left to it: the
 * `unknownSymbol` rule (it compiles the file against the modules it really
 * imports) and the known-module completion and hover after `import`. The
 * SPEC-007 rule checks and the snippets stay: no compiler says those.
 *
 * This build registers no document-symbol provider for `build.mcpp`, so there is
 * nothing there to suppress; if one is added it must consult `intelligence` too.
 *
 * Everything shown comes from `api.ts` (the generated snapshot), `modules.ts` or
 * `snippets.ts`; nothing invokes a compiler, and no provider ever says "module
 * not found". The pure modules stay testable and this file stays the only one in
 * the slice that touches the `vscode` API.
 */
import type * as vscode from "vscode";

import { read } from "../config/access";
import { analyseBuildScript } from "./analysis";
import { API, directive } from "./api";
import { knownModule, knownModules, scanImports } from "./modules";
import { buildScriptContributions } from "./settings";
import { snippetsForScope } from "./snippets";

// The deliverable for this file is typed against `import type * as vscode`; the
// extension host is the only environment it runs in, so the value is required
// here rather than injected.
const vscodeApi = require("vscode") as typeof vscode;

const LANGUAGE = "cpp";
const FILE_NAME = "build.mcpp";
const SELECTOR: vscode.DocumentFilter = { language: LANGUAGE, pattern: `**/${FILE_NAME}` };

/** `build.mcpp` by name, as a `cpp` document. */
function isBuildScript(document: vscode.TextDocument): boolean {
  return document.languageId === LANGUAGE && document.uri.path.split("/").pop() === FILE_NAME;
}

const VS_SEVERITY: Record<"error" | "warning" | "info", vscode.DiagnosticSeverity> = {
  error: vscodeApi.DiagnosticSeverity.Error,
  warning: vscodeApi.DiagnosticSeverity.Warning,
  info: vscodeApi.DiagnosticSeverity.Information,
};

function toVscodeDiagnostics(
  document: vscode.TextDocument,
  severity: "warning" | "info",
  servedByMcppls: boolean,
): vscode.Diagnostic[] {
  const options = { unknownSymbols: !servedByMcppls };
  return analyseBuildScript(document.getText().split(/\r?\n/), severity, options).map((entry) => {
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
  servedByMcppls: () => boolean,
): void {
  const selector: vscode.DocumentSelector = SELECTOR;
  const collection = vscodeApi.languages.createDiagnosticCollection("mcpp-build-script");
  const contributions = () => buildScriptContributions(read, severity);

  const refresh = (document: vscode.TextDocument): void => {
    if (!isBuildScript(document)) {
      return;
    }
    const { diagnosticSeverity } = contributions();
    if (diagnosticSeverity === undefined) {
      collection.delete(document.uri);
      return;
    }
    collection.set(document.uri, toVscodeDiagnostics(document, diagnosticSeverity, servedByMcppls()));
  };
  const refreshAll = (): void => {
    for (const document of vscodeApi.workspace.textDocuments) {
      refresh(document);
    }
  };

  const completion = vscodeApi.languages.registerCompletionItemProvider(selector, {
    provideCompletionItems(document, position) {
      const { intelligence, snippets, knownModules: completesKnownModules } = contributions();
      if (!intelligence) {
        return undefined;
      }
      const before = document.lineAt(position.line).text.slice(0, position.character);

      const afterImport = /\b(?:export\s+)?import\s+([A-Za-z0-9_.]*)$/.exec(before);
      if (afterImport !== null) {
        // Only the *list* is optional. Recognition itself (`knownModule`, hover,
        // the no-diagnostic rule) is unconditional. C++ Modules completes module
        // names from what the build can really see, so it answers instead.
        if (!completesKnownModules || servedByMcppls()) {
          return undefined;
        }
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
        const items: vscode.CompletionItem[] = names
          .filter((name, index) => names.indexOf(name) === index && name.startsWith(typed))
          .map((name) => {
            const item = new vscodeApi.CompletionItem(name, vscodeApi.CompletionItemKind.Function);
            item.detail = "mcpp build-script API";
            return item;
          });
        if (snippets) {
          for (const snippet of snippetsForScope(typed)) {
            const item = new vscodeApi.CompletionItem(
              snippet.label,
              vscodeApi.CompletionItemKind.Snippet,
            );
            item.filterText = snippet.filterText;
            item.detail = snippet.detail;
            if (snippet.documentation !== undefined) {
              item.documentation = markdown([snippet.documentation]);
            }
            item.insertText = new vscodeApi.SnippetString(snippet.insertText);
            items.push(item);
          }
        }
        return items;
      }

      return undefined;
    },
  });

  const hover = vscodeApi.languages.registerHoverProvider(selector, {
    provideHover(document, position) {
      if (!contributions().intelligence) {
        return undefined;
      }
      const lines = document.getText().split(/\r?\n/);

      // An import's hover is C++ Modules' while it serves the file.
      for (const site of servedByMcppls() ? [] : scanImports(lines)) {
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
    // Whether C++ Modules serves the file can change at any time: installed,
    // enabled, or switched off for this workspace.
    vscodeApi.extensions.onDidChange(refreshAll),
    vscodeApi.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("mcppls.enable") || event.affectsConfiguration("mcpp.buildScript")) {
        refreshAll();
      }
    }),
  ];
  refreshAll();
  context.subscriptions.push(...subscriptions);
}
