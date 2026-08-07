// mcpp.toml 的代码补全：字段表取自 mcpp 主仓库文档（docs/zh/05-mcpp-toml.md，
// 另含 03-toolchains.md 的 [toolchain]/[build].target 与 06-workspace.md 的
// [workspace]、[package].namespace、依赖 spec 的 workspace 继承键）。
// 本模块不依赖 vscode API，便于在 node --test 下直接测试；extension.ts 负责
// 把建议映射为 CompletionItem。

export interface McppTomlSuggestion {
  label: string;
  kind: "section" | "key" | "value" | "template";
  detail: string;
  documentation?: string;
  /** 插入文本；含 $1 等 snippet 占位符。缺省时插入 label。 */
  insertSnippet?: string;
}

interface ValueSpec {
  value: string;
  detail: string;
  /** 字符串枚举需要带引号插入。 */
  quoted?: boolean;
}

interface KeySpec {
  name: string;
  detail: string;
  documentation?: string;
  /** label 之后的插入片段（不含键名本身）。 */
  insertSuffix: string;
  values?: readonly ValueSpec[];
}

const BOOL_VALUES: readonly ValueSpec[] = [
  { value: "true", detail: "布尔值" },
  { value: "false", detail: "布尔值" },
];

function stringKey(name: string, detail: string, documentation?: string, values?: readonly ValueSpec[]): KeySpec {
  return { name, detail, documentation, insertSuffix: ' = "$1"', values };
}

function arrayKey(name: string, detail: string, documentation?: string, values?: readonly ValueSpec[]): KeySpec {
  return { name, detail, documentation, insertSuffix: " = [$1]", values };
}

function boolKey(name: string, detail: string, documentation?: string): KeySpec {
  return { name, detail, documentation, insertSuffix: " = $1", values: BOOL_VALUES };
}

function bareKey(name: string, detail: string, documentation?: string): KeySpec {
  return { name, detail, documentation, insertSuffix: " = " };
}

const STANDARD_VALUES: readonly ValueSpec[] = [
  { value: "c++23", detail: "默认值", quoted: true },
  { value: "c++20", detail: "mcpp 接受的最低档位", quoted: true },
  { value: "c++26", detail: "需要 C++26 语言特性时使用", quoted: true },
  { value: "c++2a", detail: "c++20 的兼容别名", quoted: true },
  { value: "c++2c", detail: "c++26 的兼容别名", quoted: true },
  { value: "gnu++20", detail: "GNU dialect", quoted: true },
  { value: "gnu++23", detail: "GNU dialect", quoted: true },
  { value: "gnu++26", detail: "GNU dialect", quoted: true },
  { value: "c++latest", detail: "跟随当前 mcpp 支持的最新标准", quoted: true },
  { value: "c++fly", detail: "c++latest 加全部实验性标准特性，勿用于发布包", quoted: true },
];

const CXX_RUNTIME_VALUES: readonly ValueSpec[] = [
  { value: "self-contained", detail: "默认：产物不依赖外部 C++ 运行时", quoted: true },
  { value: "toolchain-coupled", detail: "依赖 mcpp 安装的工具链运行时", quoted: true },
  { value: "host-coupled", detail: "依赖系统运行时；发行版打包/插件场景", quoted: true },
];

const PACKAGE_KEYS: readonly KeySpec[] = [
  stringKey("name", "包名（必填）"),
  stringKey("namespace", "包命名空间（与 name 构成包身份；工作空间成员常用）"),
  stringKey("version", "语义化版本（必填）"),
  stringKey("standard", "C++ 标准（默认 c++23）", "模块图全局有效；切换标准不会共用缓存。", STANDARD_VALUES),
  stringKey("description", "包简介"),
  stringKey("license", "许可证"),
  arrayKey("authors", "作者列表"),
  stringKey("repo", "仓库地址"),
  arrayKey("platforms", "声明支持的平台（CI 矩阵提示）", undefined, [
    { value: "linux", detail: "Linux", quoted: true },
    { value: "macos", detail: "macOS", quoted: true },
    { value: "windows", detail: "Windows", quoted: true },
  ]),
  arrayKey("provides", "本包提供的 capability（如 blas）"),
];

