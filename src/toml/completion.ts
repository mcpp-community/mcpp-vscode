// mcpp.toml 的代码补全查询层（schema 驱动版）。
//
// 范围：段头结构建议 + 已知段的键/枚举值补全 + 开放词汇段的写法模板。每条建议
// 携带显式替换范围。段/键/枚举来自 `data/toml-schema.json`（src/toml/schema.ts），
// 与诊断共用同一份快照：快照没有的段不会出现在段头表里，快照标记 `openKeys`
// 的段（键由用户自选）不出键建议。
//
// 依赖版本补全（`mcpp.toml.indexCompletion`，默认关）：本模块只负责
// 「光标是不是在依赖版本值位置」与「把候选变成建议」两件纯事；执行
// `mcpp search`、超时、会话缓存、信任/离线判定都在 src/toml/providers.ts，
// 解析人类输出在 src/cli/search.ts。本模块不依赖 vscode API：`t()` 只在
// `auto` 路径上按需加载编辑器 API，纯单测环境下退化为英文 key。

import type { PackageVersion } from "../cli/search";
import { t } from "../i18n/t";
import {
  contextAt,
  parseMcppToml,
  resolveSection,
  type ReplaceRange,
} from "./parser";
import { SCHEMA, sectionByName, type TomlKey, type TomlSection } from "./schema";

export type McppTomlSuggestionKind = "section" | "template" | "version";

export interface McppTomlSuggestion {
  label: string;
  kind: McppTomlSuggestionKind;
  detail: string;
  documentation?: string;
  /** 插入文本；含 $1 等 snippet 占位符。缺省时插入 label。 */
  insertSnippet?: string;
  /** 替换范围（光标所在行的起止列）。 */
  range: ReplaceRange;
}

export interface SectionHeaderSpec {
  group: string;
  label: string;
  /** snippet 形式的段头（含 ${1:...} 占位）。 */
  header: string;
  /**
   * 明细文案。存的是英文 key 的**取用函数**，每个补全请求才 `t()` 一次，所以
   * 改 `mcpp.ui.language` 无需重载窗口，且本模块在无编辑器的单测里也能加载。
   */
  detail: () => string;
}

// 段头明细表：只补充「写法」（label/snippet/detail），不再是段清单本身。
// 段清单来自 schema；这里按 group 名匹配，schema 新出现的段用 plane 兜底。
// 出处：mcpp 文档 02/03/05/06 与 src/manifest/toml.cppm 的段清单（契约测试用
// 真实 mcpp 逐段验证）。
export const SECTION_HEADERS: readonly SectionHeaderSpec[] = [
  { group: "package", label: "[package]", header: "[package]", detail: () => t("Package metadata") },
  { group: "lib", label: "[lib]", header: "[lib]", detail: () => t("Library root-module convention") },
  { group: "build", label: "[build]", header: "[build]", detail: () => t("Build configuration") },
  { group: "generated_files", label: "[generated_files]", header: "[generated_files]", detail: () => t("Generated files (path → content)") },
  { group: "dependencies", label: "[dependencies]", header: "[dependencies]", detail: () => t("Runtime dependencies") },
  { group: "dev-dependencies", label: "[dev-dependencies]", header: "[dev-dependencies]", detail: () => t("Development/test dependencies") },
  { group: "build-dependencies", label: "[build-dependencies]", header: "[build-dependencies]", detail: () => t("Build-time dependencies (pulled at build time only, invisible at run time)") },
  { group: "workspace", label: "[workspace]", header: "[workspace]", detail: () => t("Workspace member declarations") },
  { group: "workspace.dependencies", label: "[workspace.dependencies]", header: "[workspace.dependencies]", detail: () => t("Declare dependency versions centrally; members inherit them with workspace = true") },
  { group: "features", label: "[features]", header: "[features]", detail: () => t("Feature definitions") },
  { group: "feature-deps", label: "[feature-deps.<name>]", header: "[feature-deps.${1:name}]", detail: () => t("Optional dependencies pulled in by a feature") },
  { group: "capabilities", label: "[capabilities]", header: "[capabilities]", detail: () => t("Capability bindings (provider selection)") },
  { group: "targets", label: "[targets.<name>]", header: "[targets.${1:name}]", detail: () => t("Build targets") },
  { group: "profile", label: "[profile.<name>]", header: "[profile.${1:name}]", detail: () => t("Build profiles") },
  { group: "runtime", label: "[runtime]", header: "[runtime]", detail: () => t("Host runtime capabilities") },
  { group: "resources", label: "[resources]", header: "[resources]", detail: () => t("Metadata and assets compiled into the product (PE targets only)") },
  { group: "toolchain", label: "[toolchain]", header: "[toolchain]", detail: () => t("Compiler toolchain shorthand") },
  { group: "xlings", label: "[xlings]", header: "[xlings]", detail: () => t("Build environment (supplied by xlings)") },
  { group: "xlings.workspace", label: "[xlings.workspace]", header: "[xlings.workspace]", detail: () => t("Pin tool versions") },
  { group: "target", label: "[target.<triple>]", header: "[target.${1:x86_64-linux-gnu}]", detail: () => t("Configuration per target triple") },
  { group: "pack", label: "[pack]", header: "[pack]", detail: () => t("mcpp pack packaging configuration") },
  { group: "pack.bundle-project", label: "[pack.bundle-project]", header: "[pack.bundle-project]", detail: () => t("Fine-tuning of the vendored filtering policy") },
  { group: "indices", label: "[indices]", header: "[indices]", detail: () => t("Project-level index redirection") },
  { group: "tools.overrides", label: "[tools.overrides]", header: "[tools.overrides]", detail: () => t("Host tool binary overrides") },
  { group: "language", label: "[language]", header: "[language]", detail: () => t("Legacy compatibility field; new projects should use [package].standard") },
];

