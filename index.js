#!/usr/bin/env node
if (process.argv[2]) {
  await import("./runner.js");
} else {
  await import("./mcp.js");
}
