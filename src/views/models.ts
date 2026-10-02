/**
 * The trees, as **data**.
 *
 * Labels are keys, not sentences: the builder stays free of `vscode` and of the
 * current language, the tests assert stable keys, and `src/views/treeProvider.ts`
 * resolves them through `src/i18n/t.ts` at render time. A label's arguments may
 * themselves be labels, so a phrase like `C++23 · 87 source file(s)` is composed
 * from two independently translatable pieces instead of one frozen sentence.
 *
 * The project view is two labelled sections: **Basics** (what this project is)
 * and **Common commands** (what can be done to it). The C++ Modules block is
 * folded into the first one, with the status line carrying the problem count, so
 * a degraded language service is visible **without expanding anything**. The
 * second section is the only place in the view whose rows are all commands.
 *
 * Everything the project view needs from disk lives here as well — the declared
 * dependencies, `mcpp.lock`'s resolved versions and the source-file count — so
 * the whole layout can be unit tested without an editor host. Nothing here
 * imports `vscode`; `test/architecture.test.ts` enforces that.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseMcppToml } from "../toml/parser";
import { formatBytes, formatCount } from "../util/format";

export type LabelArgument = string | number | Label;

export interface Label {
  key: string;
  args?: readonly LabelArgument[];
}

export interface TreeCommand {
  command: string;
  title: Label;
  arguments?: readonly unknown[];
}

export interface TreeNode {
  id: string;
  label: Label;
  description?: Label;
  tooltip?: Label;
  /** A codicon id without the `$()`, e.g. `"database"`. */
  icon?: string;
  /** Consumed by `when` clauses in package.json for inline actions. */
  contextValue?: string;
  /**
   * Render expanded on first display. A node with children is collapsed unless
   * this is set; the two project sections and the dependency group start open,
   * the folded language-service block deliberately does not.
   */
  expanded?: boolean;
  command?: TreeCommand;
  children?: readonly TreeNode[];
}

const plain = (text: string): Label => ({ key: text });

/** `a`, `b` -> `a · b`, nested so each side keeps its own translation. */
function joined(parts: readonly Label[]): Label | undefined {
  if (parts.length === 0) {
    return undefined;
  }
  return parts.reduce((left, right): Label => ({ key: "{0} · {1}", args: [left, right] }));
}

export interface TargetSummary {
  name: string;
  kind: string;
}

/** One dependency declared in `mcpp.toml`, before `mcpp.lock` says what it resolved to. */
export interface DependencyDeclaration {
  /** `namespace.name` as written in the manifest. */
  name: string;
  /** The declared version constraint, when the manifest states one. */
  version?: string;
  /** Declared in `[dev-dependencies]`. */
  dev?: boolean;
  /** A local path dependency. */
  path?: string;
  /** A git dependency. */
  git?: string;
}

export interface ProjectSummary {
  root: string;
  name?: string;
  version?: string;
  standard?: string;
  profile?: string;
  toolchainSpec?: string;
  target?: string;
  targets?: readonly TargetSummary[];
  hasTests?: boolean;
  /** Declared in `[dependencies]` / `[dev-dependencies]`; absent when there are none. */
  dependencies?: readonly DependencyDeclaration[];
  /** Source files counted under the project root; absent when not measured. */
  sourceFiles?: number;
  /** Set when `mcpp.toml` could not be read; the tree then says so instead of lying. */
  error?: string;
}

/* ------------------------------------------------------------------ mcpp.toml */

/** The two manifest groups the project view reports. A dep is either runtime or dev. */
const DEPENDENCY_GROUPS: Readonly<Record<string, boolean>> = {
  dependencies: false,
  "dev-dependencies": true,
};

function dependencyField(entry: DependencyDeclaration, key: string, value: string | undefined): void {
  if (value === undefined || value.length === 0) {
    return;
  }
  if (key === "version") {
    entry.version = value;
  } else if (key === "path") {
    entry.path = value;
  } else if (key === "git") {
    entry.git = value;
  }
}

/**
 * The declared dependencies, read with the fault-tolerant TOML scanner the
 * completion provider already uses.
 *
 * Three shapes are recognised, because all three are legal mcpp.toml:
 * `name = "1.0"`, `name = { path = "…" }` (including multi-line inline tables)
 * and `[dependencies.name]` with the fields on following lines. `workspace` and
 * `features` are deliberately ignored: neither changes what the row must say.
 */
