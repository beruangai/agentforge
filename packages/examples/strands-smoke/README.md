# strands-smoke

AgentForge's coverage example on the `strands` framework: one agent, **hello-agent**, on Strands Agents and the Anthropic API, holding what AgentForge does around a strands run. `smoke-coverage` holds the same for `claude`.

## How it was generated

```bash
nx g @beruangai/agentforge:agentic-project strands-smoke --directory packages/examples --framework strands
nx g @beruangai/agentforge:agent --project strands-smoke hello-agent --procedure Summarise
nx sync
```

What follows was written by hand into the scaffolded files.

## What it holds

| Layer | Holds |
|---|---|
| `base/agentic` | `options.ts` — Haiku, 4,096 output tokens; `AGENTS.md` |
| `agents/hello-agent` | `Summarise({ text, resumeSessionId? })`, resuming a session when given one; `SleepThenAnswer({ seconds })`, a shell command to cancel mid-run, on a 300-second budget; `KeepNote` and `RecallNote({ topic })`, a note written through the file tool into the `notebook` S3 filesystem and read back by a later task; `AGENTS.md` |

## Running it

```bash
nx run @beruangai/strands-smoke:e2e
```

`e2e` serves hello-agent locally with `ANTHROPIC_API_KEY` from the root `.env.serve.local`, and asserts the run record and its session through `readSession`, the layers' `AGENTS.md` composed base first into the system prompt, a session resumed from the local store, the note across tasks, and a cancel mid-shell.

```bash
nx run @beruangai/strands-smoke:e2e-agentcore
```

`e2e-agentcore` deploys [strands-smoke-infra](../strands-smoke-infra/README.md) with the operator's credentials and runs the `agentcore` project as the test role: a retry attaches, a session resumes and a note is read back in another container, and a run is cancelled mid-shell.
