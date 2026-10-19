import assert from "node:assert/strict";
import test from "node:test";
import { decodeGraphExport } from "../../src/graphs/export";
test("export validates offline SVG and bounds untrusted payloads", () => {
  assert.equal(decodeGraphExport("svg", '<svg xmlns="http://www.w3.org/2000/svg"><path marker-end="url(#arrow)"/></svg>').extension, "svg");
  for (const data of ['<svg><script>alert(1)</script></svg>', '<svg onload="x()"/>', '<svg><image href="https://example.test/a"/></svg>', '<svg style="fill:url(https://example.test/a)"/>']) assert.throws(() => decodeGraphExport("svg", data));
  assert.throws(() => decodeGraphExport("svg", "x".repeat(32 * 1024 * 1024 + 1)));
  assert.throws(() => decodeGraphExport("png", "broken"));
  const png = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.write("IHDR",12); png.writeUInt32BE(20,16); png.writeUInt32BE(10,20);
  assert.equal(decodeGraphExport("png", png.toString("base64")).extension, "png");
  png.writeUInt32BE(8193,16); assert.throws(() => decodeGraphExport("png", png.toString("base64")));
});