const TARGET_KEYS: readonly KeySpec[] = [
  stringKey("kind", "目标类型", undefined, [
    { value: "bin", detail: "可执行程序（有 src/main.cpp 时自动推断）", quoted: true },
    { value: "lib", detail: "静态库", quoted: true },
    { value: "shared", detail: "共享库（当前仅 Linux/ELF）", quoted: true },
  ]),
  stringKey("main", "入口源文件（默认 src/main.cpp）"),
  stringKey("soname", "共享库 ABI 名称（仅 kind = \"shared\"，文件名 basename）"),
  arrayKey("defines", "预处理宏，只作用于该目标入口"),
  arrayKey("cxxflags", "该目标入口的额外 C++ 标志（不要放 -std=...）"),
  arrayKey("cflags", "该目标入口的额外 C 标志"),
  arrayKey("required_features", "列出的 feature 全部激活时才构建该目标"),
];

// 文档（03-toolchains.md / 05-mcpp-toml.md）中出现的 target 词汇；自定义 triple
// 可经 [target.<triple>] 节放行，此处只补全已知值。
const TARGET_TRIPLE_VALUES: readonly ValueSpec[] = [
  { value: "x86_64-linux-gnu", detail: "Linux/glibc（Linux x86_64 宿主）", quoted: true },
  { value: "x86_64-linux-musl", detail: "全静态 Linux ELF", quoted: true },
  { value: "aarch64-linux-musl", detail: "全静态 Linux ELF（ARM64）", quoted: true },
  { value: "x86_64-windows-gnu", detail: "Windows PE（MinGW-w64，默认 static）", quoted: true },
  { value: "x86_64-windows-msvc", detail: "Windows PE（MSVC ABI）", quoted: true },
  { value: "aarch64-macos", detail: "macOS（Apple Silicon）", quoted: true },
];

const BUILD_KEYS: readonly KeySpec[] = [
  arrayKey("sources", "源文件 glob（默认 src/**/*.{cppm,cpp,cc,c,S,s,asm}；! 前缀排除）"),
  arrayKey("include_dirs", "头文件搜索路径（-I）"),
  arrayKey("include_dirs_after", "排在系统目录之后搜索的头文件目录（-idirafter）"),
  stringKey("c_standard", "C 源文件标准（默认 c11）", undefined, [
    { value: "c11", detail: "默认值", quoted: true },
    { value: "c99", detail: "C99", quoted: true },
  ]),
  arrayKey("cflags", "额外 C 编译参数"),
  arrayKey("cxxflags", "额外 C++ 编译参数（不要放 -std=...，用 [package].standard）"),
  arrayKey("ldflags", "额外链接参数"),
  arrayKey("defines", "作用于包内每个 TU 的预处理宏（包私有，不传播）"),
  stringKey("cxx_runtime", "C++ 运行时契约（分发属性）", undefined, CXX_RUNTIME_VALUES),
  boolKey("static_stdlib", "cxx_runtime 的旧拼写：true = self-contained，false = host-coupled"),
  stringKey("macos_deployment_target", "macOS 产物的最低支持系统版本（仅 macOS 生效）"),
  stringKey("target", "项目默认构建 target（≙ cargo 的 build.target）", undefined, TARGET_TRIPLE_VALUES),
  stringKey("cache", "依赖的全局构建缓存（默认 global）", undefined, [
    { value: "global", detail: "默认：跨工程共享依赖构建缓存", quoted: true },
    { value: "local", detail: "依赖编在本工程 target/ 内", quoted: true },
    { value: "off", detail: "额外清掉本次构建目录做冷构建", quoted: true },
  ]),
  stringKey("default-profile", "不带 flag 时的默认构建档案（别名 profile）", undefined, [
    { value: "dev", detail: "默认：-O0 -g", quoted: true },
    { value: "release", detail: "-O2", quoted: true },
    { value: "debug", detail: "-O0 -g", quoted: true },
    { value: "dist", detail: "-O3 + strip", quoted: true },
  ]),
  stringKey("profile", "default-profile 的别名", undefined, [
    { value: "dev", detail: "默认：-O0 -g", quoted: true },
    { value: "release", detail: "-O2", quoted: true },
    { value: "debug", detail: "-O0 -g", quoted: true },
    { value: "dist", detail: "-O3 + strip", quoted: true },
  ]),
  {
    name: "flags",
    detail: "per-glob 编译旗标（有序内联表数组）",
    documentation: "每条目：glob（必填）+ cflags / cxxflags / asmflags / defines。",
    insertSuffix: " = [ { glob = \"$1\" } ]",
  },
];

