import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn, execSync } from "child_process";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { EventEmitter } from "events";

const sessions = new Map();
const MAX_OUTPUT_CHARS = 8000;

function sessionFile(sessionId, type) {
  return join(tmpdir(), `qa-${sessionId}-${type}.json`);
}

function killStaleRunners() {
  try {
    execSync('pkill -f "node runner.js" 2>/dev/null || true', { stdio: "ignore" });
  } catch {}
}

function startQaRunner(sessionId, prompt) {
  killStaleRunners();

  const env = { ...process.env, QA_MCP_MODE: "1", QA_SESSION_ID: sessionId };
  const child = spawn("node", ["runner.js", prompt], {
    cwd: import.meta.dirname,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const session = {
    process: child,
    outputLines: [],
    status: "running",
    pendingQuestion: null,
    events: new EventEmitter(),
    lastSentLength: 0,
  };
  sessions.set(sessionId, session);

  function setStatus(newStatus) {
    session.status = newStatus;
    session.events.emit("statusChange", newStatus);
  }

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    session.outputLines.push(text);

    const questionFile = sessionFile(sessionId, "question");
    if (existsSync(questionFile)) {
      try {
        const { question } = JSON.parse(readFileSync(questionFile, "utf8"));
        if (session.pendingQuestion !== question) {
          session.pendingQuestion = question;
          setStatus("waiting_clarification");
        }
      } catch {}
    }
  });

  child.stderr.on("data", (chunk) => {
    session.outputLines.push(`[stderr] ${chunk.toString()}`);
  });

  child.on("exit", (code) => {
    session.pendingQuestion = null;
    setStatus(code === 0 ? "completed" : "failed");
  });

  return session;
}

const HEARTBEAT_MS = 3 * 60 * 1000;

function waitForTerminal(session, timeoutMs = 60 * 60 * 1000) {
  const TERMINAL = new Set(["completed", "failed", "waiting_clarification"]);
  return new Promise((resolve, reject) => {
    if (TERMINAL.has(session.status)) { resolve(); return; }
    const deadline = setTimeout(() => reject(new Error("QA test timed out")), timeoutMs);
    const heartbeat = setTimeout(() => {
      clearTimeout(deadline);
      session.events.off("statusChange", handler);
      resolve("heartbeat");
    }, HEARTBEAT_MS);
    const handler = (status) => {
      if (TERMINAL.has(status)) {
        clearTimeout(deadline);
        clearTimeout(heartbeat);
        session.events.off("statusChange", handler);
        resolve();
      }
    };
    session.events.on("statusChange", handler);
  });
}

function buildResponse(sessionId, session) {
  const fullOutput = session.outputLines.join("");
  const newOutput = fullOutput.slice(session.lastSentLength);
  session.lastSentLength = fullOutput.length;

  const output = newOutput.length > MAX_OUTPUT_CHARS
    ? `[... truncated - full log at .qa-agent/runner.log ...]\n\n` + newOutput.slice(-MAX_OUTPUT_CHARS)
    : newOutput;

  const result = { session_id: sessionId, status: session.status, output };
  if (session.pendingQuestion) result.question = session.pendingQuestion;
  return result;
}

const server = new Server(
  { name: "qaclaw", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "test",
      description:
        "Run a QA test in a headless browser. Blocks until the test completes, fails, needs input, or 3 minutes pass.\n\n" +
        "Returns JSON with: session_id, status (completed|failed|waiting_clarification|running), output, and optionally question.\n\n" +
        "Protocol:\n" +
        "1. Call this tool with a prompt describing the test.\n" +
        "2. If status is `running`, the test is still in progress. Call `respond` with the session_id and no answer to keep waiting.\n" +
        "3. If status is `waiting_clarification`, a `question` field is present. Call `respond` with your answer.\n" +
        "4. Repeat until status is `completed` or `failed`, then report results.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Full test instructions and expected outcomes" },
        },
        required: ["prompt"],
      },
    },
    {
      name: "respond",
      description:
        "Continue waiting on a running QA test, or answer a question from it. " +
        "Call with just session_id (no answer) to poll for progress. Call with session_id and answer to respond to a question. " +
        "Blocks up to 3 minutes then returns current status. Repeat until status is `completed` or `failed`.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Session ID from the previous test or respond call" },
          answer: { type: "string", description: "Your answer to the pending question. Omit if just polling for progress." },
        },
        required: ["session_id"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "test") {
    const sessionId = randomUUID();
    const session = startQaRunner(sessionId, args.prompt);

    try {
      const reason = await waitForTerminal(session);
      if (reason === "heartbeat") session.status = "running";
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ error: e.message, status: session.status }) }] };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(buildResponse(sessionId, session), null, 2) }],
    };
  }

  if (name === "respond") {
    const session = sessions.get(args.session_id);
    if (!session) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Session not found" }) }] };
    }

    if (args.answer) {
      const answerFile = sessionFile(args.session_id, "answer");
      writeFileSync(answerFile, JSON.stringify({ answer: args.answer }));
      const questionFile = sessionFile(args.session_id, "question");
      if (existsSync(questionFile)) unlinkSync(questionFile);
      session.pendingQuestion = null;
    }
    session.status = "running";

    try {
      const reason = await waitForTerminal(session);
      if (reason === "heartbeat") session.status = "running";
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ error: e.message, status: session.status }) }] };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(buildResponse(args.session_id, session), null, 2) }],
    };
  }

  return { content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
