// mcpp.toml 契约测试：用真实 mcpp 二进制验证扩展手写的 manifest 语义
// （段头清单、模板键、条件段规则）与权威 parser 一致。
//
// 没有 mcpp 的环境整个文件 skip。mcpp 调用每次 60s 超时，全程串行。

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { SECTION_HEADERS, type SectionHeaderSpec } from "../src/mcppTomlCompletion";

/** 探测 mcpp 是否可用；不可用则全部跳过。 */
function detectMcpp(): string | undefined {
  try {
    const result = spawnSync("mcpp", ["--version"], { timeout: 10_000 });
    if (result.error !== undefined || result.status !== 0) {
      return undefined;
    }
    return String(result.stdout).trim();
  } catch {
    return undefined;
  }
}

const mcppVersion = detectMcpp();
const skipReason = mcppVersion === undefined ? "未检测到 mcpp 二进制，跳过契约测试" : false;
if (skipReason !== false) {
  console.log(skipReason);
} else {
  console.log(`契约测试使用 ${mcppVersion}`);
}

const MCPP_TIMEOUT_MS = 60_000;

interface McppRun {
  code: number;
  output: string;
}

/** 在指定工程目录串行执行 `mcpp build`，汇总 stdout+stderr。 */
function runMcppBuild(projectDir: string): Promise<McppRun> {
  return new Promise((resolve, reject) => {
    const child = spawn("mcpp", ["build"], { cwd: projectDir, timeout: MCPP_TIMEOUT_MS });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`mcpp build 被信号 ${signal} 终止（疑似超时）：\n${output}`));
        return;
      }
      resolve({ code: code ?? -1, output });
    });
  });
}

/** 每次新建唯一临时工程目录，注册到清理列表。 */
const tempDirs: string[] = [];
function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpp-contract-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "main.cpp"), "int main() { return 0; }\n");
  return dir;
}

process.on("exit", () => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const BASE_MANIFEST = '[package]\nname = "probe"\nversion = "0.1.0"\n';

/** 写 manifest（基线 + 附加内容）与额外卖文件，然后跑 mcpp build。 */
function buildWith(extraManifest: string, files: Record<string, string> = {}): Promise<McppRun> {
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, "mcpp.toml"), `${BASE_MANIFEST}\n${extraManifest}`);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return runMcppBuild(dir);
}

/** 核心断言：构建成功且输出无 unsupported / error（大小写不敏感）。 */
function assertClean(run: McppRun, what: string): void {
  assert.equal(run.code, 0, `${what}：mcpp build 退出码 ${run.code}\n${run.output}`);
  assert.ok(
    !/unsupported|error/i.test(run.output),
    `${what}：输出含 unsupported/error 诊断\n${run.output}`,
  );
}

/**
 * 把段头注册表条目变成可构建的具体 manifest 片段。
 * snippet 占位符取默认值（如 [targets.${1:name}] → [targets.name]）。
 */
function fixtureFor(entry: SectionHeaderSpec): { manifest: string; files: Record<string, string> } {
  const header = entry.header.replace(/\$\{\d+:([^}]*)\}/g, "$1");
  assert.ok(!header.includes("$"), `段头 ${entry.label} 的占位符未能全部展开`);
  if (entry.group === "package") {
    // [package] 永远在基线工程里，直接验证基线本身。
    return { manifest: "", files: {} };
  }
  if (entry.group === "targets") {
    // [targets.<name>] 需要 kind；kind = "lib" 需要 src/<name>.cppm 消除 lib-root 警告。
    return {
      manifest: `${header}\nkind = "lib"\n`,
      files: { "src/name.cppm": "export module name;\n" },
    };
  }
  return { manifest: `${header}\n`, files: {} };
}

test("段头注册表形态：数量与关键段齐全（防止测试与实现脱节）", { skip: skipReason }, () => {
  assert.ok(SECTION_HEADERS.length >= 20, `段头注册表只有 ${SECTION_HEADERS.length} 条（期望 ≥ 20）`);
  const groups = new Set(SECTION_HEADERS.map((entry) => entry.group));
  for (const key of ["package", "dependencies", "workspace", "pack"]) {
    assert.ok(groups.has(key), `段头注册表缺少关键段 ${key}`);
  }
  const labels = SECTION_HEADERS.map((entry) => entry.label);
  assert.equal(new Set(labels).size, labels.length, "段头注册表存在重复 label");
});

test("段头清单契约：每个注册段 mcpp 都接受、无诊断", { skip: skipReason, timeout: 600_000 }, async (t) => {
  for (const entry of SECTION_HEADERS) {
    await t.test(entry.label, async () => {
      const fixture = fixtureFor(entry);
      const run = await buildWith(fixture.manifest, fixture.files);
      assertClean(run, `段 ${entry.label}`);
    });
  }
});

