import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import readline from "readline";
import "dotenv/config";

/**
 * HELPER: Pauses execution to ask you a question in the terminal.
 */
const askHuman = (query) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(`\n❓ [ACTION REQUIRED]: ${query}\n> `, ans => { rl.close(); resolve(ans); }));
};

const printTokens = ({ input, output, cached }) => {
  const fmt = (n) => n.toLocaleString();
  console.log(`\n📊 Token usage: ${fmt(input)} input · ${fmt(output)} output · ${fmt(cached)} cached  (total: ${fmt(input + output)})`);
};

async function runMasterQA() {
  // 1. Get Slab URL from the command line argument
  const slabUrl = process.argv[2];

  if (!slabUrl) {
    console.error("❌ Error: Please provide a Slab URL.");
    console.log("Usage: node dado-agent.js <SLAB_URL>");
    process.exit(1);
  }

  const tokens = { input: 0, output: 0, cached: 0 };

  const stagehand = new Stagehand({
    env: "LOCAL",
    headless: false,
    model: "anthropic/claude-sonnet-4-6",
    enableCaching: true,
    cacheDir: "./stagehand-cache",
    logger: ({ category, message, auxiliary }) => {
      if (category === "agent") {
        if (message.startsWith("Agent calling tool: act")) {
          const arg = auxiliary?.arguments?.value ?? "";
          console.log(`   → ${arg}`);
        } else if (message.startsWith("reasoning:")) {
          const text = message.replace(/^reasoning:\s*/, "").slice(0, 120);
          console.log(`   💭 ${text}`);
        }
        // skip: screenshot, scroll, ariaTree, done, Task completed, deprecation warnings
      } else if (category === "action" && message === "new page (frame) URL detected") {
        const url = (auxiliary?.url?.value ?? "").replace("http://localhost:3100", "");
        console.log(`   🔗 ${url || "/"}`);
      } else if (category === "aisdk" && message === "response") {
        try {
          const resp = JSON.parse(auxiliary?.response?.value ?? "null");
          tokens.input  += resp?.usage?.inputTokens       ?? 0;
          tokens.output += resp?.usage?.outputTokens      ?? 0;
          tokens.cached += resp?.usage?.cachedInputTokens ?? 0;
        } catch { /* malformed response, skip */ }
      }
      // skip: extraction details, HTTP headers, full response JSON, etc.
    },
    localBrowserLaunchOptions: {
      userDataDir: "/Users/vlddlv/Library/Application Support/Google/Chrome-Stagehand",
      viewport: { width: 1920, height: 1080 },
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1920,1080",
        "--start-maximized"
      ]
    }
  });

  await stagehand.init();

  const page = await stagehand.context.awaitActivePage();
  await page.setViewportSize({ width: 1920, height: 1080 });
  const agent = stagehand.agent();

  try {
    // 2. FETCH CHECKLIST FROM SLAB
    console.log(`🌐 Accessing Slab: ${slabUrl}`);
    await page.goto(slabUrl, { waitUntil: "load", timeoutMs: 30000 });
    await new Promise(r => setTimeout(r, 3000)); // let the SPA render

    const extracted = await stagehand.extract(
      "Extract every test case from the table. Capture ID, Title, Instructions, and Expected Outcome.",
      z.object({
        testCases: z.array(z.object({
          id: z.string().describe("The test ID number"),
          title: z.string().describe("The test name"),
          instructions: z.string().describe("Steps to perform"),
          expectedOutcome: z.string().describe("The result we are checking for")
        }))
      })
    );

    const { testCases } = extracted;
    console.log(`\n📋 Found ${testCases.length} test cases:`);
    testCases.forEach((t, i) => console.log(`   ${i + 1}. [${t.id}] ${t.title}`));

    // 3. EXECUTION LOOP
    for (const [idx, test] of testCases.entries()) {
      let retry = false;

      do {
        retry = false;

        console.log(`\n${"─".repeat(60)}`);
        console.log(`🚀 Test ${idx + 1}/${testCases.length}: [${test.id}] ${test.title}`);
        console.log(`─${"─".repeat(59)}`);

        // Navigate to the Dev App
        await page.goto("http://localhost:3100/");

        await agent.execute({
          instruction: `
            Perform this test: ${test.instructions}.
            Verify result: ${test.expectedOutcome}.
            Note: If you encounter inconsistencies or need a file upload, explain it to the supervisor.
          `,
          onStep: async (step) => {
            // Detect need for human help or file uploads
            const needsHelp = ["upload", "attach", "missing", "inconsistent", "not found"];
            if (needsHelp.some(k => step.text.toLowerCase().includes(k))) {
              const answer = await askHuman(`${step.text}\nProvide a file path or further instructions:`);
              if (answer.includes("/") || answer.includes("\\")) {
                await page.setInputFiles('input[type="file"]', answer.trim());
                return { instruction: "I have attached the file. Proceed." };
              }
              return { instruction: answer };
            }
          }
        });

        // 4. AUDIT CHECK
        const audit = await stagehand.extract(
          `Does the final state match: ${test.expectedOutcome}?`,
          z.object({ passed: z.boolean(), notes: z.string() })
        );

        if (audit.passed) {
          console.log(`✅ PASSED`);
        } else {
          console.error(`\n❌ FAILED: [${test.id}] ${test.title}`);
          console.error(`   Reason: ${audit.notes}`);
          const choice = await askHuman(
            `What do you want to do?\n  r → retry this test\n  s → skip and continue\n  q → quit`
          );
          const c = choice.trim().toLowerCase();
          if (c === "r") {
            retry = true;
          } else if (c === "q") {
            printTokens(tokens);
            await stagehand.close();
            process.exit(1);
          }
          // "s" or anything else → fall through to next test
        }
      } while (retry);
    }

    printTokens(tokens);

  } catch (error) {
    console.error("⛔ SCRIPT CRASHED:", error);
    printTokens(tokens);
  } finally {
    await stagehand.close();
    process.exit(0);
  }
}

runMasterQA();
