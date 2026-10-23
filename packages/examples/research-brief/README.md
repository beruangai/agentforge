# research-brief

AgentForge's realistic non-coding example on the `strands` framework: a **briefer** agent answers a question from a corpus of documents with a brief whose every claim cites the documents it rests on, in their own words. `golden-kata` is its `claude` counterpart.

## How it was generated

```bash
nx g @beruangai/agentforge:agentic-project research-brief --directory packages/examples --framework strands
nx g @beruangai/agentforge:agent --project research-brief briefer --procedure Brief
nx sync
```

What follows was written by hand into the scaffolded files.

## What it holds

| Layer | Holds |
|---|---|
| `base/agentic` | `options.ts` — Sonnet, 8,192 output tokens; `AGENTS.md` |
| `agents/briefer` | `Brief({ corpus, question, glossary })`: the corpus is `corpora/<corpus>/` of the `documents` S3 filesystem, only read. The answer's schema is built per run, so a citation names a document of this corpus and quotes words it holds, or is refused in the agent's turn; a stop guard holds the answer until the file tool has viewed every document; the terms the corpus defines are kept in the memory space `glossary`, which later briefs search. The handler adds the count of documents |

## Running it

```bash
nx run @beruangai/research-brief:e2e
```

`e2e` serves the briefer locally with `ANTHROPIC_API_KEY` from the root `.env.serve.local`, uploads a three-document corpus to the local store, and asserts each citation's quote against its document, the document count, and the glossary kept under `briefer/memory/<glossary>/`; and that an empty corpus fails before the model is asked.

```bash
nx run @beruangai/research-brief:e2e-agentcore
```

`e2e-agentcore` deploys [research-brief-infra](../research-brief-infra/README.md) with the operator's credentials and runs the `agentcore` project as the test role: the corpus uploaded to the documents bucket, the citations, and the glossary in the session bucket.
