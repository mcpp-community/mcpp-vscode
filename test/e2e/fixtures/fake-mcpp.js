#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const logPath = process.env.MCPP_E2E_LOG;
const command = process.argv.slice(2).join(" ");
if (typeof logPath === "string") {
  fs.appendFileSync(logPath, `${command}\n`);
}

if (command === "build --configure-only") {
  // 使用 syntax-only CDB，避免 smoke test 依赖宿主 clangd 或真实编译器。
  const cwd = process.cwd();
  fs.writeFileSync(path.join(cwd, "compile_commands.json"), JSON.stringify([{
    directory: cwd,
    file: path.join(cwd, "main.cpp"),
    arguments: ["gcc", "-std=c++23", "-c", path.join(cwd, "main.cpp")],
  }]));
  process.exit(0);
}

process.exit(command === "build" ? 0 : 1);
