import assert from "node:assert/strict";
import test from "node:test";

import { DIAGNOSTIC_CODES, analyseBuildScript } from "../../src/buildscript/analysis";

function codes(lines: readonly string[]): string[] {
  return analyseBuildScript(lines, "warning").map((entry) => entry.code);
}

test("a clean, realistic build script earns nothing", () => {
  const lines = [
    "import std;",
    "import mcpp;",
    "",
    "int main() {",
    '    const std::string out = std::string(mcpp::out_dir()) + "/foo.pb.cc";',
    '    mcpp::cxxflag("-DHAVE_BANNER=1");',
    '    mcpp::link_lib("m");',
    '    mcpp::link_search("vendor/lib");',
    '    mcpp::link_flag("-Wl,--version-script=gen.map");',
    '    mcpp::define("HAVE_FEATURE");',
    '    mcpp::generated("src/gen.cpp");',
    '    mcpp::include_dir("vendor/include");',
    '    mcpp::runtime_search_dir("lib");',
    '    mcpp::rerun_if_changed("config.h");',
    '    mcpp::rerun_if_env_changed("USE_FAST");',
    "    mcpp::action a;",
    '    a.id = "protoc:foo";',
    "    a.role = mcpp::roles::source;",
    '    a.arg(mcpp::dep_bin("protobuf", "protoc"))',
    '     .arg("--cpp_out=gen")',
    '     .output("gen/foo.pb.cc")',
    "     .submit();",
    "    return 0;",
    "}",
  ];
  assert.deepEqual(analyseBuildScript(lines, "warning"), []);
});

test("rule 1 flags an unknown mcpp:: name and only that", () => {
  assert.deepEqual(codes(["int main() {", '    mcpp::cxxflagk("-O2");', "}"]), [
    DIAGNOSTIC_CODES.unknownSymbol,
  ]);
  assert.deepEqual(
    codes([
      '    mcpp::cxxflag("-O2");',
      "    mcpp::roles::prepare;",
      '    mcpp::warning("x");',
      '    mcpp::xpkg_source("a", "b");',
      '    mcpp::toolchain("k", "v");',
      '    mcpp::has_feature("f");',
      '    mcpp::pack_format("dir");',
      '    mcpp::windows_subsystem("app", "windows");',
    ]),
    [],
  );
});

test("rule 1 ignores mcpp:: inside strings and comments", () => {
  assert.deepEqual(
    codes([
      '    const char* s = "mcpp::bogus";',
      "    // mcpp::bogus();",
      "    /* mcpp::bogus(); */",
      "    const char* t = R\"(mcpp::bogus;)\";",
    ]),
    [],
  );
});

test("rule 1 reports 1-based line and column, at the requested severity", () => {
  const diagnostics = analyseBuildScript(["mcpp::bogus();"], "info");
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(
    {
      code: diagnostics[0].code,
      line: diagnostics[0].line,
      startCharacter: diagnostics[0].startCharacter,
      endCharacter: diagnostics[0].endCharacter,
      severity: diagnostics[0].severity,
    },
    {
      code: DIAGNOSTIC_CODES.unknownSymbol,
      line: 1,
      startCharacter: 1,
      endCharacter: 12,
      severity: "info",
    },
  );
});

test("rule 2 flags a role spelled as a string literal", () => {
  assert.deepEqual(codes(["mcpp::action a;", 'a.role = "source";', "a.submit();"]), [
    DIAGNOSTIC_CODES.roleLiteral,
  ]);
  assert.deepEqual(codes(["mcpp::action a;", "a.role = mcpp::roles::source;", "a.submit();"]), []);
  // The frozen printf surface is allowed to spell the string (docs/30).
  assert.deepEqual(codes(['printf("mcpp:action={\\"role\\":\\"source\\"}");']), []);
});

test("rule 3 flags a prepare action with no output_dir", () => {
  assert.deepEqual(
    codes([
      "mcpp::action a;",
      "a.role = mcpp::roles::prepare;",
      'a.arg("install");',
      "a.submit();",
    ]),
    [DIAGNOSTIC_CODES.prepareNeedsOutputDir],
  );
  assert.deepEqual(
    codes([
      "mcpp::action a;",
      "a.role = mcpp::roles::prepare;",
      "a.output_dir(prefix.c_str());",
      "a.submit();",
    ]),
    [],
  );
  // The raw payload carries the same obligation.
  assert.deepEqual(codes(['printf("mcpp:action={\\"role\\":\\"prepare\\"}");']), [
    DIAGNOSTIC_CODES.prepareNeedsOutputDir,
  ]);
});

test("rule 4 flags a run path spelled in link_flag", () => {
  assert.deepEqual(codes(['mcpp::link_flag("-Wl,-rpath,$ORIGIN/../lib");']), [
    DIAGNOSTIC_CODES.rpathInLinkFlag,
  ]);
  assert.deepEqual(
    codes([
      'mcpp::link_flag("-Wl,--version-script=x.map");',
      'mcpp::runtime_search_dir("lib");',
    ]),
    [],
  );
});

test("rule 5 flags -I and -L spelled in raw flags", () => {
  assert.deepEqual(codes(['mcpp::cxxflag("-Ivendor/include");']), [DIAGNOSTIC_CODES.rawPathFlag]);
  assert.deepEqual(codes(['mcpp::link_flag("-Lvendor/lib");']), [DIAGNOSTIC_CODES.rawPathFlag]);
  assert.deepEqual(
    codes(['mcpp::include_dir("vendor/include");', 'mcpp::link_search("vendor/lib");']),
    [],
  );
});

test("rule 6 flags shell syntax in an action command", () => {
  assert.deepEqual(
    codes([
      "mcpp::action a;",
      "a.role = mcpp::roles::source;",
      'a.arg("CFLAGS=-O2").arg("make");',
      "a.submit();",
    ]),
    [DIAGNOSTIC_CODES.shellSyntaxInAction],
  );
  assert.deepEqual(
    codes([
      "mcpp::action a;",
      "a.role = mcpp::roles::source;",
      'a.arg("cd tools && make");',
      "a.submit();",
    ]),
    [DIAGNOSTIC_CODES.shellSyntaxInAction],
  );
  assert.deepEqual(
    codes([
      "mcpp::action a;",
      "a.role = mcpp::roles::source;",
      'a.env("GEN_MODE", "release").cwd("tools");',
      'a.arg("--out=build");',
      "a.submit();",
    ]),
    [],
  );
});

test("rule 7 flags a missing or unknown action role", () => {
  assert.deepEqual(codes(["mcpp::action a;", 'a.arg("gen");', "a.submit();"]), [
    DIAGNOSTIC_CODES.actionNeedsRole,
  ]);
  assert.deepEqual(codes(["mcpp::action a;", 'a.role = "banana";', "a.submit();"]), [
    DIAGNOSTIC_CODES.actionNeedsRole,
  ]);
  assert.deepEqual(codes(["mcpp::action a;", "a.role = mcpp::roles::object;", "a.submit();"]), []);
});

test("each rule id is the SPEC-007 code the plan names", () => {
  assert.deepEqual(Object.values(DIAGNOSTIC_CODES), [
    "mcpp.buildscript.unknownSymbol",
    "mcpp.buildscript.roleLiteral",
    "mcpp.buildscript.prepareNeedsOutputDir",
    "mcpp.buildscript.rpathInLinkFlag",
    "mcpp.buildscript.rawPathFlag",
    "mcpp.buildscript.shellSyntaxInAction",
    "mcpp.buildscript.actionNeedsRole",
  ]);
});
