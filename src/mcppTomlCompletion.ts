// mcpp.toml 的代码补全查询层（结构补全版）。
//
// 范围：段头结构建议 + 开放词汇段的写法模板。每条建议携带显式替换范围。
// 依赖包名/版本等动态数据补全与静态字段键/枚举补全均不在本版——前者等上游
// 批量 catalog 接口，后者等版本化 manifest schema（见设计 issue #8 与
// mcpp RFC #379）。
//
// 本模块不依赖 vscode API；上下文来自 mcppTomlParser 的 contextAt（容错解析）。

import {
  contextAt,
  type ReplaceRange,
  type SectionResolution,
} from "./mcppTomlParser";

export type McppTomlSuggestionKind = "section" | "template";

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
  detail: string;
}

// 段头结构清单：TOML 结构语法，非字段语义。出处：mcpp 文档 02/03/05/06
// 与 src/manifest/toml.cppm 的段清单（契约测试用真实 mcpp 逐段验证）。
export const SECTION_HEADERS: readonly SectionHeaderSpec[] = [
  { group: "package", label: "[package]", header: "[package]", detail: "包元数据" },
  { group: "lib", label: "[lib]", header: "[lib]", detail: "库根模块约定" },
  { group: "build", label: "[build]", header: "[build]", detail: "构建配置" },
  { group: "generated_files", label: "[generated_files]", header: "[generated_files]", detail: "生成文件（路径 → 内容）" },
  { group: "dependencies", label: "[dependencies]", header: "[dependencies]", detail: "运行时依赖" },
  { group: "dev-dependencies", label: "[dev-dependencies]", header: "[dev-dependencies]", detail: "开发/测试依赖" },
  { group: "build-dependencies", label: "[build-dependencies]", header: "[build-dependencies]", detail: "构建期依赖（仅构建期拉取，运行时不可见）" },
  { group: "workspace", label: "[workspace]", header: "[workspace]", detail: "工作空间成员声明" },
  { group: "workspace.dependencies", label: "[workspace.dependencies]", header: "[workspace.dependencies]", detail: "集中声明依赖版本，成员用 workspace = true 继承" },
  { group: "features", label: "[features]", header: "[features]", detail: "feature 定义" },
  { group: "feature-deps", label: "[feature-deps.<name>]", header: "[feature-deps.${1:name}]", detail: "由 feature 拉取的可选依赖" },
  { group: "capabilities", label: "[capabilities]", header: "[capabilities]", detail: "capability 绑定（provider 选择）" },
  { group: "targets", label: "[targets.<name>]", header: "[targets.${1:name}]", detail: "构建目标" },
  { group: "profile", label: "[profile.<name>]", header: "[profile.${1:name}]", detail: "构建档案" },
  { group: "runtime", label: "[runtime]", header: "[runtime]", detail: "主机运行时能力" },
  { group: "resources", label: "[resources]", header: "[resources]", detail: "编译进产物的元数据与资产（仅 PE 目标）" },
  { group: "toolchain", label: "[toolchain]", header: "[toolchain]", detail: "编译器工具链简写" },
  { group: "xlings", label: "[xlings]", header: "[xlings]", detail: "构建环境（xlings 供给）" },
  { group: "xlings.workspace", label: "[xlings.workspace]", header: "[xlings.workspace]", detail: "固定工具版本" },
  { group: "xlings.envs", label: "[xlings.envs]", header: "[xlings.envs]", detail: "工具环境的环境变量" },
  { group: "target", label: "[target.<triple>]", header: "[target.${1:x86_64-linux-gnu}]", detail: "按目标三元组的配置" },
  { group: "pack", label: "[pack]", header: "[pack]", detail: "mcpp pack 打包配置" },
  { group: "pack.bundle-project", label: "[pack.bundle-project]", header: "[pack.bundle-project]", detail: "vendored 过滤策略微调" },
  { group: "indices", label: "[indices]", header: "[indices]", detail: "项目级索引重定向" },
  { group: "tools.overrides", label: "[tools.overrides]", header: "[tools.overrides]", detail: "host 工具二进制覆盖" },
  { group: "language", label: "[language]", header: "[language]", detail: "旧版兼容字段；新项目请用 [package].standard" },
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
  detail: string;
  documentation?: string;
  insertSnippet: string;
}

