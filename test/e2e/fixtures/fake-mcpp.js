#!/usr/bin/env node

const fs = require("node:fs");

const logPath = process.env.MCPP_E2E_LOG;
if (typeof logPath === "string") {
  fs.appendFileSync(logPath, `${process.argv.slice(2).join(" ")}\n`);
}
process.exit(process.argv.slice(2).join(" ") === "build" ? 0 : 1);
