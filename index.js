#!/usr/bin/env node
const arg = process.argv[2];
if (arg && !arg.startsWith("-")) {
  await import("./runner.js");
} else {
  await import("./mcp.js");
}
