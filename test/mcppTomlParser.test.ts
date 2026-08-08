import assert from "node:assert/strict";
import test from "node:test";

import {
  contextAt,
  parseMcppToml,
  resolveSection,
  type TomlKeyValueNode,
  type TomlSectionNode,
} from "../src/mcppTomlParser";

function sectionAt(lines: string[], index: number): TomlSectionNode {
  const node = parseMcppToml(lines).nodes[index];
  assert.equal(node?.type, "section");
  return node as TomlSectionNode;
}

function keyValueAt(lines: string[], index: number): TomlKeyValueNode {
  const node = parseMcppToml(lines).nodes[index];
  assert.equal(node?.type, "keyValue");
  return node as TomlKeyValueNode;
}

// ---- 段头解析 ----

test("解析普通段头及其范围", () => {
  const section = sectionAt(["[package]"], 0);
  assert.deepEqual(section.segments.map((s) => s.name), ["package"]);
  assert.equal(section.segments[0].quoted, false);
  assert.equal(section.isArray, false);
  assert.equal(section.open, false);
  assert.equal(section.line, 0);
  assert.deepEqual(section.range, { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 9 });
  assert.deepEqual(section.segments[0].range, { startLine: 0, startCharacter: 1, endLine: 0, endCharacter: 8 });
});

test("解析参数化段头 [targets.myapp]", () => {
  const section = sectionAt(["[targets.myapp]"], 0);
  assert.deepEqual(section.segments.map((s) => s.name), ["targets", "myapp"]);
  assert.deepEqual(section.segments[1].range, { startLine: 0, startCharacter: 9, endLine: 0, endCharacter: 14 });
});

test("解析单引号段 [target.'cfg(windows)'.build]", () => {
  const section = sectionAt(["[target.'cfg(windows)'.build]"], 0);
  assert.deepEqual(section.segments.map((s) => s.name), ["target", "cfg(windows)", "build"]);
  assert.equal(section.segments[1].quoted, true);
  assert.deepEqual(section.segments[1].range, { startLine: 0, startCharacter: 8, endLine: 0, endCharacter: 22 });
});

test("解析双引号段 [runtime.\"opengl.glx.driver\"]（带点的段名是一段）", () => {
  const section = sectionAt(['[runtime."opengl.glx.driver"]'], 0);
  assert.deepEqual(section.segments.map((s) => s.name), ["runtime", "opengl.glx.driver"]);
  assert.equal(section.segments[1].quoted, true);
  assert.deepEqual(section.segments[1].range, { startLine: 0, startCharacter: 9, endLine: 0, endCharacter: 28 });
});

test("解析数组表段头 [[build.flags]]", () => {
  const section = sectionAt(["[[build.flags]]"], 0);
  assert.equal(section.isArray, true);
  assert.equal(section.open, false);
  assert.deepEqual(section.segments.map((s) => s.name), ["build", "flags"]);
  assert.deepEqual(section.range, { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 15 });
});

test("未闭合段头解析为 open 状态且不抛错", () => {
  const document = parseMcppToml(["[dep", 'name = "x"']);
  const section = document.nodes[0] as TomlSectionNode;
  assert.equal(section.type, "section");
  assert.equal(section.open, true);
  assert.deepEqual(section.segments.map((s) => s.name), ["dep"]);
  // 后续行继续正常解析。
  const keyValue = document.nodes[1] as TomlKeyValueNode;
  assert.equal(keyValue.type, "keyValue");
  assert.deepEqual(keyValue.keyPath.map((s) => s.name), ["name"]);
});

// ---- 键值解析 ----