test("[indices] 带 path 条目被接受（项目级索引重定向）", { skip: skipReason, timeout: 120_000 }, async () => {
  const run = await buildWith('[indices]\nmyidx = { path = "/tmp/mcpp-contract-nonexistent-index" }\n');
  assertClean(run, "[indices] 索引重定向");
});

// 依赖 spec 的 12 个键：与 src/mcppTomlCompletion.ts 的 DEPENDENCY_TEMPLATES
// 保持同步（模板未逐一列出键名，此处按 mcpp manifest schema 硬编码）。
// 注意：features/backend/tools/host-module/reexport 不是「锚定键」——单独出现
// 时 mcpp 会把内联表当成嵌套依赖表报错，必须搭配 version/path/git/workspace
// 之一；tag/branch/rev 则必须搭配 git。写在 [feature-deps.<name>] 下只解析、
// 不下载（feature 未激活），适合断言「键被接受、无诊断」。
const DEP_SPEC_CASES: ReadonlyArray<readonly [string, string]> = [
  ["version", 'dep = { version = "1.0.0" }'],
  ["path", 'dep = { path = "../x" }'],
  ["git+tag", 'dep = { git = "https://example.com/r.git", tag = "v1" }'],
  ["git+branch", 'dep = { git = "https://example.com/r.git", branch = "main" }'],
  ["git+rev", 'dep = { git = "https://example.com/r.git", rev = "abc123" }'],
  ["features", 'dep = { version = "1.0.0", features = ["f"] }'],
  ["backend", 'dep = { version = "1.0.0", backend = "cmake" }'],
  ["tools", 'dep = { version = "1.0.0", tools = ["t"] }'],
  ["host-module", 'dep = { version = "1.0.0", host-module = true }'],
  ["reexport", 'dep = { version = "1.0.0", reexport = true }'],
  ["workspace", "dep = { workspace = true }"],
];

test("模板键契约：[feature-deps] 下依赖 spec 各键被接受", { skip: skipReason, timeout: 600_000 }, async (t) => {
  for (const [name, spec] of DEP_SPEC_CASES) {
    await t.test(name, async () => {
      const run = await buildWith(`[feature-deps.f1]\n${spec}\n`);
      assertClean(run, `[feature-deps.f1] 依赖 spec 键 ${name}`);
    });
  }
});

test("模板键契约：[features] 表形式与数组简写被接受", { skip: skipReason, timeout: 120_000 }, async () => {
  const run = await buildWith([
    "[features]",
    'f1 = { defines = ["X"], implies = [], sources = ["src/**"] }',
    'f2 = ["f1"]',
    'f3 = { requires = ["blas"] }',
    "",
  ].join("\n"));
  assertClean(run, "[features] 表形式键");
});

// 其余写法模板的完整实例（依赖/feature 之外的模板条目）。capabilities 的
// provider 绑定在「无包 require 该能力」时不解析，静默通过；generated_files
// 的条目会在源 glob 展开前写入工程树，这里同时验证生成机制生效（编译成功
// 即说明模块文件被正常纳入构建）。
test("模板实例契约：capabilities / xlings / tools.overrides / generated_files", { skip: skipReason, timeout: 120_000 }, async () => {
  const run = await buildWith(
    [
      "[capabilities]",
      'blas = "compat.openblas"',
      "",
      "[xlings.workspace]",
      'clang = "20.1.7"',
      "",
      "[xlings.envs]",
      'FOO = "1"',
      "",
      "[tools.overrides]",
      '"compat.protobuf:protoc" = "/usr/bin/protoc"',
      "",
      "[generated_files]",
      '"src/gen/wrap.cppm" = """',
      "export module wrap;",
      '"""',
      "",
    ].join("\n"),
  );
  assertClean(run, "模板实例（capabilities/xlings/tools.overrides/generated_files）");
});

test("条件段规则：[target.'cfg(windows)'.build] 接受 build inputs", { skip: skipReason, timeout: 120_000 }, async () => {
  const run = await buildWith("[target.'cfg(windows)'.build]\ndefines = [\"A=1\"]\n");
  assertClean(run, "条件段 build inputs");
});

test("条件段规则：反向断言——cache 在条件段必须报 unsupported", { skip: skipReason, timeout: 120_000 }, async () => {
  // 钉住「条件段只接受 build inputs」：cache 属于 profile 设置，必须告警。
  const run = await buildWith("[target.'cfg(windows)'.build]\ncache = \"off\"\n");
  assert.equal(run.code, 0, `条件段 cache：mcpp build 退出码 ${run.code}\n${run.output}`);
  assert.ok(
    /unsupported key 'cache'/i.test(run.output),
    `条件段 cache：期望 unsupported-key 警告\n${run.output}`,
  );
});
