import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  changedLines,
  computePatch,
  detectFormat,
  evaluate,
  groupRanges,
  matchGlob,
  mergeCoverage,
  normalizeCoverage,
  parseArgs,
  parseCobertura,
  parseClover,
  parseCoverage,
  parseIstanbul,
  parseLcov,
  parseRemote,
  renderMarkdown,
  run,
  totals,
} from "../lib/coverfire.js";

const LCOV = `TN:
SF:src/a.js
DA:1,1
DA:2,0
DA:3,4
end_of_record
SF:/abs/src/b.js
DA:10,0
DA:11,1
end_of_record
`;

test("parseLcov reads per-line hits", () => {
  const files = parseLcov(LCOV);
  assert.equal(files.get("src/a.js").get(2), 0);
  assert.equal(files.get("src/a.js").get(3), 4);
  assert.equal(files.get("/abs/src/b.js").get(10), 0);
});

test("parseClover and parseCobertura", () => {
  const clover = parseClover(`
    <coverage><project>
      <file path="src/a.js">
        <line num="1" count="1"/>
        <line num="2" count="0"/>
      </file>
    </project></coverage>`);
  assert.equal(clover.get("src/a.js").get(2), 0);

  const cob = parseCobertura(`
    <coverage><packages><package>
      <classes>
        <class filename="src/a.js">
          <lines>
            <line number="1" hits="2"/>
            <line number="2" hits="0"/>
          </lines>
        </class>
      </classes>
    </package></packages></coverage>`);
  assert.equal(cob.get("src/a.js").get(1), 2);
});

test("parseIstanbul uses statementMap lines", () => {
  const files = parseIstanbul({
    "src/a.js": {
      path: "src/a.js",
      statementMap: {
        "0": { start: { line: 1 } },
        "1": { start: { line: 2 } },
      },
      s: { "0": 1, "1": 0 },
    },
  });
  assert.equal(files.get("src/a.js").get(1), 1);
  assert.equal(files.get("src/a.js").get(2), 0);
});

test("detectFormat", () => {
  assert.equal(detectFormat("SF:foo.js\nDA:1,1\nend_of_record"), "lcov");
  assert.equal(detectFormat('{"a":{"statementMap":{}}}'), "istanbul");
  assert.equal(detectFormat('<coverage generated="1"><file path="a.js">'), "clover");
  assert.equal(detectFormat('<coverage><packages></packages>'), "cobertura");
});

test("changedLines from unified diff -U0", () => {
  const diff = `diff --git a/src/a.js b/src/a.js
--- a/src/a.js
+++ b/src/a.js
@@ -1,0 +2,2 @@
+two
+three
@@ -10 +12,0 @@
-gone
`;
  const files = changedLines(diff);
  assert.deepEqual([...files.get("src/a.js")].sort((a, b) => a - b), [2, 3]);
});

test("computePatch ignores non-executable lines and groups misses", () => {
  const coverage = parseLcov(LCOV);
  const changed = new Map([["src/a.js", new Set([1, 2, 3, 99])]]);
  const patch = computePatch(coverage, changed);
  assert.equal(patch.total, 3);
  assert.equal(patch.covered, 2);
  assert.deepEqual(patch.uncovered, [{ file: "src/a.js", start: 2, end: 2 }]);
  assert.deepEqual(groupRanges([4, 5, 6, 9]), [
    { start: 4, end: 6 },
    { start: 9, end: 9 },
  ]);
});

test("evaluate thresholds: 0 is off, empty patch passes", () => {
  const project = { covered: 50, total: 100, pct: 50 };
  const patchEmpty = { covered: 0, total: 0, pct: 100, uncovered: [] };
  assert.equal(evaluate({ project, patch: patchEmpty }, { min: 0, patchMin: 80 }).ok, true);
  assert.equal(evaluate({ project, patch: patchEmpty }, { min: 80 }).ok, false);
  assert.equal(
    evaluate({ project, patch: { ...patchEmpty, total: 10, covered: 5, pct: 50 } }, { patchMin: 80 })
      .ok,
    false,
  );
  assert.equal(
    evaluate({ project, patch: patchEmpty, baseProject: { pct: 52 } }, { maxDecrease: 1 }).ok,
    false,
  );
  assert.equal(
    evaluate({ project, patch: patchEmpty, baseProject: { pct: 50.5 } }, { maxDecrease: 1 }).ok,
    true,
  );
});

test("normalizeCoverage strips root and ignore globs", () => {
  const files = mergeCoverage([parseLcov(LCOV)]);
  const norm = normalizeCoverage(files, "/abs", ["src/a.js"]);
  assert.equal(norm.has("src/a.js"), false);
  assert.equal(norm.get("src/b.js").get(11), 1);
  assert.equal(matchGlob("lib/foo.test.js", "**/*.test.js"), true);
  assert.equal(matchGlob("lib/foo.js", "**/*.test.js"), false);
});

test("totals and markdown marker", () => {
  const project = totals(parseLcov(LCOV));
  assert.equal(project.total, 5);
  assert.equal(project.covered, 3);
  const md = renderMarkdown({
    project,
    patch: { covered: 1, total: 2, pct: 50, uncovered: [{ file: "src/a.js", start: 2, end: 2 }] },
    verdict: { delta: -1, failures: ["Patch coverage 50% is below minimum 80%"], ok: false },
    thresholds: { min: 80, patchMin: 80 },
  });
  assert.match(md, /<!-- coverfire -->/);
  assert.match(md, /src\/a\.js:2/);
});

test("parseArgs and parseRemote", () => {
  const a = parseArgs(["--file", "a.info", "--min", "80", "--comment", "--patch-min", "90"]);
  assert.deepEqual(a.files, ["a.info"]);
  assert.equal(a.min, 80);
  assert.equal(a.patchMin, 90);
  assert.equal(a.comment, true);
  assert.deepEqual(parseRemote("git@github.com:acme/app.git"), { owner: "acme", repo: "app" });
  assert.deepEqual(parseRemote("https://github.com/acme/app"), { owner: "acme", repo: "app" });
  assert.throws(() => parseArgs(["--nope"]));
});

test("run locally fails on --min without posting", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "coverfire-"));
  mkdirSync(path.join(dir, "coverage"));
  writeFileSync(path.join(dir, "coverage/lcov.info"), LCOV);
  const logs = [];
  const code = await run(["--file", "coverage/lcov.info", "--min", "90", "--no-comment", "--no-checks"], {}, {
    cwd: dir,
    log: (m) => logs.push(String(m)),
    err: (m) => logs.push(String(m)),
  });
  assert.equal(code, 1);
  assert.match(logs.join("\n"), /FAIL/);
});

test("run --help is 0", async () => {
  const logs = [];
  const code = await run(["--help"], {}, { log: (m) => logs.push(m), err: () => {} });
  assert.equal(code, 0);
  assert.match(logs.join("\n"), /Usage: coverfire/);
});

test("parseCoverage dispatches by filename", () => {
  const files = parseCoverage(LCOV, { filename: "coverage/lcov.info" });
  assert.ok(files.has("src/a.js"));
});
