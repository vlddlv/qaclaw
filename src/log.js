import { createWriteStream } from "fs";

const LOG_FILE = "./.qa-agent/runner.log";
export const logStream = createWriteStream(LOG_FILE, { flags: "a" });

// Tee all console output to the log file (side effect on import).
for (const method of ["log", "error", "warn"]) {
  const orig = console[method].bind(console);
  console[method] = (...args) => {
    orig(...args);
    logStream.write(args.map(a => (typeof a === "string" ? a : String(a))).join(" ") + "\n");
  };
}

export const ts = () => new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm

export function printTokens({ input, output, cached }) {
  const fmt = n => n.toLocaleString();
  console.log(`\n📊 Token usage: ${fmt(input)} input · ${fmt(output)} output · ${fmt(cached)} cached  (total: ${fmt(input + output)})`);
}

/**
 * Returns a Stagehand-compatible logger and a setSilent() toggle.
 * Accumulates token usage into the provided `tokens` object.
 */
export function makeStagehandLogger(tokens, targetUrl) {
  let silent = false;

  function logger({ category, message, auxiliary }) {
    if (silent) return;

    if (category === "agent") {
      if (message.startsWith("Agent calling tool: act")) {
        console.log(`[${ts()}]    → act: ${auxiliary?.arguments?.value ?? ""}`);
      } else if (message.startsWith("Agent calling tool: extract")) {
        console.log(`[${ts()}]    → extract: ${(auxiliary?.arguments?.value ?? "").slice(0, 100)}`);
      } else if (message.startsWith("Agent calling tool: observe")) {
        console.log(`[${ts()}]    → observe`);
      } else if (message.startsWith("Agent calling tool: goto")) {
        console.log(`[${ts()}]    → goto: ${auxiliary?.arguments?.value ?? ""}`);
      } else if (message.startsWith("Agent calling tool: navToUrl")) {
        console.log(`[${ts()}]    → navToUrl: ${auxiliary?.arguments?.value ?? ""}`);
      } else if (message.startsWith("Agent calling tool:")) {
        console.log(`[${ts()}]    → tool: ${message.replace("Agent calling tool: ", "")}`);
      } else if (message.startsWith("reasoning:")) {
        console.log(`[${ts()}]    💭 ${message.replace(/^reasoning:\s*/, "").slice(0, 400)}`);
      } else if (message === "Agent response received") {
        console.log(`[${ts()}]    ✉️  agent response received`);
      } else if (!message.includes("deprecat") && !message.includes("screenshot") && !message.includes("ariaTree")) {
        console.log(`[${ts()}]    [agent] ${message.slice(0, 120)}`);
      }
    } else if (category === "action" && message === "new page (frame) URL detected") {
      const url = (auxiliary?.url?.value ?? "").replace(targetUrl, "");
      console.log(`[${ts()}]    🔗 ${url || "/"}`);
    } else if (category === "action") {
      console.log(`[${ts()}]    [action] ${message.slice(0, 120)}`);
    } else if (category === "extract") {
      console.log(`[${ts()}]    [extract] ${message.slice(0, 120)}`);
    } else if (category === "aisdk" && message === "response") {
      try {
        const resp = JSON.parse(auxiliary?.response?.value ?? "null");
        tokens.input  += resp?.usage?.inputTokens       ?? 0;
        tokens.output += resp?.usage?.outputTokens      ?? 0;
        tokens.cached += resp?.usage?.cachedInputTokens ?? 0;
      } catch { /* malformed response, skip */ }
    }
  }

  return { logger, setSilent: (v) => { silent = v; } };
}
