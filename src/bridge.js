import readline from "readline";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Pauses execution to ask the human a question.
 * - MCP mode: writes a question file, polls for an answer file.
 * - CLI mode: prompts interactively via stdin.
 */
export function askHuman(query) {
  if (process.env.QA_MCP_MODE) {
    const sessionId = process.env.QA_SESSION_ID;
    const questionFile = join(tmpdir(), `qa-${sessionId}-question.json`);
    const answerFile   = join(tmpdir(), `qa-${sessionId}-answer.json`);

    writeFileSync(questionFile, JSON.stringify({ question: query }));
    console.log(`\n❓ [CLARIFICATION NEEDED]: ${query}`);

    return new Promise((resolve) => {
      const poll = setInterval(() => {
        if (!existsSync(answerFile)) return;
        clearInterval(poll);
        try {
          const { answer } = JSON.parse(readFileSync(answerFile, "utf8"));
          unlinkSync(answerFile);
          if (existsSync(questionFile)) unlinkSync(questionFile);
          console.log(`\n✅ Clarification received: ${answer}`);
          resolve(answer);
        } catch { /* file not fully written yet - retry next tick */ }
      }, 500);
    });
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve =>
    rl.question(`\n❓ [ACTION REQUIRED]: ${query}\n> `, ans => { rl.close(); resolve(ans); })
  );
}

/**
 * Wraps askHuman in a serial queue so parallel steps can't collide on stdin.
 */
export function makeHumanQueue() {
  let queue = Promise.resolve();
  return (query) => {
    const p = queue.then(() => askHuman(query));
    queue = p.then(() => {}, () => {});
    return p;
  };
}
