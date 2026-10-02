// mcpp.toml 的跳转查询层：只处理 manifest 内部的三种局部跳转。
//
//   workspace = true   → [workspace.dependencies] 里的同名依赖键
//   path = "../x"      → 那个 mcpp.toml 的 [package] 段头（行号由调用方解析）
//   features = ["a"]   → [features.a] 段头（光标所在的那个元素）
//
// 复用 parser 的节点树（parseMcppToml）定位光标下的键/值/数组元素；跨文件的
// 文件系统语义由 `resolveManifest` 回调注入，本模块保持纯函数、不依赖 vscode，
// 也不自己读盘。任何畸形输入都不抛异常。

import {
  parseMcppToml,
  resolveSection,
  type TomlDocument,
  type TomlKeyValueNode,
  type TomlSectionNode,
  type TomlValueNode,
} from "./parser";

export interface ManifestLocation {
  line: number;
  startCharacter: number;
  endCharacter: number;
}

/** 依赖类段组：三种跳转都只在这些段里有意义（`[lib] path`、`[indices] path` 不是）。 */
const DEPENDENCY_GROUPS: ReadonlySet<string> = new Set([
  "dependencies",
  "dev-dependencies",
  "build-dependencies",
  "workspace.dependencies",
  "feature-deps",
]);

const PACKAGE_HEADER = "[package]";

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/** 光标是否落在范围内（端点含尾，与 parser 的判定一致）。 */
function contains(
  range: { startLine: number; startCharacter: number; endLine: number; endCharacter: number },
  line: number,
  character: number,
): boolean {
  if (line < range.startLine || line > range.endLine) {
    return false;
  }
  if (line === range.startLine && character < range.startCharacter) {
    return false;
  }
  if (line === range.endLine && character > range.endCharacter) {
    return false;
  }
  return true;
}

/** 光标所在候选：一条键值语句，外加它所属的顶层依赖键（内联表内的条目才有）。 */
interface Candidate {
  node: TomlKeyValueNode;
  /** 顶层语句的点分键（`compat.zlib = { workspace = true }` → "compat.zlib"）。 */
  ownerKey?: string;
  sectionSegments: string[];
}

/** 内联表/数组可以嵌套：把所有可达的键值语句摊平，附带顶层依赖键。 */
function collectNested(
  value: TomlValueNode | undefined,
  ownerKey: string,
  sectionSegments: string[],
  out: Candidate[],
): void {
  if (value === undefined) {
    return;
  }
  if (value.kind === "inlineTable" && value.entries !== undefined) {
    for (const entry of value.entries) {
      out.push({ node: entry, ownerKey, sectionSegments });
      collectNested(entry.value, ownerKey, sectionSegments, out);
    }
    return;
  }
  if (value.kind === "array" && value.elements !== undefined) {
    for (const element of value.elements) {
      collectNested(element, ownerKey, sectionSegments, out);
    }
  }
}

function candidatesOf(doc: TomlDocument): Candidate[] {
  const out: Candidate[] = [];
  let sectionSegments: string[] = [];
  for (const node of doc.nodes) {
    if (node.type === "section") {
      sectionSegments = node.segments.map((segment) => segment.name);
      continue;
    }
    out.push({ node, sectionSegments });
    const key = node.keyPath.map((segment) => segment.name).join(".");
    collectNested(node.value, key, sectionSegments, out);
  }
  return out;
}

function groupOf(sectionSegments: readonly string[]): string | undefined {
  if (sectionSegments.length === 0) {
    return undefined;
  }
  const resolution = resolveSection(sectionSegments);
  return resolution.kind === "known" ? resolution.group : undefined;
}

/** 依赖名：内联表条目取顶层语句的键；`[dependencies.foo]` 取段名去掉首段。 */
function dependencyName(candidate: Candidate): string {
  if (candidate.ownerKey !== undefined && candidate.ownerKey !== "") {
    return candidate.ownerKey;
  }
  if (candidate.sectionSegments.length >= 2) {
    return candidate.sectionSegments.slice(1).join(".");
  }
  return "";
}

function locationOfKey(node: TomlKeyValueNode): ManifestLocation | undefined {
  const first = node.keyPath[0];
  const last = node.keyPath[node.keyPath.length - 1];
  if (first === undefined || last === undefined) {
    return undefined;
  }
  // 点分键（`compat.zlib`）整体选中，不只选第一段。
  return {
    line: first.range.startLine,
    startCharacter: first.range.startCharacter,
    endCharacter: last.range.endCharacter,
  };
}

function locationOfSection(node: TomlSectionNode): ManifestLocation {
  return {
    line: node.line,
    startCharacter: node.range.startCharacter,
    endCharacter: node.range.endCharacter,
  };
}

