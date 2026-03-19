import { readFileSync, writeFileSync, existsSync } from "fs";
import { createHash } from "crypto";

const FILE = "./.qa-agent/clarifications.json";

export function promptHash(prompt) {
  return createHash("sha256").update(prompt.trim()).digest("hex").slice(0, 8);
}

function load() {
  if (!existsSync(FILE)) return [];
  try { return JSON.parse(readFileSync(FILE, "utf8")); } catch { return []; }
}

/** Returns clarifications relevant to this prompt: global (no scope) + prompt-scoped. */
export function loadScoped(prompt) {
  const hash = promptHash(prompt);
  return load().filter(c => !c.scope || c.scope === hash);
}

export function save(context, clarification, scope = null) {
  const all = load();
  const existing = all.find(c => c.context === context && c.scope === scope);
  if (existing) {
    existing.clarification = clarification;
  } else {
    all.push({ context, clarification, ...(scope ? { scope } : {}) });
  }
  writeFileSync(FILE, JSON.stringify(all, null, 2));
  console.log(`\n💾 Clarification saved${scope ? ` (scope: ${scope})` : " (global)"}`);
}

export function toPromptSection(clarifications) {
  if (!clarifications.length) return "";
  return (
    "\n\nPreviously learned clarifications - apply these when you encounter a similar situation:\n" +
    clarifications.map(c => `- When "${c.context}": ${c.clarification}`).join("\n") +
    "\n"
  );
}