/** 依赖类段（键位置给依赖写法模板）。 */
const DEPENDENCY_GROUPS: ReadonlySet<string> = new Set([
  "dependencies",
  "dev-dependencies",
  "build-dependencies",
  "workspace.dependencies",
  "feature-deps",
]);

interface TemplateSpec {
  label: string;
  /** 同 `SectionHeaderSpec.detail`：取用时才 `t()`，语言切换无需重载。 */
  detail: () => string;
  documentation?: () => string;
  insertSnippet: string;
}

const DEPENDENCY_TEMPLATES: readonly TemplateSpec[] = [
  {
    label: 'name = "version"',
    detail: () => t("SemVer version dependency"),
    documentation: () => t("Caret constraint (^) by default; ~, = and range combinations such as \">=1.0, <2.0\" are also supported."),
    insertSnippet: '${1:name} = "${2:1.0.0}"',
  },
  {
    label: "name = { path = ... }",
    detail: () => t("Path dependency (local development)"),
    insertSnippet: '${1:name} = { path = "${2:../mylib}" }',
  },
  {
    label: "name = { git = ..., tag = ... }",
    detail: () => t("Git dependency (one of tag / branch / rev)"),
    insertSnippet: '${1:name} = { git = "${2:https://github.com/user/repo.git}", tag = "${3:v1.0.0}" }',
  },
  {
    label: "name = { version = ..., features = [...] }",
    detail: () => t("Long dep spec: request a feature of that dependency"),
    insertSnippet: '${1:name} = { version = "${2:1.0}", features = ["${3:feature}"] }',
  },
  {
    label: "name = { version = ..., tools = [...] }",
    detail: () => t("Host tools produced by the dependency (must be a bin target of that package)"),
    insertSnippet: '${1:name} = { version = "${2:1.0}", tools = ["${3:protoc}"] }',
  },
];

const FEATURE_TEMPLATES: readonly TemplateSpec[] = [
  { label: "name = [...]", detail: () => t("Array shorthand: implies the feature only"), insertSnippet: "${1:name} = [${2}]" },
  { label: "name = { defines = [...] }", detail: () => t("Table form: contributes the package's own macros when activated"), insertSnippet: '${1:name} = { defines = ["${2:MACRO}"] }' },
  { label: "name = { requires = [...] }", detail: () => t("Table form: requires a capability"), insertSnippet: '${1:name} = { requires = ["${2:blas}"] }' },
  { label: "name = { sources = [...] }", detail: () => t("Table form: feature-gated source globs"), insertSnippet: '${1:name} = { sources = ["${2:src/simd/**}"] }' },
];

const GENERATED_FILE_TEMPLATES: readonly TemplateSpec[] = [
  {
    label: '"path" = "content"',
    detail: () => t("Generated file (relative path → content, part of the fingerprint)"),
    insertSnippet: '"${1:src/gen/wrap.cppm}" = """\n${2:}\n"""',
  },
];

const CAPABILITY_TEMPLATES: readonly TemplateSpec[] = [
  {
    label: 'capability = "provider"',
    detail: () => t("Capability binding (equivalent to --cap)"),
    insertSnippet: '${1:blas} = "${2:compat.openblas}"',
  },
];