test("解析裸键字符串键值对及其范围", () => {
  const keyValue = keyValueAt(["[package]", 'name = "demo"'], 1);
  assert.deepEqual(keyValue.keyPath.map((s) => s.name), ["name"]);
  assert.deepEqual(keyValue.keyPath[0].range, { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 4 });
  assert.equal(keyValue.value?.kind, "string");
  assert.equal(keyValue.value?.open, false);
  assert.equal(keyValue.value?.text, "demo");
  assert.deepEqual(keyValue.value?.range, { startLine: 1, startCharacter: 7, endLine: 1, endCharacter: 13 });
  assert.deepEqual(keyValue.value?.contentRange, { startLine: 1, startCharacter: 8, endLine: 1, endCharacter: 12 });
});

test("解析引号键（键名带点仍是一段）", () => {
  const keyValue = keyValueAt(['"chriskohlhoff.asio" = "1.28"'], 0);
  assert.equal(keyValue.keyPath.length, 1);
  assert.equal(keyValue.keyPath[0].name, "chriskohlhoff.asio");
  assert.equal(keyValue.keyPath[0].quoted, true);
  assert.equal(keyValue.value?.text, "1.28");
});

test("解析点分键 capi.lua", () => {
  const keyValue = keyValueAt(['capi.lua = "1.0"'], 0);
  assert.deepEqual(keyValue.keyPath.map((s) => s.name), ["capi", "lua"]);
  assert.deepEqual(keyValue.keyPath[1].range, { startLine: 0, startCharacter: 5, endLine: 0, endCharacter: 8 });
});

test("解析整数与布尔值", () => {
  const integer = keyValueAt(["opt = 2"], 0);
  assert.equal(integer.value?.kind, "integer");
  assert.equal(integer.value?.text, "2");
  assert.deepEqual(integer.value?.range, { startLine: 0, startCharacter: 6, endLine: 0, endCharacter: 7 });

  const boolean = keyValueAt(["debug = true"], 0);
  assert.equal(boolean.value?.kind, "boolean");
  assert.equal(boolean.value?.text, "true");
  assert.deepEqual(boolean.value?.range, { startLine: 0, startCharacter: 8, endLine: 0, endCharacter: 12 });
});

test("解析跨行数组", () => {
  const keyValue = keyValueAt(["sources = [", '  "a",', '  "b",', "]"], 0);
  assert.equal(keyValue.value?.kind, "array");
  assert.equal(keyValue.value?.open, false);
  assert.deepEqual(keyValue.value?.range, { startLine: 0, startCharacter: 10, endLine: 3, endCharacter: 1 });
  assert.deepEqual(keyValue.value?.elements?.map((element) => element.text), ["a", "b"]);
});

test("未闭合数组解析为 open 状态", () => {
  const keyValue = keyValueAt(["flags = [ { glob = \"x\" },"], 0);
  assert.equal(keyValue.value?.kind, "array");
  assert.equal(keyValue.value?.open, true);
  assert.equal(keyValue.value?.elements?.length, 1);
  assert.equal(keyValue.value?.elements?.[0].kind, "inlineTable");
});

test("解析嵌套内联表", () => {
  const keyValue = keyValueAt(['dep = { version = "1", opts = { a = 1 } }'], 0);
  assert.equal(keyValue.value?.kind, "inlineTable");
  assert.equal(keyValue.value?.open, false);
  const entries = keyValue.value?.entries ?? [];
  assert.deepEqual(entries.map((entry) => entry.keyPath.map((s) => s.name)), [["version"], ["opts"]]);
  assert.equal(entries[0].value?.kind, "string");
  assert.equal(entries[1].value?.kind, "inlineTable");
  assert.equal(entries[1].value?.entries?.[0].value?.kind, "integer");
});

test("未闭合内联表解析为 open 状态并保留已输入条目", () => {
  const keyValue = keyValueAt(['dep = { version = "1"'], 0);
  assert.equal(keyValue.value?.kind, "inlineTable");
  assert.equal(keyValue.value?.open, true);
  assert.equal(keyValue.value?.entries?.length, 1);
  assert.deepEqual(keyValue.value?.entries?.[0].keyPath.map((s) => s.name), ["version"]);
});

// ---- 注释、字符串与行尾 ----

