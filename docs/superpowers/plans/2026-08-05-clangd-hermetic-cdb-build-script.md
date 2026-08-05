# Clangd Hermetic CDB and build.mcpp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove false clangd diagnostics from hermetic mcpp projects, keep module checks on project sources, and prevent clangd from treating `build.mcpp` as an ordinary C++ translation unit.

**Architecture:** Keep clangd's query-driver discovery for ordinary or cross-toolchain CDBs, but skip it when the selected mcpp command already declares a no-default-config sysroot and standard library. Give `build.mcpp` its own language id backed by the C++ TextMate grammar so syntax highlighting remains while the official clangd extension no longer claims the document. Rank real project sources above `.mcpp` dependency-cache and `target` commands for the extension's direct module check.

**Tech Stack:** TypeScript 5.9, VS Code extension manifests and TextMate grammars, Node.js built-in test runner, clangd 22.1.8, VSCE.

---

### Task 1: Preserve hermetic compilation commands

**Files:**
- Modify: `src/analysis.ts`
- Modify: `src/extension.ts`
- Test: `test/analysis.test.ts`

- [x] **Step 1: Write the failing hermetic CDB argument tests**

Add tests that pass the selected CDB arguments through `buildClangdArguments`. A command containing `--no-default-config`, `-nostdinc++`, an explicit `-isystem.../include/c++/v1`, and `--sysroot=...` must remove a previously managed `--query-driver`; an ordinary command must still receive the selected compiler as its query driver.

- [x] **Step 2: Run the analysis test and verify RED**

Run: `npm run compile && node --test dist/test/analysis.test.js`

Expected: the hermetic test fails because the current implementation always appends `--query-driver`.

- [x] **Step 3: Implement the minimum query-driver policy**

Add `compilationArguments?: readonly string[]` to `ClangdArgumentOptions`. Treat a command as self-contained only when all four hermetic markers are present, remove managed query-driver arguments, and append the selected compiler only for non-self-contained commands. Pass `context.analysis.arguments` from both the workspace configuration path and direct `clangd --check` path in `src/extension.ts`.

- [x] **Step 4: Run the focused tests and verify GREEN**

Run: `npm run compile && node --test dist/test/analysis.test.js`

Expected: all analysis tests pass.

### Task 2: Select a project-owned module check source

**Files:**
- Modify: `src/analysis.ts`
- Test: `test/analysis.test.ts`

- [x] **Step 1: Write the failing dependency-cache ranking test**

Create a CDB fixture whose first LLVM command points to `/work/app/.mcpp/.../transaction.cpp` with PCM flags and whose later command points to `/work/app/src/main.cpp` with the same flags. Assert that `analyzeCompilationDatabase` selects `/work/app/src/main.cpp`.

- [x] **Step 2: Run the focused test and verify RED**

Run: `npm run compile && node --test dist/test/analysis.test.js`

Expected: the new test selects the `.mcpp` command and fails.

- [x] **Step 3: Implement project-source ranking**

Keep the existing in-project and module-interface scoring, but add a higher score for paths below the command directory whose first component is neither `.mcpp` nor `target`. Preserve the existing fallback when a CDB contains only dependency or generated commands.

- [x] **Step 4: Run the focused tests and verify GREEN**

Run: `npm run compile && node --test dist/test/analysis.test.js`

Expected: all analysis tests pass and the selected UChat check source is a member source file.

### Task 3: Make build.mcpp syntax-only

**Files:**
- Modify: `package.json`
- Create: `syntaxes/mcpp-build.tmLanguage.json`
- Create: `syntaxes/mcpp-build-language-configuration.json`
- Modify: `test/artifacts.test.ts`
- Modify: `README.md`

- [x] **Step 1: Write the failing manifest and grammar tests**

Assert that the manifest declares exact filename language `mcpp-build`, that `files.associations` no longer maps `build.mcpp` to `cpp`, and that the new grammar maps `mcpp-build` to `source.mcpp-build` and includes the external `source.cpp` grammar. Keep the assertion that no broad `*.mcpp` association exists.

- [x] **Step 2: Run the artifact tests and verify RED**

Run: `npm run compile && node --test dist/test/artifacts.test.js`

Expected: the manifest still maps `build.mcpp` to `cpp`, so the new assertions fail.

- [x] **Step 3: Implement the custom language**

Register `mcpp-build` with `filenames: ["build.mcpp"]`, a C++-style language configuration, and a TextMate grammar whose root scope is `source.mcpp-build` and whose patterns include `source.cpp`. Remove only the exact `build.mcpp -> cpp` default; keep `.cppm`, `.ixx`, `.mpp`, and `.ccm` associated with `cpp`. Add `onLanguage:mcpp-build` activation.

- [x] **Step 4: Document the semantic boundary**

Update README wording so `build.mcpp` is described as C++-style syntax highlighting without clangd diagnostics, while real C++ module files continue to use clangd. Explain that semantic support for `import mcpp;` requires a future mcpp-generated host-helper CDB and PCM mapping.

- [x] **Step 5: Run the artifact tests and verify GREEN**

Run: `npm run compile && node --test dist/test/artifacts.test.js`

Expected: all artifact tests pass.

### Task 4: Version, full verification, package, install, and tag

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`

- [x] **Step 1: Bump the extension version**

Run: `npm version 0.2.4 --no-git-tag-version`

Add a `0.2.4` changelog entry covering hermetic query-driver handling, project-source checks, and syntax-only `build.mcpp` handling.

- [x] **Step 2: Run the full regression suite**

Run: `npm test`

Expected: all tests pass with zero failures.

- [x] **Step 3: Reproduce the original UChat clangd symptom**

Run matching clangd 22.1.8 against each UChat `RedisMgr.cpp` using its member CDB and the arguments produced by the fixed policy. Confirm there are no `template_instantiate_undefined`, `ovl_no_viable_function_in_call`, SDK type, or module ODR diagnostics.

- [x] **Step 4: Package and inspect the VSIX**

Run: `npm run package`

Expected: `mcpp-vscode-0.2.4.vsix` is created. Inspect its manifest and archive contents to confirm the new language grammar and configuration are included.

- [x] **Step 5: Commit only the repair files**

Stage the plan, source, focused tests, manifest, lockfile, grammar, README, and changelog files. Do not stage pre-existing modified or untracked design documents. Commit as `fix: preserve hermetic clangd configuration`.

- [x] **Step 6: Create the local release tag**

Create annotated tag `v0.2.4` on the verified repair commit. Do not push it or create a GitHub Release.

- [x] **Step 7: Install and verify the packaged extension**

Run: `code --install-extension /Users/cltx/projects/mcpp/mcpp-vscode/mcpp-vscode-0.2.4.vsix --force`

Then run `code --list-extensions --show-versions` and verify `mcpp-community.mcpp-vscode@0.2.4`. A VS Code window reload is required before the new language registration and clangd arguments take effect.
