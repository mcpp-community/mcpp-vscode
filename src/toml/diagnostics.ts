// mcpp.toml 的纯文本诊断层。
//
// 输入是文件的物理行 + 严重度配置，输出是 1 基行列（列按 UTF-16 码元计数，
// 与 VS Code 的 Diagnostic 一致）的诊断列表。本模块不依赖 vscode API，
// 可在 node --test 下直接测试。
//
// 它**不是**一个 TOML 校验器：只理解一个保守子集——段头、`key = value`、
// 行注释、单/双引号字符串、三引号多行字符串，以及可跨行的数组/内联表——
// 目的是抓住明显写坏的行与 mcpp 专属的平面/废弃规则，而不是重实现 TOML。
// 子集之外的一切一律不报（宁可漏报，不可误报）。下面每个规则都注明它停在哪里。
//
// 规则与严重度（默认值见 data/toml-schema.json 的 rules）：
//   1 syntax            明显的语法破坏
//   2 unknown-section   段不在 schema 中
//   3 unknown-key       已知段中的未知键
//   4 plane-separation  工具当依赖 / 包当工具
//   5 mcpp-floor        [package].mcpp 不是 ">=<release>" 形式
//   6 legacy-key        legacy 段/键
//   7 array-table       数组表 [[...]]（mcpp 只接受少数几处，见下）

import { sectionByName, type TomlKey, type TomlSection } from "./schema";

export type Severity = "error" | "warning" | "info" | "off";

export interface TomlDiagnostic {
  code: string;
  message: string;
  severity: Exclude<Severity, "off">;
  /** 1 基行号。 */
  line: number;
  /** 1 基起始列（含）。 */
  startCharacter: number;
  /** 1 基结束列（不含）。 */
  endCharacter: number;
  relatedKey?: string;
}

export interface DiagnosticSettings {
  syntax: Severity;
  unknownSection: Severity;
  unknownKey: Severity;
  planeSeparation: Severity;
  legacyKeys: Severity;
}

/**
 * `mcppFloor` 与 `arrayTable` 在设置面上还没有独立开关（§4 的 registry 尚未
 * 收录），因此默认是 error；一旦设置面补齐，传入同名字段即可覆盖，无需改签名。
 */
type ExtendedSettings = DiagnosticSettings & {
  mcppFloor?: Severity;
  arrayTable?: Severity;
};

/** 稳定的诊断码。补全/快速修复按它分发。 */
export const DIAGNOSTIC_CODES = {
  syntax: "mcpp.manifest.syntax",
  unknownSection: "mcpp.manifest.unknownSection",
  unknownKey: "mcpp.manifest.unknownKey",
  planeSeparation: "mcpp.manifest.planeSeparation",
  mcppFloor: "mcpp.manifest.mcppFloor",
  legacyKey: "mcpp.manifest.legacyKey",
  arrayTable: "mcpp.manifest.arrayTable",
} as const;

type RuleName = keyof typeof DIAGNOSTIC_CODES;

// ── TOML 子集的扫描状态 ─────────────────────────────────────────────────────
// mode: 当前是否在一个未闭合的三引号字符串里。
// depth: 未闭合的 `[` / `{` 层数（数组与内联表可跨行）。
interface ParseState {
  mode: "normal" | "ml-double" | "ml-single";
  depth: number;
}

/** text[i] 之前的反斜杠是否为奇数个（三引号串里的 \"\"\" 不结束）。 */
function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/**
 * 扫描一行，更新跨行状态；返回该行中「真正的注释起始 `#`」的下标（没有则 -1）。
 * 引号内的 `#` 不是注释。这是本模块对 TOML 词法理解的边界：不处理转义还原、
 * 不处理 \uXXXX、不看值是否合法。
 */
