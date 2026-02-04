import { Command } from "commander";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { openSellerAnalyticsDb, seedSellerAnalyticsData, SELLER_ANALYTICS_DEFAULTS } from "@ia/data";
import {
  FakeLLMClient,
  IaOrchestrator,
  IaStateStore,
  OpenAICompatLLMClient,
  RunLogger,
  ScenarioRunner,
  type LLMClient,
  type Scenario,
  ScenarioSchema,
  type ScenarioConfigName
} from "@ia/core";

const program = new Command();
program.name("ia").description("Insight Agents + agentic memory experiment").version("0.1.0");

const CLI_PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

loadDotEnvFromRepoRoot();

const MEMORY_MODES = ["baseline", "read", "readwrite", "readwrite_cache"] as const;
type MemoryModeCli = (typeof MEMORY_MODES)[number];

function parseMemoryMode(value: unknown): MemoryModeCli {
  if (typeof value !== "string") throw new Error(`Invalid --memory value: ${String(value)}`);
  const cleaned = value.trim().replace(/[.,;:]+$/, "");
  if ((MEMORY_MODES as readonly string[]).includes(cleaned)) return cleaned as MemoryModeCli;
  throw new Error(`Invalid --memory "${value}". Expected one of: ${MEMORY_MODES.join(", ")}`);
}

const DataOptsSchema = z.object({
  dataDir: z.string().default(".data"),
  datasetPath: z.string().optional()
});

function resolvePaths(dataDir: string) {
  const dir = join(REPO_ROOT, dataDir);
  const memDbPath = process.env.MEM_RAG_DB_PATH;
  return {
    dataDir: dir,
    datasetPath: join(dir, "seller_analytics.sqlite"),
    statePath: memDbPath ? join(REPO_ROOT, memDbPath) : join(dir, "ia_state.sqlite"),
    runsDir: join(REPO_ROOT, "runs"),
    reportsDir: join(REPO_ROOT, "reports")
  };
}

function sellerAnalyticsToolCacheNamespace(seed: number): string {
  const d = SELLER_ANALYTICS_DEFAULTS;
  return `seller_analytics:seed=${seed}:start=${d.startDate}:days=${d.days}:products=${d.productCount}`;
}

function loadLlmClient(opts: { mock?: boolean; fakeMode?: "always-correct" | "baseline-confused" }): LLMClient | null {
  if (opts.mock) return new FakeLLMClient(opts.fakeMode ?? "always-correct");

  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (openRouterKey) {
    const openRouterBaseUrl = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
    const model = process.env.CHAT_MODEL ?? process.env.OPENROUTER_MODEL ?? "grok-4.1-fast";
    return new OpenAICompatLLMClient({ baseUrl: openRouterBaseUrl, model, apiKey: openRouterKey });
  }

  const lmStudioBaseUrl = process.env.LMSTUDIO_BASE_URL;
  const lmStudioModel = process.env.LMSTUDIO_CHAT_MODEL;
  if (lmStudioBaseUrl && lmStudioModel) {
    const apiKey = process.env.LMSTUDIO_API_KEY;
    return new OpenAICompatLLMClient({ baseUrl: lmStudioBaseUrl, model: lmStudioModel, ...(apiKey ? { apiKey } : {}) });
  }

  const baseUrl = process.env.OPENAI_BASE_URL;
  const model = process.env.OPENAI_MODEL;
  if (baseUrl && model) {
    const apiKey = process.env.OPENAI_API_KEY;
    return new OpenAICompatLLMClient({ baseUrl, model, ...(apiKey ? { apiKey } : {}) });
  }

  return null;
}

async function ensureDatasetDb(paths: ReturnType<typeof resolvePaths>, seed: number): Promise<import("node:sqlite").DatabaseSync> {
  mkdirSync(paths.dataDir, { recursive: true });
  const { db } = openSellerAnalyticsDb(paths.datasetPath);
  seedSellerAnalyticsData(db, { seed });
  return db;
}

