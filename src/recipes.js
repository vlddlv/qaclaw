import { readFileSync, writeFileSync, existsSync } from "fs";

const FILE = "./.qa-agent/recipes.json";
const MEANINGFUL = new Set(["act", "navToUrl", "fillForm", "goto"]);

/** Stable lookup key for a prompt - first 200 normalized chars. */
export function taskKey(prompt) {
  return prompt.trim().replace(/\s+/g, " ").slice(0, 200);
}

function load() {
  if (!existsSync(FILE)) return {};
  try { return JSON.parse(readFileSync(FILE, "utf8")); } catch { return {}; }
}

export function get(key) {
  return load()[key];
}

export function save(key, actions, agentSummary, clarifications = []) {
  const steps = actions
    .filter(a => MEANINGFUL.has(a.type))
    .map((a, i) => {
      const n = i + 1;
      if (a.type === "navToUrl" || a.type === "goto")
        return `${n}. [navigate] ${a.url ?? a.args?.url ?? a.pageUrl}`;
      if (a.type === "act")
        return `${n}. [act on ${a.pageUrl ?? "page"}] ${a.instruction ?? a.args?.instruction ?? a.reasoning ?? ""}`;
      if (a.type === "fillForm")
        return `${n}. [fillForm on ${a.pageUrl ?? "page"}] ${JSON.stringify(a.fields ?? a.args?.fields ?? {}).slice(0, 120)}`;
      return `${n}. [${a.type}] ${JSON.stringify(a.args ?? {}).slice(0, 80)}`;
    });

  const recipes = load();
  recipes[key] = {
    steps,
    agentSummary: agentSummary?.slice(0, 400),
    clarifications,
    savedAt: new Date().toISOString(),
  };
  writeFileSync(FILE, JSON.stringify(recipes, null, 2));
  console.log(`\n📚 Recipe saved (${steps.length} meaningful steps, ${clarifications.length} clarification(s) → ${FILE})`);
}

export function remove(key) {
  const recipes = load();
  if (recipes[key]) {
    delete recipes[key];
    writeFileSync(FILE, JSON.stringify(recipes, null, 2));
    console.log(`\n🗑️  Recipe invalidated (UI may have changed) - will re-learn on next successful run`);
  }
}

export function toPromptSection(recipe) {
  if (!recipe?.steps?.length) return "";
  return (
    `\n\nRoute from a previous successful run (${recipe.savedAt}) - try this first, ` +
    `but if any step fails or the UI looks different, fall back to exploration:\n` +
    recipe.steps.join("\n") +
    "\n"
  );
}