const PROFILE_KEYS: readonly KeySpec[] = [
  {
    name: "opt",
    detail: "优化级别",
    insertSuffix: " = $1",
    values: [
      { value: "0", detail: "-O0" },
      { value: "1", detail: "-O1" },
      { value: "2", detail: "-O2" },
      { value: "3", detail: "-O3" },
      { value: "s", detail: "-Os（字符串）", quoted: true },
      { value: "z", detail: "-Oz（字符串）", quoted: true },
    ],
  },
  boolKey("debug", "生成调试信息（-g）"),
  boolKey("lto", "链接期优化（-flto）"),
  boolKey("strip", "链接期去除符号（-s）"),
  arrayKey("cflags", "passthrough：额外 C 编译参数"),
  arrayKey("cxxflags", "passthrough：额外 C++ 编译参数"),
  arrayKey("ldflags", "passthrough：额外链接参数"),
];

const RUNTIME_KEYS: readonly KeySpec[] = [
  arrayKey("library_dirs", "烤进产物 RUNPATH 的目录（相对包根）"),
  arrayKey("dlopen_libs", "运行期 dlopen 的 soname"),
  arrayKey("capabilities", "需要的主机能力（开放命名空间，如 opengl.glx.driver）"),
  arrayKey("provides", "显式声明本包兑现的能力（强 provider）"),
];

const RESOURCES_KEYS: readonly KeySpec[] = [
  stringKey("icon", "作为应用图标嵌入的 .ico 路径（仅 PE 目标编译）"),
  arrayKey("files", "自写的 .rc 脚本，mcpp 编译并跟踪为构建输入"),
  arrayKey("extra-inputs", ".rc 扫描器看不见的输入"),
  boolKey("version-info", "false 表示不生成版本资源"),
];

const TOOLCHAIN_KEYS: readonly KeySpec[] = [
  stringKey("default", "默认工具链（如 gcc@16.1.0）"),
  stringKey("linux", "Linux 宿主的工具链 pin（项目级版本锁定）"),
  stringKey("macos", "macOS 宿主的工具链 pin（如 llvm@20.1.7）"),
  stringKey("windows", "Windows 宿主的工具链 pin（如 gcc@16 / msvc@system）"),
];

const XLINGS_KEYS: readonly KeySpec[] = [
  arrayKey("deps", "要供给的 host 构建工具（如 make@4.4）"),
  stringKey("subos", "命名的项目级沙箱"),
];

const LIB_KEYS: readonly KeySpec[] = [
  stringKey("path", "覆盖默认 lib-root 位置（默认 src/<包名最后一段>.cppm）"),
];

const WORKSPACE_KEYS: readonly KeySpec[] = [
  arrayKey("members", "成员包相对路径（每个路径下须含独立 mcpp.toml）"),
  arrayKey("exclude", "从 members glob 中排除的路径"),
];

const TARGET_TRIPLE_KEYS: readonly KeySpec[] = [
  stringKey("toolchain", "该目标三元组使用的工具链"),
  stringKey("linkage", "链接方式", undefined, [
    { value: "static", detail: "完全静态链接（musl / windows-gnu 的默认）", quoted: true },
    { value: "dynamic", detail: "动态链接", quoted: true },
  ]),
  stringKey("cxx_runtime", "该目标三元组的 C++ 运行时契约", undefined, CXX_RUNTIME_VALUES),
];

const BUILD_CXX_RUNTIME_KEYS: readonly KeySpec[] = [
  stringKey("default", "可执行文件与共享库的 C++ 运行时契约", undefined, CXX_RUNTIME_VALUES),
  stringKey("tests", "测试二进制的 C++ 运行时契约", undefined, CXX_RUNTIME_VALUES),
];

