# coverfire

Coverage that blocks the merge.

Site: [charlisim.github.io/coverfire](https://charlisim.github.io/coverfire/)

[![ci](https://github.com/Charlisim/coverfire/actions/workflows/ci.yml/badge.svg)](https://github.com/Charlisim/coverfire/actions/workflows/ci.yml)

Runs **locally** and in **CI**. Reads lcov/istanbul/clover/cobertura, computes **project** and **patch** coverage, fails the job, and on GitHub upserts a **PR comment**, publishes **status checks**, and marks uncovered lines.

Not a GitHub App. Uses `GITHUB_TOKEN` (or any PAT) from the job. Source code never leaves the machine.

Zero dependencies. Node 20+, plus bun and pnpm.

## Install

```bash
npm i -D coverfire
pnpm add -D coverfire
bun add -d coverfire
```

No install:

```bash
npx coverfire --help
pnpm dlx coverfire --help   # pnpx also works
bunx coverfire --help
```

## Compatibility

CI runs this matrix on every push:

| Runtime | Versions |
| --- | --- |
| Node | 22, 24 (LTS), 26 (current), latest patch |
| pnpm | 10, pack + `pnpm exec coverfire` |
| bun | latest, `bun test` + pack + `bunx coverfire` |

## Local

```bash
# Jest / Vitest / nyc usually write coverage/lcov.info
npx jest --coverage --coverageReporters=lcov --coverageReporters=text
# or: pnpm exec jest --coverage --coverageReporters=lcov
# or: bun test --coverage

npx coverfire --min 80 --patch-min 80 --base origin/main
# or: pnpm exec coverfire --min 80 --patch-min 80 --base origin/main
# or: bunx coverfire --min 80 --patch-min 80 --base origin/main
```

Exit `0` if thresholds pass, `1` if they fail, `2` on usage/config errors.

Useful flags:

```bash
npx coverfire --file coverage/lcov.info
npx coverfire --file coverage/coverage-final.json
npx coverfire --dry-run --comment --checks --pr 12 --repo acme/app
npx coverfire --json
```

Config file `coverfire.json` in the repo root (CLI flags win):

```json
{
  "file": "coverage/lcov.info",
  "min": 80,
  "patchMin": 80,
  "maxDecrease": 1,
  "ignore": ["**/*.generated.js"],
  "github": { "comment": true, "checks": true, "annotate": true }
}
```

`0` on `min` / `patchMin` means “report only, do not fail”.

Patch coverage is `git diff -U0 base...HEAD` intersected with executable lines in the coverage file. Project delta needs `--base-file` (there is no hosted history).

## GitHub Actions

`fetch-depth: 0` (or at least `2`) so patch coverage can see the base commit. Grant the token permission to comment and write checks:

```yaml
name: tests
on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      checks: write
      statuses: write
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v5
        with:
          node-version: 24
          check-latest: true
          cache: npm

      - run: npm ci
      - run: npx jest --coverage --coverageReporters=lcov --coverageReporters=text

      - name: Coverage gate
        uses: Charlisim/coverfire@v0.2.0
        with:
          file: coverage/lcov.info
          min: "80"
          patch-min: "80"
          # uploads coverfire-report/ (json + md + HTML) even if the gate fails
```

Same thing as a CLI step (no `uses:`):

```yaml
      - name: Coverage gate
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: npx coverfire --file coverage/lcov.info --min 80 --patch-min 80 --out coverfire-report
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: coverfire-report
          path: coverfire-report
```

On `GITHUB_ACTIONS=true` with a token, `--comment` and `--checks` turn on by themselves.

### What gets posted

| Surface | Context / name | Behavior |
| --- | --- | --- |
| PR comment | sticky `<!-- coverfire -->` | bars, CLEAR/HOLD FIRE, worst files, uncovered lines linked to the blob |
| Check run | `coverage/project` | fails if project `%` &lt; `--min` |
| Check run | `coverage/patch` | fails if changed executable lines `%` &lt; `--patch-min`; notice annotations on uncovered hunks |
| Check run | `coverage/change` | fails if project `%` drops more than `--max-decrease` (needs `--base-file`) |
| Artifact | `coverfire-report` | `index.html` + `report.md` + `report.json` (uploaded even when the gate fails) |

If the token cannot create check runs (403), coverfire falls back to **commit statuses** with the same names. Annotations need check runs.

`--out coverfire-report` writes the HTML dashboard. In GitHub Actions that directory is created by default.

### Branch protection

Repo → Settings → Branches → protect `main` → **Require status checks to pass**:

- `coverage/project`
- `coverage/patch`
- optionally `coverage/change`

### Monorepo

Run the tool twice with `--component`:

```yaml
      - run: npx coverfire --file apps/web/coverage/lcov.info --component web
      - run: npx coverfire --file apps/api/coverage/lcov.info --component api
```

## Other CI

The gate is just a process exit code. Point it at a coverage file after tests. To still comment on a **GitHub** PR from GitLab/Circle/Jenkins, pass a GitHub token plus `--repo`, `--pr`, `--sha`.

### GitLab CI

```yaml
test:
  image: node:24
  script:
    - npm ci
    - npx jest --coverage --coverageReporters=lcov
    - npx coverfire --file coverage/lcov.info --min 80 --patch-min 80
  # Optional: comment on the GitHub PR this branch tracks
  # GITHUB_TOKEN stored as a masked CI variable
  # - npx coverfire --comment --checks --repo acme/app --pr "$GH_PR" --sha "$CI_COMMIT_SHA"
```

### CircleCI

```yaml
version: 2.1
jobs:
  test:
    docker:
      - image: cimg/node:24.0
    steps:
      - checkout
      - run: npm ci
      - run: npx jest --coverage --coverageReporters=lcov
      - run: npx coverfire --file coverage/lcov.info --min 80 --patch-min 80
      # Optional GitHub publish:
      # - run: npx coverfire --comment --checks --repo acme/app --pr $CIRCLE_PR_NUMBER --sha $CIRCLE_SHA1
```

### Jenkins

```groovy
pipeline {
  agent { docker { image 'node:24' } }
  environment { GITHUB_TOKEN = credentials('github-token') }
  stages {
    stage('test') {
      steps {
        sh 'npm ci'
        sh 'npx jest --coverage --coverageReporters=lcov'
        sh 'npx coverfire --file coverage/lcov.info --min 80 --patch-min 80 --comment --checks --repo acme/app --pr $CHANGE_ID --sha $GIT_COMMIT'
      }
    }
  }
}
```

### GitHub Enterprise

Set `GITHUB_API_URL` (Actions already does). Same CLI.

## Coverage formats

Auto-detected from content or `--file` suffix:

| Format | Typical command |
| --- | --- |
| LCOV | `jest --coverage --coverageReporters=lcov` → `coverage/lcov.info` |
| Istanbul JSON | `c8` / nyc `coverage/coverage-final.json` |
| Clover XML | `phpunit --coverage-clover=coverage/clover.xml` |
| Cobertura XML | `pytest --cov-report xml:coverage.xml` |

Default search order: `coverage/lcov.info`, `coverage/coverage-final.json`, `coverage/clover.xml`, `build/logs/clover.xml`, `coverage/cobertura-coverage.xml`, `coverage.xml`.

## Library

```js
import { parseCoverage, changedLines, computePatch, evaluate } from "coverfire";
```

## License

MIT