export function readDependencies(lines: readonly string[]): DependencyDeclaration[] {
  const found: DependencyDeclaration[] = [];
  const byName = new Map<string, DependencyDeclaration>();
  const ensure = (name: string, dev: boolean): DependencyDeclaration => {
    const existing = byName.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const entry: DependencyDeclaration = dev ? { name, dev: true } : { name };
    byName.set(name, entry);
    found.push(entry);
    return entry;
  };

  try {
    let group: string | undefined;
    let named: DependencyDeclaration | undefined;
    for (const node of parseMcppToml(lines).nodes) {
      if (node.type === "section") {
        const segments = node.segments.map((segment) => segment.name);
        const head = segments[0];
        if (head === undefined || DEPENDENCY_GROUPS[head] === undefined) {
          group = undefined;
          named = undefined;
          continue;
        }
        group = head;
        // `[dependencies.name]` names the dependency; its fields follow.
        named = segments.length >= 2 ? ensure(segments.slice(1).join("."), DEPENDENCY_GROUPS[head] === true) : undefined;
        continue;
      }
      if (group === undefined) {
        continue;
      }
      const dev = DEPENDENCY_GROUPS[group] === true;
      const key = node.keyPath.map((segment) => segment.name).join(".");
      const value = node.value;
      if (value === undefined) {
        continue;
      }
      if (named !== undefined) {
        dependencyField(named, key, value.text);
        continue;
      }
      if (key.length === 0) {
        continue;
      }
      const entry = ensure(key, dev);
      if (value.kind === "string") {
        dependencyField(entry, "version", value.text);
      } else if (value.kind === "inlineTable") {
        for (const field of value.entries ?? []) {
          dependencyField(entry, field.keyPath.map((segment) => segment.name).join("."), field.value?.text);
        }
      }
    }
  } catch {
    // A manifest being edited is not an error here; whatever was read stands.
  }
  return found;
}

/* ------------------------------------------------------------------ mcpp.lock */

/** One `[package."…"]` entry of `mcpp.lock`: a resolved package, with no parent edge. */
export interface LockPackage {
  /** The table key as written: `openkal` or `compat.freetype`. */
  key: string;
  namespace?: string;
  version?: string;
  source?: string;
  hash?: string;
}

const LOCK_HEADER = /^\[\s*package\s*\.\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*\]\s*$/;
const LOCK_FIELD = /^([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^#\s]+))\s*(?:#.*)?$/;
const LOCK_FIELDS: ReadonlySet<string> = new Set(["namespace", "version", "source", "hash"]);

/**
 * `mcpp.lock`, read tolerantly.
 *
 * The file is a flat TOML set — `version = 2` then one `[package."…"]` table per
 * resolved package — and it deliberately carries **no parent/child edges**,
 * which is why the view can only ever show two levels. Anything unrecognised is
 * skipped and nothing here throws: a file being written is still a valid lock
 * with fewer entries, not a broken view.
 */
export function parseLockfile(text: string): LockPackage[] {
  const packages: LockPackage[] = [];
  try {
    let current: LockPackage | undefined;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.length === 0 || line.startsWith("#")) {
        continue;
      }
      const header = LOCK_HEADER.exec(line);
      if (header !== null) {
        const key = header[1] ?? header[2] ?? header[3] ?? "";
        if (key.length === 0) {
          current = undefined;
          continue;
        }
        current = { key };
        packages.push(current);
        continue;
      }
      if (line.startsWith("[")) {
        current = undefined;
        continue;
      }
      if (current === undefined) {
        continue;
      }
      const field = LOCK_FIELD.exec(line);
      if (field === null || !LOCK_FIELDS.has(field[1])) {
        continue;
      }
      const value = field[2] ?? field[3] ?? field[4];
      if (value === undefined || value.length === 0) {
        continue;
      }
      if (field[1] === "namespace") current.namespace = value;
      else if (field[1] === "version") current.version = value;
      else if (field[1] === "source") current.source = value;
      else current.hash = value;
    }
  } catch {
    // Tolerant by construction: an unreadable lock is an empty lock.
  }
  return packages;
}