const RESOURCES_VERSION_INFO_KEYS: readonly KeySpec[] = [
  stringKey("company", "CompanyName（默认取 [package]）"),
  stringKey("product", "ProductName（默认取 [package]）"),
  stringKey("description", "FileDescription（默认取 [package]）"),
  stringKey("copyright", "LegalCopyright（默认取 [package]）"),
  stringKey("original-filename", "OriginalFilename"),
  stringKey("internal-name", "InternalName"),
];

const RUNTIME_PROVIDER_KEYS: readonly KeySpec[] = [
  stringKey("provider", "该 capability 的显式 provider（覆盖强弱档）"),
];

const LANGUAGE_KEYS: readonly KeySpec[] = [
  stringKey("standard", "旧版兼容字段；新项目请用 [package].standard", undefined, STANDARD_VALUES),
];

/** 依赖长式 spec（{ version = ..., features = ... } 内联表）的键。 */
const DEP_SPEC_KEYS: readonly KeySpec[] = [
  stringKey("version", "SemVer 约束"),
  stringKey("path", "路径依赖（本地开发）"),
  stringKey("git", "Git 仓库地址；与 tag / branch / rev 之一配合"),
  stringKey("tag", "Git tag"),
  stringKey("branch", "Git 分支（首次构建解析进 mcpp.lock）"),
  stringKey("rev", "Git commit"),
  arrayKey("features", "请求该依赖的 feature"),
  stringKey("backend", "糖：= features = [\"backend-<impl>\"]"),
  arrayKey("tools", "依赖产出的 host 工具（须为该包的 bin target）"),
  boolKey("host-module", "以包分发可复用构建规则，供 build.mcpp import"),
  boolKey("reexport", "把边上的构建期提供物交给本包的消费者"),
  boolKey("workspace", "继承 [workspace.dependencies] 中声明的版本"),
];

/** feature 表形式（{ defines = [...], ... }）的键。 */
const FEATURE_SPEC_KEYS: readonly KeySpec[] = [
  arrayKey("defines", "feature 激活时贡献的包自有宏"),
  arrayKey("implies", "隐含 feature"),
  arrayKey("sources", "feature 门控的源 glob"),
  arrayKey("requires", "需要的 capability"),
  arrayKey("provides", "提供的 capability"),
  {
    name: "flags",
    detail: "feature 门控的 per-glob 编译旗标",
    insertSuffix: " = [ { glob = \"$1\" } ]",
  },
];

/** [build].flags / feature flags 的 per-glob 条目键（§2.3 / §2.8）。 */
const PER_GLOB_FLAG_KEYS: readonly KeySpec[] = [
  stringKey("glob", "相对包根的 glob（必填）"),
  arrayKey("cflags", "命中源的额外 C 旗标"),
  arrayKey("cxxflags", "命中源的额外 C++ 旗标"),
  arrayKey("asmflags", "命中汇编单元的旗标"),
  arrayKey("defines", "命中源的预处理宏"),
];

interface SectionSpec {
  /** 规范化后的组名，如 targets / profile / target build。 */
  group: string;
  /** 列表里显示的标题；缺省时用 header。 */
  label?: string;
  header: string;
  detail: string;
}

/** 开放词汇段（键是包名、feature 名等）在空行提供的写法模板。 */
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
  {
    label: "name = [...]",
    detail: "数组简写：仅隐含 feature",
    insertSnippet: "${1:name} = [${2}]",
  },
  {
    label: "name = { defines = [...] }",
    detail: "表形式：激活时贡献包自有宏",
    insertSnippet: '${1:name} = { defines = ["${2:MACRO}"] }',
  },
  {
    label: "name = { requires = [...] }",
    detail: "表形式：需要 capability",
    insertSnippet: '${1:name} = { requires = ["${2:blas}"] }',
  },
  {
    label: "name = { sources = [...] }",
    detail: "表形式：feature 门控的源 glob",
    insertSnippet: '${1:name} = { sources = ["${2:src/simd/**}"] }',
  },
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
  {
    label: 'tool = "version"',
    detail: "固定工具版本",
    insertSnippet: '${1:clang} = "${2:20.1.7}"',
  },
];

