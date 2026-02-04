import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const PAGES_SRC_DIR = process.env.PAGES_SRC_DIR ?? join(REPO_ROOT, "apps/pages");
const REPORTS_DIR = process.env.REPORTS_DIR ?? join(REPO_ROOT, "reports");
const OUT_DIR = process.env.PAGES_OUT_DIR ?? join(REPO_ROOT, "site");

function exists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function safeAggregate(summary) {
  const a = summary?.aggregate ?? {};
  return {
    avgQuality: typeof a.avgQuality === "number" ? a.avgQuality : null,
    questionLevelAccRate: typeof a.questionLevelAccRate === "number" ? a.questionLevelAccRate : null,
    toolCallsTotal: typeof a.toolCallsTotal === "number" ? a.toolCallsTotal : null,
    cachedToolCallsTotal: typeof a.cachedToolCallsTotal === "number" ? a.cachedToolCallsTotal : null,
    p90LatencyMs: typeof a.p90LatencyMs === "number" ? a.p90LatencyMs : null
  };
}

function buildManifest(reportFiles) {
  const reports = [];
  for (const f of reportFiles) {
    const path = join(REPORTS_DIR, f);
    const json = readJson(path);
    const scenario = json?.scenario ?? {};
    const summaries = Array.isArray(json?.summaries) ? json.summaries : [];
    const configs = summaries
      .filter((s) => s && typeof s.config === "string")
      .map((s) => ({
        config: s.config,
        aggregate: safeAggregate(s)
      }));

    const mtimeMs = statSync(path).mtimeMs;
    reports.push({
      file: f,
      mtimeMs,
      scenario: {
        id: typeof scenario.id === "string" ? scenario.id : null,
        title: typeof scenario.title === "string" ? scenario.title : null,
        seed: typeof scenario.seed === "number" ? scenario.seed : null,
        today: typeof scenario.today === "string" ? scenario.today : null,
        steps: Array.isArray(scenario.steps)
          ? scenario.steps
              .filter((s) => s && typeof s.id === "string" && typeof s.query === "string")
              .map((s) => ({ id: s.id, query: s.query }))
          : []
      },
      configs
    });
  }

  reports.sort((a, b) => b.mtimeMs - a.mtimeMs);

  return {
    generatedAt: new Date().toISOString(),
    reports
  };
}

function buildInfo() {
  return {
    generatedAt: new Date().toISOString(),
    repository: process.env.GITHUB_REPOSITORY ?? null,
    ref: process.env.GITHUB_REF ?? null,
    sha: process.env.GITHUB_SHA ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runNumber: process.env.GITHUB_RUN_NUMBER ?? null
  };
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

cpSync(PAGES_SRC_DIR, OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, ".nojekyll"), "", "utf8");

const outReportsDir = join(OUT_DIR, "reports");
mkdirSync(outReportsDir, { recursive: true });

const reportFiles = exists(REPORTS_DIR) ? readdirSync(REPORTS_DIR).filter((f) => f.endsWith(".json")) : [];
for (const f of reportFiles) {
  cpSync(join(REPORTS_DIR, f), join(outReportsDir, f));
}

const manifest = buildManifest(reportFiles);
writeFileSync(join(OUT_DIR, "reports-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
writeFileSync(join(OUT_DIR, "build-info.json"), JSON.stringify(buildInfo(), null, 2) + "\n", "utf8");

process.stdout.write(`Built site: ${OUT_DIR}\n`);
process.stdout.write(`Reports: ${reportFiles.length}\n`);
