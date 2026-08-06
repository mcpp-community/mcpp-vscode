import assert from "node:assert/strict";
import test from "node:test";

import { CLI_COMMANDS, quickMenuItems, quickMenuStatusText } from "../src/commands";

test("状态栏快捷菜单名称与模块状态易于区分", () => {
  assert.equal(quickMenuStatusText, "$(tools) mcpp: 快捷菜单");
});

test("CLI 命令覆盖项目、工具链和 IDE", () => {
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
    "mcpp.autoConfigureModules",
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
      "mcpp.configureClangd",
      "mcpp.refreshCompilationDatabase",
      "mcpp.checkModuleSupport",
      "mcpp.autoConfigureModules",
    ],
  );
  assert.ok(quickMenuItems.every((item) => item.label.length > 0));
});
