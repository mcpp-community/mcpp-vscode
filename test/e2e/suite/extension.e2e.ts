import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

async function waitForFile(file: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const content = readFileSync(file, "utf8");
      if (content.trim().length > 0) {
        return content;
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

suite("mcpp extension smoke", () => {
  test("activates, registers commands, builds and refreshes C++ Modules", async () => {
    const extension = vscode.extensions.getExtension("mcpp-community.mcpp-vscode");
    assert.ok(extension, "mcpp extension should be installed in development host");
    await extension.activate();

    const languageServer = vscode.extensions.getExtension("sunrisepeak.mcpp-language-server");
    assert.ok(languageServer, "mcppls dependency should be installed next to the extension");
    await languageServer.activate();

    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      "mcpp.build",
      "mcpp.autoConfigureModules",
      "mcpp.configureLanguageServer",
      "mcpp.configureClangd",
      "mcpp.refreshCompilationDatabase",
      "mcpp.checkModuleSupport",
      "mcpp.showModuleGraph",
      "mcpp.showLanguageServerLogs",
    ]) {
      assert.ok(commands.includes(command), `missing command: ${command}`);
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, "fixture workspace should be open");
    const fakeMcpp = process.env.MCPP_E2E_FAKE_MCPP;
    const mcppLog = process.env.MCPP_E2E_LOG;
    const mcpplsLog = process.env.MCPP_E2E_MCPPLS_LOG;
    assert.ok(fakeMcpp);
    assert.ok(mcppLog);
    assert.ok(mcpplsLog);
    await vscode.workspace.getConfiguration("mcpp", workspaceFolder.uri)
      .update("path", fakeMcpp, vscode.ConfigurationTarget.Workspace);

    void vscode.commands.executeCommand("mcpp.build");
    assert.equal((await waitForFile(mcppLog, 15_000)).trim(), "build");
    assert.equal((await waitForFile(mcpplsLog, 15_000)).trim(), "mcppls.restartServer");

    await vscode.commands.executeCommand("mcpp.configureClangd");
    await vscode.commands.executeCommand("mcpp.showModuleGraph");
    await vscode.commands.executeCommand("mcpp.showLanguageServerLogs");
    assert.deepEqual(
      (await waitForFile(mcpplsLog, 15_000)).trim().split("\n"),
      ["mcppls.restartServer", "mcppls.selectContext", "mcppls.showModuleGraph", "mcppls.showLogs"],
    );
    assert.equal(path.basename(workspaceFolder.uri.fsPath), "project");
  });
});