const XLINGS_WORKSPACE_TEMPLATES: readonly TemplateSpec[] = [
  { label: 'tool = "version"', detail: () => t("Pin the xlings tool version"), insertSnippet: '${1:node} = "${2:24.19.0}"' },
];

const TOOLS_OVERRIDES_TEMPLATES: readonly TemplateSpec[] = [
  {
    label: '"pkg:tool" = "path"',
    detail: () => t("Override a host tool with an existing binary (skips the build)"),
    insertSnippet: '"${1:compat.protobuf:protoc}" = "${2:/usr/bin/protoc}"',
  },
];

const TEMPLATES_BY_GROUP: Record<string, readonly TemplateSpec[]> = {
  "features": FEATURE_TEMPLATES,
  "generated_files": GENERATED_FILE_TEMPLATES,
  "capabilities": CAPABILITY_TEMPLATES,
  "xlings.workspace": XLINGS_WORKSPACE_TEMPLATES,
  "tools.overrides": TOOLS_OVERRIDES_TEMPLATES,
};

/** 手写明细按 group 索引；schema 段只借它取 label/snippet/detail。 */
const HEADER_SPEC_BY_GROUP: ReadonlyMap<string, SectionHeaderSpec> = new Map(
  SECTION_HEADERS.map((spec) => [spec.group, spec]),
);

interface HeaderEntry {
  label: string;
  header: string;
  detail: string;
  documentation?: string;
}

/**
 * 段头清单：以 schema 为准（§3.3.2）。schema 为空（快照未生成）时才退回手写
 * 清单，保证补全在缺数据时仍可用。手写明细按段名匹配以保留既有 label/snippet/
 * 文案；schema 新收录的段用平面名兜底。
 */
function headerEntries(): HeaderEntry[] {
  if (SCHEMA.sections.length === 0) {
    return SECTION_HEADERS.map((spec) => ({
      label: spec.label,
      header: spec.header,
      detail: spec.detail(),
    }));
  }
  // The snapshot describes the schema mcpp validates; the curated list also covers
  // tables mcpp accepts but the snapshot does not model (for example
  // `[workspace.dependencies]`). Merge them, preferring the curated wording, so
  // schema-driven detail never costs a writable table its suggestion.
  const entries: HeaderEntry[] = SCHEMA.sections.map((section) => {
    const spec = HEADER_SPEC_BY_GROUP.get(section.name);
    const entry: HeaderEntry = {
      label: spec?.label ?? section.header,
      header: spec?.header ?? section.header,
      detail: spec?.detail() ?? `plane: ${section.plane}`,
    };
    if (section.deprecatedBy) {
      entry.documentation = `Deprecated; use \`${section.deprecatedBy}\`.`;
    }
    return entry;
  });
  const suggested = new Set(entries.map((entry) => entry.header));
  for (const spec of SECTION_HEADERS) {
    if (suggested.has(spec.header)) {
      continue;
    }
    entries.push({ label: spec.label, header: spec.header, detail: spec.detail() });
  }
  return entries;
}

function headerSuggestions(range: ReplaceRange): McppTomlSuggestion[] {
  return headerEntries().map((entry) => {
    const suggestion: McppTomlSuggestion = {
      label: entry.label,
      kind: "section",
      detail: entry.detail,
      insertSnippet: entry.header,
      range,
    };
    if (entry.documentation !== undefined) {
      suggestion.documentation = entry.documentation;
    }
    return suggestion;
  });
}

function templateSuggestions(templates: readonly TemplateSpec[], range: ReplaceRange): McppTomlSuggestion[] {
  return templates.map((template) => ({
    label: template.label,
    kind: "template",
    detail: template.detail(),
    documentation: template.documentation?.(),
    insertSnippet: template.insertSnippet,
    range,
  }));
}

/** 类型的占位值：与 §3.3.2 的键补全约定一致。 */
function keyPlaceholder(key: TomlKey): string {
  switch (key.type) {
    case "boolean":
      return "true";
    case "number":
      return "0";
    case "array":
      return "[]";
    case "enum":
      return JSON.stringify(key.values?.[0] ?? "");
    default:
      return '""';
  }
}

/** `detail` 展示类型；枚举展开取值，有默认值再补默认值。 */
function keyDetail(key: TomlKey): string {
  let detail = key.type;
  if (key.values !== undefined && key.values.length > 0) {
    detail += `: ${key.values.join(" | ")}`;
  }
  if (key.default !== undefined) {
    detail += ` (default: ${JSON.stringify(key.default)})`;
  }
  return detail;
}

