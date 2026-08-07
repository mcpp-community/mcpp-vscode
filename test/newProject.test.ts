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

test("接受常规项目名，前后空白忽略", () => {
  for (const name of ["hello", "hello-mcpp", "my_project", "a.b.c", "项目", "  padded  "]) {
    assert.equal(validateNewProjectName(name), undefined, `should accept: ${name}`);
  }
});