/** {@link parseLockfile} for a path that may not exist. A missing lock is empty, not an error. */
export function readLockfile(file: string): LockPackage[] {
  try {
    return parseLockfile(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

/**
 * The lock entry a declaration resolved to, matched by `namespace.name`.
 *
 * Real lock files are inconsistent about the table key: `[package."openkal"]`
 * carries `namespace = "mcpplibs"` while `[package."compat.freetype"]` already
 * folds the namespace into the key. Both resolve here; when the entry has no
 * namespace of its own, the name is the only thing left to match on.
 */
export function resolveLockedPackage(entries: readonly LockPackage[], name: string): LockPackage | undefined {
  const dot = name.lastIndexOf(".");
  const namespace = dot > 0 ? name.slice(0, dot) : undefined;
  const local = dot > 0 ? name.slice(dot + 1) : name;
  for (const entry of entries) {
    if (entry.key === name) {
      return entry;
    }
    const entryLocal = entry.key.includes(".") ? entry.key.slice(entry.key.lastIndexOf(".") + 1) : entry.key;
    if (entryLocal !== local) {
      continue;
    }
    if (namespace === undefined || entry.namespace === undefined || entry.namespace === namespace) {
      return entry;
    }
  }
  return undefined;
}

/* --------------------------------------------------------------- source files */

/** Extensions counted as source: module interfaces, translation units and headers. */
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".c++",
  ".cppm",
  ".ixx",
  ".mpp",
  ".h",
  ".hh",
  ".hpp",
  ".hxx",
  ".ipp",
  ".inl",
]);

/** Directories that hold build output or other people's code, never the project's own sources. */
const SOURCE_SKIP_DIRS: ReadonlySet<string> = new Set([
  "target",
  "build",
  "out",
  "dist",
  "node_modules",
  ".git",
  ".mcpp",
  ".vscode",
  ".cache",
]);

const SOURCE_MAX_ENTRIES = 20_000;
const SOURCE_MAX_DEPTH = 8;

/**
 * How many source files this project has, counted under `root`.
 *
 * Bounded and non-throwing, like every other walk in this codebase: a huge or
 * unreadable tree stops early rather than hanging the extension host, and the
 * build directories are skipped so `target/` cannot flatter the number. The
 * count is what makes the identity row say something about the project's size
 * without running mcpp.
 */
export function countSourceFiles(root: string): number {
  let count = 0;
  let seen = 0;
  const visit = (dir: string, depth: number): void => {
    if (depth > SOURCE_MAX_DEPTH || seen >= SOURCE_MAX_ENTRIES) {
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > SOURCE_MAX_ENTRIES) {
        return;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SOURCE_SKIP_DIRS.has(entry.name)) {
          visit(full, depth + 1);
        }
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        count += 1;
      }
    }
  };
  visit(root, 0);
  return count;
}

/* ---------------------------------------------------------------- keybindings */

export interface KeybindingHint {
  key?: string;
  mac?: string;
}

export type KeyboardPlatform = "mac" | "other";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The keybindings this extension contributes, keyed by command id, read from
 * `package.json` rather than copied into the source.
 *
 * A hint in the tree that disagrees with the manifest is worse than no hint, so
 * the row asks the manifest. `context.extension.packageJSON` is what the caller
 * hands in; this function itself is pure and testable.
 */
export function keybindingsFromPackage(packageJSON: unknown): Readonly<Record<string, KeybindingHint>> {
  const bindings: Record<string, KeybindingHint> = {};
  if (!isRecord(packageJSON) || !isRecord(packageJSON.contributes)) {
    return bindings;
  }
  const list = packageJSON.contributes.keybindings;
  if (!Array.isArray(list)) {
    return bindings;
  }
  for (const entry of list) {
    if (!isRecord(entry) || typeof entry.command !== "string" || bindings[entry.command] !== undefined) {
      continue;
    }
    const key = typeof entry.key === "string" && entry.key.length > 0 ? entry.key : undefined;
    const mac = typeof entry.mac === "string" && entry.mac.length > 0 ? entry.mac : undefined;
    if (key === undefined && mac === undefined) {
      continue;
    }
    const hint: KeybindingHint = {};
    if (key !== undefined) hint.key = key;
    if (mac !== undefined) hint.mac = mac;
    bindings[entry.command] = hint;
  }
  return bindings;
}

