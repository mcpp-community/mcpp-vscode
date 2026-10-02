// mcpp.toml 快照的读取层。
//
// 数据来自 `tools/generate-toml-schema.mjs` 生成的 `data/toml-schema.json`
// （贡献者期从 mcpp 仓库生成，运行期只读快照，不新增依赖）。本模块是纯数据
// 访问，不依赖 vscode API：补全、悬停、诊断都从这里取段/键/枚举。
//
// 快照里没有的段不会出现在这里，因此 mcpp 停止接受的段会自动消失——这正是
// "段列表必须来自 toml.cppm" 的落点。

import raw from "../../data/toml-schema.json";

export interface TomlKey {
  key: string;
  type: "string" | "boolean" | "number" | "array" | "enum";
  values?: string[];
  default?: unknown;
  since?: string;
  legacy?: boolean;
  note?: string;
  /** 类型是推断而非读出来的：不要据此做严格的类型校验。 */
  unmodelled?: boolean;
}

export interface TomlSection {
  header: string;
  name: string;
  plane: string;
  doc?: string;
  deprecatedBy?: string | null;
  keys?: TomlKey[];
  /**
   * 该段的键由用户自选而非固定词表（如 `[toolchain]` 的平台名与 `bootstrap`），
   * 诊断层不对它做未知键检查。生成器只对这类段写 true。
   */
  openKeys?: boolean;
}

export interface TomlSchema {
  sourceVersion: string;
  sourceCommit: string;
  sections: TomlSection[];
  rules: Array<{ id: string; severity: string }>;
}

export const SCHEMA: TomlSchema = raw as unknown as TomlSchema;

/** `[package]` / `package` → `package`；数组表 `[[x]]` 不是段，返回空串。 */
function normaliseSectionName(headerOrName: string): string {
  const text = headerOrName.trim();
  if (text.startsWith("[[")) {
    return "";
  }
  if (text.startsWith("[") && text.endsWith("]")) {
    return text.slice(1, -1).trim();
  }
  return text;
}

/** 按段头（`"[package]"` 或 `"package"`）查找。数组表不匹配任何段。 */
export function sectionByHeader(header: string): TomlSection | undefined {
  const name = normaliseSectionName(header);
  return name === "" ? undefined : sectionByName(name);
}

/** 按段名精确查找。参数化段（`[targets.<n>]`）由调用方用前缀匹配处理。 */
export function sectionByName(name: string): TomlSection | undefined {
  const wanted = normaliseSectionName(name);
  if (wanted === "") {
    return undefined;
  }
  return SCHEMA.sections.find((section) => section.name === wanted);
}

/** 段内某个键的元数据；段不存在、段没有键表或键不在表中都返回 undefined。 */
export function keyOf(sectionName: string, key: string): TomlKey | undefined {
  const section = sectionByName(sectionName);
  return section?.keys?.find((entry) => entry.key === key);
}

/**
 * `deprecatedBy` 形如 `[package].standard` / `[package]` / `package.standard`，
 * 取出它指向的段名。
 */
function deprecatedSectionName(reference: string): string {
  const text = reference.trim();
  const bracketed = /^\[([^\]]+)\]/.exec(text);
  if (bracketed !== null) {
    return bracketed[1].split(".")[0].trim();
  }
  return text.split(".")[0].trim();
}

/**
 * 快照自身的结构问题：重复段头、空平面、以及指向不存在段的 deprecatedBy。
 * 生成器保证当前快照为空数组；测试把它当门禁。
 */
export function sectionProblems(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const section of SCHEMA.sections) {
    if (seen.has(section.header)) {
      problems.push(`duplicate section header ${section.header}`);
    }
    seen.add(section.header);

    if (section.plane.trim() === "") {
      problems.push(`section ${section.header} has an empty plane`);
    }

    if (section.deprecatedBy) {
      const target = deprecatedSectionName(section.deprecatedBy);
      if (target === "" || sectionByName(target) === undefined) {
        problems.push(
          `${section.header} is deprecated by ${section.deprecatedBy}, which names no known section`,
        );
      }
    }
  }
  return problems;
}

/** 快照来自哪个 mcpp 版本与提交（环境自检与诊断输出用）。 */
export function schemaSource(): { version: string; commit: string } {
  return { version: SCHEMA.sourceVersion, commit: SCHEMA.sourceCommit };
}
