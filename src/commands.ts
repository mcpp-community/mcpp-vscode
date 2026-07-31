export const CLI_COMMANDS = {
  showMenu: "mcpp.showMenu",
  build: "mcpp.build",
  run: "mcpp.run",
  test: "mcpp.test",
  clean: "mcpp.clean",
  showToolchains: "mcpp.showToolchains",
  installToolchain: "mcpp.installToolchain",
  selectDefaultToolchain: "mcpp.selectDefaultToolchain",
} as const;

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
  { label: "$(symbol-interface) 配置 clangd", command: "mcpp.configureClangd", group: "ide" },
  { label: "$(database) 刷新编译数据库", command: "mcpp.refreshCompilationDatabase", group: "ide" },
  { label: "$(check) 检查模块支持", command: "mcpp.checkModuleSupport", group: "ide" },
];