function keyToken(token: string, platform: KeyboardPlatform): string {
  if (platform === "mac") {
    switch (token) {
      case "cmd":
      case "meta":
      case "super":
        return "⌘";
      case "ctrl":
      case "control":
        return "⌃";
      case "alt":
      case "option":
        return "⌥";
      case "shift":
        return "⇧";
      default:
        return token.length === 1 ? token.toUpperCase() : token;
    }
  }
  switch (token) {
    case "cmd":
    case "meta":
    case "super":
      return "Meta";
    case "ctrl":
    case "control":
      return "Ctrl";
    case "alt":
    case "option":
      return "Alt";
    case "shift":
      return "Shift";
    default:
      return token.length === 1 ? token.toUpperCase() : token;
  }
}

/** `cmd+alt+b` -> `⌘⌥B` on macOS, `ctrl+alt+b` -> `Ctrl+Alt+B` elsewhere. */
export function formatKeybinding(hint: KeybindingHint | undefined, platform: KeyboardPlatform): string | undefined {
  if (hint === undefined) {
    return undefined;
  }
  const raw = platform === "mac" ? hint.mac ?? hint.key : hint.key ?? hint.mac;
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  const parts = raw
    .split("+")
    .map((part) => keyToken(part.trim().toLowerCase(), platform))
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return undefined;
  }
  return platform === "mac" ? parts.join("") : parts.join("+");
}

/* ------------------------------------------------------------ language service */

/** The part of an mcppls issue the folded block renders. `clangd` is never among them. */
export interface LanguageServiceIssue {
  code: string;
  message: string;
  /** mcppls's own remedy for this issue, when it offers one. */
  command?: { command: string; arguments?: unknown[]; title?: string };
}

/**
 * The folded C++ Modules block.
 *
 * Only the language service's own identity, its state and its problems are
 * rendered: the engines, the semantic profile and the compilation database used
 * to *define* the old view, and the spec is explicit that `clangd` must not
 * appear anywhere in it (§8.2).
 */
export interface LanguageServiceBlock {
  /** `mcpp.views.languageServer.show`; `false` removes the block from the tree. */
  show?: boolean;
  installed: boolean;
  enabled?: boolean;
  version?: string;
  state?: {
    available: boolean;
    reason?: string;
    state?: string;
    issues?: readonly LanguageServiceIssue[];
  };
}

/** The provider line the block always carries, so "who owns this" stays answerable. */
export const LANGUAGE_SERVICE_PROVIDER = "sunrisepeak.mcpp-language-server";

interface ActionRow {
  id: string;
  label: string;
  icon: string;
  command: string;
}

/** The four actions worth a permanent row; everything else folds into 「其它 N 项…」. */
const LANGUAGE_SERVICE_COMMON_ACTIONS: readonly ActionRow[] = [
  { id: "project.languageService.action.restart", label: "Restart language service", icon: "debug-restart", command: "mcpp.languageServer.restart" },
  { id: "project.languageService.action.selectContext", label: "Select analysis context", icon: "symbol-interface", command: "mcpp.languageServer.selectContext" },
  { id: "project.languageService.action.graph", label: "Module graph", icon: "type-hierarchy", command: "mcpp.languageServer.showModuleGraph" },
  { id: "project.languageService.action.logs", label: "Open logs", icon: "output", command: "mcpp.languageServer.showLogs" },
];

const LANGUAGE_SERVICE_MORE_ACTIONS: readonly ActionRow[] = [
  { id: "project.languageService.action.refreshState", label: "Refresh this view", icon: "refresh", command: "mcpp.languageServer.refreshState" },
  { id: "project.languageService.action.restartEngine", label: "Restart the semantic engine", icon: "debug-restart", command: "mcpp.languageServer.restartEngine" },
  { id: "project.languageService.action.resetCache", label: "Reset this workspace's cache", icon: "trash", command: "mcpp.languageServer.resetWorkspaceCache" },
  { id: "project.languageService.action.report", label: "Collect a diagnostic report", icon: "report", command: "mcpp.languageServer.collectReport" },
  { id: "project.languageService.action.bundle", label: "Export a diagnostic bundle", icon: "package", command: "mcpp.languageServer.exportDiagnosticBundle" },
  { id: "project.languageService.action.runBuildTool", label: "Run the build tool in a terminal", icon: "terminal", command: "mcpp.languageServer.runBuildToolInTerminal" },
  { id: "project.languageService.action.settings", label: "Open the C++ Modules settings", icon: "settings-gear", command: "mcpp.openMcpplsSettings" },
];

/* -------------------------------------------------------------- project view */