function scan(text: string, state: ParseState): number {
  let i = 0;
  while (i < text.length) {
    if (state.mode === "ml-double") {
      if (text.startsWith('"""', i) && !isEscaped(text, i)) {
        state.mode = "normal";
        i += 3;
        continue;
      }
      i += 1;
      continue;
    }
    if (state.mode === "ml-single") {
      if (text.startsWith("'''", i)) {
        state.mode = "normal";
        i += 3;
        continue;
      }
      i += 1;
      continue;
    }

    const ch = text[i];
    if (ch === "#") {
      return i;
    }
    if (ch === '"') {
      if (text.startsWith('"""', i)) {
        state.mode = "ml-double";
        i += 3;
        continue;
      }
      i += 1;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === "'") {
      if (text.startsWith("'''", i)) {
        state.mode = "ml-single";
        i += 3;
        continue;
      }
      i += 1;
      while (i < text.length) {
        if (text[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === "[" || ch === "{") {
      state.depth += 1;
      i += 1;
      continue;
    }
    if (ch === "]" || ch === "}") {
      if (state.depth > 0) state.depth -= 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return -1;
}

/** 去掉行尾注释（引号内的 `#` 保留），返回可解析的代码片段。 */
function codeBeforeComment(text: string): string {
  const stop = scan(text, { mode: "normal", depth: 0 });
  return stop < 0 ? text : text.slice(0, stop);
}

/** 在引号之外查找 needle 的下标；找不到返回 -1。 */
function indexOfUnquoted(text: string, needle: string): number {
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const delim = ch.repeat(3);
      if (!text.startsWith(delim, i)) {
        i += 1;
        while (i < text.length) {
          if (ch === '"' && text[i] === "\\") {
            i += 2;
            continue;
          }
          if (text[i] === ch) {
            i += 1;
            break;
          }
          i += 1;
        }
        continue;
      }
      i += 3;
      while (i < text.length) {
        if (text.startsWith(delim, i) && !isEscaped(text, i)) {
          i += 3;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (text.startsWith(needle, i)) {
      return i;
    }
    i += 1;
  }
  return -1;
}

/** 按点拆分段路径/点分键，引号内的点不拆。保留引号。 */
function splitDots(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      current += ch;
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ".") {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function isBareKey(text: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(text);
}

function isQuotedKey(text: string): boolean {
  if (text.length < 2) {
    return false;
  }
  const first = text[0];
  const last = text[text.length - 1];
  return (first === '"' && last === '"') || (first === "'" && last === "'");
}

/** `a.b` / `"a b"` / `c."d.e"` 是合法键；其余交给语法规则。 */
function isValidKey(text: string): boolean {
  const parts = splitDots(text);
  return parts.length > 0 && parts.every((part) => isBareKey(part) || isQuotedKey(part));
}

/** 去掉一层引号；不是带引号的字符串则返回 undefined（不做转义还原）。 */
function unquote(text: string): string | undefined {
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1);
    }
  }
  return undefined;
}

// ── schema 侧的段解析 ───────────────────────────────────────────────────────

/** 精确匹配，失败时逐级去掉尾部段（`[target.'cfg(x)'.dependencies]` → `target`）。 */
function lookupSection(name: string): TomlSection | undefined {
  const exact = sectionByName(name);
  if (exact !== undefined) {
    return exact;
  }
  const parts = splitDots(name);
  for (let i = parts.length - 1; i >= 1; i -= 1) {
    const candidate = sectionByName(parts.slice(0, i).join("."));
    if (candidate !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * 键规则要用的段：`[targets.<n>]`、`[profile.<n>]`、`[target.<selector>]` 这三种
 * 「行表」继承基段的键表，更深一层（`[package.metadata.<tool>]`、
 * `[target.<sel>.build]`、`[runtime.<cap>]`、`[toolchain.<platform>]`）的键
 * 属于另一套词表，不做未知键检查。
 */
const ROW_KEY_SECTIONS: ReadonlySet<string> = new Set(["targets", "profile", "target"]);

function keySectionOf(headerName: string): TomlSection | undefined {
  const exact = sectionByName(headerName);
  if (exact !== undefined) {
    return exact;
  }
  const parts = splitDots(headerName);
  if (parts.length === 2 && ROW_KEY_SECTIONS.has(parts[0])) {
    return sectionByName(parts[0]);
  }
  return undefined;
}

/** 键在段里的元数据；点分键（`metadata.demo`）按首段查找。 */
function keyInfoOf(section: TomlSection | undefined, key: string): TomlKey | undefined {
  if (section?.keys === undefined) {
    return undefined;
  }
  const parts = splitDots(key);
  const direct = section.keys.find((entry) => entry.key === key);
  if (direct !== undefined) {
    return direct;
  }
  if (parts.length > 1) {
    return section.keys.find((entry) => entry.key === parts[0]);
  }
  return undefined;
}

// ── mcpp 专属规则用的判定 ───────────────────────────────────────────────────

const DEPENDENCY_TABLES: ReadonlySet<string> = new Set([
  "dependencies",
  "dev-dependencies",
  "build-dependencies",
]);

function lastSegment(name: string): string {
  const parts = splitDots(name);
  return parts[parts.length - 1];
}

function isDependencySection(name: string): boolean {
  return DEPENDENCY_TABLES.has(lastSegment(name));
}

/** `[xlings]`、`[xlings.workspace]` 及其条件形式 `[target.<sel>.xlings…]`。 */
function isXlingsSection(name: string): boolean {
  return splitDots(name).includes("xlings");
}

/** 工具载荷名：`xim:` / `xpm:` / `xlings:` / `xvm:` 前缀。 */
function isToolPayloadName(key: string): boolean {
  const bare = unquote(key) ?? key;
  return /^(xim|xpm|xlings|xvm):/i.test(bare);
}

/** mcpp 包身份形如 `namespace.name`（至少一个点），不是工具载荷。 */
function isMcppPackageName(key: string): boolean {
  const bare = unquote(key) ?? key;
  if (isToolPayloadName(bare)) {
    return false;
  }
  return /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)+$/.test(bare);
}

/**
 * 值是否陈述了一个版本而不是一个路径。`"1.0"` / `{ version = "1.0" }` 是；
 * `{ path = "../x" }`、`""`（平台键对象）、`{ linux = "" }` 不是。
 */
function declaresVersion(valueText: string): boolean {
  const text = valueText.trim();
  if (text.startsWith("{")) {
    return /(^|[,{\s])version\s*=/.test(text) && !/(^|[,{\s])path\s*=/.test(text);
  }
  const bare = unquote(text);
  if (bare === undefined || bare === "") {
    return false;
  }
  return !bare.includes("/") && !bare.startsWith(".");
}

/**
 * mcpp 允许的数组表（`[[...]]`）。这份名单来自 toml.cppm 的
 * `kAllowedArraysOfTables`：除这些之外，任何 `[[...]]` 都是 mcpp 不接受的写法。
 *
 * 注意：任务书写的是「`[[name]]`，mcpp 不使用」，但 mcpp 明确接受
 * `[[build.flags]]`、`[[features.<f>.flags]]`、`[[runtime.requirements]]` 等
 * 少数数组表，把它们报错就是误报——而本层的第一原则是不误报。
 */
const ALLOWED_ARRAY_TABLES: ReadonlyArray<ReadonlyArray<string>> = [
  ["build", "flags"],
  ["build", "sources"],
  ["features", "*", "flags"],
  ["runtime", "requirements"],
  ["runtime", "artifacts"],
  ["runtime", "deploy"],
  ["target", "*", "build", "flags"],
  ["target", "*", "build", "sources"],
  ["xlings", "deps"],
];

function isAllowedArrayTable(name: string): boolean {
  const parts = splitDots(name);
  return ALLOWED_ARRAY_TABLES.some(
    (pattern) =>
      pattern.length === parts.length && pattern.every((part, index) => part === "*" || part === parts[index]),
  );
}

/** docs/04 §2.1：只有 `>=` 形式的下界被接受。 */
function isMcppFloor(valueText: string): boolean {
  const bare = unquote(valueText.trim());
  return bare !== undefined && /^>=\d+(\.\d+)+$/.test(bare);
}

// ── 入口 ────────────────────────────────────────────────────────────────────

/**
 * 分析一份 mcpp.toml。`lines` 是文件的物理行（含或不含 `\r` 都可以）；
 * 返回按 (line, startCharacter, code) 排序的稳定诊断列表。
 */
export function analyseManifest(
  lines: readonly string[],
  settings: DiagnosticSettings,
): TomlDiagnostic[] {
  const extended = settings as ExtendedSettings;
  const severity: Record<RuleName, Severity> = {
    syntax: settings.syntax,
    unknownSection: settings.unknownSection,
    unknownKey: settings.unknownKey,
    planeSeparation: settings.planeSeparation,
    mcppFloor: extended.mcppFloor ?? "error",
    legacyKey: settings.legacyKeys,
    arrayTable: extended.arrayTable ?? "error",
  };

  const diagnostics: TomlDiagnostic[] = [];

  function push(
    rule: RuleName,
    message: string,
    line: number,
    startCharacter: number,
    endCharacter: number,
    relatedKey?: string,
  ): void {
    const level = severity[rule];
    if (level === "off") {
      return;
    }
    const diagnostic: TomlDiagnostic = {
      code: DIAGNOSTIC_CODES[rule],
      message,
      severity: level,
      line,
      startCharacter,
      endCharacter,
    };
    if (relatedKey !== undefined) {
      diagnostic.relatedKey = relatedKey;
    }
    diagnostics.push(diagnostic);
  }

  const state: ParseState = { mode: "normal", depth: 0 };
  /** 当前段头的原始名字（未解析到 schema 的时刻也保留，用于平面规则）。 */
  let headerName: string | undefined;
  /** 当前段解析到的 schema 段（键规则用；未知段为 undefined）。 */
  let section: TomlSection | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].endsWith("\r") ? lines[index].slice(0, -1) : lines[index];
    const lineNumber = index + 1;

    // 多行字符串/数组的续行：整行属于上一个结构，不产生诊断。
    if (state.mode !== "normal" || state.depth > 0) {
      scan(raw, state);
      continue;
    }

    const code = codeBeforeComment(raw);
    const text = code.trim();
    if (text === "") {
      scan(raw, state);
      continue;
    }
    // 行首空白宽度。
    const lead = code.length - code.trimStart().length;
    const lineStart = lead + 1;
    const lineEnd = lead + text.length + 1;

    // ── 段头 ──
    if (text.startsWith("[")) {
      const arrayHeader = /^\[\[(.+?)\]\]$/.exec(text);
      const plainHeader = /^\[(.+?)\]$/.exec(text);
      if (arrayHeader === null && plainHeader === null) {
        // `[` / `[foo` / `[foo] bar`：不是合法段头，也不是 key = value。
        push("syntax", `not a [section] header: ${text}`, lineNumber, lineStart, lineEnd);
        scan(raw, state);
        continue;
      }

      const isArray = arrayHeader !== null;
      const name = ((isArray ? arrayHeader : plainHeader)?.[1] ?? "").trim();
      headerName = name;
      section = keySectionOf(name);

      if (isArray) {
        // 规则 7：mcpp 只接受少数数组表；其余是用户写错的 `[[...]]`。
        if (!isAllowedArrayTable(name)) {
          push(
            "arrayTable",
            `[[${name}]] is an array of tables, which mcpp does not use here`,
            lineNumber,
            lineStart,
            lineEnd,
            name,
          );
        }
        // 规则 2 明确忽略数组表。
      } else {
        // 规则 2：未知段（允许点分名逐级回退到已知前缀段）。
        if (lookupSection(name) === undefined) {
          push("unknownSection", `unknown section [${name}]`, lineNumber, lineStart, lineEnd, name);
        } else if (section?.deprecatedBy) {
          // 规则 6：段级 legacy。
          push(
            "legacyKey",
            `[${name}] is deprecated; use ${section.deprecatedBy}`,
            lineNumber,
            lineStart,
            lineEnd,
            section.deprecatedBy,
          );
        }
      }
      scan(raw, state);
      continue;
    }

    // ── 键值行 ──
    const equals = indexOfUnquoted(text, "=");
    if (equals <= 0) {
      push("syntax", `not a [section] header or key = value: ${text}`, lineNumber, lineStart, lineEnd);
      scan(raw, state);
      continue;
    }
    const key = text.slice(0, equals).trim();
    const value = text.slice(equals + 1).trim();
    const keyStart = lineStart;
    const keyEnd = keyStart + key.length;

    if (!isValidKey(key)) {
      push("syntax", `invalid key: ${key}`, lineNumber, keyStart, keyEnd);
      scan(raw, state);
      continue;
    }
    if (value === "") {
      push("syntax", `key ${key} has no value`, lineNumber, keyStart, keyEnd, key);
      scan(raw, state);
      continue;
    }

    const info = keyInfoOf(section, key);

    // 规则 3：已知段 + 有键表 + 不在表中（且该段不是自选键的段）。
    if (section?.keys !== undefined && section.openKeys !== true && info === undefined) {
      const label = section.header;
      push("unknownKey", `unknown key ${key} in ${label}`, lineNumber, keyStart, keyEnd, key);
    }

    // 规则 6：键级 legacy（段本身已 deprecated 时只在段头报一次）。
    if (info?.legacy === true && !section?.deprecatedBy) {
      const replacement = info.note ?? "no replacement documented";
      push(
        "legacyKey",
        `key ${key} is deprecated; ${replacement}`,
        lineNumber,
        keyStart,
        keyEnd,
        key,
      );
    }

    // 规则 5：[package].mcpp 必须是 ">=<release>"。
    if (section?.name === "package" && (splitDots(key)[0] === "mcpp") && !isMcppFloor(value)) {
      push(
        "mcppFloor",
        `[package] mcpp must be a release floor like ">=2026.9.28.3"`,
        lineNumber,
        keyStart,
        keyEnd,
        "mcpp",
      );
    }

    // 规则 4：平面分离。
    const bareKey = unquote(key) ?? key;
    if (isDependencySection(headerName ?? "") && isToolPayloadName(bareKey)) {
      push(
        "planeSeparation",
        `${bareKey} is a tool payload, not a library dependency; declare it in [xlings]/[xlings.workspace]`,
        lineNumber,
        keyStart,
        keyEnd,
        bareKey,
      );
    } else if (isXlingsSection(headerName ?? "") && isMcppPackageName(bareKey) && declaresVersion(value)) {
      push(
        "planeSeparation",
        `${bareKey} is an mcpp package, not a tool payload; declare it in [dependencies]`,
        lineNumber,
        keyStart,
        keyEnd,
        bareKey,
      );
    }

    scan(raw, state);
  }

  diagnostics.sort(
    (a, b) =>
      a.line - b.line ||
      a.startCharacter - b.startCharacter ||
      a.code.localeCompare(b.code) ||
      a.message.localeCompare(b.message),
  );
  return diagnostics;
}