program
  .command("ask")
  .argument("<query>", "User question")
  .option("--user <id>", "User id (memory namespace)", "demo")
  .option("--memory <mode>", "baseline|read|readwrite|readwrite_cache", "readwrite")
  .option("--seed <n>", "Dataset seed", "42")
  .option("--data-dir <dir>", "Data directory", ".data")
  .option("--mock-llm", "Use a deterministic fake LLM", false)
  .action(async (query: string, options) => {
    const paths = resolvePaths(options.dataDir);
    const llm = loadLlmClient({ mock: options.mockLlm, fakeMode: "always-correct" });
    const seed = Number(options.seed);
    const datasetDb = await ensureDatasetDb(paths, seed);
    const store = new IaStateStore(paths.statePath);
    const memoryMode = parseMemoryMode(options.memory);
    const toolCacheNamespace = sellerAnalyticsToolCacheNamespace(seed);

    const orchestrator = new IaOrchestrator({ llm, datasetDb, store, toolCacheNamespace });
    const result = await orchestrator.runQuery({
      query,
      userId: options.user,
      config: { memoryMode }
    });

    const runLogger = new RunLogger({ runsDir: paths.runsDir });
    runLogger.log(result);

    process.stdout.write(result.responseText + "\n");
    if (result.scores) {
      process.stdout.write(
        `\nEval: quality=${result.scores.quality.toFixed(3)} correctness=${result.scores.correctness.toFixed(3)} completeness=${result.scores.completeness.toFixed(3)} relevance=${result.scores.relevance.toFixed(3)}\n`
      );
    }

    store.close();
    datasetDb.close();
  });

program
  .command("scenarios")
  .description("Scenario runner")
  .command("run")
  .option("--file <path>", "Scenario JSON file", "scenarios/basic.json")
  .option("--user <id>", "User id", "demo")
  .option("--repeat <n>", "Repeat scenario N times (cross-session)", "2")
  .option("--configs <list>", "Comma-separated configs", "baseline,read,readwrite,readwrite_cache")
  .option("--seed <n>", "Dataset seed (overrides scenario seed)", "")
  .option("--data-dir <dir>", "Data directory", ".data")
  .option("--mock-llm", "Use a deterministic fake LLM", false)
  .option("--fake-mode <mode>", "always-correct|baseline-confused", "baseline-confused")
  .action(async (options) => {
    const scenarioPath = resolveExistingPath(options.file, [process.cwd(), CLI_PACKAGE_DIR, REPO_ROOT]);
    const raw = readFileSync(scenarioPath, "utf8");
    const parsed = ScenarioSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) throw new Error(parsed.error.message);
    const scenario: Scenario = parsed.data;

    const paths = resolvePaths(options.dataDir);
    const llm = loadLlmClient({ mock: options.mockLlm, fakeMode: options.fakeMode });

    const seed = options.seed ? Number(options.seed) : scenario.seed;
    const datasetDb = await ensureDatasetDb(paths, seed);
    const toolCacheNamespace = sellerAnalyticsToolCacheNamespace(seed);

    const configs = options.configs.split(",").map((s: string) => parseMemoryMode(s)) as ScenarioConfigName[];
    const repeat = Number(options.repeat);

    const runner = new ScenarioRunner({
      datasetDb,
      llm,
      toolCacheNamespace,
      stateStoreFactory: (config) => new IaStateStore(statePathForConfig(paths.statePath, config))
    });

    const runLogger = new RunLogger({ runsDir: paths.runsDir });
    const summaries = await runner.runScenario({
      scenario,
      userId: options.user,
      configs,
      repeat,
      onRun: (r) => runLogger.log(r)
    });

    mkdirSync(paths.reportsDir, { recursive: true });
    const reportPath = join(
      paths.reportsDir,
      `${new Date().toISOString().replaceAll(":", "").slice(0, 15)}-${scenario.id}.json`
    );
    writeFileSync(reportPath, JSON.stringify({ scenario, summaries }, null, 2), "utf8");

    for (const s of summaries) {
      process.stdout.write(`\n[${s.config}] avgQuality=${s.aggregate.avgQuality?.toFixed(3) ?? "n/a"} qAccRate=${s.aggregate.questionLevelAccRate?.toFixed(3) ?? "n/a"} toolCalls=${s.aggregate.toolCallsTotal} cached=${s.aggregate.cachedToolCallsTotal} p90=${s.aggregate.p90LatencyMs ?? "n/a"}ms\n`);
    }
    process.stdout.write(`\nReport written: ${reportPath}\n`);

    datasetDb.close();
  });

const memoryCmd = program.command("memory").description("Inspect memory store");

