/**
 * Snippet contributions for `build.mcpp` (`mcpp.buildScript.snippets`, §3.2.2).
 *
 * A snippet is a **starting point, not a signature**: `data/buildscript-api.json`
 * records a directive's wire name, tag, slot, scope and SPEC-007 rules, never its
 * arity or argument types. So the call-shaped snippets place one editable
 * argument and the two `mcpp::action` snippets follow the typed spelling the
 * analyser and mcpp's `docs/30-build-mcpp.md` use. Anything more specific would
 * be an invented signature, which this extension does not do.
 *
 * Pure data plus pure filters, so the catalogue is unit-tested and
 * `providers.ts` stays the only `vscode`-touching file in the slice.
 */
import { ACTION_ROLES, API } from "./api";

export interface BuildScriptSnippet {
  /** The text the editor filters the typed prefix against, e.g. `link_script`. */
  filterText: string;
  /** Human label; the placeholder is spelled `...` so it never reads as syntax. */
  label: string;
  detail: string;
  documentation?: string;
  /** VS Code snippet syntax (`${1:…}`, `${2|a,b|}`). */
  insertText: string;
}

/** The one placeholder a directive snippet places: no arity is known. */
const VALUE_PLACEHOLDER = "${1:value}";

/** `mcpp::<typed>("…")` for every directive the snapshot has, except `action`. */
export function directiveCallSnippets(): BuildScriptSnippet[] {
  const seen = new Set<string>();
  const snippets: BuildScriptSnippet[] = [];

  for (const entry of API.directives) {
    const name = entry.wire.replace(/-/g, "_");
    // `mcpp::action` is a declaration, not a call; the block snippets below are
    // its shape. A duplicate typed name would be a snapshot bug, but skipping it
    // keeps the list a set either way.
    if (name === "action" || seen.has(name)) {
      continue;
    }
    seen.add(name);

    const documentation: string[] = [];
    if (entry.rules.length > 0) {
      documentation.push(`SPEC-007 ${entry.rules.join(", ")}`);
    }
    if (typeof entry.docsUrl === "string") {
      documentation.push(`[docs/30 — build.mcpp](${entry.docsUrl})`);
    }

    const snippet: BuildScriptSnippet = {
      filterText: name,
      label: `${name}(...)`,
      detail: `mcpp:${entry.wire}= · slot ${entry.slot}`,
      insertText: `${name}("${VALUE_PLACEHOLDER}")`,
    };
    if (documentation.length > 0) {
      snippet.documentation = documentation.join(" · ");
    }
    snippets.push(snippet);
  }

  return snippets;
}

/**
 * The two action blocks worth spelling out: a general one with the five roles as
 * a choice, and a `prepare` one, which is the only role whose `output_dir` the
 * engine *requires* (SPEC-007 R3.3, the analyser's `prepareNeedsOutputDir`).
 */
export function actionSnippets(): BuildScriptSnippet[] {
  const roles = ACTION_ROLES.join(",");
  return [
    {
      filterText: "action",
      label: "action ... (typed action block)",
      detail: "mcpp::action with id, role, description, arg/input/output and submit",
      documentation: `The five roles (SPEC-007 R3.6): ${ACTION_ROLES.join(", ")}.`,
      insertText: [
        `mcpp::action \${1:handle};`,
        `\${1:handle}.id = "\${2:id}";`,
        `\${1:handle}.role = mcpp::roles::\${3|${roles}|};`,
        `\${1:handle}.description = "\${4:description}";`,
        `\${1:handle}.arg("\${5:argument}")`,
        `    .input("\${6:input}")`,
        `    .output("\${7:output}")`,
        `    .submit();`,
      ].join("\n"),
    },
    {
      filterText: "action",
      label: "action ... (prepare block)",
      detail: "mcpp::action for a prepare role; output_dir is required (SPEC-007 R3.3)",
      documentation: "A prepare action must declare output_dir; the engine refuses one without it.",
      insertText: [
        `mcpp::action \${1:handle};`,
        `\${1:handle}.id = "\${2:id}";`,
        `\${1:handle}.role = mcpp::roles::prepare;`,
        `\${1:handle}.output_dir("\${3:dir}");`,
        `\${1:handle}.command("\${4:command}").submit();`,
      ].join("\n"),
    },
  ];
}

/** The whole catalogue, action blocks first. */
export function buildScriptSnippets(): BuildScriptSnippet[] {
  return [...actionSnippets(), ...directiveCallSnippets()];
}

/** The snippets whose typed name starts with `typed` (the text after `mcpp::`). */
export function snippetsForScope(typed: string): BuildScriptSnippet[] {
  return buildScriptSnippets().filter((snippet) => snippet.filterText.startsWith(typed));
}
