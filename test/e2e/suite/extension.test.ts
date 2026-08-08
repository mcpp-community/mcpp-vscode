import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

suite("mcpp extension smoke", () => {
  test("activates, registers commands and executes a configured build", async () => {
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

    void vscode.commands.executeCommand("mcpp.build");
    const deadline = Date.now() + 15_000;
    while (!existsSync(logPath) && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    assert.ok(existsSync(logPath), "fake mcpp should have been invoked");
    assert.equal(readFileSync(logPath, "utf8").trim(), "build");
    assert.equal(path.basename(workspaceFolder.uri.fsPath), "project");
  });
});
