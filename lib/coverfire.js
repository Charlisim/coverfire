import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { publishGithub } from "./github.js";

export const MARKER = "<!-- coverfire -->";

const CANDIDATES = [
  "coverage/lcov.info",
  "coverage/coverage-final.json",
  "coverage/clover.xml",
  "build/logs/clover.xml",
  "coverage/cobertura-coverage.xml",
  "coverage.xml",
];

const HELP = `coverfire — coverage that blocks the merge

Usage: coverfire [options]

  --file <path>          Coverage file (repeatable). Auto-detected if omitted
  --base <ref>           Git base ref/sha for patch coverage
  --base-file <path>     Coverage from the base branch (enables project delta)
  --min <n>              Fail if project coverage < n (0 = off)
  --patch-min <n>        Fail if patch coverage < n (0 = off)
  --max-decrease <n>     Fail if project coverage drops more than n points
  --ignore <glob>        Ignore coverage files matching glob (repeatable)
  --comment              Upsert a GitHub PR comment
  --checks               Publish GitHub check runs (falls back to commit statuses)
  --no-comment           Do not post a PR comment
  --no-checks            Do not publish checks
  --no-annotate          Skip line annotations on the patch check
  --pr <n>               Pull request number
  --repo <owner/name>    GitHub repository
  --sha <sha>            Commit SHA for checks
  --token <token>        GitHub token (or GITHUB_TOKEN / GH_TOKEN)
  --component <name>     Label for monorepos (appears on comments/checks)
  --dry-run              Print GitHub payloads, do not post
  --json                 Machine-readable JSON on stdout
  --quiet                Only print failures
  -h, --help

GitHub Actions enables --comment and --checks automatically when GITHUB_TOKEN is set.
No GitHub App. The workflow token is enough (see README for permissions).
`;

