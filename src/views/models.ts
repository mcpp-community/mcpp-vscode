/**
 * The three trees, as **data**.
 *
 * Labels are keys, not sentences: the builder stays free of `vscode` and of the
 * current language, the tests assert stable keys, and `src/views/treeProvider.ts`
 * resolves them through `src/i18n/t.ts` at render time.
 *
 * The same shape serves the project, the cache and the C++ Modules view, so the
 * three providers differ only in the data they hand in.
 */

import { formatBytes, formatCount } from "../util/format";

export interface Label {
  key: string;
  args?: readonly (string | number)[];
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
  command?: TreeCommand;
  children?: readonly TreeNode[];
}

const plain = (text: string): Label => ({ key: text });

export interface TargetSummary {
  name: string;
  kind: string;
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
  /** Set when `mcpp.toml` could not be read; the tree then says so instead of lying. */
  error?: string;
}

/** The project view: identity first, then what the buttons act on. */
export function buildProjectTree(project: ProjectSummary | undefined): TreeNode[] {
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

  const identity: TreeNode[] = [
    {
      id: "project.identity",
      label: project.version === undefined ? plain(project.name ?? "mcpp project") : { key: "{0} {1}", args: [project.name ?? "mcpp project", project.version] },
      icon: "package",
      tooltip: { key: "{0}", args: [project.root] },
      contextValue: "mcppProject",
      children: [
        {
          id: "project.root",
          label: plain("Location"),
          description: { key: "{0}", args: [project.root] },
          icon: "folder",
        },
        ...(project.standard === undefined
          ? []
          : [{ id: "project.standard", label: plain("C++ standard"), description: { key: "{0}", args: [project.standard] }, icon: "symbol-namespace" }]),
        ...(project.profile === undefined
          ? []
          : [{ id: "project.profile", label: plain("Profile"), description: { key: "{0}", args: [project.profile] }, icon: "settings-gear" }]),
      ],
    },
  ];

  const toolchain: TreeNode[] = [
    {
      id: "project.toolchain",
      label: plain("Toolchain"),
      description: { key: "{0}", args: [project.toolchainSpec ?? "host default"] },
      icon: "chip",
      children: [
        ...(project.target === undefined
          ? []
          : [{ id: "project.target", label: plain("Target"), description: { key: "{0}", args: [project.target] }, icon: "target" }]),
        ...(project.targets ?? []).map((entry): TreeNode => ({
          id: `project.target.${entry.name}`,
          label: { key: "{0}", args: [entry.name] },
          description: { key: "{0}", args: [entry.kind] },
          icon: "symbol-method",
        })),
      ],
    },
  ];

  const actions: TreeNode[] = [
    {
      id: "project.action.build",
      label: plain("Build"),
      icon: "tools",
      command: { command: "mcpp.build", title: plain("Build") },
    },
    {
      id: "project.action.run",
      label: plain("Run"),
      icon: "play",
      command: { command: "mcpp.run", title: plain("Run") },
    },
    {
      id: "project.action.test",
      label: plain("Test"),
      icon: "beaker",
      command: { command: "mcpp.test", title: plain("Test") },
    },
    {
      id: "project.action.clean",
      label: plain("Clean project artifacts"),
      icon: "trash",
      command: { command: "mcpp.cleanProjectArtifacts", title: plain("Clean project artifacts") },
    },
  ];

  return [...identity, ...toolchain, ...actions];
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
      command: { command: "mcpp.showCachePanel", title: plain("Cache statistics") },
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

export interface LanguageServerTreeInput {
  installed: boolean;
  enabled?: boolean;
  version?: string;
  state?: {
    available: boolean;
    reason?: string;
    state?: string;
    project?: { source: string; level?: number };
    profile?: { compiler?: string; stdlib: string; target: string; standard?: string };
    engine?: { name: string; version: string };
    engines?: Array<{ name: string; version: string; role: string; state: string }>;
    issues?: Array<{ code: string; message: string; command?: { command: string; arguments?: unknown[]; title?: string } }>;
    notices?: Array<{ code: string; message: string }>;
    onlineRun?: { outcome: string; message: string; at: string };
  };
}

/**
 * The C++ Modules view. Everything here is provided by mcppls: the tree says so
 * in its description, and every action forwards to an mcppls command.
 */
export function buildLanguageServerTree(input: LanguageServerTreeInput): TreeNode[] {
  if (!input.installed) {
    return [
      {
        id: "ls.absent",
        label: plain("C++ Modules is not installed"),
        icon: "warning",
        command: { command: "mcpp.openMcpplsSettings", title: plain("Install C++ Modules") },
      },
    ];
  }

  const status = input.state;
  const nodes: TreeNode[] = [];

  nodes.push({
    id: "ls.status",
    label: plain("Status"),
    description:
      status?.available === true
        ? { key: "{0}", args: [status.state ?? "unknown"] }
        : { key: "{0}", args: [status?.reason ?? "not read yet"] },
    icon: status?.available === true ? stateIcon(status.state) : "question",
    contextValue: "mcppLanguageServerStatus",
  });

  if (input.version !== undefined || input.enabled !== undefined) {
    nodes.push({
      id: "ls.identity",
      label: plain("C++ Modules"),
      description: {
        key: "{0}{1}",
        args: [input.version ?? "?", input.enabled === false ? " · disabled here" : ""],
      },
      icon: "beaker",
    });
  }

  if (status?.available === true) {
    if (status.profile !== undefined) {
      nodes.push({
        id: "ls.profile",
        label: plain("Semantic profile"),
        description: { key: "{0} · {1}", args: [status.profile.compiler ?? status.profile.stdlib, status.profile.target] },
        icon: "symbol-class",
      });
    }
    if (status.project !== undefined) {
      nodes.push({
        id: "ls.database",
        label: plain("Build description"),
        description: { key: "{0}", args: [status.project.source] },
        icon: "database",
      });
    }
    if (status.engines !== undefined || status.engine !== undefined) {
      const engines = status.engines ?? [];
      nodes.push({
        id: "ls.engines",
        label: plain("Engines"),
        icon: "server-process",
        children:
          engines.length > 0
            ? engines.map((engine): TreeNode => ({
                id: `ls.engine.${engine.name}`,
                label: { key: "{0}", args: [engine.name] },
                description: { key: "{0} · {1} · {2}", args: [engine.version, engine.role, engine.state] },
                icon: engine.state === "ready" ? "check" : "sync~spin",
              }))
            : [{ id: "ls.engine.core", label: { key: "{0}", args: [status.engine?.name ?? "?"] }, description: { key: "{0}", args: [status.engine?.version ?? "?"] }, icon: "check" }],
      });
    }
    if (status.onlineRun !== undefined) {
      nodes.push({
        id: "ls.onlineRun",
        label: plain("Last online run"),
        description: { key: "{0} · {1}", args: [status.onlineRun.outcome, status.onlineRun.at] },
        icon: "cloud",
        tooltip: { key: "{0}", args: [status.onlineRun.message] },
      });
    }
  }

  const issues = status?.issues ?? [];
  if (issues.length > 0) {
    nodes.push({
      id: "ls.issues",
      label: plain("Issues"),
      description: { key: "{0}", args: [issues.length] },
      icon: "warning",
      children: issues.map((issue, index): TreeNode => ({
        id: `ls.issue.${index}.${issue.code}`,
        label: { key: "{0}", args: [issue.code] },
        description: { key: "{0}", args: [issue.message] },
        icon: "warning",
        // S3 hands us the remedy; use it rather than inventing one.
        command:
          issue.command === undefined
            ? undefined
            : {
                command: issue.command.command,
                title: issue.command.title === undefined ? plain("Fix") : { key: "{0}", args: [issue.command.title] },
                arguments: issue.command.arguments,
              },
      })),
    });
  }

  const notices = status?.notices ?? [];
  if (notices.length > 0) {
    nodes.push({
      id: "ls.notices",
      label: plain("Notices"),
      description: { key: "{0}", args: [notices.length] },
      icon: "info",
      children: notices.map((notice, index): TreeNode => ({
        id: `ls.notice.${index}.${notice.code}`,
        label: { key: "{0}", args: [notice.code] },
        description: { key: "{0}", args: [notice.message] },
        icon: "info",
      })),
    });
  }

  nodes.push({
    id: "ls.actions",
    label: plain("Actions"),
    icon: "tools",
    children: [
      { id: "ls.action.refreshState", label: plain("Refresh this view"), icon: "refresh", command: { command: "mcpp.languageServer.refreshState", title: plain("Refresh") } },
      { id: "ls.action.restart", label: plain("Restart the language server"), icon: "debug-restart", command: { command: "mcpp.languageServer.restart", title: plain("Restart") } },
      { id: "ls.action.restartEngine", label: plain("Restart the semantic engine"), icon: "debug-restart", command: { command: "mcpp.languageServer.restartEngine", title: plain("Restart engine") } },
      { id: "ls.action.resetCache", label: plain("Reset this workspace's cache"), icon: "trash", command: { command: "mcpp.languageServer.resetWorkspaceCache", title: plain("Reset cache") } },
      { id: "ls.action.selectContext", label: plain("Select the analysis context"), icon: "symbol-interface", command: { command: "mcpp.languageServer.selectContext", title: plain("Select context") } },
      { id: "ls.action.graph", label: plain("Show the module graph"), icon: "type-hierarchy", command: { command: "mcpp.languageServer.showModuleGraph", title: plain("Module graph") } },
      { id: "ls.action.logs", label: plain("Open the C++ Modules log"), icon: "output", command: { command: "mcpp.languageServer.showLogs", title: plain("Logs") } },
      { id: "ls.action.report", label: plain("Collect a diagnostic report"), icon: "report", command: { command: "mcpp.languageServer.collectReport", title: plain("Report") } },
      { id: "ls.action.bundle", label: plain("Export a diagnostic bundle"), icon: "package", command: { command: "mcpp.languageServer.exportDiagnosticBundle", title: plain("Bundle") } },
      { id: "ls.action.runBuildTool", label: plain("Run the build tool in a terminal"), icon: "terminal", command: { command: "mcpp.languageServer.runBuildToolInTerminal", title: plain("Run build tool") } },
      { id: "ls.action.settings", label: plain("Open the C++ Modules settings"), icon: "settings-gear", command: { command: "mcpp.openMcpplsSettings", title: plain("Settings") } },
    ],
  });

  return nodes;
}

function stateIcon(state: string | undefined): string {
  switch (state) {
    case "ready":
      return "pass-filled";
    case "degraded":
      return "warning";
    case "error":
      return "error";
    default:
      return "sync~spin";
  }
}
