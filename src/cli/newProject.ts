import { t } from "../i18n/t";

export interface NewProjectActions {
  exists(path: string): boolean;
  confirm(message: string): Promise<boolean>;
  run(name: string, cwd: string): Promise<number>;
  openFolder(path: string): Promise<void>;
  showError(message: string): Promise<void> | void;
}

export type NewProjectOutcome = "exists" | "declined" | "failed" | "opened";

/**
 * 新建工程的核心流程，依赖全部注入以便单测。契约：创建并打开工程——
 * 打开后的完整构建交给用户手动触发；新窗口按自身信任状态与 CDB 状态决定是否运行
 * `mcpp build --configure-only`，避免创建流程跨窗口重复启动配置。
 */
export async function runNewProjectFlow(
  projectName: string,
  location: string,
  projectRoot: string,
  actions: NewProjectActions,
): Promise<NewProjectOutcome> {
  if (actions.exists(projectRoot)) {
    await actions.showError(t("The destination already exists: {0}. Choose another project name or location.", projectRoot));
    return "exists";
  }
  const confirmed = await actions.confirm(
    t("Run “mcpp new {0}” in {1}, create the project folder {2} and open it.", projectName, location, projectRoot),
  );
  if (!confirmed) {
    return "declined";
  }
  const exitCode = await actions.run(projectName, location);
  if (exitCode !== 0) {
    await actions.showError(
      t("mcpp new {0} failed (exit code {1}). See the mcpp output channel.", projectName, exitCode),
    );
    return "failed";
  }
  await actions.openFolder(projectRoot);
  return "opened";
}

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const WINDOWS_RESERVED_CHARS = /[<>:"|?*]/;
const WINDOWS_DEVICE_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const MCPP_BUILTIN_TEMPLATE_MARKER = "PROJECT";

/**
 * 新建工程的项目名校验。返回错误提示；undefined 表示合法。
 *
 * 项目名随后作为 `mcpp new <name>` 的 argv 传入：参数数组只能防 shell 注入，
 * 不能阻止 mcpp 自身把名字解析为 CLI 选项（如 --template），所以这里拒绝
 * `-` 前缀以及 `.`、`..`。
 *
 * mcpp 模板把项目名直接写进 mcpp.toml 的 `name = "{}"` 和 main.cpp，不做
 * TOML/C++ 转义，所以拒绝双引号和控制字符；Windows 保留字符、保留设备名和
 * 尾随点一并按跨平台策略拒绝。根本修复应在 mcpp CLI 自身完成。
 */
export function validateNewProjectName(input: string): string | undefined {
  const name = input.trim();
  if (name.length === 0) {
    return t("The project name must not be empty.");
  }
  if (/[\\/]/.test(name)) {
    return t("The project name must not contain a path separator.");
  }
  if (name.startsWith("-")) {
    return t("The project name must not start with -, or mcpp would read it as a command-line option.");
  }
  if (name === "." || name === "..") {
    return t("The project name must not be . or ..");
  }
  // mcpp#380：当前内置模板会重复扫描替换结果，名称包含该标记时不会终止。
  if (name.includes(MCPP_BUILTIN_TEMPLATE_MARKER)) {
    return t("The project name must not contain PROJECT: it triggers a defect in the current mcpp template substitution.");
  }
  if (CONTROL_CHARS.test(name)) {
    return t("The project name must not contain control characters.");
  }
  if (WINDOWS_RESERVED_CHARS.test(name)) {
    return t('The project name must not contain reserved characters such as <>:"|?*.');
  }
  if (name.endsWith(".")) {
    return t("The project name must not end with . (unsupported on Windows).");
  }
  if (WINDOWS_DEVICE_NAMES.test(name)) {
    return t("The project name must not be a Windows reserved device name.");
  }
  return undefined;
}