export function parseArgs(argv) {
  const out = {
    files: [],
    ignore: [],
    comment: null,
    checks: null,
    annotate: true,
    dryRun: false,
    json: false,
    quiet: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v == null) throw new Error(`Missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "-h":
      case "--help":
        out.help = true;
        break;
      case "--file":
        out.files.push(next());
        break;
      case "--base":
        out.base = next();
        break;
      case "--base-file":
        out.baseFile = next();
        break;
      case "--min":
        out.min = Number(next());
        break;
      case "--patch-min":
        out.patchMin = Number(next());
        break;
      case "--max-decrease":
        out.maxDecrease = Number(next());
        break;
      case "--ignore":
        out.ignore.push(next());
        break;
      case "--comment":
        out.comment = true;
        break;
      case "--checks":
        out.checks = true;
        break;
      case "--no-comment":
        out.comment = false;
        break;
      case "--no-checks":
        out.checks = false;
        break;
      case "--no-annotate":
        out.annotate = false;
        break;
      case "--pr":
        out.pr = Number(next());
        break;
      case "--repo":
        out.repo = next();
        break;
      case "--sha":
        out.sha = next();
        break;
      case "--token":
        out.token = next();
        break;
      case "--component":
        out.component = next();
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--json":
        out.json = true;
        break;
      case "--quiet":
        out.quiet = true;
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  return out;
}

export function loadConfig(cwd) {
  const p = path.join(cwd, "coverfire.json");
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function matchGlob(filePath, pattern) {
  const norm = filePath.replaceAll("\\", "/");
  const esc = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, ".*");
  return new RegExp(`^${esc}$`).test(norm);
}

export function findCoverageFile(cwd) {
  return CANDIDATES.map((rel) => path.join(cwd, rel)).find((p) => fs.existsSync(p)) ?? null;
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : "";
}

export function parseLcov(text) {
  const files = new Map();
  let current = null;
  let hits = null;
  const flush = () => {
    if (current && hits) files.set(current, hits);
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      flush();
      current = line.slice(3).trim();
      hits = new Map();
    } else if (line.startsWith("DA:") && hits) {
      const [ln, count] = line.slice(3).split(",");
      hits.set(Number(ln), Number(count));
    } else if (line === "end_of_record") {
      flush();
      current = null;
      hits = null;
    }
  }
  flush();
  return files;
}

export function parseIstanbul(json) {
  const files = new Map();
  const data = json.data && typeof json.data === "object" ? json.data : json;
  for (const [key, file] of Object.entries(data)) {
    if (!file || typeof file !== "object") continue;
    const filePath = file.path || key;
    const hits = new Map();
    for (const [id, stmt] of Object.entries(file.statementMap || {})) {
      const line = stmt?.start?.line;
      if (!line) continue;
      const n = Number(file.s?.[id] || 0);
      hits.set(line, (hits.get(line) || 0) + n);
    }
    if (hits.size) files.set(filePath, hits);
  }
  return files;
}

export function parseClover(xml) {
  const files = new Map();
  const fileRe = /<file\b([^>]*)>([\s\S]*?)<\/file>/gi;
  let m;
  while ((m = fileRe.exec(xml))) {
    const filePath = attr(m[1], "path") || attr(m[1], "name");
    if (!filePath) continue;
    const hits = new Map();
    const lineRe = /<line\b([^>]*)\/?>/gi;
    let l;
    while ((l = lineRe.exec(m[2]))) {
      const num = Number(attr(l[1], "num"));
      if (!num) continue;
      hits.set(num, Number(attr(l[1], "count") || 0));
    }
    if (hits.size) files.set(filePath, hits);
  }
  return files;
}

export function parseCobertura(xml) {
  const files = new Map();
  const classRe = /<class\b([^>]*)>([\s\S]*?)<\/class>/gi;
  let m;
  while ((m = classRe.exec(xml))) {
    const filePath = attr(m[1], "filename") || attr(m[1], "name");
    if (!filePath) continue;
    const hits = files.get(filePath) || new Map();
    const lineRe = /<line\b([^>]*)\/?>/gi;
    let l;
    while ((l = lineRe.exec(m[2]))) {
      const num = Number(attr(l[1], "number"));
      if (!num) continue;
      hits.set(num, (hits.get(num) || 0) + Number(attr(l[1], "hits") || 0));
    }
    if (hits.size) files.set(filePath, hits);
  }
  return files;
}

export function detectFormat(text, filename = "") {
  const t = text.trim();
  const lower = filename.replaceAll("\\", "/").toLowerCase();
  if (lower.endsWith(".info") || t.startsWith("TN:") || t.startsWith("SF:") || t.includes("\nSF:")) {
    return "lcov";
  }
  if (lower.endsWith(".json") || t.startsWith("{")) return "istanbul";
  if (/clover/i.test(t) || /<file\b[^>]*\bpath=/.test(t)) return "clover";
  if (/cobertura/i.test(t) || t.includes("<packages>")) return "cobertura";
  if (t.includes("<coverage")) return "clover";
  throw new Error(`Unknown coverage format${filename ? ` for ${filename}` : ""}`);
}

export function parseCoverage(text, { filename = "" } = {}) {
  const format = detectFormat(text, filename);
  if (format === "lcov") return parseLcov(text);
  if (format === "istanbul") return parseIstanbul(JSON.parse(text));
  if (format === "clover") return parseClover(text);
  return parseCobertura(text);
}

export function mergeCoverage(maps) {
  const out = new Map();
  for (const files of maps) {
    for (const [file, hits] of files) {
      const dest = out.get(file) || new Map();
      for (const [line, n] of hits) dest.set(line, (dest.get(line) || 0) + n);
      out.set(file, dest);
    }
  }
  return out;
}

export function normalizePath(filePath, root) {
  let p = filePath.replaceAll("\\", "/");
  const r = root.replaceAll("\\", "/").replace(/\/$/, "");
  if (p.startsWith(r + "/")) p = p.slice(r.length + 1);
  return p.replace(/^\.\//, "");
}

export function normalizeCoverage(files, root, ignore = []) {
  const out = new Map();
  for (const [file, hits] of files) {
    const rel = normalizePath(file, root);
    if (ignore.some((g) => matchGlob(rel, g))) continue;
    const dest = out.get(rel) || new Map();
    for (const [line, n] of hits) dest.set(line, (dest.get(line) || 0) + n);
    out.set(rel, dest);
  }
  return out;
}

export function totals(files) {
  let covered = 0;
  let total = 0;
  for (const hits of files.values()) {
    for (const n of hits.values()) {
      total++;
      if (n > 0) covered++;
    }
  }
  return { covered, total, pct: total ? (covered / total) * 100 : 100 };
}

export function changedLines(diff) {
  const files = new Map();
  let file = null;
  let newLine = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      file = line.slice(6);
      if (file === "/dev/null") {
        file = null;
        continue;
      }
      if (!files.has(file)) files.set(file, new Set());
      continue;
    }
    if (line.startsWith("+++ ")) continue;
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!file) continue;
    if (line.startsWith("+")) {
      files.get(file).add(newLine);
      newLine++;
    } else if (line.startsWith("-") || line.startsWith("\\")) {
      // removed line / "\ No newline" — do not advance the new-file cursor
    } else if (line.startsWith(" ")) {
      newLine++;
    }
  }
  return files;
}

export function computePatch(coverage, changed) {
  let covered = 0;
  let total = 0;
  const uncovered = [];
  for (const [file, lines] of changed) {
    const hits = coverage.get(file);
    if (!hits) continue;
    const missed = [];
    for (const line of [...lines].sort((a, b) => a - b)) {
      if (!hits.has(line)) continue;
      total++;
      if (hits.get(line) > 0) covered++;
      else missed.push(line);
    }
    for (const range of groupRanges(missed)) uncovered.push({ file, ...range });
  }
  return { covered, total, pct: total ? (covered / total) * 100 : 100, uncovered };
}

export function groupRanges(lines) {
  const ranges = [];
  for (const line of lines) {
    const last = ranges.at(-1);
    if (last && last.end === line - 1) last.end = line;
    else ranges.push({ start: line, end: line });
  }
  return ranges;
}

export function pct(n) {
  return Math.round(n * 100) / 100;
}

export function evaluate({ project, patch, baseProject }, thresholds) {
  const min = Number(thresholds.min) || 0;
  const patchMin = Number(thresholds.patchMin) || 0;
  const maxDecrease = thresholds.maxDecrease;
  const delta = baseProject ? project.pct - baseProject.pct : null;
  const failures = [];
  if (min && project.pct < min) {
    failures.push(`Project coverage ${pct(project.pct)}% is below minimum ${min}%`);
  }
  if (patchMin && patch.total > 0 && patch.pct < patchMin) {
    failures.push(`Patch coverage ${pct(patch.pct)}% is below minimum ${patchMin}%`);
  }
  if (maxDecrease != null && delta != null && delta < -Math.abs(Number(maxDecrease))) {
    failures.push(
      `Coverage decreased ${pct(Math.abs(delta))} points (max allowed ${Number(maxDecrease)})`,
    );
  }
  return { delta, failures, ok: failures.length === 0 };
}

function fmtDelta(delta) {
  if (delta == null) return "n/a";
  const n = pct(delta);
  return n > 0 ? `+${n}%` : `${n}%`;
}

export function renderMarkdown(result) {
  const { project, patch, verdict, component, thresholds } = result;
  const title = component ? `Coverage (${component})` : "Coverage";
  const rows = [
    `| | Current | Threshold |`,
    `| --- | ---: | ---: |`,
    `| Project | ${pct(project.pct)}% (${project.covered}/${project.total}) ${fmtDelta(verdict.delta)} | ${thresholds.min || "—"} |`,
    `| Patch | ${patch.total ? `${pct(patch.pct)}% (${patch.covered}/${patch.total})` : "no executable lines"} | ${thresholds.patchMin || "—"} |`,
  ];
  const warns = verdict.failures.map((f) => `> **Warning** ${f}`).join("\n\n");
  const missed = result.patch.uncovered.slice(0, 40);
  const missBlock = missed.length
    ? `\n### Uncovered in this diff\n\n${missed
        .map((u) =>
          u.start === u.end
            ? `- \`${u.file}:${u.start}\``
            : `- \`${u.file}:${u.start}-${u.end}\``,
        )
        .join("\n")}${result.patch.uncovered.length > 40 ? `\n- …${result.patch.uncovered.length - 40} more` : ""}`
    : "";
  return [
    MARKER,
    `## ${title}`,
    "",
    warns,
    warns ? "" : "",
    rows.join("\n"),
    missBlock,
    "",
    `<sub>Posted by coverfire. Comment is updated in place on new pushes.</sub>`,
  ]
    .filter((x) => x != null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

export function renderText(result) {
  const lines = [
    `project  ${pct(result.project.pct)}%  (${result.project.covered}/${result.project.total})  delta ${fmtDelta(result.verdict.delta)}`,
    `patch    ${result.patch.total ? `${pct(result.patch.pct)}%  (${result.patch.covered}/${result.patch.total})` : "n/a"}`,
  ];
  for (const f of result.verdict.failures) lines.push(`FAIL  ${f}`);
  if (result.verdict.ok) lines.push("PASS");
  return lines.join("\n");
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 20 * 1024 * 1024,
  }).trim();
}