const XLINGS_ENVS_TEMPLATES: readonly TemplateSpec[] = [
  {
    label: 'NAME = "value"',
    detail: "应用到工具环境的环境变量",
    insertSnippet: '${1:NAME} = "${2:value}"',
  },
];

const TOOLS_OVERRIDES_TEMPLATES: readonly TemplateSpec[] = [
  {
    label: '"pkg:tool" = "path"',
    detail: "用已有二进制覆盖 host 工具（跳过构建）",
    insertSnippet: '"${1:compat.protobuf:protoc}" = "${2:/usr/bin/protoc}"',
  },
];

interface SectionGroupSpec {
  keys: readonly KeySpec[];
  inlineKeys?: readonly KeySpec[];
  /** 键名为自由词汇（包名、feature 名），不提供键补全，改为提供写法模板。 */
  freeKeys?: boolean;
  templates?: readonly TemplateSpec[];
}

const SECTION_GROUPS: Record<string, SectionGroupSpec> = {
  "package": { keys: PACKAGE_KEYS },
  "lib": { keys: LIB_KEYS },
  "build": { keys: BUILD_KEYS },
  "targets": { keys: TARGET_KEYS },
  "profile": { keys: PROFILE_KEYS },
  "runtime": { keys: RUNTIME_KEYS },
  "resources": { keys: RESOURCES_KEYS },
  "toolchain": { keys: TOOLCHAIN_KEYS },
  "xlings": { keys: XLINGS_KEYS },
  "language": { keys: LANGUAGE_KEYS },
  "target": { keys: TARGET_TRIPLE_KEYS },
  "workspace": { keys: WORKSPACE_KEYS },
  "build.cxx_runtime": { keys: BUILD_CXX_RUNTIME_KEYS },
  "resources.version-info": { keys: RESOURCES_VERSION_INFO_KEYS },
  "runtime.capability": { keys: RUNTIME_PROVIDER_KEYS },
  "dependencies": { keys: [], inlineKeys: DEP_SPEC_KEYS, freeKeys: true, templates: DEPENDENCY_TEMPLATES },
  "dev-dependencies": { keys: [], inlineKeys: DEP_SPEC_KEYS, freeKeys: true, templates: DEPENDENCY_TEMPLATES },
  "build-dependencies": { keys: [], inlineKeys: DEP_SPEC_KEYS, freeKeys: true, templates: DEPENDENCY_TEMPLATES },
  "workspace.dependencies": { keys: [], inlineKeys: DEP_SPEC_KEYS, freeKeys: true, templates: DEPENDENCY_TEMPLATES },
  "feature-deps": { keys: [], inlineKeys: DEP_SPEC_KEYS, freeKeys: true, templates: DEPENDENCY_TEMPLATES },
  "features": { keys: [], inlineKeys: FEATURE_SPEC_KEYS, freeKeys: true, templates: FEATURE_TEMPLATES },
  "generated_files": { keys: [], freeKeys: true, templates: GENERATED_FILE_TEMPLATES },
  "capabilities": { keys: [], freeKeys: true, templates: CAPABILITY_TEMPLATES },
  "xlings.workspace": { keys: [], freeKeys: true, templates: XLINGS_WORKSPACE_TEMPLATES },
  "xlings.envs": { keys: [], freeKeys: true, templates: XLINGS_ENVS_TEMPLATES },
  "tools.overrides": { keys: [], freeKeys: true, templates: TOOLS_OVERRIDES_TEMPLATES },
};

