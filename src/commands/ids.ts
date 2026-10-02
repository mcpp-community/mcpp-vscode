export const CLI_COMMANDS = {
  showMenu: "mcpp.showMenu",
  newProject: "mcpp.newProject",
  build: "mcpp.build",
  run: "mcpp.run",
  test: "mcpp.test",
  clean: "mcpp.clean",
  showToolchains: "mcpp.showToolchains",
  installToolchain: "mcpp.installToolchain",
  selectDefaultToolchain: "mcpp.selectDefaultToolchain",
  configureLanguageServer: "mcpp.configureLanguageServer",
  refreshCompilationDatabase: "mcpp.refreshCompilationDatabase",
  checkModuleSupport: "mcpp.checkModuleSupport",
  autoConfigureModules: "mcpp.autoConfigureModules",
  showModuleGraph: "mcpp.showModuleGraph",
  showLanguageServerLogs: "mcpp.showLanguageServerLogs",
} as const;

export const DEPRECATED_COMMANDS = {
  configureClangd: "mcpp.configureClangd",
} as const;

export type CliCommandId = (typeof CLI_COMMANDS)[keyof typeof CLI_COMMANDS];
