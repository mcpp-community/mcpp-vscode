// mcpp.toml 的悬停查询层。
//
// 输入是文件的物理行 + 0 基光标，输出纯数据 HoverInfo；provider 负责渲染成
// MarkdownString（本模块不依赖 vscode API）。上下文来自 parser 的 contextAt，
// 与补全共用同一套容错解析，不另写 TOML 解析器。
//
// 覆盖三类位置：段头、键、枚举键的值。其余位置一律 undefined——宁可不显示，
// 也不猜；任何畸形输入都不抛异常。

import {
  contextAt,
  resolveSection,
  type ReplaceRange,
  type TomlCursorContext,
} from "./parser";
import { sectionByName, type TomlKey, type TomlSection } from "./schema";

export interface HoverInfo {
  title: string;
  body: string;
  documentation?: string;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/** 取光标所在行（越界与 CRLF 都容错）。 */
function lineTextAt(lines: readonly string[], line: number): string {
  if (!Array.isArray(lines) || lines.length === 0) {
    return "";
  }
  const index = clamp(line, 0, lines.length - 1);
  return (lines[index] ?? "").replace(/\r$/, "");
}

/** 替换范围对应的原文（越界钳制）。 */
function tokenAt(lineText: string, range: ReplaceRange): string {
  const start = clamp(range.startCharacter, 0, lineText.length);
  const end = clamp(range.endCharacter, start, lineText.length);
  return lineText.slice(start, end);
}

function unquote(text: string): string {
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1);
    }
  }
  return text;
}

/**
 * 段头路径 → schema 段：先精确匹配，再让 parser 的组映射处理参数化段
 * （`[targets.app]` → `targets`），最后逐级去掉尾部（与诊断的 lookupSection
 * 同策略），使 `[features.a]` 这类行表也能落到基段。
 */
function sectionForHeader(segments: readonly string[]): TomlSection | undefined {
  if (segments.length === 0) {
    return undefined;
  }
  const exact = sectionByName(segments.join("."));
  if (exact !== undefined) {
    return exact;
  }
  const resolution = resolveSection(segments);
  if (resolution.kind === "known") {
    // parser 认识的组就是权威归属：schema 没收录它（如 [xlings.workspace]）时
    // 不显示，而不是把键张冠李戴到基段上。
    return sectionByName(resolution.group);
  }
  for (let length = segments.length - 1; length >= 1; length -= 1) {
    const found = sectionByName(segments.slice(0, length).join("."));
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function sectionHover(section: TomlSection): HoverInfo {
  const lines: string[] = [`plane: \`${section.plane}\``];
  if (section.deprecatedBy) {
    lines.push(`legacy: replaced by \`${section.deprecatedBy}\``);
  }
  const keyCount = section.keys?.length ?? 0;
  lines.push(
    section.keys === undefined
      ? "keys: none declared in the snapshot"
      : `keys: ${keyCount}${section.openKeys === true ? " (open: the user picks the names)" : ""}`,
  );
  const info: HoverInfo = { title: section.header, body: lines.join("\n\n") };
  if (section.doc !== undefined) {
    info.documentation = section.doc;
  }
  return info;
}

function keyHover(key: TomlKey, section: TomlSection | undefined): HoverInfo {
  const lines: string[] = [`type: \`${key.type}\``];
  if (key.values !== undefined && key.values.length > 0) {
    lines.push(`values: ${key.values.map((value) => `\`${value}\``).join(" | ")}`);
  }
  if (key.default !== undefined) {
    lines.push(`default: \`${JSON.stringify(key.default)}\``);
  }
  if (key.since !== undefined) {
    lines.push(`since: ${key.since}`);
  }
  if (key.note !== undefined && key.note !== "") {
    lines.push(key.note);
  }
  if (key.legacy === true) {
    lines.push("legacy: this key is deprecated");
  }
  if (key.unmodelled === true) {
    lines.push("unmodelled: the type is inferred from the docs, not read from mcpp");
  }
  const info: HoverInfo = { title: key.key, body: lines.join("\n\n") };
  if (section?.doc !== undefined) {
    info.documentation = section.doc;
  }
  return info;
}

function enumValueHover(key: TomlKey, value: string, section: TomlSection | undefined): HoverInfo {
  const lines: string[] = [`enum value of \`${key.key}\``];
  if (key.values !== undefined && key.values.length > 0) {
    lines.push(`one of: ${key.values.map((entry) => `\`${entry}\``).join(" | ")}`);
  }
  if (key.default !== undefined) {
    lines.push(`default: \`${JSON.stringify(key.default)}\``);
  }
  if (key.note !== undefined && key.note !== "") {
    lines.push(key.note);
  }
  const info: HoverInfo = { title: value === "" ? key.key : value, body: lines.join("\n\n") };
  if (section?.doc !== undefined) {
    info.documentation = section.doc;
  }
  return info;
}

/**
 * 光标下的悬停内容；没有可显示的内容时返回 undefined。永不抛异常。
 */
export function hoverAt(
  lines: readonly string[],
  line: number,
  character: number,
): HoverInfo | undefined {
  try {
    const context: TomlCursorContext = contextAt(lines, line, character);
    const text = lineTextAt(lines, line);

    if (context.kind === "section-header") {
      const segments = [...context.segments];
      const token = tokenAt(text, context.replaceRange).trim();
      // 光标落在某个段路径 token 内时，context.segments 是它之前的段。
      if (token !== "") {
        segments.push(unquote(token));
      }
      const section = sectionForHeader(segments);
      return section === undefined ? undefined : sectionHover(section);
    }

    if (context.kind === "key") {
      if (context.section.kind !== "known" || context.containerPath.length > 0) {
        return undefined;
      }
      const section = sectionByName(context.section.group);
      if (section?.keys === undefined) {
        return undefined;
      }
      // 点分键的根段是 schema 里的键（`metadata.demo` → `metadata`）。
      const token = unquote(tokenAt(text, context.replaceRange).trim());
      const name = context.keyPrefix.length > 0 ? context.keyPrefix[0] : token;
      const key = section.keys.find((entry) => entry.key === name);
      return key === undefined ? undefined : keyHover(key, section);
    }

    // 值位置：只有枚举键的值有可展示的语义。
    if (context.section.kind !== "known") {
      return undefined;
    }
    const section = sectionByName(context.section.group);
    if (section?.keys === undefined || context.keyPath.length === 0) {
      return undefined;
    }
    const key =
      section.keys.find((entry) => entry.key === context.keyPath.join(".")) ??
      section.keys.find((entry) => entry.key === context.keyPath[0]);
    if (key?.type !== "enum") {
      return undefined;
    }
    const value = unquote(tokenAt(text, context.replaceRange)).trim();
    return enumValueHover(key, value, section);
  } catch {
    return undefined;
  }
}