const SECTIONS: readonly SectionSpec[] = [
  { group: "package", header: "[package]", detail: "包元数据" },
  { group: "lib", header: "[lib]", detail: "库根模块约定" },
  { group: "build", header: "[build]", detail: "构建配置" },
  { group: "generated_files", header: "[generated_files]", detail: "生成文件（路径 → 内容）" },
  { group: "dependencies", header: "[dependencies]", detail: "运行时依赖" },
  { group: "dev-dependencies", header: "[dev-dependencies]", detail: "开发/测试依赖" },
  { group: "workspace", header: "[workspace]", detail: "工作空间成员声明" },
  { group: "workspace.dependencies", header: "[workspace.dependencies]", detail: "集中声明依赖版本，成员用 workspace = true 继承" },
  { group: "features", header: "[features]", detail: "feature 定义" },
  { group: "feature-deps", label: "[feature-deps.<name>]", header: "[feature-deps.${1:name}]", detail: "由 feature 拉取的可选依赖" },
  { group: "capabilities", label: "[capabilities]", header: "[capabilities]", detail: "capability 绑定（provider 选择）" },
  { group: "targets", label: "[targets.<name>]", header: "[targets.${1:name}]", detail: "构建目标" },
  { group: "profile", label: "[profile.<name>]", header: "[profile.${1:name}]", detail: "构建档案" },
  { group: "runtime", header: "[runtime]", detail: "主机运行时能力" },
  { group: "resources", header: "[resources]", detail: "编译进产物的元数据与资产（仅 PE 目标）" },
  { group: "toolchain", header: "[toolchain]", detail: "编译器工具链简写" },
  { group: "xlings", header: "[xlings]", detail: "构建环境（xlings 供给）" },
  { group: "xlings.workspace", header: "[xlings.workspace]", detail: "固定工具版本" },
  { group: "xlings.envs", header: "[xlings.envs]", detail: "工具环境的环境变量" },
  { group: "target", label: "[target.<triple>]", header: "[target.${1:x86_64-linux-gnu}]", detail: "按目标三元组的配置" },
  { group: "tools.overrides", header: "[tools.overrides]", detail: "host 工具二进制覆盖" },
  { group: "language", header: "[language]", detail: "旧版兼容字段；新项目请用 [package].standard" },
];

const HEADER_PATTERN = /^\s*\[\[?\s*([^\]]*?)\s*\]\]?\s*(?:#.*)?$/;
// 键名允许点号：dependencies 的点式选择器（capi.lua、imgui.backend.glfw_opengl3）
// 是合法的裸键写法（docs/zh/05-mcpp-toml.md §2.5）。
const KEY_VALUE_PATTERN = /^\s*([A-Za-z0-9_.-]+|"[^"]*")\s*=\s*(.*)$/;
const PARTIAL_HEADER_PATTERN = /^\s*\[[^\]]*$/;

/** 把段头规范化为组名：去掉引号，剥离 target.<sel>. 前缀与 .<name> 后缀。 */
export function normalizeSectionGroup(rawHeader: string): string | undefined {
  const header = rawHeader.replace(/'/g, "").replace(/"/g, "");
  if (header.length === 0) {
    return undefined;
  }

  let rest = header;
  if (rest === "target" || rest.startsWith("target.")) {
    // [target.<sel>] 或 [target.<sel>.<子表>]；sel 本身不含点。
    const segments = rest.split(".");
    if (segments.length === 1) {
      return "target";
    }
    rest = segments.slice(2).join(".");
    if (rest.length === 0) {
      return "target";
    }
  }

  if (rest in SECTION_GROUPS) {
    return rest;
  }
  if (rest.startsWith("workspace.dependencies.")) {
    // [workspace.dependencies.<namespace>] 命名空间子表。
    return "workspace.dependencies";
  }
  const dot = rest.indexOf(".");
  if (dot > 0) {
    const head = rest.slice(0, dot);
    if (head === "targets" || head === "profile" || head === "feature-deps" || head === "dependencies" || head === "dev-dependencies") {
      // targets.<name> / profile.<name> / feature-deps.<name> /
      // dependencies.<namespace> 都归入各自组。
      return head;
    }
    if (head === "runtime") {
      // [runtime."<capability>"] 显式 provider 覆盖子表。
      return "runtime.capability";
    }
  }
  return undefined;
}

/** 当前段上下文：none = 文档顶部（尚无段头）；unknown = 未识别的自定义段；group = 已知段组。 */
type SectionContext =
  | { kind: "none" }
  | { kind: "unknown" }
  | { kind: "group"; group: string };

function findCurrentSection(lines: readonly string[], line: number): SectionContext {
  for (let index = Math.min(line, lines.length - 1); index >= 0; index -= 1) {
    const match = HEADER_PATTERN.exec(lines[index]);
    if (match !== null) {
      const group = normalizeSectionGroup(match[1]);
      return group === undefined ? { kind: "unknown" } : { kind: "group", group };
    }
  }
  return { kind: "none" };
}

function sectionSuggestions(): McppTomlSuggestion[] {
  return SECTIONS.map((section) => ({
    label: section.label ?? section.header,
    kind: "section",
    detail: section.detail,
    insertSnippet: section.header,
  }));
}

function keySuggestions(keys: readonly KeySpec[]): McppTomlSuggestion[] {
  return keys.map((key) => ({
    label: key.name,
    kind: "key",
    detail: key.detail,
    documentation: key.documentation,
    insertSnippet: `${key.name}${key.insertSuffix}`,
  }));
}

function valueSuggestions(values: readonly ValueSpec[], insideString: boolean): McppTomlSuggestion[] {
  return values.map((entry) => {
    const needsQuotes = entry.quoted === true && !insideString;
    return {
      label: entry.value,
      kind: "value",
      detail: entry.detail,
      insertSnippet: needsQuotes ? `"${entry.value}"` : entry.value,
    };
  });
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + 1);
  }
  return count;
}

