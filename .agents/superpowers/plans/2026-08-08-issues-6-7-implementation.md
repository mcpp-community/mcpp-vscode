# Issues 6 And 7 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make module code completion genuinely one-click and add deterministic PR unit/E2E CI for the VS Code extension.

**Architecture:** Issue #6 gets a pure `moduleSetup` planner/state machine plus a non-interactive, locked mcpp preparation method. The VS Code layer performs one confirmation, then reloads the new CDB before configuring clangd. Issue #7 adds a Linux Extension Host smoke lane using fake mcpp and a stub clangd dependency, while the existing Node tests and VSIX packaging run in a separate CI job.

**Tech Stack:** TypeScript, Node `node:test`, Mocha inside `@vscode/test-electron`, GitHub Actions, VS Code extension APIs.

---

## File Map

| File | Responsibility |
| --- | --- |
| `src/moduleSetup.ts` | Pure plan construction, command list, confirmation text, and injected execution state machine. |
| `test/moduleSetup.test.ts` | RED/GREEN coverage for plan branches, command order, failure stops, and build degradation. |
| `src/cliController.ts` | Non-interactive locked execution of `toolchain install llvm`, `toolchain default llvm`, and `build`. |
| `test/artifacts.test.ts` | Manifest/source assertions for the new one-click flow and no extra interactive prompt. |
| `src/extension.ts` | Replace the eight-step wizard with the single-confirmation adapter and reload the post-build context. |
| `README.md` | Update command behavior and explain the explicit project-toolchain boundary. |
| `package.json`, `package-lock.json` | Add E2E scripts and runner dependencies. |
| `test/e2e/runTest.ts` | Download/start VS Code and prepare isolated user/extensions directories. |
| `test/e2e/suite/index.ts`, `test/e2e/suite/extension.test.ts` | Extension Host smoke test entry and cases. |
| `test/e2e/fixtures/project/mcpp.toml` | Minimal workspace fixture. |
| `test/e2e/fixtures/fake-mcpp.js` | Deterministic executable recording argv and returning success. |
| `test/e2e/fixtures/clangd-stub/` | Installed-looking `llvm-vs-code-extensions.vscode-clangd` dependency stub. |
| `.github/workflows/ci.yml` | PR/main checks for unit/package and Extension Host E2E. |

## Task 1: Add The Failing Pure Workflow Tests

**Files:**
- Create: `test/moduleSetup.test.ts`
- Create: `src/moduleSetup.ts` only after the RED command fails

- [ ] **Step 1: Define test fixtures and the planner contract**

Add a minimal inventory factory using the existing `ToolchainInventory` shape and tests that import the not-yet-existing functions:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildModuleSetupPlan,
  executeModuleSetup,
  mcppModuleSetupCommands,
  type ModuleSetupOperations,
} from "../src/moduleSetup";
import type { ToolchainInventory } from "../src/cli";

function inventory(overrides: Partial<ToolchainInventory> = {}): ToolchainInventory {
  return {
    installed: [{ family: "gcc", version: "16.1.0", spec: "gcc@16.1.0", source: "managed", effective: true }],
    available: [{ family: "llvm", version: "22.1.8", spec: "llvm@22.1.8", source: "managed", effective: false }],
    targets: [],
    effective: { family: "gcc", version: "16.1.0", spec: "gcc@16.1.0", source: "managed", effective: true },
    effectiveTarget: undefined,
    globalDefaultSpec: "gcc@16.1.0",
    projectOverridesGlobal: false,
    recognized: true,
    rawOutput: "fixture",
    ...overrides,
  };
}

test("plans install, switch and build for an unfixed GCC project", () => {
  const plan = buildModuleSetupPlan(inventory(), "syntax-only", true, false);
  assert.deepEqual(plan, { state: "ready", installLlvm: true, switchDefault: true });
  if (plan.state !== "ready") throw new Error("expected a ready setup plan");
  assert.deepEqual(
    mcppModuleSetupCommands(plan),
    [
      { stage: "install", mode: "task", args: ["toolchain", "install", "llvm"] },
      { stage: "default", mode: "process", args: ["toolchain", "default", "llvm"] },
      { stage: "build", mode: "task", args: ["build"] },
    ],
  );
});

