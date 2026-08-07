/**
 * 新建工程的项目名校验。返回错误提示；undefined 表示合法。
 *
 * 项目名随后作为 `mcpp new <name>` 的 argv 传入：参数数组只能防 shell 注入，
 * 不能阻止 mcpp 自身把名字解析为 CLI 选项（如 --template），所以这里拒绝
 * `-` 前缀以及 `.`、`..`。
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
  return undefined;
}