const DEPENDENCY_TEMPLATES: readonly TemplateSpec[] = [
  {
    label: 'name = "version"',
    detail: "SemVer 版本依赖",
    documentation: "默认 caret 约束（^）；也支持 ~、= 与 \">=1.0, <2.0\" 范围组合。",
    insertSnippet: '${1:name} = "${2:1.0.0}"',
  },
  {
    label: "name = { path = ... }",
    detail: "路径依赖（本地开发）",
    insertSnippet: '${1:name} = { path = "${2:../mylib}" }',
  },
  {
    label: "name = { git = ..., tag = ... }",
    detail: "Git 依赖（tag / branch / rev 三选一）",
    insertSnippet: '${1:name} = { git = "${2:https://github.com/user/repo.git}", tag = "${3:v1.0.0}" }',
  },
  {
    label: "name = { version = ..., features = [...] }",
    detail: "长式 dep spec：请求该依赖的 feature",
    insertSnippet: '${1:name} = { version = "${2:1.0}", features = ["${3:feature}"] }',
  },
  {
    label: "name = { version = ..., tools = [...] }",
    detail: "依赖产出的 host 工具（须为该包的 bin target）",
    insertSnippet: '${1:name} = { version = "${2:1.0}", tools = ["${3:protoc}"] }',
  },
];

const FEATURE_TEMPLATES: readonly TemplateSpec[] = [
  { label: "name = [...]", detail: "数组简写：仅隐含 feature", insertSnippet: "${1:name} = [${2}]" },
  { label: "name = { defines = [...] }", detail: "表形式：激活时贡献包自有宏", insertSnippet: '${1:name} = { defines = ["${2:MACRO}"] }' },
  { label: "name = { requires = [...] }", detail: "表形式：需要 capability", insertSnippet: '${1:name} = { requires = ["${2:blas}"] }' },
  { label: "name = { sources = [...] }", detail: "表形式：feature 门控的源 glob", insertSnippet: '${1:name} = { sources = ["${2:src/simd/**}"] }' },
];

const GENERATED_FILE_TEMPLATES: readonly TemplateSpec[] = [
  {
    label: '"path" = "content"',
    detail: "生成文件（相对路径 → 内容，进指纹）",
    insertSnippet: '"${1:src/gen/wrap.cppm}" = """\n${2:}\n"""',
  },
];

const CAPABILITY_TEMPLATES: readonly TemplateSpec[] = [
  {
    label: 'capability = "provider"',
    detail: "capability 绑定（等价于 --cap）",
    insertSnippet: '${1:blas} = "${2:compat.openblas}"',
  },
];

const XLINGS_WORKSPACE_TEMPLATES: readonly TemplateSpec[] = [
  { label: 'tool = "version"', detail: "固定工具版本", insertSnippet: '${1:clang} = "${2:20.1.7}"' },
];

const XLINGS_ENVS_TEMPLATES: readonly TemplateSpec[] = [
  { label: 'NAME = "value"', detail: "应用到工具环境的环境变量", insertSnippet: '${1:NAME} = "${2:value}"' },
];

const TOOLS_OVERRIDES_TEMPLATES: readonly TemplateSpec[] = [
  {
    label: '"pkg:tool" = "path"',
    detail: "用已有二进制覆盖 host 工具（跳过构建）",
    insertSnippet: '"${1:compat.protobuf:protoc}" = "${2:/usr/bin/protoc}"',
  },
];

const TEMPLATES_BY_GROUP: Record<string, readonly TemplateSpec[]> = {
  "features": FEATURE_TEMPLATES,
  "generated_files": GENERATED_FILE_TEMPLATES,
  "capabilities": CAPABILITY_TEMPLATES,
  "xlings.workspace": XLINGS_WORKSPACE_TEMPLATES,
  "xlings.envs": XLINGS_ENVS_TEMPLATES,
  "tools.overrides": TOOLS_OVERRIDES_TEMPLATES,
};

function sectionHeaderSuggestions(range: ReplaceRange): McppTomlSuggestion[] {
  return SECTION_HEADERS.map((section) => ({
    label: section.label,
    kind: "section",
    detail: section.detail,
    insertSnippet: section.header,
    range,
  }));
}

function templateSuggestions(templates: readonly TemplateSpec[], range: ReplaceRange): McppTomlSuggestion[] {
  return templates.map((template) => ({
    label: template.label,
    kind: "template",
    detail: template.detail,
    documentation: template.documentation,
    insertSnippet: template.insertSnippet,
    range,
  }));
}

/**
 * 计算 mcpp.toml 在指定位置的补全建议（结构补全：段头 + 写法模板）。
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
    return sectionHeaderSuggestions(range);
  }

  if (context.kind === "key") {
    const { section, containerPath, replaceRange } = context;
    // 文档顶部（尚无段头）：提示段头。未知段：不提供建议
    // （附录 A：不支持包自定义 toml 键）。
    if (section.kind === "top") {
      return sectionHeaderSuggestions(replaceRange);
    }
    if (section.kind !== "known" || containerPath.length > 0) {
      return [];
    }
    if (DEPENDENCY_GROUPS.has(section.group)) {
      return templateSuggestions(DEPENDENCY_TEMPLATES, replaceRange);
    }
    const templates = TEMPLATES_BY_GROUP[section.group];
    return templates === undefined ? [] : templateSuggestions(templates, replaceRange);
  }

  // 值位置：自由格式值不瞎猜（版本候选等动态数据层落地后再说）。
  return [];
}