test("注释被跳过，字符串内的 # 不算注释", () => {
  const keyValue = keyValueAt(["# 顶部注释", 'name = "a # b" # 行尾注释'], 0);
  assert.equal(keyValue.value?.kind, "string");
  assert.equal(keyValue.value?.text, "a # b");
});

test("字符串内的转义引号不结束字符串", () => {
  const keyValue = keyValueAt(['desc = "a \\"b\\" c"'], 0);
  assert.equal(keyValue.value?.kind, "string");
  assert.equal(keyValue.value?.open, false);
  assert.equal(keyValue.value?.text, 'a \\"b\\" c');
});

test("解析三引号多行字符串", () => {
  const keyValue = keyValueAt(['text = """', "hello", '"""'], 0);
  assert.equal(keyValue.value?.kind, "string");
  assert.equal(keyValue.value?.multiline, true);
  assert.equal(keyValue.value?.open, false);
  assert.equal(keyValue.value?.text, "\nhello\n");
});

test("未闭合字符串解析为 open 状态", () => {
  const keyValue = keyValueAt(['name = "hel'], 0);
  assert.equal(keyValue.value?.kind, "string");
  assert.equal(keyValue.value?.open, true);
  assert.equal(keyValue.value?.text, "hel");
});

test("CRLF 行尾被剥除，列号按剥除后计算", () => {
  const document = parseMcppToml(["[package]\r", 'name = "demo"\r']);
  const section = document.nodes[0] as TomlSectionNode;
  assert.deepEqual(section.range, { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 9 });
  const keyValue = document.nodes[1] as TomlKeyValueNode;
  assert.deepEqual(keyValue.keyPath[0].range, { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 4 });
  assert.deepEqual(keyValue.value?.contentRange, { startLine: 1, startCharacter: 8, endLine: 1, endCharacter: 12 });
});

test("无法识别的垃圾行不抛错、不中断后续解析", () => {
  const document = parseMcppToml(["!!garbage!!", "[package]"]);
  const section = document.nodes.find((node) => node.type === "section") as TomlSectionNode;
  assert.deepEqual(section.segments.map((s) => s.name), ["package"]);
});

// ---- resolveSection 段归属语义 ----

test("resolveSection 精确匹配已知段", () => {
  assert.deepEqual(resolveSection(["package"]), { kind: "known", group: "package" });
  assert.deepEqual(resolveSection(["build"]), { kind: "known", group: "build" });
  assert.deepEqual(resolveSection(["workspace", "dependencies"]), { kind: "known", group: "workspace.dependencies" });
  assert.deepEqual(resolveSection(["pack", "bundle-project"]), { kind: "known", group: "pack.bundle-project" });
  assert.deepEqual(resolveSection(["tools", "overrides"]), { kind: "known", group: "tools.overrides" });
  assert.deepEqual(resolveSection(["xlings", "envs"]), { kind: "known", group: "xlings.envs" });
});

test("resolveSection 参数化段归入基组", () => {
  assert.deepEqual(resolveSection(["targets", "myapp"]), { kind: "known", group: "targets" });
  assert.deepEqual(resolveSection(["profile", "release"]), { kind: "known", group: "profile" });
  assert.deepEqual(resolveSection(["feature-deps", "simd"]), { kind: "known", group: "feature-deps" });
  assert.deepEqual(resolveSection(["dependencies", "capi"]), { kind: "known", group: "dependencies" });
  assert.deepEqual(resolveSection(["dependencies", "capi", "lua"]), { kind: "known", group: "dependencies" });
  assert.deepEqual(resolveSection(["dev-dependencies", "ns"]), { kind: "known", group: "dev-dependencies" });
  assert.deepEqual(resolveSection(["workspace", "dependencies", "ns"]), { kind: "known", group: "workspace.dependencies" });
});

