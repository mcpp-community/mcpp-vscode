import assert from "node:assert/strict";
import test from "node:test";

import {
  SCHEMA,
  keyOf,
  schemaSource,
  sectionByHeader,
  sectionByName,
  sectionProblems,
} from "../../src/toml/schema";

test("the generated schema loads and every section header matches its name", () => {
  assert.ok(SCHEMA.sections.length > 0, "the snapshot is empty");
  for (const section of SCHEMA.sections) {
    assert.equal(section.header, `[${section.name}]`, section.name);
  }
});

test("the snapshot is internally consistent", () => {
  assert.deepEqual(sectionProblems(), []);
});

test("the snapshot records which mcpp produced it", () => {
  const source = schemaSource();
  assert.match(source.version, /^\d+(\.\d+)+$/, source.version);
  assert.notEqual(source.commit, "");
  assert.equal(source.version, SCHEMA.sourceVersion);
  assert.equal(source.commit, SCHEMA.sourceCommit);
});

test("section lookup accepts both the header and the bare name", () => {
  const byHeader = sectionByHeader("[package]");
  assert.ok(byHeader);
  assert.equal(byHeader.name, "package");
  assert.equal(sectionByHeader("package"), byHeader);
  assert.equal(sectionByName("build")?.header, "[build]");
  // An array table is not a section.
  assert.equal(sectionByHeader("[[package]]"), undefined);
  assert.equal(sectionByName("does-not-exist"), undefined);
});

test("planes come from SPEC-004 §2 and legacy sections name their replacement", () => {
  assert.equal(sectionByName("package")?.plane, "identity");
  assert.equal(sectionByName("lib")?.plane, "artifact");
  assert.equal(sectionByName("targets")?.plane, "artifact");
  assert.equal(sectionByName("build")?.plane, "compile");
  assert.equal(sectionByName("profile")?.plane, "compile");
  assert.equal(sectionByName("dependencies")?.plane, "dependency");
  assert.equal(sectionByName("xlings")?.plane, "tool");
  assert.equal(sectionByName("features")?.plane, "gate");
  assert.equal(sectionByName("target")?.plane, "condition");
  assert.equal(sectionByName("runtime")?.plane, "metadata");
  assert.equal(sectionByName("hooks")?.plane, "lifecycle");
  assert.equal(sectionByName("language")?.deprecatedBy, "[package].standard");
});

test("the snapshot carries a doc anchor for sections docs/04 documents", () => {
  assert.equal(
    sectionByName("package")?.doc,
    "https://github.com/mcpp-community/mcpp/blob/main/docs/04-mcpp-toml.md#21-package--package-metadata",
  );
  assert.match(sectionByName("build")?.doc ?? "", /#23-build--build-configuration$/);
});

test("enums carry the values the docs list", () => {
  const standard = keyOf("package", "standard");
  assert.equal(standard?.type, "enum");
  assert.equal(standard?.default, "c++23");
  for (const value of ["c++20", "c++23", "c++26"]) {
    assert.ok(standard?.values?.includes(value), value);
  }
  assert.deepEqual(keyOf("targets", "kind")?.values, ["bin", "lib", "shared", "app"]);
  assert.deepEqual(keyOf("build", "bmi_schedule")?.values, ["auto", "on", "off"]);
  assert.deepEqual(keyOf("build", "cache")?.values, ["global", "local", "off"]);
  assert.deepEqual(keyOf("profile", "opt")?.values, ["s", "z"]);
  assert.ok(keyOf("toolchain", "family")?.values?.includes("gcc"));
  assert.equal(keyOf("language", "standard")?.legacy, true);
  assert.equal(keyOf("build", "static_stdlib")?.legacy, true);
  assert.equal(keyOf("package", "does-not-exist"), undefined);
});

test("a section that carries a key table carries a non-empty, typed one", () => {
  const types = new Set(["string", "boolean", "number", "array", "enum"]);
  for (const section of SCHEMA.sections) {
    if (section.keys === undefined) {
      continue;
    }
    assert.ok(section.keys.length > 0, section.header);
    for (const key of section.keys) {
      assert.notEqual(key.key, "", section.header);
      assert.ok(types.has(key.type), `${section.header} ${key.key} has type ${key.type}`);
      if (key.type === "enum") {
        assert.ok((key.values?.length ?? 0) > 0, `${section.header} ${key.key} has no values`);
      }
    }
  }
});