function keyDocumentation(key: TomlKey): string | undefined {
  const lines: string[] = [];
  if (key.note !== undefined && key.note !== "") {
    lines.push(key.note);
  }
  if (key.since !== undefined) {
    lines.push(`Since ${key.since}.`);
  }
  if (key.legacy === true) {
    lines.push("Legacy key.");
  }
  return lines.length === 0 ? undefined : lines.join(" ");
}

function keySuggestions(
  section: TomlSection,
  used: ReadonlySet<string>,
  range: ReplaceRange,
): McppTomlSuggestion[] {
  const keys = section.keys ?? [];
  return keys
    .filter((key) => !used.has(key.key))
    .map((key) => {
      const suggestion: McppTomlSuggestion = {
        label: key.key,
        kind: "template",
        detail: keyDetail(key),
        insertSnippet: `${key.key} = ${keyPlaceholder(key)}`,
        range,
      };
      const documentation = keyDocumentation(key);
      if (documentation !== undefined) {
        suggestion.documentation = documentation;
      }
      return suggestion;
    });
}

/**
 * 同段中光标之前已出现的顶层键。用容错解析器遍历节点树：`[targets.<n>]` 这类
 * 行表按 parser 的组归属聚合，因此同组的不同行表会互相剔除已用键。
 */
function keysUsedBefore(lines: readonly string[], line: number, group: string): Set<string> {
  const used = new Set<string>();
  let current: string | undefined;
  for (const node of parseMcppToml(lines).nodes) {
    if (node.type === "section") {
      const resolution = resolveSection(node.segments.map((segment) => segment.name));
      current = resolution.kind === "known" ? resolution.group : undefined;
      continue;
    }
    if (current !== group || node.range.startLine >= line) {
      continue;
    }
    const first = node.keyPath[0];
    if (first !== undefined) {
      used.add(first.name);
    }
  }
  return used;
}

/** 值位置的枚举键：点分键按完整路径查，找不到退回首段（与诊断一致）。 */
function enumKeyOf(section: TomlSection | undefined, keyPath: readonly string[]): TomlKey | undefined {
  if (section?.keys === undefined || keyPath.length === 0) {
    return undefined;
  }
  const joined = keyPath.join(".");
  const key =
    section.keys.find((entry) => entry.key === joined) ??
    section.keys.find((entry) => entry.key === keyPath[0]);
  return key?.type === "enum" ? key : undefined;
}

function enumValueSuggestions(
  key: TomlKey,
  insideString: boolean,
  range: ReplaceRange,
): McppTomlSuggestion[] {
  return (key.values ?? []).map((value) => ({
    label: value,
    kind: "template",
    detail: `value of ${key.key}`,
    // 字符串内只替换内容；裸值位置补上引号，枚举值在 manifest 里都是字符串。
    insertSnippet: insideString ? value : JSON.stringify(value),
    range,
  }));
}

/**
 * 计算 mcpp.toml 在指定位置的补全建议（段头 + 键 + 枚举值 + 写法模板）。
 */
export function computeMcppTomlCompletions(
  lines: readonly string[],
  line: number,
  character: number,
): McppTomlSuggestion[] {
  const context = contextAt(lines, line, character);

  if (context.kind === "section-header") {
    // mcpp manifest 不使用 TOML 数组表（[[...]]）；[[ 内不提供建议，
    // 避免把用户意图的数组表悄悄替换成普通段 [x]（未知段会被 mcpp 静默忽略）。
    if (context.isArray) {
      return [];
    }
    // parser 的替换范围从段名 token 开始；段头建议插入的是完整 "[xxx]"，
    // 需要把范围扩展到本行的 "["，避免留下 "[["。仅当 "[" 是行内首个
    // 非空白字符时才扩展（section-header 上下文正常都满足，防御奇怪输入）。
    const lineText = (lines[line] ?? "").replace(/\r$/, "");
    const bracket = lineText.indexOf("[");
    const firstNonWs = lineText.search(/\S/);
    const range = bracket >= 0 && bracket === firstNonWs
      ? { startCharacter: bracket, endCharacter: context.replaceRange.endCharacter }
      : context.replaceRange;
    return headerSuggestions(range);
  }

  if (context.kind === "key") {
    const { section, containerPath, replaceRange } = context;
    // 文档顶部（尚无段头）：提示段头。未知段：不提供建议
    // （附录 A：不支持包自定义 toml 键）。
    if (section.kind === "top") {
      return headerSuggestions(replaceRange);
    }
    if (section.kind !== "known" || containerPath.length > 0) {
      return [];
    }
    if (DEPENDENCY_GROUPS.has(section.group)) {
      return templateSuggestions(DEPENDENCY_TEMPLATES, replaceRange);
    }
    const schemaSection = sectionByName(section.group);
    // openKeys 段的键由用户自选（如 [toolchain] 的平台名），不能给固定词表。
    if (schemaSection?.openKeys !== true && schemaSection?.keys !== undefined) {
      const used = keysUsedBefore(lines, line, section.group);
      return keySuggestions(schemaSection, used, replaceRange);
    }
    const templates = TEMPLATES_BY_GROUP[section.group];
    return templates === undefined ? [] : templateSuggestions(templates, replaceRange);
  }

  // 值位置：只有已知枚举键才出候选，其余自由格式值不瞎猜。
  if (context.section.kind === "known") {
    const schemaSection = sectionByName(context.section.group);
    const key = enumKeyOf(schemaSection, context.keyPath);
    if (key !== undefined) {
      return enumValueSuggestions(key, context.insideString, context.replaceRange);
    }
  }
  return [];
}

