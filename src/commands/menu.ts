import { CLI_COMMANDS } from "./ids";

export const quickMenuStatusText = "$(tools) mcpp: 快捷菜单";

export interface QuickMenuItem {
  label: string;
  command: string;
  group: "project" | "toolchain" | "ide";
}

export const quickMenuItems: readonly QuickMenuItem[] = [
  { label: "$(gear) 构建", command: CLI_COMMANDS.build, group: "project" },
  { label: "$(play) 运行", command: CLI_COMMANDS.run, group: "project" },
  { label: "$(beaker) 测试", command: CLI_COMMANDS.test, group: "project" },
  { label: "$(trash) 清理 target", command: CLI_COMMANDS.clean, group: "project" },
  { label: "$(list-unordered) 查看工具链", command: CLI_COMMANDS.showToolchains, group: "toolchain" },
  { label: "$(cloud-download) 安装工具链", command: CLI_COMMANDS.installToolchain, group: "toolchain" },
  { label: "$(settings-gear) 选择全局默认工具链", command: CLI_COMMANDS.selectDefaultToolchain, group: "toolchain" },
  { label: "$(symbol-interface) 选择 C++ 模块分析上下文", command: CLI_COMMANDS.configureLanguageServer, group: "ide" },
  { label: "$(database) 刷新模块构建描述", command: CLI_COMMANDS.refreshCompilationDatabase, group: "ide" },
  { label: "$(check) 重启 C++ Modules 语言服务", command: CLI_COMMANDS.checkModuleSupport, group: "ide" },
  { label: "$(type-hierarchy) 查看模块图", command: CLI_COMMANDS.showModuleGraph, group: "ide" },
  { label: "$(output) 打开 C++ Modules 日志", command: CLI_COMMANDS.showLanguageServerLogs, group: "ide" },
  { label: "$(rocket) 一键构建并刷新模块语言服务", command: CLI_COMMANDS.autoConfigureModules, group: "ide" },
];