/**
 * 计算 mcpp.toml 在指定位置的补全建议。
 *
 * @param lines 文档全部行
 * @param line 光标所在行（0 基）
 * @param character 光标列（0 基）
 */
export function computeMcppTomlCompletions(
  lines: readonly string[],
  line: number,
  character: number,
): McppTomlSuggestion[] {
  if (line < 0 || line >= lines.length) {
    return [];
  }
  const textBefore = lines[line].slice(0, character);

  // 段头补全：当前行是一个未闭合的 [ 开头。
  if (PARTIAL_HEADER_PATTERN.test(textBefore)) {
    return sectionSuggestions();
  }

  const context = findCurrentSection(lines, line);
  const group = context.kind === "group" ? context.group : undefined;

  const keyValue = KEY_VALUE_PATTERN.exec(textBefore);
  if (keyValue !== null) {
    const keyName = keyValue[1].replace(/"/g, "");
    const valuePrefix = keyValue[2];

    // 内联表：dependencies / features 的值位置补全 spec 键。
    if (valuePrefix.trimStart().startsWith("{") && group !== undefined) {
      const inlineKeys = SECTION_GROUPS[group]?.inlineKeys;
      if (inlineKeys !== undefined) {
        return keySuggestions(inlineKeys);
      }
      return [];
    }

    // flags 是有序内联表数组：[ { glob = ... } ] 条目内补全 per-glob 键。
    if (keyName === "flags" && valuePrefix.includes("{")) {
      return keySuggestions(PER_GLOB_FLAG_KEYS);
    }

    if (group === undefined) {
      return [];
    }
    const keySpec = SECTION_GROUPS[group]?.keys.find((key) => key.name === keyName);
    if (keySpec?.values === undefined) {
      return [];
    }
    // 奇数个引号说明光标在字符串内部。
    const insideString = countOccurrences(valuePrefix, '"') % 2 === 1;
    return valueSuggestions(keySpec.values, insideString);
  }

  // 键位置：文档顶部（还没有任何段）时提示段头；未识别的自定义段不提供建议
  // （附录 A：不支持包自定义 toml 键）。
  if (context.kind === "none") {
    return sectionSuggestions();
  }
  if (context.kind === "unknown") {
    return [];
  }
  const spec = SECTION_GROUPS[context.group];
  if (spec === undefined) {
    return [];
  }
  if (spec.freeKeys === true) {
    // 开放词汇段没有可枚举的键，提供该段的常用写法模板。
    return (spec.templates ?? []).map((template) => ({
      label: template.label,
      kind: "template",
      detail: template.detail,
      documentation: template.documentation,
      insertSnippet: template.insertSnippet,
    }));
  }
  return keySuggestions(spec.keys);
}
