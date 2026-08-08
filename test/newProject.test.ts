import assert from "node:assert/strict";
import test from "node:test";

import { validateNewProjectName } from "../src/newProject";

test("拒绝空值和纯空白项目名", () => {
  for (const name of ["", "   "]) {
    assert.ok(validateNewProjectName(name) !== undefined, `should reject: ${JSON.stringify(name)}`);
  }
});

test("拒绝包含路径分隔符的项目名", () => {
  for (const name of ["a/b", "a\\b", "/abs", "..\\up"]) {
    assert.ok(validateNewProjectName(name) !== undefined, `should reject: ${name}`);
  }
});

test("拒绝会被 mcpp 解析为 CLI 选项的项目名", () => {
  // 参数数组只能防 shell 注入；`-` 前缀会被 mcpp 自身解析为
  // --template、--list-templates 等选项，可能成功退出却没有创建工程。
  for (const name of ["-x", "--template", "--list-templates"]) {
    assert.ok(validateNewProjectName(name) !== undefined, `should reject: ${name}`);
  }
});

test("拒绝相对路径名 . 和 ..", () => {
  for (const name of [".", ".."]) {
    assert.ok(validateNewProjectName(name) !== undefined, `should reject: ${name}`);
  }
});

test("拒绝双引号和控制字符，避免破坏 mcpp 生成的 TOML 和 C++ 源码", () => {
  // mcpp 模板把项目名直接写进 mcpp.toml 的 name = "{}" 和 main.cpp，
  // 不做 TOML/C++ 转义，这些输入会生成坏工程。
  for (const name of ['bad"name', "bad\tname", "bad\nname", "bad\rname", "bad\u001Fname", "bad\u007Fname"]) {
    assert.ok(validateNewProjectName(name) !== undefined, `should reject: ${JSON.stringify(name)}`);
  }
});

test("按跨平台策略拒绝 Windows 保留字符、设备名和尾随点", () => {
  for (const name of ["a<b", "a>b", "a:b", "a|b", "a?b", "a*b", "name."]) {
    assert.ok(validateNewProjectName(name) !== undefined, `should reject: ${name}`);
  }
  for (const name of ["CON", "con", "PRN", "AUX", "NUL", "COM1", "com9", "LPT1"]) {
    assert.ok(validateNewProjectName(name) !== undefined, `should reject: ${name}`);
  }
});

test("接受常规项目名，前后空白忽略", () => {
  for (const name of ["hello", "hello-mcpp", "my_project", "a.b.c", "项目", "console", "com10", "  padded  "]) {
    assert.equal(validateNewProjectName(name), undefined, `should accept: ${name}`);
  }
});
