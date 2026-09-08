import assert from "node:assert/strict";
import test from "node:test";
import { publishChecks, publishGithub, upsertComment } from "../lib/github.js";
import { MARKER, parseLcov, renderMarkdown, totals } from "../lib/coverfire.js";

function mockFetch(handler) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    return handler(url, init, calls.length - 1);
  };
  return { fetch, calls };
}

function jsonRes(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] || headers[k] || null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

test("upsertComment creates then updates via marker", async () => {
  const comments = [];
  const { fetch, calls } = mockFetch((url, init) => {
    if (url.includes("/issues/7/comments") && (!init.method || init.method === "GET")) {
      return jsonRes(200, comments);
    }
    if (url.endsWith("/issues/7/comments") && init.method === "POST") {
      const created = { id: 11, body: JSON.parse(init.body).body };
      comments.push(created);
      return jsonRes(201, created);
    }
    if (url.includes("/issues/comments/11") && init.method === "PATCH") {
      comments[0].body = JSON.parse(init.body).body;
      return jsonRes(200, comments[0]);
    }
    return jsonRes(500, { message: url });
  });

  const first = await upsertComment({
    api: "https://api.github.com",
    token: "t",
    fetch,
    owner: "acme",
    repo: "app",
    number: 7,
    body: `${MARKER}\nhello`,
  });
  assert.equal(first.action, "created");

  const second = await upsertComment({
    api: "https://api.github.com",
    token: "t",
    fetch,
    owner: "acme",
    repo: "app",
    number: 7,
    body: `${MARKER}\nupdated`,
  });
  assert.equal(second.action, "updated");
  assert.equal(comments[0].body.includes("updated"), true);
  assert.equal(calls.filter((c) => c.init.method === "POST").length, 1);
});

test("publishChecks falls back to commit statuses on 403", async () => {
  const { fetch, calls } = mockFetch((url, init) => {
    if (url.endsWith("/check-runs")) return jsonRes(403, { message: "Resource not accessible" });
    if (url.includes("/statuses/")) return jsonRes(201, { id: 1 });
    return jsonRes(500, { message: url + " " + init.method });
  });
  const posted = await publishChecks({
    api: "https://api.github.com",
    token: "t",
    fetch,
    owner: "acme",
    repo: "app",
    sha: "abc",
    annotate: false,
    result: {
      component: null,
      project: { covered: 8, total: 10, pct: 80 },
      patch: { covered: 1, total: 1, pct: 100, uncovered: [] },
      verdict: { delta: null, failures: [], ok: true },
      thresholds: { min: 80, patchMin: 80 },
    },
  });
  assert.equal(posted.length, 3);
  assert.equal(posted[0].kind, "status");
  assert.equal(calls.filter((c) => String(c.url).includes("/statuses/")).length, 3);
});

test("publishGithub dry-run does not call the API", async () => {
  const { fetch, calls } = mockFetch(() => jsonRes(500, {}));
  const logs = [];
  const files = parseLcov("SF:a.js\nDA:1,1\nend_of_record");
  const project = totals(files);
  const result = {
    project,
    patch: { covered: 1, total: 1, pct: 100, uncovered: [] },
    verdict: { delta: null, failures: [], ok: true },
    thresholds: { min: 0, patchMin: 0 },
  };
  await publishGithub({
    result,
    markdown: renderMarkdown(result),
    token: "t",
    repo: "acme/app",
    pr: 3,
    sha: "abc",
    comment: true,
    checks: true,
    annotate: true,
    dryRun: true,
    fetch,
    api: "https://api.github.com",
    log: (m) => logs.push(String(m)),
    err: () => {},
  });
  assert.equal(calls.length, 0);
  assert.match(logs.join("\n"), /<!-- coverfire -->/);
});
