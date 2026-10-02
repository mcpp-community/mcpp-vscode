import assert from "node:assert/strict";
import test from "node:test";

import { CLI_COMMANDS, DEPRECATED_COMMANDS } from "../../src/commands/ids";
import { quickMenuItems, quickMenuStatusText } from "../../src/commands/menu";

test("状态栏快捷菜单名称与 mcpp 项目状态易于区分", () => {
  assert.equal(quickMenuStatusText, "$(tools) mcpp: 快捷菜单");
});

test("CLI 命令覆盖项目、工具链和 C++ Modules 语言服务", () => {
  assert.deepEqual(Object.values(CLI_COMMANDS), [
    "mcpp.showMenu",
    "mcpp.newProject",
    "mcpp.build",
    "mcpp.run",
    "mcpp.test",
    "mcpp.clean",
    "mcpp.showToolchains",
    "mcpp.installToolchain",
    "mcpp.selectDefaultToolchain",
    "mcpp.configureLanguageServer",
    "mcpp.refreshCompilationDatabase",
    "mcpp.checkModuleSupport",
    "mcpp.autoConfigureModules",
    "mcpp.showModuleGraph",
    "mcpp.showLanguageServerLogs",
  ]);
  assert.deepEqual(
    quickMenuItems.map((item) => item.command),
    [
      "mcpp.build",
      "mcpp.run",
      "mcpp.test",
      "mcpp.clean",
      "mcpp.showToolchains",
      "mcpp.installToolchain",
      "mcpp.selectDefaultToolchain",
      "mcpp.configureLanguageServer",
      "mcpp.refreshCompilationDatabase",
      "mcpp.checkModuleSupport",
      "mcpp.showModuleGraph",
      "mcpp.showLanguageServerLogs",
      "mcpp.autoConfigureModules",
    ],
  );
  assert.ok(quickMenuItems.every((item) => item.label.length > 0));
  assert.ok(quickMenuItems.some((item) => item.label.includes("模块语言服务")));
  assert.ok(quickMenuItems.some((item) => item.label.includes("模块图")));
  assert.ok(quickMenuItems.some((item) => item.label.includes("C++ Modules 日志")));
  assert.ok(quickMenuItems.every((item) => !item.label.includes("clangd")));
});

test("保留 configureClangd 作为仅转发到 mcppls 的弃用别名", () => {
  assert.equal(DEPRECATED_COMMANDS.configureClangd, "mcpp.configureClangd");
  assert.ok(!(Object.values(CLI_COMMANDS) as readonly string[]).includes(DEPRECATED_COMMANDS.configureClangd));
  assert.ok(quickMenuItems.every((item) => item.command !== DEPRECATED_COMMANDS.configureClangd));
});