/** `[workspace.dependencies]` 里名字匹配的那条键值语句。 */
function findWorkspaceDependency(
  doc: TomlDocument,
  dependency: string,
): TomlKeyValueNode | undefined {
  if (dependency === "") {
    return undefined;
  }
  let inWorkspaceDependencies = false;
  for (const node of doc.nodes) {
    if (node.type === "section") {
      inWorkspaceDependencies = groupOf(node.segments.map((segment) => segment.name)) === "workspace.dependencies";
      continue;
    }
    if (inWorkspaceDependencies && node.keyPath.map((segment) => segment.name).join(".") === dependency) {
      return node;
    }
  }
  return undefined;
}

/** `[features.<name>]` 段头（数组表不算）。 */
function findFeatureSection(doc: TomlDocument, name: string): TomlSectionNode | undefined {
  for (const node of doc.nodes) {
    if (node.type !== "section" || node.isArray || node.segments.length !== 2) {
      continue;
    }
    if (node.segments[0].name === "features" && node.segments[1].name === name) {
      return node;
    }
  }
  return undefined;
}

function isRelativePath(value: string): boolean {
  const text = value.trim();
  if (text === "") {
    return false;
  }
  if (text.startsWith("/") || text.startsWith("\\") || text.startsWith("~")) {
    return false;
  }
  if (/^[A-Za-z]:[\\/]/.test(text)) {
    return false;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return false;
  }
  return true;
}

function safeResolve(
  resolveManifest: (relative: string) => number | undefined,
  relative: string,
): number | undefined {
  try {
    const value = resolveManifest(relative);
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return undefined;
    }
    return Math.trunc(value);
  } catch {
    return undefined;
  }
}

function locate(
  candidate: Candidate,
  line: number,
  character: number,
  doc: TomlDocument,
  resolveManifest: (relative: string) => number | undefined,
): ManifestLocation | undefined {
  const { node, sectionSegments } = candidate;
  const onKey = node.keyPath.some((segment) => contains(segment.range, line, character));
  const onValue = node.value !== undefined && contains(node.value.range, line, character);
  if (!onKey && !onValue) {
    return undefined;
  }

  const keyName = node.keyPath[node.keyPath.length - 1]?.name ?? "";
  const group = groupOf(sectionSegments);
  const inDependencies = group !== undefined && DEPENDENCY_GROUPS.has(group);

  if (keyName === "workspace") {
    const isTrue = node.value?.kind === "boolean" && node.value.text === "true";
    if (!isTrue || !inDependencies) {
      return undefined;
    }
    const dependency = dependencyName(candidate);
    const target = findWorkspaceDependency(doc, dependency);
    return target === undefined ? undefined : locationOfKey(target);
  }

  if (keyName === "path") {
    if (!inDependencies || node.value?.kind !== "string") {
      return undefined;
    }
    const relative = node.value.text ?? "";
    if (!isRelativePath(relative)) {
      return undefined;
    }
    const resolved = safeResolve(resolveManifest, relative);
    if (resolved === undefined) {
      return undefined;
    }
    // 只有行号是可知的（另一个文件的内容不在本函数手里），所以选中该行的
    // [package] 字面量；缩进可能使起点略有偏差，位置仍落在段头行上。
    return { line: resolved, startCharacter: 0, endCharacter: PACKAGE_HEADER.length };
  }

  if (keyName === "features") {
    if (node.value?.kind !== "array" || node.value.elements === undefined) {
      return undefined;
    }
    const element = node.value.elements.find((entry) => contains(entry.range, line, character));
    if (element === undefined || element.kind !== "string") {
      return undefined;
    }
    const name = (element.text ?? "").trim();
    if (name === "") {
      return undefined;
    }
    const target = findFeatureSection(doc, name);
    return target === undefined ? undefined : locationOfSection(target);
  }

  return undefined;
}

/**
 * 光标位置的跳转目标；不在三种形态上时返回 undefined。永不抛异常。
 *
 * `resolveManifest` 把相对路径解析为「那个 mcpp.toml 里 [package] 段头的行号
 * （0 基）」，不存在时返回 undefined——文件系统由调用方负责。
 */
export function definitionAt(
  lines: readonly string[],
  line: number,
  character: number,
  resolveManifest: (relative: string) => number | undefined = () => undefined,
): ManifestLocation | undefined {
  try {
    const cursorLine = clamp(line, 0, Number.MAX_SAFE_INTEGER);
    const cursorCharacter = clamp(character, 0, Number.MAX_SAFE_INTEGER);
    const doc = parseMcppToml(lines);
    for (const candidate of candidatesOf(doc)) {
      const found = locate(candidate, cursorLine, cursorCharacter, doc, resolveManifest);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
