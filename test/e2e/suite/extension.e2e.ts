import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as vscode from "vscode";

import { contributedCommandIds } from "../../../src/commands/ids";

type Stub = "full" | "partial" | "renamed" | "noapi" | "throwing";

const STUB = (process.env.MCPP_E2E_STUB ?? "full") as Stub;

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

function lines(file: string): string[] {
  return readFileSync(file, "utf8").trim().split("\n").filter((line) => line.length > 0);
}

suite(`mcpp extension smoke (mcppls stub: ${STUB})`, () => {
  test("activates and registers the whole command surface", async () => {
    const extension = vscode.extensions.getExtension("mcpp-community.mcpp-vscode");
    assert.ok(extension, "the mcpp extension should be installed in the development host");
    await extension.activate();

    const languageServer = vscode.extensions.getExtension("sunrisepeak.mcpp-language-server");
    assert.ok(languageServer, "the C++ Modules dependency should be installed next to the extension");
    await languageServer.activate();

    const registered = await vscode.commands.getCommands(true);
    const missing = contributedCommandIds().filter((id) => !registered.includes(id));
    assert.deepEqual(missing, [], "every contributed command must be registered");
  });

  test("contributes the view container, its views, and the theme colours", () => {
    const manifest = vscode.extensions.getExtension("mcpp-community.mcpp-vscode")?.packageJSON as {
      contributes?: Record<string, unknown>;
    };
    const contributes = manifest.contributes ?? {};
    assert.ok(contributes.viewsContainers, "an activity bar container is contributed");
    assert.ok(contributes.views, "views are contributed");
    assert.ok(contributes.colors, "theme colours are contributed");
  });

  test("a build runs mcpp and then asks the language service to refresh", async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, "the fixture workspace should be open");
    const fakeMcpp = process.env.MCPP_E2E_FAKE_MCPP;
    const mcppLog = process.env.MCPP_E2E_LOG;
    const mcpplsLog = process.env.MCPP_E2E_MCPPLS_LOG;
    assert.ok(fakeMcpp, "MCPP_E2E_FAKE_MCPP");
    assert.ok(mcppLog, "MCPP_E2E_LOG");
    assert.ok(mcpplsLog, "MCPP_E2E_MCPPLS_LOG");
    await vscode.workspace
      .getConfiguration("mcpp", workspaceFolder.uri)
      .update("path", fakeMcpp, vscode.ConfigurationTarget.Workspace);

    void vscode.commands.executeCommand("mcpp.build");
    assert.equal((await waitForFile(mcppLog, 20_000)).trim(), "build");

    // Which command the refresh chain lands on is exactly what the variant decides.
    const recorded = await waitForFile(mcpplsLog, 20_000);
    if (STUB === "partial") {
      assert.ok(recorded.includes("mcppls.restartServer"), `expected a restart, saw: ${recorded.trim()}`);
    } else if (STUB === "renamed") {
      assert.equal(recorded.trim(), "", "a stub without the command must not be called");
    } else {
      assert.ok(
        recorded.includes("mcppls.reloadBuildDescription"),
        `expected the cheap reload to be preferred, saw: ${recorded.trim()}`,
      );
    }
  });

  test("forwarded commands reach mcppls, and a missing one does not throw", async () => {
    const mcpplsLog = process.env.MCPP_E2E_MCPPLS_LOG;
    assert.ok(mcpplsLog);
    const before = existsSync(mcpplsLog) ? lines(mcpplsLog).length : 0;

    // `executeCommand` rejects when a command was never registered, so awaiting
    // these is the assertion: the bridge must swallow a missing capability.
    await vscode.commands.executeCommand("mcpp.languageServer.refreshState");
    await vscode.commands.executeCommand("mcpp.languageServer.showModuleGraph");
    await vscode.commands.executeCommand("mcpp.languageServer.collectReport");

    const after = existsSync(mcpplsLog) ? lines(mcpplsLog) : [];
    const forwarded = after.slice(before);
    if (STUB === "full" || STUB === "noapi" || STUB === "throwing") {
      assert.ok(forwarded.includes("mcppls.showModuleGraph"), `${STUB}: ${forwarded.join(",")}`);
      assert.ok(forwarded.includes("mcppls.collectReport"), `${STUB}: ${forwarded.join(",")}`);
    } else {
      assert.deepEqual(forwarded, [], `${STUB} should have no such command to call`);
    }
  });

  test("the legacy 0.4.x ids still work", async () => {
    const mcpplsLog = process.env.MCPP_E2E_MCPPLS_LOG;
    assert.ok(mcpplsLog);
    const before = existsSync(mcpplsLog) ? lines(mcpplsLog).length : 0;
    await vscode.commands.executeCommand("mcpp.configureClangd");
    await vscode.commands.executeCommand("mcpp.showLanguageServerLogs");
    const forwarded = (existsSync(mcpplsLog) ? lines(mcpplsLog) : []).slice(before);
    if (STUB === "full" || STUB === "noapi" || STUB === "throwing") {
      assert.ok(forwarded.includes("mcppls.selectContext"), forwarded.join(","));
      assert.ok(forwarded.includes("mcppls.showLogs"), forwarded.join(","));
    }
  });

  test("reading mcppls state never throws, whatever the stub exposes", async () => {
    // Whether `exports` is a conforming object, nothing at all, or one that throws,
    // the self-check has to produce a snapshot rather than an error.
    await vscode.commands.executeCommand("mcpp.selfCheck");
  });

  test("opening the settings panel does not throw", async () => {
    await vscode.commands.executeCommand("mcpp.openSettings");
  });
});
