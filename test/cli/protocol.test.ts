import assert from "node:assert/strict";
import test from "node:test";

import {
  parseEnvelope,
  parseProtocolInfo,
  readData,
  supportsKind,
} from "../../src/cli/protocol";

/** The shape documented for `mcpp --protocol-version` (docs/50-machine-output.md). */
const protocolOutput = JSON.stringify({
  schemaVersion: 1,
  kind: "mcpp.protocol",
  envelope: { min: 1, max: 1 },
  kinds: { "mcpp.env": 1, "mcpp.toolchain.list": 1, "mcpp.build-database": 1 },
  commands: {
    "self env": { effects: ["read"] },
    "toolchain list": { effects: ["read"] },
    "cache clean": { effects: ["write"] },
    "emit build-database": { effects: ["read", "write"] },
  },
  mcpp: { version: "2026.9.30.2", protocol: { min: 1, max: 1 } },
});

const toolchainListOutput = JSON.stringify({
  schemaVersion: 1,
  kind: "mcpp.toolchain.list",
  kindVersion: 1,
  mcpp: { version: "2026.9.30.2", protocol: { min: 1, max: 1 } },
  data: {
    host: "x86_64-linux-gnu",
    toolchains: [{ family: "llvm", version: "22.1.8", default: true }],
    targets: [{ target: "x86_64-linux-gnu", toolchain: "llvm@22.1.8", status: "installed" }],
  },
  diagnostics: [],
  effects: [],
});

test("解析 mcpp.protocol 探测输出", () => {
  const envelope = parseEnvelope(protocolOutput);
  assert.equal(envelope?.schemaVersion, 1);
  assert.equal(envelope?.kind, "mcpp.protocol");
  assert.equal(envelope?.mcpp?.version, "2026.9.30.2");
  assert.equal(envelope?.mcpp?.protocol?.max, 1);

  const info = parseProtocolInfo(protocolOutput);
  assert.ok(info);
  assert.equal(info.mcppVersion, "2026.9.30.2");
  assert.equal(info.envelopeMax, 1);
  assert.deepEqual(info.kinds, {
    "mcpp.env": 1,
    "mcpp.toolchain.list": 1,
    "mcpp.build-database": 1,
  });
  assert.deepEqual(info.effects["emit build-database"], ["read", "write"]);
  assert.deepEqual(info.effects["cache clean"], ["write"]);
  assert.deepEqual(info.effects["self env"], ["read"]);
});

test("supportsKind 只认 mcpp 广告过的 kind", () => {
  const info = parseProtocolInfo(protocolOutput);
  assert.equal(supportsKind(info, "mcpp.env"), true);
  assert.equal(supportsKind(info, "mcpp.toolchain.list"), true);
  assert.equal(supportsKind(info, "mcpp.build-database"), true);
  assert.equal(supportsKind(info, "mcpp.why.toolchain"), false);
  assert.equal(supportsKind(info, ""), false);
  assert.equal(supportsKind(undefined, "mcpp.env"), false);
  assert.equal(supportsKind(info, "toString"), false);
});

test("解析 mcpp.toolchain.list 信封并取出 data", () => {
  const envelope = parseEnvelope(toolchainListOutput);
  assert.equal(envelope?.kind, "mcpp.toolchain.list");
  assert.equal(envelope?.kindVersion, 1);

  const data = readData<{ host: string; toolchains: Array<{ family: string }> }>(
    toolchainListOutput,
    "mcpp.toolchain.list",
  );
  assert.equal(data?.host, "x86_64-linux-gnu");
  assert.equal(data?.toolchains[0]?.family, "llvm");
  assert.equal(readData(toolchainListOutput, "mcpp.env"), undefined);

  // kind 正确但没有 data 的合法信封
  const empty = JSON.stringify({ schemaVersion: 1, kind: "mcpp.env" });
  assert.equal(readData(empty, "mcpp.env"), undefined);
});

test("未知 kind 的信封仍被识别为机读输出", () => {
  const output = JSON.stringify({ schemaVersion: 2, kind: "mcpp.future.thing", data: { x: 1 } });
  const envelope = parseEnvelope(output);
  assert.equal(envelope?.kind, "mcpp.future.thing");
  assert.equal(envelope?.schemaVersion, 2);

  assert.deepEqual(readData(output, "mcpp.future.thing"), { x: 1 });
  assert.equal(readData(output, "mcpp.env"), undefined);
  // 不是协议探测输出，不能当成 --protocol-version 的结果
  assert.equal(parseProtocolInfo(output), undefined);
});

