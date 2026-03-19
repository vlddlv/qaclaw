import { generateObject } from "ai";
import { z } from "zod";
import { getAISDKLanguageModel } from "@browserbasehq/stagehand";
import { CONFIG, parseModel, getApiKeyForProvider } from "./config.js";

/** Collapses a fully linear plan (each step depends on the previous) into a single step. */
export function collapseLinearChain(plan) {
  if (plan.length <= 1) return plan;
  const isLinear = plan.every((s, i) =>
    i === 0 ? s.dependsOn.length === 0
            : s.dependsOn.length === 1 && s.dependsOn[0] === plan[i - 1].step
  );
  if (!isLinear) return plan;
  console.log(`\n🔗 Plan is a linear chain of ${plan.length} steps - collapsing into 1 (steps share no browser state)`);
  return [{ step: 1, action: plan.map((s, i) => `${i + 1}. ${s.action}`).join("\n"), dependsOn: [] }];
}

/** Groups plan steps into dependency waves for parallel execution. */
export function buildWaves(plan) {
  const waves = [];
  const completed = new Set();
  let remaining = [...plan];
  while (remaining.length > 0) {
    const wave = remaining.filter(s => s.dependsOn.every(d => completed.has(d)));
    if (wave.length === 0) break; // guard against circular deps
    waves.push(wave);
    wave.forEach(s => completed.add(s.step));
    remaining = remaining.filter(s => !completed.has(s.step));
  }
  return waves;
}

/**
 * Runs the preflight planner: interprets test instructions into a dependency-aware plan
 * and surfaces any questions that need answering before execution starts.
 */
export async function runPreflight(instructions, clarifications) {
  const { provider, model } = parseModel(CONFIG.plannerModel);
  const plannerModel = getAISDKLanguageModel(provider, model, { apiKey: getApiKeyForProvider(provider) });

  const result = await generateObject({
    model: plannerModel,
    schema: z.object({
      plan: z.array(z.object({
        step: z.number(),
        action: z.string().describe(
          "The exact action to perform - preserve ALL details from the original, do not paraphrase or simplify"
        ),
        dependsOn: z.array(z.number()).describe(
          "Step numbers that must complete before this step can start. Empty [] if independent."
        ),
      })),
      questions: z.array(z.string()).describe("Questions that must be answered before starting"),
    }),
    prompt: `You are about to execute a QA test on a web app. Read the instructions carefully and produce a step-by-step plan plus any questions that need answering first.

PLAN RULES:
- Preserve every detail from the original instructions exactly. Do NOT simplify, paraphrase, or drop any requirement.
- If a step mentions verifying against external content (a ticket, a document, a spreadsheet, an email), include the full verification criterion verbatim.
- For each step, set dependsOn to the step numbers it requires to complete first. Set it to [] if the step is independent of all others.
- CRITICAL: All steps that interact with the same web page or UI flow MUST be sequential (chained via dependsOn). Browser UI interactions cannot run in parallel - they share a single page state. Only set dependsOn to [] if the step navigates to a completely independent URL with no shared state.
- CRITICAL: Each step runs in a SEPARATE browser tab starting from scratch. Steps do NOT share page state. If the instructions describe a continuous workflow on one page (e.g. creating a template and adding multiple items, filling a multi-step form), keep ALL of that as ONE step with the full instructions. Only split into multiple steps when the tasks are truly independent and can each be done from a fresh browser tab.
- When in doubt, use FEWER steps. A single step with detailed instructions is better than many steps that lose context.

QUESTION RULES - you MUST ask about any of the following:
1. Terms or steps you do not know how to perform in this app.
2. Any expected outcome that references external content you don't have (e.g. "issues should match text in the ticket" → ask "What is the exact text in the ticket that the issues should match?").
3. Any file, URL, or data the test requires that was not provided.
4. Anything genuinely ambiguous that would cause you to guess.

Do NOT ask about things already resolved in the clarifications below.

Previously learned clarifications (already resolved - do NOT ask about these again):
${clarifications.map(c => `- "${c.context}": ${c.clarification}`).join("\n") || "none"}

Instructions:
${instructions}`,
  });

  return result.object;
}
