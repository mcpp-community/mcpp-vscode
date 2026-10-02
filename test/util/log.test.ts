import assert from "node:assert/strict";
import test from "node:test";

import { createLogger, isLogLevel, logLevelOf, shouldLog } from "../../src/util/log";

test("错误永远不被任何 mcpp.log.level 抑制", () => {
  for (const configured of ["error", "warn", "info", "debug", "nonsense", undefined]) {
    assert.equal(shouldLog("error", configured), true, `error must pass at ${String(configured)}`);
  }
});

test("threshold: 每个级别只写自己不高于配置的级别", () => {
  assert.equal(shouldLog("error", "error"), true);
  assert.equal(shouldLog("warn", "error"), false);
  assert.equal(shouldLog("info", "error"), false);
  assert.equal(shouldLog("debug", "error"), false);

  assert.equal(shouldLog("error", "warn"), true);
  assert.equal(shouldLog("warn", "warn"), true);
  assert.equal(shouldLog("info", "warn"), false);
  assert.equal(shouldLog("debug", "warn"), false);

  // `info` is the declared default: the verbose command echo is hidden.
  assert.equal(shouldLog("info", "info"), true);
  assert.equal(shouldLog("debug", "info"), false);

  assert.equal(shouldLog("debug", "debug"), true);
});

test("未知配置回退 info，而不是静音频道", () => {
  assert.equal(logLevelOf("chatty"), "info");
  assert.equal(logLevelOf(undefined), "info");
  assert.equal(logLevelOf(2), "info");
  assert.equal(isLogLevel("debug"), true);
  assert.equal(isLogLevel("verbose"), false);
  assert.equal(shouldLog("info", "chatty"), true);
  assert.equal(shouldLog("debug", "chatty"), false);
});

test("createLogger 逐行读取级别，并在频道已释放时静默", () => {
  const lines: string[] = [];
  let level = "warn";
  const logger = createLogger({ appendLine: (line) => lines.push(line) }, () => level);

  logger.debug("d");
  logger.info("i");
  logger.warn("w");
  logger.error("e");
  assert.deepEqual(lines, ["w", "e"]);

  // A configuration change applies to the next line, without re-creating the logger.
  level = "debug";
  logger.debug("d2");
  assert.deepEqual(lines, ["w", "e", "d2"]);

  // A disposed output channel is a no-op, never an error.
  const disposed = createLogger({
    appendLine: () => {
      throw new Error("channel disposed");
    },
  }, () => "debug");
  assert.doesNotThrow(() => disposed.error("e"));
});