export interface ProjectTreeOptions {
  /** `mcpp.lock`'s resolved packages, matched to the declarations by name. */
  lock?: readonly LockPackage[];
  /** The folded C++ Modules block; omitted means "no block". */
  languageService?: LanguageServiceBlock;
  /** Keybindings read from the extension manifest. */
  keybindings?: Readonly<Record<string, KeybindingHint>>;
  platform?: KeyboardPlatform;
}

/** The project view: two labelled sections — what this is, then what to do with it. */
export function buildProjectTree(project: ProjectSummary | undefined, options: ProjectTreeOptions = {}): TreeNode[] {
  if (project === undefined) {
    return [
      {
        id: "project.none",
        label: plain("No mcpp project in this workspace"),
        icon: "info",
        tooltip: plain("Open a folder containing mcpp.toml, or create a project with mcpp: New Project."),
      },
    ];
  }
  if (project.error !== undefined) {
    return [
      {
        id: "project.error",
        label: plain("mcpp.toml could not be read"),
        description: { key: "{0}", args: [project.error] },
        icon: "error",
        contextValue: "mcppProjectError",
      },
    ];
  }

  const facts: Label[] = [];
  if (project.standard !== undefined) {
    facts.push({ key: "{0}", args: [project.standard] });
  }
  if (project.sourceFiles !== undefined) {
    facts.push({ key: "{0} source file(s)", args: [project.sourceFiles] });
  }
  const identity: TreeNode = {
    id: "project.package",
    label: plain(project.name ?? "mcpp project"),
    icon: "package",
    tooltip:
      project.version === undefined
        ? { key: "{0}", args: [project.root] }
        : { key: "{0} · version {1}", args: [project.root, project.version] },
    contextValue: "mcppProject",
  };
  const identityFacts = joined(facts);
  if (identityFacts !== undefined) {
    identity.description = identityFacts;
  }

  const basic: TreeNode[] = [
    identity,
    ...(project.target === undefined
      ? []
      : [{ id: "project.target", label: plain("Target"), description: { key: "{0}", args: [project.target] }, icon: "target" }]),
    {
      id: "project.toolchain",
      label: plain("Toolchain"),
      description: { key: "{0}", args: [project.toolchainSpec ?? "host default"] },
      icon: "chip",
    },
    ...dependencyNodes(project, options),
    ...languageServiceNodes(options.languageService),
  ];

  return [
    { id: "project.section.basic", label: plain("Basics"), icon: "info", expanded: true, children: basic },
    { id: "project.section.commands", label: plain("Common commands"), icon: "terminal", expanded: true, children: commandNodes(options) },
  ];
}

interface CommandRow {
  id: string;
  label: string;
  icon: string;
  command: string;
}

/** The eight rows of 「常用命令」, in the order the prototype fixes them. */
const COMMON_COMMANDS: readonly CommandRow[] = [
  { id: "project.action.build", label: "Build", icon: "tools", command: "mcpp.build" },
  { id: "project.action.run", label: "Run", icon: "play", command: "mcpp.run" },
  { id: "project.action.test", label: "Test", icon: "beaker", command: "mcpp.test" },
  { id: "project.action.clean", label: "Clean", icon: "trash", command: "mcpp.cleanProjectArtifacts" },
  { id: "project.action.toolchain", label: "Toolchain", icon: "chip", command: "mcpp.showToolchains" },
  { id: "project.action.librarySearch", label: "Search and add a dependency…", icon: "cloud", command: "mcpp.library.search" },
  { id: "project.action.selfCheck", label: "Environment self-check", icon: "heart", command: "mcpp.selfCheck" },
  { id: "project.action.settings", label: "Settings", icon: "settings-gear", command: "mcpp.openSettings" },
];

function commandNodes(options: ProjectTreeOptions): TreeNode[] {
  return COMMON_COMMANDS.map((row): TreeNode => {
    const hint = formatKeybinding(options.keybindings?.[row.command], options.platform ?? "other");
    const label = plain(row.label);
    const node: TreeNode = {
      id: row.id,
      label,
      icon: row.icon,
      contextValue: "mcppProjectCommand",
      command: { command: row.command, title: label },
    };
    if (hint !== undefined) {
      node.description = plain(hint);
    }
    return node;
  });
}

