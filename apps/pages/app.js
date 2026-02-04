const elReportSelect = document.getElementById("reportSelect");
const elScenarioMeta = document.getElementById("scenarioMeta");
const elDownloadLink = document.getElementById("downloadLink");
const elAggregateBody = document.querySelector("#aggregateTable tbody");
const elRunsBody = document.querySelector("#runsTable tbody");
const elBuildInfo = document.getElementById("buildInfo");

function fmtNum(value, digits = 3) {
  if (value == null) return "—";
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  return value.toFixed(digits);
}

function fmtInt(value) {
  if (value == null) return "—";
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  return String(value);
}

function fmtMs(value) {
  if (value == null) return "—";
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  return `${Math.round(value)}ms`;
}

function pill(kind, text) {
  const span = document.createElement("span");
  span.className = `pill pill--${kind}`;
  span.textContent = text;
  return span;
}

function okPill(value) {
  if (value === true) return pill("ok", "yes");
  if (value === false) return pill("bad", "no");
  return pill("warn", "—");
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

async function safeFetchJson(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`Fetch failed: ${path} (${r.status})`);
  return await r.json();
}

function shortSha(sha) {
  if (!sha || typeof sha !== "string") return null;
  return sha.slice(0, 7);
}

function renderBuildInfo(info) {
  if (!info || typeof info !== "object") return;
  const parts = [];
  const s = shortSha(info.sha);
  if (info.repository && s) parts.push(`${info.repository}@${s}`);
  if (info.ref) parts.push(info.ref.replace("refs/heads/", ""));
  if (info.generatedAt) parts.push(info.generatedAt);
  elBuildInfo.textContent = parts.join(" • ");
}

function renderScenarioMeta(report) {
  const scenario = report?.scenario ?? {};
  const title = scenario.title ?? "—";
  const id = scenario.id ? `(${scenario.id})` : "";
  const today = scenario.today ? `today=${scenario.today}` : "";
  const seed = typeof scenario.seed === "number" ? `seed=${scenario.seed}` : "";
  const steps = Array.isArray(scenario.steps) ? `steps=${scenario.steps.length}` : "";
  elScenarioMeta.textContent = [title, id, today, seed, steps].filter(Boolean).join(" ");
}

function renderAggregates(report) {
  clear(elAggregateBody);
  const summaries = Array.isArray(report?.summaries) ? report.summaries : [];

  for (const s of summaries) {
    const tr = document.createElement("tr");
    const cfg = s.config ?? "—";
    const a = s.aggregate ?? {};

    tr.appendChild(td(cfg));
    tr.appendChild(td(fmtNum(a.avgQuality, 3)));
    tr.appendChild(td(fmtNum(a.questionLevelAccRate, 3)));
    tr.appendChild(td(fmtInt(a.toolCallsTotal)));
    tr.appendChild(td(fmtInt(a.cachedToolCallsTotal)));
    tr.appendChild(td(fmtMs(a.p90LatencyMs)));
    elAggregateBody.appendChild(tr);
  }
}

function renderRuns(report) {
  clear(elRunsBody);
  const summaries = Array.isArray(report?.summaries) ? report.summaries : [];

  for (const s of summaries) {
    const cfg = s.config ?? "—";
    const runs = Array.isArray(s.runs) ? s.runs : [];
    for (const r of runs) {
      const tr = document.createElement("tr");
      const scores = r.scores ?? {};
      tr.appendChild(td(cfg));
      tr.appendChild(td(fmtInt(r.stepIndex)));
      tr.appendChild(td(r.query ?? "—"));
      tr.appendChild(tdMono(r.runId ?? "—"));
      tr.appendChild(td(fmtInt(r.toolCalls)));
      tr.appendChild(td(fmtInt(r.cachedToolCalls)));
      tr.appendChild(td(fmtMs(r.latencyMs)));
      tr.appendChild(td(fmtNum(scores.quality, 3)));
      tr.appendChild(td(fmtNum(scores.correctness, 3)));
      tr.appendChild(td(fmtNum(scores.completeness, 3)));
      tr.appendChild(td(fmtNum(scores.relevance, 3)));
      tr.appendChild(tdNode(okPill(r.questionLevelAcc)));
      elRunsBody.appendChild(tr);
    }
  }
}

function td(text) {
  const td = document.createElement("td");
  td.textContent = String(text);
  return td;
}

function tdMono(text) {
  const td = document.createElement("td");
  const code = document.createElement("code");
  code.textContent = String(text);
  td.appendChild(code);
  return td;
}

function tdNode(node) {
  const td = document.createElement("td");
  td.appendChild(node);
  return td;
}

function optionLabel(item) {
  const title = item?.scenario?.title ?? "Report";
  const today = item?.scenario?.today ? ` • ${item.scenario.today}` : "";
  return `${title}${today} • ${item.file}`;
}

function updateDownloadLink(file) {
  elDownloadLink.href = `./reports/${encodeURIComponent(file)}`;
}

async function load() {
  try {
    const info = await safeFetchJson("./build-info.json");
    renderBuildInfo(info);
  } catch {
    // ignore
  }

  const manifest = await safeFetchJson("./reports-manifest.json");
  const reports = Array.isArray(manifest?.reports) ? manifest.reports : [];
  clear(elReportSelect);

  if (!reports.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No reports found";
    elReportSelect.appendChild(opt);
    elReportSelect.disabled = true;
    elScenarioMeta.textContent = "No reports found. Generate a report with `pnpm ia scenarios run` and rebuild Pages.";
    return;
  }

  for (const r of reports) {
    const opt = document.createElement("option");
    opt.value = r.file;
    opt.textContent = optionLabel(r);
    elReportSelect.appendChild(opt);
  }

  elReportSelect.addEventListener("change", async () => {
    const file = elReportSelect.value;
    if (!file) return;
    await loadReport(file);
  });

  await loadReport(reports[0].file);
}

async function loadReport(file) {
  updateDownloadLink(file);
  const report = await safeFetchJson(`./reports/${encodeURIComponent(file)}`);
  renderScenarioMeta(report);
  renderAggregates(report);
  renderRuns(report);
}

load().catch((err) => {
  elScenarioMeta.textContent = `Failed to load reports: ${err?.message ?? String(err)}`;
});