test("blocks a project-pinned non-LLVM toolchain without operations", () => {
  const decision = buildModuleSetupPlan(inventory({ projectOverridesGlobal: true }), "syntax-only", true, false);
  assert.deepEqual(decision, { state: "blocked", reason: "project-toolchain-override" });
});
```

- [ ] **Step 2: Add execution-order and failure tests**

Use an injected operation recorder. Cover an installed LLVM plan, a cancelled install, a failed default, a failed build with no usable CDB, and a failed build whose reload returns a full LLVM context. Assert that later operations are absent and that the latter returns `degraded` after clangd/check succeed.

```ts
function recorder(log: string[], result: Partial<ModuleSetupOperations> = {}): ModuleSetupOperations {
  return {
    prepare: async () => { log.push("prepare"); return { state: "succeeded", stage: "build" }; },
    reload: async () => { log.push("reload"); return { state: "succeeded" }; },
    ensureClangd: async () => { log.push("clangd"); return { state: "succeeded" }; },
    checkModules: async () => { log.push("check"); return { state: "succeeded" }; },
    ...result,
  };
}

test("executes prepare, reload, clangd and module check exactly once", async () => {
  const log: string[] = [];
  const outcome = await executeModuleSetup(
    { state: "ready", installLlvm: false, switchDefault: false },
    recorder(log),
  );
  assert.equal(outcome.state, "succeeded");
  assert.deepEqual(log, ["prepare", "reload", "clangd", "check"]);
});

test("does not continue after a non-build preparation failure", async () => {
  const log: string[] = [];
  const outcome = await executeModuleSetup(
    { state: "ready", installLlvm: true, switchDefault: true },
    recorder(log, { prepare: async () => { log.push("prepare"); return { state: "failed", stage: "default" }; } }),
  );
  assert.equal(outcome.state, "failed");
  assert.deepEqual(log, ["prepare"]);
});
```

- [ ] **Step 3: Run the focused test and verify RED**

Run: `npm run clean && npm run compile && node --test dist/test/moduleSetup.test.js`

Expected: TypeScript compilation fails because `src/moduleSetup.ts` and its exported contract do not exist. Do not add implementation before observing this failure.

## Task 2: Implement The Pure Workflow

**Files:**
- Create: `src/moduleSetup.ts`
- Modify: `test/moduleSetup.test.ts` only for assertions clarified by the implementation contract

- [ ] **Step 1: Implement inventory planning**

Export the following types and function signatures:

```ts
export type ModuleSetupStage = "install" | "default" | "build" | "reload" | "clangd" | "check";
export type ModuleSetupStepState = "succeeded" | "failed" | "cancelled";
export type ModuleSetupBlockedReason = "untrusted" | "busy" | "project-toolchain-override" | "unrecognized-inventory";
export type ModuleSetupDecision =
  | { state: "ready"; installLlvm: boolean; switchDefault: boolean }
  | { state: "blocked"; reason: ModuleSetupBlockedReason };

export function buildModuleSetupPlan(
  inventory: ToolchainInventory,
  capability: "full" | "syntax-only" | "unavailable",
  trusted: boolean,
  busy: boolean,
): ModuleSetupDecision;
```

Return `untrusted` before reading mutable state, `unrecognized-inventory` before reading inventory fields, and `busy` before planning mutations. Block project overrides only when `projectOverridesGlobal` is true and the effective toolchain is not LLVM. Treat an installed host LLVM as `family.toLowerCase() === "llvm"`; the available list does not count as installed.

- [ ] **Step 2: Implement fixed command construction and Chinese confirmation text**

Export:

```ts
export type ModuleSetupCommand = {
  stage: "install" | "default" | "build";
  mode: "task" | "process";
  args: string[];
};

export function mcppModuleSetupCommands(
  plan: Extract<ModuleSetupDecision, { state: "ready" }>,
): ModuleSetupCommand[];

