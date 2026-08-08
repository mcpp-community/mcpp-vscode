const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const WINDOWS_RESERVED_CHARS = /[<>:"|?*]/;
const WINDOWS_DEVICE_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

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
    return "项目名不能为空";
  }
  if (/[\\/]/.test(name)) {
    return "项目名不能包含路径分隔符";
  }
  if (name.startsWith("-")) {
    return "项目名不能以 - 开头，否则会被 mcpp 解析为命令行选项";
  }
  if (name === "." || name === "..") {
    return "项目名不能是 . 或 ..";
  }
  if (CONTROL_CHARS.test(name)) {
    return "项目名不能包含控制字符";
  }
  if (WINDOWS_RESERVED_CHARS.test(name)) {
    return '项目名不能包含 <>:"|?* 等保留字符';
  }
  if (name.endsWith(".")) {
    return "项目名不能以 . 结尾（Windows 不支持）";
  }
  if (WINDOWS_DEVICE_NAMES.test(name)) {
    return "项目名不能是 Windows 保留设备名";
  }
  return undefined;
}