test("resolveSection target 选择器与子表递归", () => {
  assert.deepEqual(resolveSection(["target"]), { kind: "known", group: "target" });
  assert.deepEqual(resolveSection(["target", "x86_64-linux-gnu"]), { kind: "known", group: "target" });
  assert.deepEqual(resolveSection(["target", "cfg(windows)", "build"]), { kind: "known", group: "build" });
  assert.deepEqual(resolveSection(["target", "x", "feature-deps", "codegen"]), { kind: "known", group: "feature-deps" });
  assert.deepEqual(resolveSection(["target", "x", "dependencies", "capi"]), { kind: "known", group: "dependencies" });
});

test("resolveSection runtime capability 子表", () => {
  assert.deepEqual(resolveSection(["runtime"]), { kind: "known", group: "runtime" });
  assert.deepEqual(resolveSection(["runtime", "opengl.glx.driver"]), { kind: "known", group: "runtime.capability" });
});

test("resolveSection 区分未知段与文档顶部", () => {
  assert.deepEqual(resolveSection(["custom"]), { kind: "unknown", segments: ["custom"] });
  assert.deepEqual(resolveSection(["build", "flags"]), { kind: "unknown", segments: ["build", "flags"] });
  assert.deepEqual(resolveSection([]), { kind: "top" });
});

// ---- contextAt 光标上下文 ----

test("contextAt 未闭合段头内：段头上下文与替换范围", () => {
  const context = contextAt(["[tar"], 0, 4);
  assert.equal(context.kind, "section-header");
  if (context.kind !== "section-header") return;
  assert.deepEqual(context.segments, []);
  assert.equal(context.isArray, false);
  assert.deepEqual(context.replaceRange, { startCharacter: 1, endCharacter: 4 });
});

test("contextAt 段头点号之后：已解析段作为前缀", () => {
  const context = contextAt(["[targets."], 0, 9);
  assert.equal(context.kind, "section-header");
  if (context.kind !== "section-header") return;
  assert.deepEqual(context.segments, ["targets"]);
  assert.deepEqual(context.replaceRange, { startCharacter: 9, endCharacter: 9 });
});

test("contextAt 段头中间段的替换范围覆盖整个 token", () => {
  const context = contextAt(["[targets.myapp]"], 0, 11);
  assert.equal(context.kind, "section-header");
  if (context.kind !== "section-header") return;
  assert.deepEqual(context.segments, ["targets"]);
  assert.deepEqual(context.replaceRange, { startCharacter: 9, endCharacter: 14 });
});

test("contextAt 数组表段头刚输入 [[ 时", () => {
  const context = contextAt(["[["], 0, 2);
  assert.equal(context.kind, "section-header");
  if (context.kind !== "section-header") return;
  assert.equal(context.isArray, true);
  assert.deepEqual(context.segments, []);
});

test("contextAt 已知段内空行：键位置并携带段归属", () => {
  const context = contextAt(["[package]", ""], 1, 0);
  assert.equal(context.kind, "key");
  if (context.kind !== "key") return;
  assert.deepEqual(context.section, { kind: "known", group: "package" });
  assert.deepEqual(context.containerPath, []);
  assert.deepEqual(context.keyPrefix, []);
  assert.deepEqual(context.replaceRange, { startCharacter: 0, endCharacter: 0 });
});

test("contextAt 区分文档顶部与未知段", () => {
  const top = contextAt([""], 0, 0);
  assert.equal(top.kind, "key");
  if (top.kind === "key") {
    assert.deepEqual(top.section, { kind: "top" });
  }

  const unknown = contextAt(["[custom]", ""], 1, 0);
  assert.equal(unknown.kind, "key");
  if (unknown.kind === "key") {
    assert.deepEqual(unknown.section, { kind: "unknown", segments: ["custom"] });
  }
});

test("contextAt 点分键中间：keyPrefix 与替换范围", () => {
  const context = contextAt(["capi.la"], 0, 7);
  assert.equal(context.kind, "key");
  if (context.kind !== "key") return;
  assert.deepEqual(context.containerPath, []);
  assert.deepEqual(context.keyPrefix, ["capi"]);
  assert.deepEqual(context.replaceRange, { startCharacter: 5, endCharacter: 7 });
});

