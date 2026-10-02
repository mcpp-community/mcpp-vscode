import assert from "node:assert/strict";
import test from "node:test";

import {
  McppOperationRegistry,
  classifyTaskExit,
  projectTaskPlan,
  shouldRefreshLanguageServerAfterTask,
} from "../../src/cli/tasks";

test("基础项目任务使用固定的 mcpp 参数数组", () => {
  assert.deepEqual(projectTaskPlan("build"), {
    kind: "build",
    title: "mcpp: 构建",
    args: ["build"],
  });
  assert.deepEqual(projectTaskPlan("run"), {
    kind: "run",
    title: "mcpp: 运行",
    args: ["run"],
  });
  assert.deepEqual(projectTaskPlan("test"), {
    kind: "test",
    title: "mcpp: 测试",
    args: ["test"],
  });
  assert.deepEqual(projectTaskPlan("clean"), {
    kind: "clean",
    title: "mcpp: 清理",
    args: ["clean"],
  });
});

test("只有非取消的 build 任务刷新 C++ 模块语言服务", () => {
  assert.equal(shouldRefreshLanguageServerAfterTask("build", { state: "succeeded", exitCode: 0 }), true);
  assert.equal(shouldRefreshLanguageServerAfterTask("build", { state: "failed", exitCode: 2 }), true);
  assert.equal(shouldRefreshLanguageServerAfterTask("build", { state: "cancelled" }), false);
  assert.equal(shouldRefreshLanguageServerAfterTask("build"), false);
  for (const kind of ["run", "test", "clean"] as const) {
    assert.equal(shouldRefreshLanguageServerAfterTask(kind, { state: "succeeded", exitCode: 0 }), false);
  }
});

test("退出码区分成功、失败和取消", () => {
  assert.deepEqual(classifyTaskExit(0), { state: "succeeded", exitCode: 0 });
  assert.deepEqual(classifyTaskExit(2), { state: "failed", exitCode: 2 });
  assert.deepEqual(classifyTaskExit(undefined), { state: "cancelled" });
});

test("项目任务锁和全局工具链锁互相阻塞且只接受原 token 解锁", () => {
  const registry = new McppOperationRegistry<object>();
  const first = {};
  const second = {};

  assert.equal(registry.beginProject("/work/app", first), undefined);
  assert.equal(registry.beginProject("/work/app", second), first);
  assert.equal(registry.beginProject("/work/lib", second), undefined);
  assert.notEqual(registry.beginGlobal(first), undefined);
  registry.finishGlobal(first);
  registry.finishProject("/work/lib", second);
  registry.finishProject("/work/app", second);
  registry.finishProject("/work/app", first);
  assert.equal(registry.beginGlobal(second), undefined);
  assert.equal(registry.beginProject("/work/lib", first), second);

  registry.finishProject("/work/lib", first);
  registry.finishGlobal(first);
  registry.finishGlobal(second);
  assert.equal(registry.beginProject("/work/app", second), undefined);
  registry.finishProject("/work/app", second);
  assert.equal(registry.beginGlobal(second), undefined);
});

test("查询注册表是否有活跃操作", () => {
  const registry = new McppOperationRegistry<object>();
  assert.equal(registry.hasActive(), false);

  const token = {};
  assert.equal(registry.beginProject("/a", token), undefined);
  assert.equal(registry.hasActive(), true);

  registry.finishProject("/a", token);
  assert.equal(registry.hasActive(), false);

  assert.equal(registry.beginGlobal(token), undefined);
  assert.equal(registry.hasActive(), true);

  registry.finishGlobal(token);
  assert.equal(registry.hasActive(), false);
});