function gitOk(args, cwd) {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

export function detectBase(cwd, preferred) {
  if (preferred) return preferred;
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    if (gitOk(["rev-parse", "--verify", ref], cwd)) {
      return gitOk(["merge-base", "HEAD", ref], cwd) || ref;
    }
  }
  return gitOk(["rev-parse", "HEAD~1"], cwd);
}

export function parseRemote(url) {
  if (!url) return {};
  const m = url.trim().match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/i);
  return m ? { owner: m[1], repo: m[2] } : {};
}

export function githubContext(env, cwd) {
  let event = {};
  if (env.GITHUB_EVENT_PATH && fs.existsSync(env.GITHUB_EVENT_PATH)) {
    try {
      event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    } catch {
      event = {};
    }
  }
  const fromEnv = (env.GITHUB_REPOSITORY || "").split("/");
  const remote = parseRemote(gitOk(["remote", "get-url", "origin"], cwd) || "");
  const owner = fromEnv[0] || remote.owner;
  const repo = fromEnv[1] || remote.repo;
  const number = event.pull_request?.number || event.number || undefined;
  const sha = env.GITHUB_SHA || gitOk(["rev-parse", "HEAD"], cwd);
  const base =
    event.pull_request?.base?.sha ||
    (event.before && event.before !== "0000000000000000000000000000000000000000"
      ? event.before
      : undefined);
  return { owner, repo, number, sha, base, eventName: env.GITHUB_EVENT_NAME };
}