test("contextAt 字符串值内部：insideString 与替换范围", () => {
  const context = contextAt(['kind = "bin"'], 0, 9);
  assert.equal(context.kind, "value");
  if (context.kind !== "value") return;
  assert.deepEqual(context.keyPath, ["kind"]);
  assert.equal(context.valueKind, "string");
  assert.equal(context.insideString, true);
  assert.equal(context.stringOpen, false);
  assert.deepEqual(context.replaceRange, { startCharacter: 8, endCharacter: 11 });
});

test("contextAt 未闭合字符串内：stringOpen 为 true", () => {
  const context = contextAt(['name = "hel'], 0, 11);
  assert.equal(context.kind, "value");
  if (context.kind !== "value") return;
  assert.deepEqual(context.keyPath, ["name"]);
  assert.equal(context.valueKind, "string");
  assert.equal(context.insideString, true);
  assert.equal(context.stringOpen, true);
  assert.deepEqual(context.replaceRange, { startCharacter: 8, endCharacter: 11 });
});

test("contextAt 等号后值未开始：valueKind 为 undefined", () => {
  const context = contextAt(["kind = "], 0, 7);
  assert.equal(context.kind, "value");
  if (context.kind !== "value") return;
  assert.deepEqual(context.keyPath, ["kind"]);
  assert.equal(context.valueKind, undefined);
  assert.equal(context.insideString, false);
  assert.deepEqual(context.replaceRange, { startCharacter: 7, endCharacter: 7 });
});

test("contextAt 数组元素槽位", () => {
  const context = contextAt(["sources = [ "], 0, 12);
  assert.equal(context.kind, "value");
  if (context.kind !== "value") return;
  assert.deepEqual(context.keyPath, ["sources"]);
  assert.equal(context.valueKind, undefined);
  assert.deepEqual(context.replaceRange, { startCharacter: 12, endCharacter: 12 });
});

test("contextAt 深度下钻：features 值 → flags 数组 → 内联表条目的键位置", () => {
  const context = contextAt(["[features]", "simd = { flags = [ { "], 1, 21);
  assert.equal(context.kind, "key");
  if (context.kind !== "key") return;
  assert.deepEqual(context.section, { kind: "known", group: "features" });
  assert.deepEqual(context.containerPath, ["simd", "flags"]);
  assert.deepEqual(context.keyPrefix, []);
  assert.deepEqual(context.replaceRange, { startCharacter: 21, endCharacter: 21 });
});

test("contextAt 内联表条目的字符串值：keyPath 含下钻路径", () => {
  const context = contextAt(['dep = { version = "1.0" }'], 0, 20);
  assert.equal(context.kind, "value");
  if (context.kind !== "value") return;
  assert.deepEqual(context.keyPath, ["dep", "version"]);
  assert.equal(context.valueKind, "string");
  assert.equal(context.insideString, true);
  assert.deepEqual(context.replaceRange, { startCharacter: 19, endCharacter: 22 });
});

test("contextAt 数组内内联表条目的值：keyPath 穿过数组", () => {
  const context = contextAt(['flags = [ { glob = "src/**" } ]'], 0, 23);
  assert.equal(context.kind, "value");
  if (context.kind !== "value") return;
  assert.deepEqual(context.keyPath, ["flags", "glob"]);
  assert.equal(context.insideString, true);
  assert.deepEqual(context.replaceRange, { startCharacter: 20, endCharacter: 26 });
});

test("contextAt 布尔 token 中间：valueKind 为 boolean 且替换范围覆盖 token", () => {
  const context = contextAt(["debug = true"], 0, 9);
  assert.equal(context.kind, "value");
  if (context.kind !== "value") return;
  assert.equal(context.valueKind, "boolean");
  assert.deepEqual(context.replaceRange, { startCharacter: 8, endCharacter: 12 });
});

