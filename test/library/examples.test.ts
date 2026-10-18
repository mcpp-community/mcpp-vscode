import assert from "node:assert/strict";
import test from "node:test";
import { bundledExample, bundledExampleText, ExampleDocuments } from "../../src/library/examples";
import { exampleCatalog, usageLinesFor } from "../../src/library/indexModel";

test("official offline examples are real own-library tests with pinned provenance", () => {
  const argparse = bundledExample("compat.argparse")!;
  assert.equal(argparse.project, "argparse");
  assert.match(argparse.commit, /^[0-9a-f]{40}$/);
  assert.ok(argparse.files.some((file) => file.text.includes("argparse::ArgumentParser")));
  assert.deepEqual(usageLinesFor(argparse.files, "compat.argparse"), ["#include <argparse/argparse.hpp>"]);
  assert.equal(bundledExample("compat.zlib")?.project, "zlib", "prefer zlib tests over archive's incidental dependency");
  assert.equal(bundledExample("nonexistent.example"), undefined);
  const file = argparse.files[0];
  assert.equal(bundledExampleText("/" + file.path), file.text);
  assert.equal(bundledExampleText("/../../etc/passwd"), undefined);
});

test("local catalogs prefer the package's own example while preserving exact namespace matching", () => {
  const manifest = '[dependencies.compat]\nzlib = "1"';
  const catalog = exampleCatalog([{project:"archive",text:manifest,sources:["archive.cpp"]},{project:"zlib",text:manifest,sources:["zlib.cpp"]}]);
  assert.equal(catalog.get("compat.zlib")?.path,"zlib.cpp");
  assert.equal(catalog.get("foreign.zlib"), undefined);
});

test("local and bundled source documents are immutable snapshots, never editable file URIs", () => {
  const documents = new ExampleDocuments();
  const file = { path: "tests/examples/custom/tests/main.cpp", text: "int main() {}" };
  const first = documents.capture(file);
  file.text = "int main() { return 1; }";
  const second = documents.capture(file);
  assert.match(first, /^mcpp-example:/);
  assert.notEqual(first, second);
  assert.equal(documents.read(first), "int main() {}");
  assert.equal(documents.read(first.replace("snapshot=", "snapshot%3D")), "int main() {}", "VS Code URI serialization may encode query separators");
  assert.equal(documents.read(second), file.text);
});
