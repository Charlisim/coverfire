import fs from "node:fs";

const MARKER = "<!-- coverfire -->";

function pct(n) {
  return Math.round(n * 100) / 100;
}

function nextLink(link) {
  if (!link) return null;
  const part = link
    .split(",")
    .map((s) => s.trim())
    .find((s) => s.endsWith('rel="next"'));
  return part ? part.match(/<([^>]+)>/)[1] : null;
}

async function gh(url, { token, fetch, method = "GET", body, api } = {}) {
  const res = await fetch(url.startsWith("http") ? url : `${api}${url}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "coverfire",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body,
  });
  return res;
}

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { message: text };
  }
}

function checkName(base, component) {
  return component ? `${base} (${component})` : base;
}

function conclusion(ok) {
  return ok ? "success" : "failure";
}

function annotationsFrom(uncovered) {
  return uncovered.slice(0, 50).map((u) => ({
    path: u.file,
    start_line: u.start,
    end_line: u.end,
    annotation_level: "notice",
    message:
      u.start === u.end
        ? `Line ${u.start} is not covered by tests.`
        : `Lines ${u.start}–${u.end} are not covered by tests.`,
  }));
}

export async function upsertComment({ api, token, fetch, owner, repo, number, body }) {
  let url = `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`;
  let existing = null;
  while (url) {
    const res = await gh(url, { api, token, fetch });
    if (!res.ok) {
      const data = await readJson(res);
      throw new Error(`List comments failed (${res.status}): ${data.message || res.status}`);
    }
    const comments = await readJson(res);
    existing = comments.find((c) => (c.body || "").includes(MARKER));
    if (existing) break;
    url = nextLink(res.headers.get("link"));
  }
  if (existing) {
    const res = await gh(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
      api,
      token,
      fetch,
      method: "PATCH",
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`Update comment failed (${res.status})`);
    return { action: "updated", id: existing.id };
  }
  const res = await gh(`/repos/${owner}/${repo}/issues/${number}/comments`, {
    api,
    token,
    fetch,
    method: "POST",
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const data = await readJson(res);
    throw new Error(`Create comment failed (${res.status}): ${data.message || res.status}`);
  }
  const created = await readJson(res);
  return { action: "created", id: created.id };
}

async function createCheck({ api, token, fetch, owner, repo, sha, name, ok, title, summary, annotations }) {
  const res = await gh(`/repos/${owner}/${repo}/check-runs`, {
    api,
    token,
    fetch,
    method: "POST",
    body: JSON.stringify({
      name,
      head_sha: sha,
      status: "completed",
      conclusion: conclusion(ok),
      output: {
        title,
        summary,
        ...(annotations?.length ? { annotations } : {}),
      },
    }),
  });
  return res;
}

async function createStatus({ api, token, fetch, owner, repo, sha, context, ok, description }) {
  const res = await gh(`/repos/${owner}/${repo}/statuses/${sha}`, {
    api,
    token,
    fetch,
    method: "POST",
    body: JSON.stringify({
      state: ok ? "success" : "failure",
      context,
      description: description.slice(0, 140),
    }),
  });
  return res;
}

function projectOk(result) {
  const min = Number(result.thresholds.min) || 0;
  return !min || result.project.pct >= min;
}

function patchOk(result) {
  const min = Number(result.thresholds.patchMin) || 0;
  return !min || result.patch.total === 0 || result.patch.pct >= min;
}

function changeOk(result) {
  const maxDecrease = result.thresholds.maxDecrease;
  if (maxDecrease == null || result.verdict.delta == null) return true;
  return result.verdict.delta >= -Math.abs(Number(maxDecrease));
}

export async function publishChecks({
  api,
  token,
  fetch,
  owner,
  repo,
  sha,
  result,
  annotate,
}) {
  const component = result.component;
  const checks = [
    {
      name: checkName("coverage/project", component),
      ok: projectOk(result),
      title: `${pct(result.project.pct)}% project coverage`,
      summary: `${result.project.covered}/${result.project.total} lines covered.`,
    },
    {
      name: checkName("coverage/patch", component),
      ok: patchOk(result),
      title: result.patch.total
        ? `${pct(result.patch.pct)}% patch coverage`
        : "No executable lines in diff",
      summary: result.patch.total
        ? `${result.patch.covered}/${result.patch.total} changed executable lines covered.`
        : "Diff has no executable lines in the coverage report.",
      annotations: annotate ? annotationsFrom(result.patch.uncovered) : [],
    },
    {
      name: checkName("coverage/change", component),
      ok: changeOk(result),
      title:
        result.verdict.delta == null
          ? "No base coverage to compare"
          : `${result.verdict.delta >= 0 ? "+" : ""}${pct(result.verdict.delta)}% vs base`,
      summary:
        result.verdict.delta == null
          ? "Pass --base-file to compare against the base branch coverage."
          : `Project coverage changed by ${pct(result.verdict.delta)} points.`,
    },
  ];

  const first = await createCheck({
    api,
    token,
    fetch,
    owner,
    repo,
    sha,
    ...checks[0],
  });
  if (first.status === 403 || first.status === 404) {
    const posted = [];
    for (const c of checks) {
      const res = await createStatus({
        api,
        token,
        fetch,
        owner,
        repo,
        sha,
        context: c.name,
        ok: c.ok,
        description: c.title,
      });
      if (!res.ok) {
        const data = await readJson(res);
        throw new Error(`Status ${c.name} failed (${res.status}): ${data.message || res.status}`);
      }
      posted.push({ name: c.name, kind: "status", ok: c.ok });
    }
    return posted;
  }
  if (!first.ok) {
    const data = await readJson(first);
    throw new Error(`Check run failed (${first.status}): ${data.message || first.status}`);
  }
  const posted = [{ name: checks[0].name, kind: "check", ok: checks[0].ok }];
  for (const c of checks.slice(1)) {
    const res = await createCheck({ api, token, fetch, owner, repo, sha, ...c });
    if (!res.ok) {
      const data = await readJson(res);
      throw new Error(`Check run ${c.name} failed (${res.status}): ${data.message || res.status}`);
    }
    posted.push({ name: c.name, kind: "check", ok: c.ok });
  }
  return posted;
}

export async function publishGithub({
  result,
  markdown,
  token,
  repo,
  pr,
  sha,
  comment,
  checks,
  annotate,
  dryRun,
  fetch,
  api,
  summaryFile,
  log,
  err,
}) {
  if (!repo || !repo.includes("/")) {
    err("Cannot post to GitHub: pass --repo owner/name (or set GITHUB_REPOSITORY).");
    return;
  }
  const [owner, name] = repo.split("/");
  if (summaryFile) {
    try {
      fs.appendFileSync(summaryFile, markdown + "\n");
    } catch (e) {
      err(`Could not write GitHub step summary: ${e.message}`);
    }
  }
  if (dryRun) {
    log(
      JSON.stringify(
        { comment: comment && pr ? markdown : null, checks: checks && sha ? true : false, pr, sha, repo },
        null,
        2,
      ),
    );
    return;
  }
  if (comment && pr) {
    const posted = await upsertComment({
      api,
      token,
      fetch,
      owner,
      repo: name,
      number: pr,
      body: markdown,
    });
    log(`PR comment ${posted.action} (#${pr}).`);
  } else if (comment && !pr) {
    log("No pull request number; skipping comment. Pass --pr on non-PR events.");
  }
  if (checks && sha) {
    const posted = await publishChecks({
      api,
      token,
      fetch,
      owner,
      repo: name,
      sha,
      result,
      annotate,
    });
    log(`Published ${posted.length} GitHub ${posted[0]?.kind || "check"}(s).`);
  } else if (checks && !sha) {
    err("No commit SHA; cannot publish checks. Pass --sha.");
  }
}