memoryCmd
  .command("search")
  .argument("<query>", "FTS query")
  .option("--user <id>", "User id scope", "demo")
  .option("--data-dir <dir>", "Data directory", ".data")
  .option("--state <path>", "State DB path (overrides --data-dir)", "")
  .action((query: string, options) => {
    const paths = resolvePaths(options.dataDir);
    const store = new IaStateStore(options.state ? options.state : paths.statePath);
    const hits = store.searchMemory({ query, scopes: ["global", `user:${options.user}`], limit: 10 });
    for (const h of hits) {
      process.stdout.write(`\n- ${h.kind} ${h.scope} q=${h.quality.toFixed(2)} imp=${h.importance.toFixed(2)} used=${h.useCount} fts=${h.ftsRank.toFixed(3)}\n`);
      process.stdout.write(h.text.slice(0, 300) + (h.text.length > 300 ? "…" : "") + "\n");
    }
    store.close();
  });

memoryCmd
  .command("stats")
  .option("--data-dir <dir>", "Data directory", ".data")
  .option("--state <path>", "State DB path (overrides --data-dir)", "")
  .action((options) => {
    const paths = resolvePaths(options.dataDir);
    const store = new IaStateStore(options.state ? options.state : paths.statePath);
    const stats = store.getMemoryStats();
    for (const s of stats) process.stdout.write(`${s.scope}\t${s.kind}\t${s.count}\n`);
    store.close();
  });

program
  .command("report")
  .description("Print the latest scenario report")
  .option("--file <path>", "Report JSON file (defaults to latest in ./reports)", "")
  .option("--reports-dir <dir>", "Reports directory", "reports")
  .action((options) => {
    const file = options.file || findLatestReport(options.reportsDir);
    if (!file) throw new Error("No report file found.");
    const raw = readFileSync(file, "utf8");
    const json = JSON.parse(raw) as any;
    const summaries = json.summaries as any[] | undefined;
    if (!Array.isArray(summaries)) {
      process.stdout.write(raw + "\n");
      return;
    }
    for (const s of summaries) {
      process.stdout.write(
        `[${s.config}] avgQuality=${s.aggregate?.avgQuality?.toFixed?.(3) ?? "n/a"} qAccRate=${s.aggregate?.questionLevelAccRate?.toFixed?.(3) ?? "n/a"} toolCalls=${s.aggregate?.toolCallsTotal ?? "n/a"} cached=${s.aggregate?.cachedToolCallsTotal ?? "n/a"} p90=${s.aggregate?.p90LatencyMs ?? "n/a"}ms\n`
      );
    }
  });

function findLatestReport(dir: string): string | null {
  try {
    const full = join(REPO_ROOT, dir);
    const files = readdirSync(full)
      .map((f) => join(full, f))
      .filter((p) => p.endsWith(".json"))
      .map((p) => ({ p, m: statSync(p).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    return files[0]?.p ?? null;
  } catch {
    return null;
  }
}

await program.parseAsync(process.argv);

function resolveExistingPath(path: string, baseDirs: string[]): string {
  if (path.startsWith("/") || path.match(/^[A-Za-z]:\\/)) return path;
  for (const base of baseDirs) {
    const candidate = join(base, path);
    try {
      statSync(candidate);
      return candidate;
    } catch {
      // continue
    }
  }
  return path;
}

function statePathForConfig(basePath: string, config: string): string {
  if (basePath.endsWith(".sqlite")) return basePath.replace(/\.sqlite$/, `_${config}.sqlite`);
  return `${basePath}_${config}`;
}

function loadDotEnvFromRepoRoot(): void {
  const candidates = [join(REPO_ROOT, ".env"), join(process.cwd(), ".env")];
  for (const path of candidates) {
    if (!exists(path)) continue;
    const raw = readFileSync(path, "utf8");
    applyDotEnv(raw);
    return;
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function applyDotEnv(contents: string): void {
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const noExport = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
    const eq = noExport.indexOf("=");
    if (eq <= 0) continue;

    const key = noExport.slice(0, eq).trim();
    if (!key) continue;
    if (process.env[key] != null) continue;

    let value = noExport.slice(eq + 1).trim();
    value = stripInlineComment(value);
    value = unquote(value);
    process.env[key] = value;
  }
}

function stripInlineComment(value: string): string {
  // Keep everything inside quotes.
  if (value.startsWith("'") || value.startsWith("\"")) return value;
  const hash = value.indexOf("#");
  return hash >= 0 ? value.slice(0, hash).trimEnd() : value;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
    const inner = value.slice(1, -1);
    return inner.replaceAll("\\n", "\n").replaceAll("\\r", "\r").replaceAll("\\t", "\t").replaceAll("\\\"", "\"").replaceAll("\\\\", "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}