test("contextAt 兼容 CRLF 行尾", () => {
  const context = contextAt(["[package]\r", 'name = "demo"\r'], 1, 9);
  assert.equal(context.kind, "value");
  if (context.kind !== "value") return;
  assert.deepEqual(context.section, { kind: "known", group: "package" });
  assert.equal(context.insideString, true);
  assert.deepEqual(context.replaceRange, { startCharacter: 8, endCharacter: 12 });
});

test("contextAt 越界坐标被钳制而不抛错", () => {
  const context = contextAt(["[package]"], 99, 99);
  assert.equal(context.kind, "key");
  if (context.kind !== "key") return;
  assert.deepEqual(context.section, { kind: "known", group: "package" });
});

// ---- 回归：值槽位替换范围 / 引号停止符 / 裸值停止字符 ----

test("contextAt 光标在 = 与值 token 之间的空白上：替换整个 token", () => {
  const context = contextAt(["cmdline = true"], 0, 9);
  assert.equal(context.kind, "value");
  if (context.kind !== "value") return;
  assert.deepEqual(context.keyPath, ["cmdline"]);
  assert.equal(context.valueKind, "boolean");
  assert.deepEqual(context.replaceRange, { startCharacter: 10, endCharacter: 14 });
});

test("contextAt 光标恰在值 token 首字符：替换范围覆盖整个 token", () => {
  const context = contextAt(["cmdline = true"], 0, 10);
  assert.equal(context.kind, "value");
  if (context.kind !== "value") return;
  assert.equal(context.valueKind, "boolean");
  assert.deepEqual(context.replaceRange, { startCharacter: 10, endCharacter: 14 });
});

test("contextAt 光标在字符串 token 前的空白上：替换范围覆盖整个带引号 token", () => {
  const context = contextAt(['name = "demo"'], 0, 6);
  assert.equal(context.kind, "value");
  if (context.kind !== "value") return;
  assert.equal(context.valueKind, "string");
  assert.equal(context.insideString, false);
  assert.deepEqual(context.replaceRange, { startCharacter: 7, endCharacter: 13 });
});

test("contextAt 单引号字符串内的双引号不截断替换范围", () => {
  const context = contextAt(["s = 'a\"b'"], 0, 7);
  assert.equal(context.kind, "value");
  if (context.kind !== "value") return;
  assert.equal(context.valueKind, "string");
  assert.equal(context.insideString, true);
  assert.deepEqual(context.replaceRange, { startCharacter: 5, endCharacter: 8 });
});

test("contextAt 双引号字符串内的单引号不截断替换范围", () => {
  const context = contextAt(["s = \"a'b\""], 0, 7);
  assert.equal(context.kind, "value");
  if (context.kind !== "value") return;
  assert.equal(context.insideString, true);
  assert.deepEqual(context.replaceRange, { startCharacter: 5, endCharacter: 8 });
});

test("裸值不停在 [ / { 之外的后续结构：x = 1 [dep", () => {
  const document = parseMcppToml(["x = 1 [dep"]);
  const keyValue = document.nodes[0] as TomlKeyValueNode;
  assert.equal(keyValue.type, "keyValue");
  assert.equal(keyValue.value?.kind, "integer");
  assert.equal(keyValue.value?.text, "1");
  assert.deepEqual(keyValue.value?.range, { startLine: 0, startCharacter: 4, endLine: 0, endCharacter: 5 });
  const section = document.nodes[1] as TomlSectionNode;
  assert.equal(section.type, "section");
  assert.equal(section.open, true);
  assert.deepEqual(section.segments.map((s) => s.name), ["dep"]);
});

test("裸值在 { 前停止：y = 2 {k = 1}", () => {
  const keyValue = keyValueAt(["y = 2 {k = 1}"], 0);
  assert.equal(keyValue.value?.kind, "integer");
  assert.equal(keyValue.value?.text, "2");
  assert.deepEqual(keyValue.value?.range, { startLine: 0, startCharacter: 4, endLine: 0, endCharacter: 5 });
});