function readCoverageMaps(files, cwd) {
  const maps = [];
  for (const file of files) {
    const abs = path.resolve(cwd, file);
    if (!fs.existsSync(abs)) throw new Error(`Coverage file not found: ${file}`);
    maps.push(parseCoverage(fs.readFileSync(abs, "utf8"), { filename: abs }));
  }
  return maps;
}

export async function run(argv, env = process.env, io = {}) {
  const log = io.log || console.log;
  const err = io.err || console.error;
  const cwd = io.cwd || process.cwd();
  const fetchImpl = io.fetch || globalThis.fetch;

  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err(e.message);
    return 2;
  }
  if (args.help) {
    log(HELP);
    return 0;
  }

  const fileCfg = loadConfig(cwd);
  const files = args.files.length
    ? args.files
    : fileCfg.file
      ? [fileCfg.file].flat()
      : (() => {
          const found = findCoverageFile(cwd);
          return found ? [found] : [];
        })();
  if (!files.length) {
    err(
      "No coverage file found. Pass --file or generate one of: coverage/lcov.info, coverage/coverage-final.json, coverage/clover.xml",
    );
    return 2;
  }

  const ignore = [...(fileCfg.ignore || []), ...args.ignore];
  const coverage = normalizeCoverage(mergeCoverage(readCoverageMaps(files, cwd)), cwd, ignore);
  const project = totals(coverage);

  let baseProject = null;
  const baseFile = args.baseFile || fileCfg.baseFile;
  if (baseFile) {
    baseProject = totals(
      normalizeCoverage(mergeCoverage(readCoverageMaps([baseFile], cwd)), cwd, ignore),
    );
  }

  const ctx = githubContext(env, cwd);
  const base = detectBase(cwd, args.base || fileCfg.base || ctx.base);
  const gitHead = args.sha || ctx.sha;
  const head = gitHead || "HEAD";
  let patch = { covered: 0, total: 0, pct: 100, uncovered: [] };
  if (base) {
    const diff = gitOk(["diff", "-U0", "--no-color", "--diff-filter=ACMR", `${base}...${head}`], cwd);
    if (diff) {
      const changed = changedLines(diff);
      const relChanged = new Map();
      for (const [file, lines] of changed) {
        relChanged.set(normalizePath(file, cwd), lines);
      }
      patch = computePatch(coverage, relChanged);
    }
  }

  const thresholds = {
    min: args.min ?? fileCfg.min ?? 0,
    patchMin: args.patchMin ?? fileCfg.patchMin ?? 0,
    maxDecrease: args.maxDecrease ?? fileCfg.maxDecrease,
  };
  const verdict = evaluate({ project, patch, baseProject }, thresholds);
  const component = args.component || fileCfg.component;
  const result = { project, patch, baseProject, verdict, thresholds, component, files, base, head };

  if (args.json) log(JSON.stringify(result, null, 2));
  else if (!args.quiet || !verdict.ok) log(renderText(result));

  const token = args.token || env.GITHUB_TOKEN || env.GH_TOKEN;
  const inActions = env.GITHUB_ACTIONS === "true";
  const wantComment = args.comment ?? fileCfg.github?.comment ?? inActions;
  const wantChecks = args.checks ?? fileCfg.github?.checks ?? inActions;
  if ((wantComment || wantChecks) && token) {
    const repo = args.repo || (ctx.owner && ctx.repo ? `${ctx.owner}/${ctx.repo}` : null);
    try {
      await publishGithub({
        result,
        markdown: renderMarkdown(result),
        token,
        repo,
        pr: args.pr || ctx.number,
        sha: gitHead,
        comment: wantComment,
        checks: wantChecks,
        annotate: args.annotate && fileCfg.github?.annotate !== false,
        dryRun: args.dryRun,
        fetch: fetchImpl,
        api: env.GITHUB_API_URL || "https://api.github.com",
        summaryFile: env.GITHUB_STEP_SUMMARY,
        log,
        err,
      });
    } catch (e) {
      err(e.message);
      err(
        "GitHub publish failed. For Actions, set:\n  permissions:\n    contents: read\n    pull-requests: write\n    checks: write\n    statuses: write",
      );
      return 2;
    }
  } else if ((wantComment || wantChecks) && !token && inActions) {
    err("GITHUB_TOKEN is missing; cannot post PR comments or checks.");
    return 2;
  }

  return verdict.ok ? 0 : 1;
}
