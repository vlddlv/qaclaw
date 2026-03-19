#!/usr/bin/env node
import "dotenv/config";
import { logStream, printTokens, makeStagehandLogger } from "./src/log.js";
import { CONFIG } from "./src/config.js";
import { askHuman, makeHumanQueue } from "./src/bridge.js";
import { promptHash, loadScoped, save as saveClarification } from "./src/clarifications.js";
import { taskKey, get as getRecipe } from "./src/recipes.js";
import { collapseLinearChain, buildWaves, runPreflight } from "./src/planner.js";
import { runStep, splitPrompt } from "./src/step.js";
import { Stagehand } from "@browserbasehq/stagehand";

// ─── Graceful shutdown ────────────────────────────────────────────────────────

let stagehandRef = null;
async function cleanup() {
  try { if (stagehandRef) await stagehandRef.close(); } catch {}
  logStream.end();
}
process.on("SIGINT",  async () => { await cleanup(); process.exit(0); });
process.on("SIGTERM", async () => { await cleanup(); process.exit(0); });
process.on("exit",    () => { logStream.end(); });

console.log(`\n${"=".repeat(60)}`);
console.log(`Log started: ${new Date().toISOString()}  →  .qa-agent/runner.log`);

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const prompt = process.argv[2];
  if (!prompt) {
    console.error('❌ Error: Please provide a prompt.');
    console.log('Usage: node runner.js "<PROMPT>"');
    process.exit(1);
  }

  const tokens    = { input: 0, output: 0, cached: 0 };
  const startTime = Date.now();

  const { logger, setSilent } = makeStagehandLogger(tokens, CONFIG.targetUrl);

  const stagehand = new Stagehand({
    env: "LOCAL",
    headless: CONFIG.headless,
    model: CONFIG.model,
    experimental: true,
    disableAPI: true,
    enableCaching: true,
    cacheDir: "./.qa-agent/stagehand-cache",
    logger,
    localBrowserLaunchOptions: {
      headless: CONFIG.headless,
      ...(CONFIG.chromeProfile ? { userDataDir: CONFIG.chromeProfile } : {}),
      viewport: { width: CONFIG.viewportWidth, height: CONFIG.viewportHeight },
      args: ["--no-first-run", "--no-default-browser-check"],
    },
  });

  stagehandRef = stagehand;
  await stagehand.init();

  const page = await stagehand.context.awaitActivePage();
  await page.setViewportSize({ width: CONFIG.viewportWidth, height: CONFIG.viewportHeight });

  let exitCode = 0;
  try {
    // ── Load stored clarifications and recipe ──────────────────────────────

    const clarifications = loadScoped(prompt);
    if (clarifications.length > 0) {
      console.log(`\n🧠 Loaded ${clarifications.length} scoped clarification(s) (hash: ${promptHash(prompt)})`);
    }

    const key    = taskKey(prompt);
    const recipe = getRecipe(key);
    if (recipe) {
      console.log(`\n📚 Loaded recipe from ${recipe.savedAt} (${recipe.steps.length} steps)`);
      if (recipe.clarifications?.length) {
        for (const rc of recipe.clarifications) {
          if (!clarifications.find(c => c.context === rc.context)) clarifications.push(rc);
        }
        console.log(`\n🧠 Merged ${recipe.clarifications.length} clarification(s) from recipe`);
      }
    }

    // ── Preflight plan ─────────────────────────────────────────────────────

    const { instructions: testInstructions } = splitPrompt(prompt);
    let preflight;

    if (recipe) {
      console.log(`\n⚡ Skipping preflight planner - reusing cached plan from recipe`);
      preflight = { plan: [{ step: 1, action: testInstructions, dependsOn: [] }], questions: [] };
    } else {
      console.log(`\n🔎 Interpreting instructions...`);
      preflight = await runPreflight(testInstructions, clarifications);
    }

    await page.goto(CONFIG.targetUrl, { waitUntil: "load", timeout: 30000 });
    preflight.plan = collapseLinearChain(preflight.plan);

    console.log(`\n📋 Interpreted plan:`);
    preflight.plan.forEach(s => {
      const deps = s.dependsOn.length ? ` (after: ${s.dependsOn.join(", ")})` : "";
      console.log(`   ${s.step}. ${s.action.slice(0, 120)}${deps}`);
    });

    // ── Answer preflight questions ─────────────────────────────────────────

    if (preflight.questions.length > 0) {
      const scope = promptHash(prompt);
      console.log(`\n❓ ${preflight.questions.length} clarification(s) needed:`);
      for (const q of preflight.questions) {
        console.log(`\n   Q: ${q}`);
        const answer = await askHuman(q);
        console.log(`\n   A: ${answer}`);
        saveClarification(q.slice(0, 120), answer, scope);
        clarifications.push({ context: q.slice(0, 120), clarification: answer, scope });
      }
    } else {
      console.log(`\n✅ No clarifications needed - starting test`);
    }

    console.log(`\n🚀 Running: ${prompt}`);

    // ── Execute waves ──────────────────────────────────────────────────────

    const modelTiers = [
      { name: CONFIG.model, model: CONFIG.model },
      ...(CONFIG.fallbackModel !== CONFIG.model
        ? [{ name: CONFIG.fallbackModel, model: CONFIG.fallbackModel }]
        : []),
    ];
    const askHumanQueued = makeHumanQueue();
    const promptScope    = promptHash(prompt);
    const waves          = buildWaves(preflight.plan);
    const multiStep      = preflight.plan.length > 1;

    console.log(`\n🗺️  ${waves.length} wave(s), ${preflight.plan.length} step(s) total`);
    waves.forEach((wave, i) => {
      if (wave.length > 1) {
        console.log(`   Wave ${i + 1}: Steps ${wave.map(s => s.step).join(" + ")} run in parallel`);
      } else {
        console.log(`   Wave ${i + 1}: Step ${wave[0].step}`);
      }
    });

    for (const [waveIdx, wave] of waves.entries()) {
      console.log(`\n${"─".repeat(60)}`);
      if (wave.length > 1) {
        console.log(`⚡ Wave ${waveIdx + 1}/${waves.length} - ${wave.length} steps running in parallel:`);
        wave.forEach(s => console.log(`   [Step ${s.step}] ${s.action.slice(0, 80)}`));
      } else {
        const s = wave[0];
        const label = multiStep ? `Step ${s.step}: ` : "";
        console.log(`▶  Wave ${waveIdx + 1}/${waves.length} - ${label}${s.action.slice(0, 80)}`);
      }
      await Promise.all(wave.map(step => runStep(step, { stagehand, clarifications, promptScope, modelTiers, multiStep, askHumanQueued })));
      if (wave.length > 1) {
        console.log(`\n✅ Wave ${waveIdx + 1} complete - all ${wave.length} parallel steps finished`);
      }
    }

    // ── Audit expected outcomes ────────────────────────────────────────────

    const { expectedOutcomes } = splitPrompt(prompt);
    if (expectedOutcomes) {
      console.log(`\n${"═".repeat(60)}`);
      console.log(`📋 SUMMARY & EXPECTED OUTCOMES`);
      console.log(`${"═".repeat(60)}`);

      try {
        await page.goto(CONFIG.targetUrl, { waitUntil: "load", timeout: 15000 });
      } catch {
        const freshPage = await stagehand.context.newPage();
        await freshPage.goto(CONFIG.targetUrl, { waitUntil: "load", timeout: 15000 });
      }

      setSilent(true);
      const auditResult = await stagehand.agent({ model: modelTiers[0].model }).execute({
        instruction: `You are a QA auditor. Check each expected outcome below by navigating the app.

For EACH outcome bullet point, output a line in this exact format:
  ✅ PASSED - [what you saw that confirms it]
  ❌ FAILED - [what you saw that contradicts it]
  ⚠️  UNKNOWN - [why you cannot verify it from the app, e.g. requires checking an email inbox]

After all verdicts, add a "## Next Steps" section listing only the items that need follow-up (failures and unknowns), with a one-line suggested action for each.

Do NOT skip any bullet point. Do NOT call done until you have a verdict for every single item.

${expectedOutcomes}`,
      });
      setSilent(false);

      if (auditResult.message) console.log(`\n${auditResult.message}`);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`\n⏱  Total run time: ${elapsed}s`);
      console.log(`${"═".repeat(60)}`);
    }

    printTokens(tokens);
  } catch (error) {
    exitCode = 1;
    const msg = error?.message ?? String(error);
    if (msg.includes("ECONNREFUSED") || msg.includes("connect")) {
      console.error("⛔ BROWSER LAUNCH FAILED - Chrome could not start or its CDP connection was refused.");
      console.error("   Set QA_CHROME_PROFILE in .env to point at a Chrome user data dir.");
    }
    console.error("⛔ SCRIPT CRASHED:", error);
    printTokens(tokens);
  } finally {
    await stagehand.close();
    process.exit(exitCode);
  }
}

main();