export function moduleSetupConfirmation(
  capability: "full" | "syntax-only" | "unavailable",
  plan: Extract<ModuleSetupDecision, { state: "ready" }>,
): { message: string; detail: string };
```

Always append `{ stage: "build", mode: "task", args: ["build"] }`. Use argv arrays, never shell strings. The detail must state that global default changes are not project manifest changes and mention the possible LLVM/llvm-tools download.

- [ ] **Step 3: Implement injected execution and the build-degradation exception**

Export:

```ts
export interface ModuleSetupStepResult {
  state: ModuleSetupStepState;
  stage?: ModuleSetupStage;
  message?: string;
}

export interface ModuleSetupOperations {
  prepare: () => Promise<ModuleSetupStepResult>;
  reload: () => Promise<ModuleSetupStepResult>;
  ensureClangd: () => Promise<ModuleSetupStepResult>;
  checkModules: () => Promise<ModuleSetupStepResult>;
}

export type ModuleSetupOutcome = ModuleSetupStepResult & { degraded?: boolean };

export function executeModuleSetup(
  decision: Extract<ModuleSetupDecision, { state: "ready" }>,
  operations: ModuleSetupOperations,
): Promise<ModuleSetupOutcome>;
```

Stop on cancelled or failed `prepare` except a failed build; invoke `reload` after a failed build to determine whether the new CDB is usable. Only a successful reload, clangd configuration, and module check may produce `succeeded`; a successful remainder after a failed build produces `degraded: true`. Never call `ensureClangd` or `checkModules` after a failed reload.

- [ ] **Step 4: Run the focused tests and the full Node suite**

Run: `npm test`

Expected: the new planner/state-machine tests and all pre-existing tests pass. If a test fails, fix the implementation or its contract before proceeding to VS Code integration.

## Task 3: Add The Locked Non-Interactive Controller Operation

**Files:**
- Modify: `src/cliController.ts`
- Modify: `test/artifacts.test.ts`
- Modify: `test/tasks.test.ts` if lock behavior needs a focused pure assertion

- [ ] **Step 1: Add a failing source-contract test**

Assert that `src/cliController.ts` exposes an automated setup method which uses `mcppModuleSetupCommands`, calls `beginGlobal` before the first command, and calls `finishGlobal` in a `finally` block. Also assert that the method does not call `pickInstallSpec`, `selectDefaultToolchainFromInventory`, `showQuickPick`, or `showWarningMessage`.

- [ ] **Step 2: Implement the method with one operation token**

Make the existing inventory reader public without changing its parsing/error behavior, then add:

```ts
public async readToolchainInventory(
  project: McppProjectDiscovery | undefined = this.options.currentProject(),
): Promise<ToolchainInventory | undefined>;

public async runAutomaticModuleSetup(
  plan: Extract<ModuleSetupDecision, { state: "ready" }>,
): Promise<ModuleSetupStepResult>;
```

The method must require a project and trust, acquire one global token, and execute `mcppModuleSetupCommands(plan)` in order. `task` commands use the existing `executeTask`; `process` commands use `runProcess`; append all output through the existing helpers. Return the exact failing stage and distinguish `cancelled` from `failed`. The `build` task executes directly under the global token instead of calling `runProjectTask`, avoiding a nested project-lock attempt. Release the token before returning even when `executeTask` throws.

Use Chinese comments only for the lock lifetime and the direct-build reason; the method itself should remain self-explanatory.

- [ ] **Step 3: Run focused controller/task tests**

Run: `npm run clean && npm run compile && node --test dist/test/artifacts.test.js dist/test/tasks.test.js dist/test/moduleSetup.test.js`

Expected: PASS with the new source/lock assertions and no regression in existing task-lock tests.

## Task 4: Replace The Eight-Step Wizard

**Files:**
- Modify: `src/extension.ts`
- Modify: `test/artifacts.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Add failing source assertions for the user contract**

Extend `test/artifacts.test.ts` to assert that the one-click path calls `readToolchainInventory`, `buildModuleSetupPlan`, `moduleSetupConfirmation`, `runAutomaticModuleSetup`, and `executeModuleSetup`; assert that the wizard no longer calls the generic install/default commands or displays the post-build “刷新编译数据库” choice.