/** 光标所在的依赖版本值位置：属于哪个依赖、替换范围、是否已在字符串内。 */
export interface DependencyVersionContext {
  /** 依赖名（值所属的键，如 `zlib`）。 */
  name: string;
  /** 光标已在引号内（只替换内容，不再补引号）。 */
  insideString: boolean;
  /** 替换范围：简写覆盖 `= ` 之后的值，长式在字符串内只覆盖已输入内容。 */
  range: ReplaceRange;
}

/**
 * 判断光标是否落在依赖的**版本值**上（方案 §3.3.2 的 `toml.indexCompletion`
 * 位置）。只认两种写法：
 *
 *   `zlib = "1.2|"`                  简写版本
 *   `zlib = { version = "1.2|" }`    长式 dep spec 的 version 字段
 *
 * `git` / `path` / `features` 的值不是版本，返回 undefined，绝不据此查询索引。
 */
export function dependencyVersionContextAt(
  lines: readonly string[],
  line: number,
  character: number,
): DependencyVersionContext | undefined {
  const context = contextAt(lines, line, character);
  if (context.kind !== "value" || context.section.kind !== "known") {
    return undefined;
  }
  if (!DEPENDENCY_GROUPS.has(context.section.group) || context.keyPath.length === 0) {
    return undefined;
  }
  const last = context.keyPath[context.keyPath.length - 1];
  if (context.keyPath.length > 1 && last !== "version") {
    return undefined;
  }
  // A version is a string, or a value not typed yet. An inline table, an array
  // or a bare non-version token is a different dep-spec field; offering versions
  // there would replace the wrong thing.
  const kind = context.valueKind;
  if (kind !== undefined && kind !== "string" && kind !== "unknown") {
    return undefined;
  }
  return {
    name: context.keyPath[0],
    insideString: context.insideString,
    range: context.replaceRange,
  };
}

/** 把索引候选变成补全建议；字符串内只替换内容，裸值位置补上引号。 */
export function indexVersionSuggestions(
  context: DependencyVersionContext,
  versions: readonly PackageVersion[],
): McppTomlSuggestion[] {
  return versions.map((entry) => {
    const suggestion: McppTomlSuggestion = {
      label: entry.version,
      kind: "version",
      detail:
        entry.summary === undefined ? `version of ${context.name}` : `${context.name}: ${entry.summary}`,
      insertSnippet: context.insideString ? entry.version : JSON.stringify(entry.version),
      range: context.range,
    };
    return suggestion;
  });
}

/** 取索引候选：按依赖名查询，失败与超时都由调用方降级为空数组。 */
export type IndexVersionResolver = (name: string) => Promise<readonly PackageVersion[]>;

/**
 * 静态补全 + 依赖版本补全的合并入口。静态层有建议就返回它；否则若光标在依赖
 * 版本值上且调用方给了 resolver，就询问索引。resolver 抛异常时静默降级为
 * 「无候选」，绝不冒泡成错误。
 */
export async function computeMcppTomlCompletionsWithIndex(
  lines: readonly string[],
  line: number,
  character: number,
  resolveIndex?: IndexVersionResolver,
): Promise<McppTomlSuggestion[]> {
  const direct = computeMcppTomlCompletions(lines, line, character);
  if (direct.length > 0 || resolveIndex === undefined) {
    return direct;
  }
  const context = dependencyVersionContextAt(lines, line, character);
  if (context === undefined) {
    return direct;
  }
  let versions: readonly PackageVersion[];
  try {
    versions = await resolveIndex(context.name);
  } catch {
    return direct;
  }
  return indexVersionSuggestions(context, versions);
}