function dependencyNodes(project: ProjectSummary, options: ProjectTreeOptions): TreeNode[] {
  const declared = project.dependencies ?? [];
  if (declared.length === 0) {
    return [];
  }
  const lock = options.lock ?? [];
  const dev = declared.filter((entry) => entry.dev === true).length;
  return [
    {
      id: "project.dependencies",
      label: { key: "Dependencies ({0})", args: [declared.length] },
      ...(dev === 0 ? {} : { description: { key: "{0} dev", args: [dev] } }),
      icon: "library",
      tooltip: plain("Declared in mcpp.toml; the resolved version comes from mcpp.lock."),
      expanded: true,
      children: declared.map((entry) => dependencyNode(entry, lock)),
    },
  ];
}

/**
 * One declared dependency.
 *
 * Level 1 is the declaration, with its markers; level 2 is the single version
 * `mcpp.lock` resolved, or `Resolved —` when the lock has nothing to say. There
 * is deliberately no third level and no connector glyph: `mcpp.lock` is a flat
 * set with no parent/child edges, so a deeper tree would be invented.
 */
function dependencyNode(declaration: DependencyDeclaration, lock: readonly LockPackage[]): TreeNode {
  const resolved = resolveLockedPackage(lock, declaration.name);
  const resolvedLabel: Label =
    resolved?.version === undefined ? plain("Resolved —") : { key: "Resolved {0}", args: [resolved.version] };
  const marker = dependencyMarker(declaration);
  const node: TreeNode = {
    id: `project.dependency.${declaration.name}`,
    label: plain(declaration.name),
    description: marker === undefined ? resolvedLabel : { key: "{0} · {1}", args: [marker, resolvedLabel] },
    icon: declaration.path === undefined ? "package" : "folder",
  };
  return node;
}

function dependencyMarker(declaration: DependencyDeclaration): Label | undefined {
  if (declaration.path !== undefined) {
    return { key: "path · {0}", args: [declaration.path] };
  }
  if (declaration.git !== undefined) {
    return { key: "git · {0}", args: [declaration.git] };
  }
  return declaration.dev === true ? plain("dev") : undefined;
}

function languageServiceNodes(block: LanguageServiceBlock | undefined): TreeNode[] {
  if (block === undefined || block.show === false) {
    return [];
  }
  const issues = block.state?.issues ?? [];
  const healthy = block.state?.available === true && block.state.state === "ready";
  const identity: Label = { key: "mcppls {0}", args: [block.version ?? "?"] };
  const node: TreeNode = {
    id: "project.languageService",
    label: plain("Language service"),
    description:
      issues.length === 0
        ? identity
        : { key: "{0} · {1}", args: [identity, { key: "{0} problem(s)", args: [issues.length] }] },
    icon: healthy ? "pass" : "warning",
    contextValue: "mcppLanguageService",
    children: languageServiceChildren(block),
  };
  if (block.state?.available === false && block.state.reason !== undefined) {
    node.tooltip = plain(block.state.reason);
  }
  return [node];
}

/**
 * The expanded block: state, provider, every problem, then the four common
 * actions and one folded row for the rest. mcppls's engines and semantic profile
 * are not read here at all — only the language service itself.
 */
function languageServiceChildren(block: LanguageServiceBlock): TreeNode[] {
  if (!block.installed) {
    return [
      {
        id: "project.languageService.status",
        label: plain("C++ Modules is not installed"),
        icon: "warning",
        command: { command: "mcpp.openMcpplsSettings", title: plain("Install C++ Modules") },
      },
    ];
  }

  const state = block.state;
  const nodes: TreeNode[] = [
    languageServiceStatus(state),
    {
      id: "project.languageService.provider",
      label: plain("Provided by"),
      description: plain(LANGUAGE_SERVICE_PROVIDER),
      icon: "beaker",
    },
  ];

  (state?.issues ?? []).forEach((issue, index) => {
    nodes.push({
      id: `project.languageService.issue.${index}.${issue.code}`,
      label: plain(issue.message),
      description: plain(issue.code),
      icon: "warning",
      // S3 hands us the remedy; use it rather than inventing one.
      command:
        issue.command === undefined
          ? undefined
          : {
              command: issue.command.command,
              // mcppls's own title — a sentence we did not write, shown as-is.
              title: plain(issue.command.title ?? "Fix"),
              arguments: issue.command.arguments,
            },
    });
  });

  for (const action of LANGUAGE_SERVICE_COMMON_ACTIONS) {
    nodes.push(actionNode(action));
  }
  nodes.push({
    id: "project.languageService.action.more",
    label: { key: "More ({0})…", args: [LANGUAGE_SERVICE_MORE_ACTIONS.length] },
    icon: "ellipsis",
    children: LANGUAGE_SERVICE_MORE_ACTIONS.map((action) => actionNode(action)),
  });
  return nodes;
}

