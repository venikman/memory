# Agentic Memory — Insight Agents (recreation)

This repo implements a small, self-contained recreation of the “Insight Agents” architecture with an explicit **agentic memory** layer (leverager + evaluator) and a CLI for running scenarios and comparing configs.

Live demo: [https://venikman.github.io/memory/](https://venikman.github.io/memory/)

It’s designed to be demoable + inspectable:
- Local deterministic dataset (SQLite)
- Tool-driven “tabular RAG”
- Multi-agent orchestration (manager → planner/executor → generator)
- Long-term memory (SQLite FTS) with leverager (read path) + evaluator (write path)
- Run logs in `runs/` and scenario reports in `reports/`

![Reports dashboard (GitHub Pages)](.github/assets/pages-screenshot.png)

## Architecture at a glance

```
CLI
  |
Manager
  |
Planner/Executor  --->  Tools / Data
  |
  +--> Leverager (read) ---> Memory (SQLite FTS)
  |                           ^
  |                           |
  |                    Evaluator (write)
  |
  +--> Insight Generator  ---> Narrative answer
  +--> Data Presenter     ---> Deterministic answer
```

## Prerequisites

- Node.js 22 (matches CI)
- pnpm 10.28.0 (matches `package.json`)

## Quick start

1) Install deps:
```bash
pnpm install
```

2) Run a scenario suite:
```bash
pnpm ia scenarios run
```

3) Ask ad-hoc questions:
```bash
pnpm ia ask "What were the sales for my top 10 products last month?"
```

Memory modes:
- `--memory baseline` (no long-term memory)
- `--memory read` (retrieve/inject only)
- `--memory readwrite` (retrieve + evaluate/write)
- `--memory readwrite_cache` (also caches tool results in the state DB)

## Common commands

| Command | Purpose |
| --- | --- |
| `pnpm ia scenarios run` | Run the scenario suite |
| `pnpm ia ask "<question>"` | Ask an ad-hoc question |
| `pnpm pages:build` | Build the static Pages site into `site/` |
| `pnpm test` | Run tests across packages |
| `pnpm typecheck` | Run type checks across packages |
| `pnpm build` | Build all packages |

## Repo layout

- `apps/` — CLI and app entrypoints
- `packages/` — core agents, memory, tools
- `scripts/` — build and report helpers
- `site/` — GitHub Pages output
- `runs/` and `reports/` — generated artifacts
- `.data/` — local SQLite DBs

## Share reports (GitHub Pages)

- Live site: [https://venikman.github.io/memory/](https://venikman.github.io/memory/)
- Local build:
  - `pnpm ia scenarios run --mock-llm`
  - `pnpm pages:build` (outputs `site/`)
- CI deploy: `.github/workflows/pages.yml` builds a static dashboard and deploys it to GitHub Pages on pushes to `main`.
  - Optional: set Actions secret `OPENROUTER_API_KEY` to run scenarios with a real LLM (keeps the key off the frontend).

## Config

Copy `.env.example` → `.env` and fill in one provider.

OpenRouter (OpenAI-compatible):
- `OPENROUTER_API_KEY`
- `OPENROUTER_BASE_URL` (default `https://openrouter.ai/api/v1`)
- `CHAT_MODEL` (default `x-ai/grok-4.1-fast`)

LM Studio (OpenAI-compatible):
- `LMSTUDIO_BASE_URL` (e.g. `http://localhost:1234/v1`)
- `LMSTUDIO_CHAT_MODEL`
- `LMSTUDIO_API_KEY` (optional)

Storage:
- `MEM_RAG_DB_PATH` (defaults to `.data/mem-rag.sqlite`)

## Where answers come from

- `data_presenter` route: final answer text is deterministic rendering of tool results (no LLM writing the output).
- `insight_generator` route: tools fetch data, then the LLM writes the narrative **grounded on `{ plan, toolCalls }` JSON**.