- [ ] **Step 2: Add the planner/controller imports and a post-build context holder**

Import the pure module types/functions. Keep the existing `ProjectContext` local to the extension and use `let currentContext = context` inside the workflow closure. The reload operation must call `loadProjectContext(context.project)` after the controller returns; it must update status before clangd resolution.

- [ ] **Step 3: Implement one preflight modal**

Replace the current `autoConfigureModulesWizard` body with this sequence:

```ts
const inventory = await cliController.readToolchainInventory(context.project);
if (inventory === undefined) return;
const decision = buildModuleSetupPlan(
  inventory,
  context.analysis.capability,
  vscode.workspace.isTrusted,
  cliController.isBusy(),
);
if (decision.state === "blocked") {
  await vscode.window.showWarningMessage(moduleSetupBlockedMessage(decision.reason));
  return;
}
const confirmation = moduleSetupConfirmation(context.analysis.capability, decision);
const choice = await vscode.window.showWarningMessage(
  confirmation.message,
  { modal: true, detail: confirmation.detail },
  "确认一键配置",
);
if (choice !== "确认一键配置") return;
```

The preflight modal is the only confirmation. Do not call the existing interactive install/default commands from this path.

Add a local pure mapping helper with exhaustive cases:

```ts
function moduleSetupBlockedMessage(reason: ModuleSetupBlockedReason): string {
  switch (reason) {
    case "project-toolchain-override":
      return "当前项目显式固定了非 LLVM 工具链；一键配置不会修改 mcpp.toml，请先手动切换项目工具链。";
    case "untrusted":
      return "当前工作区未受信任，不会执行外部程序。请先信任工作区。";
    case "busy":
      return "已有 mcpp 操作正在运行，请等待完成后再试。";
    case "unrecognized-inventory":
      return "无法识别 mcpp 工具链状态，请查看 mcpp 输出频道并检查 mcpp 版本。";
  }
}
```

- [ ] **Step 4: Implement the injected execution closures**

Use `executeModuleSetup` with:

- `prepare`: `cliController.runAutomaticModuleSetup(decision)`.
- `reload`: reload the project context, require a full LLVM analysis and return a failed result when the CDB is missing or remains GCC/MSVC.
- `ensureClangd`: resolve current clangd; if compatible, call `configureClangd(currentContext, status, output, "automatic", true)`. Otherwise require `findXlingsExecutable()` and a compiler LLVM identity, run the existing xlings task with `xlingsInstallArgs`, reload the context again, then configure clangd automatically.
- `checkModules`: call `runModuleSupportCheck(currentContext, status, output, "automatic")` and return failed when no available module status is produced.

The closure must not call `maybeDisableCppTools`, `showQuickPick`, `showInputBox`, or any interactive clangd mode.

- [ ] **Step 5: Report one final result and update README**

Map `succeeded` to one information message, `degraded` to one warning containing “构建失败，语言服务已刷新”, and `failed/cancelled` to one error/warning. Update the README command table and workflow section to say the command performs a single confirmation and refuses project-pinned toolchains instead of claiming it can silently switch them.

- [ ] **Step 6: Run the full Node suite and package build**

Run: `npm test && npm run package`

Expected: all tests pass and `vsce package` creates a version-matched VSIX without including `test/**` or `dist/test/**`.

## Task 5: Add Deterministic Extension Host E2E

**Files:**
- Modify: `package.json`, `package-lock.json`
- Create: `test/e2e/runTest.ts`
- Create: `test/e2e/suite/index.ts`
- Create: `test/e2e/suite/extension.test.ts`
- Create: `test/e2e/fixtures/project/mcpp.toml`
- Create: `test/e2e/fixtures/project/main.cpp`
- Create: `test/e2e/fixtures/fake-mcpp.js`
- Create: `test/e2e/fixtures/clangd-stub/package.json`
- Create: `test/e2e/fixtures/clangd-stub/extension.js`