function actionNode(action: ActionRow): TreeNode {
  const label = plain(action.label);
  return {
    id: action.id,
    label,
    icon: action.icon,
    contextValue: "mcppProjectCommand",
    command: { command: action.command, title: label },
  };
}

function languageServiceStatus(state: LanguageServiceBlock["state"]): TreeNode {
  if (state === undefined || !state.available) {
    return {
      id: "project.languageService.status",
      label: plain("Unavailable"),
      description: plain(state?.reason ?? "not read yet"),
      icon: "warning",
    };
  }
  return {
    id: "project.languageService.status",
    label: plain(state.state === "ready" ? "Ready" : state.state === "degraded" ? "Degraded" : state.state ?? "Unknown"),
    icon: state.state === "ready" ? "pass" : "warning",
  };
}

export interface CacheTreeInput {
  projectRoot?: string;
  artifacts?: ArtifactEstimateSummary;
  inventory?: CacheInventorySummary;
  legacyBytes?: number;
  error?: string;
}

export interface ArtifactEstimateSummary {
  exists: boolean;
  totalBytes: number;
  files: number;
  groups: number;
  truncated?: string;
}

export interface CacheInventorySummary {
  root: string;
  totalBytes: number;
  totalEntries: number;
  byKind: Array<{ kind: string; entries: number; bytes: number }>;
  topLabels: Array<{ label: string; entries: number; bytes: number }>;
  incomplete: number;
  oldestAccessed?: number;
  newestAccessed?: number;
  ageBuckets: Array<{ fromDays: number; toDays?: number; entries: number; bytes: number }>;
}

/** The cache view: what this project leaves behind, then what the machine shares. */
export function buildCacheTree(input: CacheTreeInput): TreeNode[] {
  const nodes: TreeNode[] = [];

  nodes.push({
    id: "cache.project",
    label: plain("Project artifacts"),
    description: { key: "{0}", args: [input.projectRoot ?? "target/"] },
    icon: "file-directory",
    contextValue: "mcppCacheProject",
    children: projectArtifactChildren(input),
  });

  if (input.inventory !== undefined) {
    nodes.push({
      id: "cache.global",
      label: plain("Global build cache"),
      description: { key: "{0} · {1}", args: [formatBytes(input.inventory.totalBytes), formatCount(input.inventory.totalEntries)] },
      icon: "database",
      contextValue: "mcppCacheGlobal",
      tooltip: { key: "{0}", args: [input.inventory.root] },
      children: globalCacheChildren(input.inventory),
    });
  } else {
    nodes.push({
      id: "cache.global.unknown",
      label: plain("Global build cache"),
      description: input.error === undefined ? plain("not read yet") : { key: "{0}", args: [input.error] },
      icon: input.error === undefined ? "database" : "warning",
      contextValue: "mcppCacheGlobalUnknown",
      command: { command: "mcpp.refreshCacheStats", title: plain("Refresh cache statistics") },
    });
  }

  if (input.legacyBytes !== undefined && input.legacyBytes > 0) {
    nodes.push({
      id: "cache.legacy",
      label: plain("Pre-v1 cache"),
      description: { key: "{0}", args: [formatBytes(input.legacyBytes)] },
      icon: "archive",
      contextValue: "mcppCacheLegacy",
      command: { command: "mcpp.cleanLegacyCache", title: plain("Remove the pre-v1 cache") },
    });
  }

  return nodes;
}

