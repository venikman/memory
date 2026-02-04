# Agentic Memory — Insight Agents (recreation)

This repo implements a small, self-contained recreation of the “Insight Agents” architecture with an explicit **agentic memory** layer (leverager + evaluator) and a CLI for running scenarios and comparing configs.

It’s designed to be demoable + inspectable:
- Local deterministic dataset (SQLite)
- Tool-driven “tabular RAG”
- Multi-agent orchestration (manager → planner/executor → generator)
- Long-term memory (SQLite FTS) with leverager (read path) + evaluator (write path)
- Run logs in `runs/` and scenario reports in `reports/`

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

## Share reports (GitHub Pages)

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
