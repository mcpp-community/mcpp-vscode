import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

suite("mcpp extension smoke", () => {
  test("configures a missing CDB once before executing a full build", async () => {
    const extension = vscode.extensions.getExtension("mcpp-community.mcpp-vscode");
    assert.ok(extension, "mcpp extension should be installed in development host");
    await extension.activate();

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("mcpp.build"));
    assert.ok(commands.includes("mcpp.autoConfigureModules"));

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, "fixture workspace should be open");
    const fakeMcpp = process.env.MCPP_E2E_FAKE_MCPP;
    const logPath = process.env.MCPP_E2E_LOG;
    assert.ok(fakeMcpp);
    assert.ok(logPath);
    await vscode.workspace.getConfiguration("mcpp", workspaceFolder.uri)
      .update("path", fakeMcpp, vscode.ConfigurationTarget.Workspace);

    const configureDeadline = Date.now() + 15_000;
    let invocations: string[] = [];
    while (Date.now() < configureDeadline) {
      if (existsSync(logPath)) {
        invocations = readFileSync(logPath, "utf8").trim().split("\n");
        if (invocations.includes("build --configure-only")) {
          break;
        }
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    assert.ok(existsSync(logPath), "fake mcpp should have been invoked");

    void vscode.commands.executeCommand("mcpp.build");
    const buildDeadline = Date.now() + 15_000;
    while (Date.now() < buildDeadline) {
      invocations = readFileSync(logPath, "utf8").trim().split("\n");
      if (invocations.includes("build")) {
        break;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    assert.deepEqual(invocations, ["build --configure-only", "build"]);
    assert.ok(existsSync(path.join(workspaceFolder.uri.fsPath, "compile_commands.json")));
    assert.equal(path.basename(workspaceFolder.uri.fsPath), "project");
  });
});