test("人类文本、空输入都不是信封", () => {
  const human = [
    "mcpp 0.9.0",
    "usage: mcpp [command]",
    "unknown option --protocol-version",
  ].join("\n");
  assert.equal(parseEnvelope(human), undefined);
  assert.equal(parseProtocolInfo(human), undefined);
  assert.equal(readData(human, "mcpp.env"), undefined);

  assert.equal(parseEnvelope(""), undefined);
  assert.equal(parseEnvelope("   \n\n  "), undefined);
  assert.equal(parseProtocolInfo(""), undefined);
});

test("拒绝 null、数组和标量 JSON", () => {
  assert.equal(parseEnvelope("null"), undefined);
  assert.equal(parseEnvelope("[]"), undefined);
  assert.equal(parseEnvelope('[{"schemaVersion":1,"kind":"mcpp.env"}]'), undefined);
  assert.equal(parseEnvelope("42"), undefined);
  assert.equal(parseEnvelope('"mcpp.env"'), undefined);
  assert.equal(parseEnvelope("true"), undefined);
});

test("schemaVersion 与 kind 缺一不可且类型必须正确", () => {
  assert.equal(parseEnvelope('{"schemaVersion":1}'), undefined);
  assert.equal(parseEnvelope('{"kind":"mcpp.env"}'), undefined);
  assert.equal(parseEnvelope('{"schemaVersion":"1","kind":"mcpp.env"}'), undefined);
  assert.equal(parseEnvelope('{"schemaVersion":1,"kind":""}'), undefined);
  assert.equal(parseEnvelope('{"schemaVersion":1,"kind":7}'), undefined);
});

test("从前后 narration 行之间提取 JSON", () => {
  const output = [
    "warning: using the legacy text interface",
    "",
    `  ${toolchainListOutput}  `,
    "",
    "note: run mcpp self doctor",
  ].join("\n");
  const envelope = parseEnvelope(output);
  assert.equal(envelope?.kind, "mcpp.toolchain.list");
  assert.equal(readData<{ host: string }>(output, "mcpp.toolchain.list")?.host, "x86_64-linux-gnu");

  // narration 自带花括号（在 JSON 之前、之后）都不能破坏提取
  const braces = `note: merged {deps} graph\n${JSON.stringify({
    schemaVersion: 1,
    kind: "mcpp.env",
    data: { mcppVersion: "2026.9.30.2" },
  })}\ntrailing {docs} line\n`;
  assert.equal(parseEnvelope(braces)?.kind, "mcpp.env");
  assert.equal(readData<{ mcppVersion: string }>(braces, "mcpp.env")?.mcppVersion, "2026.9.30.2");
});

test("任何输入都不抛异常", () => {
  const inputs = ["{", "}", "{]", '{"schemaVersion":', "}{", "{{{{", "[{]}", "\u0000\u0001", "{\"a\":}"];
  for (const input of inputs) {
    assert.doesNotThrow(() => parseEnvelope(input));
    assert.doesNotThrow(() => parseProtocolInfo(input));
    assert.doesNotThrow(() => readData(input, "mcpp.env"));
  }
  assert.equal(parseEnvelope("{{{{"), undefined);
  // 形状坏掉的探测输出不能让调用方崩，只是"什么都没广告"
  assert.deepEqual(parseProtocolInfo('{"schemaVersion":1,"kind":"mcpp.protocol","kinds":null}'), {
    kinds: {},
    effects: {},
  });
  assert.deepEqual(
    parseProtocolInfo('{"schemaVersion":1,"kind":"mcpp.protocol","kinds":{"mcpp.env":"1"}}'),
    { kinds: {}, effects: {} },
  );
});

test("protocol 探测接受 data 内嵌的防御形状", () => {
  const nested = JSON.stringify({
    schemaVersion: 1,
    kind: "mcpp.protocol",
    data: {
      envelope: { min: 1, max: 2 },
      kinds: { "mcpp.env": 1 },
      commands: { "self env": { effects: ["read"] } },
    },
    mcpp: { version: "2026.10.1.3", protocol: { min: 1, max: 2 } },
  });
  assert.deepEqual(parseProtocolInfo(nested), {
    mcppVersion: "2026.10.1.3",
    envelopeMax: 2,
    kinds: { "mcpp.env": 1 },
    effects: { "self env": ["read"] },
  });
});