function projectArtifactChildren(input: CacheTreeInput): TreeNode[] {
  const estimate = input.artifacts;
  if (estimate === undefined) {
    return [
      {
        id: "cache.project.unread",
        label: plain("Not measured yet"),
        icon: "info",
        command: { command: "mcpp.refreshCacheStats", title: plain("Refresh cache statistics") },
      },
    ];
  }
  if (!estimate.exists) {
    return [{ id: "cache.project.absent", label: plain("No target/ directory"), icon: "info" }];
  }
  const children: TreeNode[] = [
    {
      id: "cache.project.size",
      label: plain("Estimated size"),
      description: {
        key: "{0} · {1} file(s)",
        args: [formatBytes(estimate.totalBytes), formatCount(estimate.files)],
      },
      icon: "graph",
      tooltip: plain("An estimate: mcpp does not publish the layout of target/, so this is measured from the file system."),
    },
    {
      id: "cache.project.groups",
      label: plain("Build directories"),
      description: { key: "{0}", args: [estimate.groups] },
      icon: "file-submodule",
    },
    {
      id: "cache.project.stale",
      label: plain("Stale artifacts"),
      description: plain("Removed by mcpp clean --stale"),
      icon: "history",
      contextValue: "mcppCacheStale",
      command: { command: "mcpp.cleanStaleArtifacts", title: plain("Clean stale artifacts") },
    },
    {
      id: "cache.project.clean",
      label: plain("Clean project artifacts"),
      icon: "trash",
      command: { command: "mcpp.cleanProjectArtifacts", title: plain("Clean project artifacts") },
    },
  ];
  if (estimate.truncated !== undefined) {
    children.push({
      id: "cache.project.truncated",
      label: plain("The measurement stopped early; the figure is a lower bound"),
      icon: "warning",
    });
  }
  return children;
}

function globalCacheChildren(inventory: CacheInventorySummary): TreeNode[] {
  const children: TreeNode[] = [
    ...inventory.byKind.map((entry): TreeNode => ({
      id: `cache.kind.${entry.kind}`,
      label: { key: "{0}", args: [entry.kind] },
      description: { key: "{0} · {1}", args: [formatBytes(entry.bytes), formatCount(entry.entries)] },
      icon: entry.kind === "std" ? "library" : "package",
    })),
    {
      id: "cache.age",
      label: plain("By last use"),
      icon: "clock",
      children: inventory.ageBuckets.map((bucket, index): TreeNode => ({
        id: `cache.age.${index}`,
        label:
          bucket.toDays === undefined
            ? { key: "more than {0} day(s) ago", args: [bucket.fromDays] }
            : { key: "{0}–{1} day(s) ago", args: [bucket.fromDays, bucket.toDays] },
        description: { key: "{0} · {1}", args: [formatBytes(bucket.bytes), formatCount(bucket.entries)] },
        icon: index === inventory.ageBuckets.length - 1 ? "warning" : "history",
      })),
    },
    ...(inventory.topLabels.length === 0
      ? []
      : [
          {
            id: "cache.top",
            label: plain("Largest packages"),
            icon: "list-ordered",
            children: inventory.topLabels.map((entry): TreeNode => ({
              id: `cache.top.${entry.label}`,
              label: { key: "{0}", args: [entry.label] },
              description: { key: "{0} · {1}", args: [formatBytes(entry.bytes), formatCount(entry.entries)] },
              icon: "package",
              contextValue: "mcppCachePackage",
              command: {
                command: "mcpp.showCacheEntry",
                title: plain("Show cache entry details"),
                arguments: [entry.label],
              },
            })),
          },
        ]),
  ];

  if (inventory.incomplete > 0) {
    children.push({
      id: "cache.incomplete",
      label: plain("Incomplete entries"),
      description: { key: "{0}", args: [formatCount(inventory.incomplete)] },
      icon: "warning",
      contextValue: "mcppCacheIncomplete",
      command: { command: "mcpp.verifyGlobalCache", title: plain("Verify the cache") },
    });
  }

  children.push(
    {
      id: "cache.action.refresh",
      label: plain("Refresh statistics"),
      icon: "refresh",
      command: { command: "mcpp.refreshCacheStats", title: plain("Refresh cache statistics") },
    },
    {
      id: "cache.action.panel",
      label: plain("Open the cache panel"),
      icon: "graph",
      command: { command: "mcpp.cache.focus", title: plain("Cache statistics") },
    },
    {
      id: "cache.action.gc",
      label: plain("Collect to a budget"),
      icon: "history",
      command: { command: "mcpp.gcGlobalCache", title: plain("Collect the global cache") },
    },
    {
      id: "cache.action.prune",
      label: plain("Drop entries unused for a while"),
      icon: "clock",
      command: { command: "mcpp.pruneGlobalCache", title: plain("Prune the global cache") },
    },
    {
      id: "cache.action.verify",
      label: plain("Verify the cache"),
      icon: "check",
      command: { command: "mcpp.verifyGlobalCache", title: plain("Verify the cache") },
    },
  );
  return children;
}
