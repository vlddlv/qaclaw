import { readFileSync, writeFileSync, existsSync } from "fs";

const FILE = "./.qa-agent/recipes.json";
const MEANINGFUL = new Set(["act", "navToUrl", "fillForm", "goto"]);

/** Stable lookup key for a prompt - first 200 normalized chars. */
export function taskKey(prompt) {
  return prompt.trim().replace(/\s+/g, " ").slice(0, 200);
}

/** Extracts the ordered sequence of unique URL pathnames visited in a recipe. */
function extractUrlPattern(steps) {
  return [...new Set(
    steps
      .filter(s => s.includes("[navigate]"))
      .map(s => {
        const m = s.match(/\[navigate\]\s+(\S+)/);
        if (!m) return null;
        try { return new URL(m[1]).pathname; } catch { return m[1]; }
      })
      .filter(Boolean)
  )];
}

function load() {
  if (!existsSync(FILE)) return {};
  try { return JSON.parse(readFileSync(FILE, "utf8")); } catch { return {}; }
}

/**
 * Returns a recipe for the given key. Falls back to URL pattern matching
 * when no exact key match exists and urlHints are provided.
 */
export function get(key, urlHints = []) {
  const recipes = load();

  if (recipes[key]) return recipes[key];
  if (urlHints.length === 0) return null;

  let best = null;
  let bestScore = 0;
  for (const recipe of Object.values(recipes)) {
    if (!recipe.urlPattern?.length) continue;
    const matches = recipe.urlPattern.filter(p => urlHints.some(h => p.includes(h) || h.includes(p)));
    const score = matches.length / recipe.urlPattern.length;
    if (score >= 0.5 && score > bestScore) {
      best = recipe;
      bestScore = score;
    }
  }
  return best;
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
    urlPattern: extractUrlPattern(steps),
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
