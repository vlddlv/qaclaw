# qaclaw

An autonomous QA agent exposed over MCP. Give it test instructions in plain English - it opens a headless browser, executes the steps, handles failures, and returns pass/fail results.

The agent uses [Stagehand](https://github.com/browserbase/stagehand) to drive a real browser with an AI model that can see the page, decide what to click, and recover when things go wrong. The MCP server is just the transport layer - the agent is `qa-runner.js`.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Your AI tool (Claude Code, Cursor, Copilot, etc.)      │
│  ── the caller. Sends test instructions, relays answers  │
└──────────────────────┬──────────────────────────────────┘
                       │ MCP (stdio)
                       ▼
┌─────────────────────────────────────────────────────────┐
│  mcp-server.js - transport layer                         │
│  Exposes two tools: `test` and `respond`.                │
│  Spawns qa-runner.js as a child process.                 │
│  Bridges communication via temp files (questions/answers)│
│  Has no reasoning - just plumbing.                       │
└──────────────────────┬──────────────────────────────────┘
                       │ child process + file IPC
                       ▼
┌─────────────────────────────────────────────────────────┐
│  qa-runner.js - the agent                                │
│                                                          │
│  Has its own reasoning loop:                             │
│  1. Preflight planner breaks prompt into steps           │
│  2. For each step, Stagehand's agent.execute() runs:     │
│     screenshot → LLM decides action → execute → repeat   │
│  3. Stuck detection triggers model escalation or asks    │
│     the caller for help (via the question/answer bridge) │
│  4. Audit phase verifies expected outcomes               │
└─────────────────────────────────────────────────────────┘
```

### Communication flow

**Happy path** - test runs without questions:

```
Caller                    MCP server              qa-runner (agent)
  │                           │                         │
  │── test(prompt) ──────────→│                         │
  │                           │── spawn ───────────────→│
  │                           │                         │── plan steps
  │                           │                         │── open browser
  │                           │   (blocks)              │── execute steps
  │                           │                         │── audit outcomes
  │                           │←── exit(0) ────────────│
  │←── { status: completed } ─│                         │
```

**With clarification** - agent gets stuck and needs input:

```
Caller                    MCP server              qa-runner (agent)
  │                           │                         │
  │── test(prompt) ──────────→│                         │
  │                           │── spawn ───────────────→│
  │                           │                         │── starts executing
  │                           │                         │── gets stuck
  │                           │                         │── writes question file
  │                           │←── (detects file) ──────│
  │←── { question: "..." } ──│                         │   (polls for answer)
  │                           │                         │
  │── respond(answer) ───────→│                         │
  │                           │── writes answer file ──→│
  │                           │                         │── reads answer, continues
  │                           │   (blocks)              │── finishes
  │                           │←── exit(0) ────────────│
  │←── { status: completed } ─│                         │
```

### Why this split?

The caller (your AI tool) doesn't drive the browser. The agent does. This means:

- **Fire and forget** - send instructions, get results. The caller doesn't manage browser state.
- **Model agnostic** - works regardless of what the calling LLM is. Claude, GPT, Gemini, local models - anything that speaks MCP.
- **Autonomous recovery** - the agent handles stuck situations, model escalation, and retries on its own. It only asks the caller when all else fails.

## Setup

```bash
npm install
```

Create a `.env` file with the API key for your chosen model provider:

```bash
# Pick the one that matches your QA_MODEL provider
GOOGLE_API_KEY=your-key        # for google/* models (default)
ANTHROPIC_API_KEY=your-key     # for anthropic/* models
OPENAI_API_KEY=your-key        # for openai/* models
```

## Configuration

All configuration is via environment variables. Set them in `.env` or your shell.

| Variable | Default | Description |
|----------|---------|-------------|
| `QA_TARGET_URL` | `http://localhost:3100` | URL of the app to test |
| `QA_MODEL` | `google/gemini-2.5-pro` | Primary model (`provider/model`) |
| `QA_FALLBACK_MODEL` | `google/gemini-2.5-flash` | Fallback model for stuck recovery |
| `QA_PLANNER_MODEL` | same as fallback | Model for the preflight planner |
| `QA_HEADLESS` | `true` | Set `false` to see the browser |
| `QA_VIEWPORT_WIDTH` | `1920` | Browser viewport width |
| `QA_VIEWPORT_HEIGHT` | `1080` | Browser viewport height |
| `QA_CHROME_PROFILE` | (see hints) | Path to a Chrome user data dir |

Model format is `provider/model-name`. The agent picks the right API key env var based on the provider prefix (`google/` → `GOOGLE_API_KEY`, etc).

## MCP Configuration

Add to your AI tool's MCP config:

```json
{
  "mcpServers": {
    "qaclaw": {
      "command": "node",
      "args": ["mcp-server.js"],
      "cwd": "/path/to/qaclaw"
    }
  }
}
```

Works with any MCP-capable tool: Claude Code, Cursor, Windsurf, Continue, Open Code, etc.

## Tools

Two tools. The protocol is embedded in the tool descriptions, so any LLM reading the tool list knows how to use them without extra setup.

### `test`

Run a QA test. Blocks until the test completes, fails, or needs input.

```
Input:  { prompt: "Go to /settings, change the timezone to PST, verify it saved" }

Output: {
  session_id: "uuid",
  status: "completed" | "failed" | "waiting_clarification",
  output: "... execution log (last ~8000 chars) ...",
  question: "What credentials should I use?"   // only when status is waiting_clarification
}
```

### `respond`

Answer a question from a running test. Blocks again until the next terminal state.

```
Input:  { session_id: "uuid", answer: "Use admin@test.com / pass123" }
Output: same shape as test
```

### Protocol

```
test(prompt)
    │
    ├── status: completed → done, report results
    ├── status: failed    → done, report failure
    └── status: waiting_clarification
            │
            │  question: "..."
            │
            ▼
        respond(session_id, answer)
            │
            └── (repeat: check status)
```

## Commands and Skills

For AI tools that support project-level commands or skills, you can create a shortcut that wraps the protocol above. The implementation depends on your tool:

**Claude Code** - create `.claude/commands/qa.md`:
```markdown
Run a QA test. Call the `test` MCP tool with $ARGUMENTS as the prompt.
If the response has a `question`, answer it with `respond` or ask the user.
Repeat until status is completed or failed. Report the results.
```

**Cursor** - add to `.cursor/rules`:
```
When asked to run QA tests, use the `test` MCP tool with the user's instructions.
Handle clarifications by calling `respond`. Report pass/fail results.
```

**Other tools** - the tool descriptions are self-documenting. Most MCP-capable tools will figure out the protocol from the descriptions alone. A command/skill just makes it invocable by name (e.g. `/qa`).

## Standalone CLI

```bash
node qa-runner.js "Navigate to /users, create a new user, verify it appears in the list"
```

In CLI mode, clarifications are handled interactively via stdin instead of the MCP bridge.

## Agent Internals

### Preflight planner

Breaks the prompt into steps with dependency tracking. Independent steps run in parallel across browser tabs. Linear chains (every step depends on the previous) are collapsed into a single step to preserve shared page context.

### Execution loop

Each step runs via `stagehand.agent.execute()` - the inner LLM sees the page, decides what to do, and acts. The runner monitors for stuck patterns (passive-spinning, repeated identical actions, stuck keywords) and escalates.

### Model escalation

Primary model → fallback model → ask the caller. Each tier gets a chance before escalating. If both models are the same, it goes straight to asking the caller.

### Clarifications

When the agent encounters something ambiguous - a term it doesn't understand, a file it needs, a decision it can't make - it asks for clarification. Answers are **persisted** to `.qa-agent/clarifications.json`, scoped by a hash of the prompt.

On subsequent runs of the same test, the agent loads matching clarifications and injects them into its instructions. It also feeds them to the preflight planner so it doesn't re-ask resolved questions.

Clarifications are scoped:
- **Prompt-scoped** - tied to a specific test prompt (by hash). Only loaded when that exact prompt runs again.
- **Global** - no scope. Loaded for every test. Useful for general knowledge like "the admin password is X".

This means the agent learns from each run. The first run might ask 3 questions; the second run asks zero.

### Recipes

After a successful test run, the agent saves the action sequence (navigation, clicks, form fills) as a **recipe** in `.qa-agent/recipes.json`, keyed by the first 200 characters of the prompt.

On repeat runs:
1. The recipe is loaded and injected as "suggested steps" in the agent's instructions
2. The preflight planner is **skipped entirely** - the recipe already provides a plan
3. Any clarifications from the recipe are merged into the current set

The agent still has full autonomy - if the recipe's steps fail (UI changed, different state), it falls back to exploration. But when the UI is stable, recipes make repeated runs significantly faster.

Recipes are invalidated automatically when the agent gets stuck during a replay, so stale recipes don't cause loops.

### Caching

Stagehand's built-in caching is enabled (`.qa-agent/stagehand-cache/`). This caches LLM responses for identical page states and instructions, so repeated interactions with the same UI elements don't burn API tokens.

Combined with recipes (skip the planner) and clarifications (skip the questions), a fully cached repeat run of a test can be dramatically faster and cheaper than the first run.

### Audit phase

If the prompt includes "expected outcome" text, a separate agent pass runs after execution. It navigates the app and verifies each expected outcome against the actual state, producing per-item verdicts:

```
✅ PASSED - timezone shows PST in the header
❌ FAILED - notification preference still shows "email", expected "slack"
⚠️  UNKNOWN - cannot verify email was sent (requires inbox access)
```

## Hints

### Bypassing authentication

If your app requires login (SSO, OAuth, session cookies), create a dedicated Chrome profile, log in manually once, then point qaclaw at it:

```bash
# 1. Create a new Chrome profile and log in manually
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --user-data-dir="$HOME/Library/Application Support/Google/Chrome-QAClaw" \
  --no-first-run

# 2. Log in to your app in that browser window, then close it

# 3. Point qaclaw at the profile
QA_CHROME_PROFILE="$HOME/Library/Application Support/Google/Chrome-QAClaw"
```

Set `QA_CHROME_PROFILE` in your `.env` or pass it as an environment variable. The agent will launch Chrome with that profile, inheriting the logged-in session.

### Watching the agent work

Set `QA_HEADLESS=false` to open a visible browser window. Useful for debugging or understanding what the agent is doing.

### Writing good prompts

- Be specific about what to test: "Go to /users, click 'Add User', fill in name 'Test User', click Save, verify 'Test User' appears in the list"
- Include expected outcomes: append "Expected outcome: the user appears in the user list with status 'Active'" - this triggers the audit phase
- For multi-step workflows, describe them in order - the planner will figure out dependencies

## Logs

All output is written to `.qa-agent/qa-runner.log`. MCP responses are truncated to ~8000 chars - check the log for the full trace.