- [ ] **Step 1: Add the E2E dependencies and scripts**

Add `@vscode/test-electron`, `mocha`, and `@types/mocha` as dev dependencies. Add scripts:

```json
"test:e2e": "npm run compile && node dist/test/e2e/runTest.js",
"test:all": "npm test && npm run test:e2e"
```

Run `npm install --save-dev @vscode/test-electron@3.1.0 mocha @types/mocha` and verify only the intended manifest/lockfile changes occur.

- [ ] **Step 2: Add the fake CLI and dependency stub**

The fake CLI writes its `process.argv.slice(2).join(" ")` to `process.env.MCPP_E2E_LOG`, exits zero for `build`, and exits one for no other unneeded command. The stub package id is `llvm-vs-code-extensions.vscode-clangd`, its activation registers `clangd.restart`, and it has no external process behavior. `runTest.ts` copies/chmods the fake CLI and places the stub under an isolated extensions directory with a versioned folder name.

- [ ] **Step 3: Add the Extension Host runner and suite**

`runTest.ts` calls `runTests` with the compiled extension root, compiled suite path, fixture workspace, `--user-data-dir`, `--extensions-dir`, `--disable-updates`, `--skip-welcome`, and `--disable-workspace-trust` launch args. Set `MCPP_E2E_FAKE_MCPP` and `MCPP_E2E_LOG` through `extensionTestsEnv`.

The suite activates the mcpp extension, asserts `mcpp.build` and `mcpp.autoConfigureModules` are registered, writes workspace-scoped `mcpp.path` to the fake executable, executes `mcpp.build`, waits for the log file, and asserts the recorded argv is exactly `build`.

- [ ] **Step 4: Run E2E locally and fix only harness issues**

Run: `npm run test:e2e`

Expected: VS Code downloads once, the Extension Host exits zero, and the suite reports all smoke cases passing. A missing display must be handled by running `xvfb-run -a npm run test:e2e`; do not weaken the test to skip activation.

## Task 6: Add PR CI

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `test/artifacts.test.ts` if workflow assertions are useful

- [ ] **Step 1: Add workflow source assertions**

Add tests that parse `.github/workflows/ci.yml` as text and assert `pull_request`, `push` to `main`, `npm ci`, `npm test`, `npm run package`, `npm run test:e2e`, `xvfb-run`, `contents: read`, and a concurrency group are present. Keep the release workflow test unchanged.

- [ ] **Step 2: Implement the two-job workflow**

Use Node 22 and `actions/checkout@v4`/`actions/setup-node@v4`. The `unit-and-package` job runs `npm ci`, `npm test`, `npm run package`, and checks the generated VSIX. The `extension-host-e2e` job runs `npm ci`, then `xvfb-run -a npm run test:e2e`. Set `permissions: contents: read` and cancel superseded runs per PR/ref.

- [ ] **Step 3: Run local workflow-adjacent verification**

Run: `npm test && npm run package && npm run test:e2e` (with `xvfb-run -a` when needed), then `git diff --check` and `git status --short`.

Expected: both local jobs' command sequences pass, the VSIX remains valid, and no unrelated files are modified.

## Task 7: Final Verification And Commits

- [ ] **Step 1: Run the complete local command**

Run: `npm run test:all` (prefix the E2E command with `xvfb-run -a` on headless Linux), followed by `npm run package` and `unzip -t mcpp-vscode-*.vsix`.

- [ ] **Step 2: Review the diff against the approved specs**

Check that #6 has one modal only, never edits project manifests, reloads context after build, and keeps manual commands unchanged. Check that #7 adds only PR/main CI and deterministic smoke dependencies.

- [ ] **Step 3: Commit in focused changes**

```bash
git add src/moduleSetup.ts test/moduleSetup.test.ts src/cliController.ts src/extension.ts test/artifacts.test.ts README.md
git commit -m "feat: make module setup one click"

git add package.json package-lock.json test/e2e .github/workflows/ci.yml test/artifacts.test.ts
git commit -m "test: add pull request extension checks"
```

Do not push or create a PR until the user requests that integration step.
