# Notion Project Integration

_Last updated: 2026-10-20_

The Showdar Router roadmap, work items, architecture notes, decisions, and working
agreement live in Notion. This page explains how those records relate to the Git
repository and how agents should use them without creating duplicate work or
stale statuses.

## Purpose

Notion is the planning surface: it records what should be true, in what order,
and why. The repository is the implementation surface: it records what is true
now. Neither is a substitute for the other.

Use Notion to:

- choose the next task and confirm its priority;
- read the original problem report and acceptance criteria;
- check dependencies and agreed decisions;
- record implementation evidence and outcomes.

Use the repository to:

- understand current behavior and architecture;
- run the tests that prove a change works;
- find the exact files, commits, and release history.

## Project links

| Area | Link |
| --- | --- |
| Project Hub | https://app.notion.com/p/3ff02b8c13d0813cbdc8ea6eb3055893 |
| Work Items | https://app.notion.com/p/73ca48a4bb9e4203a83ced49816083a0 |
| Roadmap | https://app.notion.com/p/3ff02b8c13d081909027fa1e4ea9f01e |
| Architecture | https://app.notion.com/p/3ff02b8c13d081a1a446dcae62fbd4eb |
| Decisions | https://app.notion.com/p/3ff02b8c13d081059dbcecddc842c682 |
| Working Agreement | https://app.notion.com/p/3ff02b8c13d081409705eca2e7641d51 |

There is one Project Hub, one Work Items database, and one roadmap. Do not
create a second project, database, or parallel task list for the same work.

## Source-of-truth boundaries

| Information | Authoritative source | Rule |
| --- | --- | --- |
| Current runtime behavior | Code and tests in this repository | Code wins when it contradicts a plan or an older note. |
| Architecture intent | `docs/ARCHITECTURE.md`, `open-sse/AGENTS.md`, and accepted Notion decisions | Code wins for behavior; a decision record wins over an undocumented assumption. |
| Roadmap order, status, acceptance criteria | Notion Work Items and Roadmap | Do not copy status into a second tracker. |
| Original problem reports | Notion work item | Preserve them; append evidence instead of rewriting history. |
| Release history | `CHANGELOG.md`, Git tags, commits | Link the commit or PR from Notion when reporting work. |
| Working agreement | Notion | Follow it for process; this page covers the Git/Notion handoff. |

Practical consequences:

- A feature existing in `main` does **not** by itself make a Notion item Done.
  The item is Done only when its acceptance criteria are verified and the
  evidence is recorded.
- A Notion item marked Done does **not** by itself prove current behavior.
  Re-check the code and tests before relying on it, especially after refactors.
- `docs/ARCHITECTURE.md` describes the system but can lag behind implementation.
  `CLAUDE.md` calls out at least one known stale area (the persistence layer is
  SQLite under `src/lib/db/`, not `db.json`). Treat code as current behavior.

## Work item rules

- Work items use stable IDs `SR-01` through `SR-08`. Never renumber or reuse an
  ID.
- Search Notion for the exact ID before creating anything. If a matching item
  exists, update it instead of creating another.
- One work item represents one deliverable outcome. A sub-step, bug, or test gap
  discovered during the work belongs in the same item as a checklist entry or
  comment unless it can ship and be accepted independently.
- New, independently deliverable follow-ups get new IDs after `SR-08`; do not
  recycle closed IDs.
- Keep acceptance criteria observable and testable. If scope changes, record the
  change and the reason; do not silently replace the original problem report.
- Do not record credentials, tokens, API keys, customer data, or full request
  bodies in Notion, Git, or logs.

## Agent workflow

### Before implementation

1. Read `CLAUDE.md`, `open-sse/AGENTS.md` when the change touches the engine,
   and the relevant sections of `docs/ARCHITECTURE.md`.
2. Fetch the Project Hub and the matching Work Item by its `SR-0x` ID. Read the
   roadmap, dependencies, and any linked decision.
3. Inspect the current implementation and tests. Confirm whether the behavior is
   implemented, partially implemented, or genuinely missing.
4. Verify the task scope, status, dependencies, and acceptance criteria. If the
   repository contradicts the task description, update the task description with
   the evidence before writing code.
5. If Notion is unavailable, report the blocker. Do not invent a status, a task
   body, or a duplicate work item. Continue only with local documentation work.

### During implementation

- Follow the existing architecture boundaries (`src/sse/` app glue,
  `open-sse/` engine, `cli/` launcher package).
- Add or update tests where behavior changes.
- Avoid unrelated refactors and drive-by documentation rewrites.
- Keep secrets and sensitive request data out of logs, commits, and Notion.
- If a required dependency is missing or blocked, mark the work item Blocked with
  the concrete reason instead of silently parking it.

### After implementation

1. Run the narrowest relevant tests. For routing changes, start with
   `npm run test:routing`; use the baseline gate described below for broad runs.
2. Record in Notion:
   - files changed;
   - exact commands and results;
   - commit SHA and PR link when they exist;
   - remaining risks, follow-ups, or unverified behavior.
3. Mark Done only when every acceptance criterion is satisfied and the evidence
   above exists.
4. Mark Blocked explicitly when a dependency is unavailable; do not leave an
   in-progress item without a reason.

## Evidence format

Use a short, repeatable block so later readers can verify the claim:

```text
Work item: SR-0x
Date:
Commit/PR:
Files:
Commands:
Results:
Environment:
Risks / follow-ups:
```

Keep commands copy-pasteable. Quote real output (test counts, exit status) rather
than "tests pass". Link the commit instead of pasting a diff.

## Roadmap maintenance

After the work is verified:

1. Update the work item status and acceptance criteria checkboxes.
2. Add the evidence block and any linked decision.
3. Add follow-ups as new items; leave the original report intact.
4. Adjust roadmap order only when priority actually changes, not to reflect
   implementation convenience.
5. Update repository docs when behavior, architecture, or commands changed.
   Do not mirror the whole roadmap into Git.

## Avoiding duplicates and stale statuses

- Search by `SR-0x` and by title before creating an item.
- Prefer commenting on an existing item over opening a near-duplicate.
- Treat status as a claim with a last-verified date. A Done item without a
  commit, test command, or other evidence is a candidate for re-verification.
- If a Done item regresses, reopen it or link a new item; do not quietly flip the
  status without evidence.
- If the local checkout differs from the branch referenced by a task, say so in
  the task before reconciling it.

## Local evidence

### Repository snapshot

| Field | Value |
| --- | --- |
| Package version | 0.6.0 (root and CLI) |
| Branch | `main` |
| Commit | `6c2892f5` (2026-10-16) |
| Remote | `git@github.com:caongocquy/showdar-router.git` |

Focused routing gate run on 2026-10-20:

```bash
npm run test:routing
# 8 test files passed, 97 tests passed
```

The inherited broad suite is not all-green on a clean checkout. Expected failures
are listed in `tests/__baseline__/known-fails.txt`; the
`tests/__baseline__/verify-no-regression.mjs` gate expects a checkout at `/app`
(its CI layout), so on a local checkout compare failures against the baseline
manually instead of expecting zero. The `cloud/` worker directory is not present
in this repository, so `tests/unit/embeddings.cloud.test.js` always fails locally.

### Roadmap reconciliation

Reconciled against `main` at `6c2892f5` on 2026-10-20. Each work item received a
dated Reconciliation section in Notion; SR-08 was moved to In Progress and no
item was marked Done. Notion remains the authority for status; re-check it
before acting.

| ID | Notion status | Repository evidence | Assessment |
| --- | --- | --- | --- |
| SR-01 | Ready / P0 | Combo loop, 429 classification, executor retry gates; no end-to-end reproduction | **Unverified runtime issue.** No root cause. Needs a failing fixture before any fix. |
| SR-02 | Backlog / P1 | `DEFAULT_RETRY_CONFIG`, provider retry overrides, connect/first-chunk/stall timeouts, retry metadata; `base-executor-retry`, `d2a-retry-fallback`, `retry-metadata`, `error-taxonomy` tests | **Partially implemented.** Per-phase timeouts and 429 classification exist; no single end-to-end request-budget abstraction was found. Depends on SR-01. |
| SR-03 | Backlog / P1 | `chatComboResponseValidator.js` waits for first meaningful output and falls back on empty streams; post-output failures terminate the stream | **Partially verified.** Pre-output fallback is covered; the full SSE contract matrix (tool calls, mid-stream failure, buffered mode) is not consolidated. Depends on SR-01. |
| SR-04 | Backlog / P1 | External signal → `streamController`, abortable retry waits, connect and stall timeouts, fusion cancellation; `combo-cancellation`, `latency-trace`, `responses-abort-terminal`, `opencode-phase-a1` tests | **Substantially implemented.** Cancellation and cleanup are tested; end-to-end deadline ownership is still split across phases (SR-02). |
| SR-05 | Backlog / P1 | `routeHealthState`, `comboPlanner`, combo health hooks, `accountFallback`; `route-health-state`, `combo-routing`, `antigravity-quota-routing`, `runtime-health-hardening` tests | **Partial matrix.** Individual behaviors are covered, but not one matrix spanning cooldown, half-open, exhausted account, capability, capacity and reset metadata. |
| SR-06 | Backlog / P2 | `open-sse/utils/latencyTrace.js` (opt-in `SHOWDAR_ROUTER_LATENCY_TRACE=1`), sanitized failure enums, attempt/retry/health-skip records; `latency-trace` tests | **Implemented as opt-in diagnostics.** Not marked Done pending redaction review and end-to-end use. Depends on SR-01. |
| SR-07 | Backlog / P2 | README client setup; `scripts/standalone-runtime-smoke.mjs` checks start-up, login and health only | **Missing the requested smoke.** No representative stream/non-stream tool-call, long-prefill, 429-fallback run. Depends on SR-03 and SR-05. |
| SR-08 | In Progress / P2 | `docs/ARCHITECTURE.md` refreshed (SQLite, routing, health, retries, streaming, tracing, packaging); `docs/OPERATOR-RUNBOOK.md` added; release verification recorded | **Documentation complete; release gate NO-GO.** Release gate fails in `d2a-retry-fallback`; full suite has 107 failures; Risk A (omitted `stream`) and Risk B (default remote capacity pools) remain open. Notion status update pending because Notion MCP is unavailable. |

Overlap to watch:

- SR-01, SR-02 and SR-03 all touch the same 429 → fallback path. Fix the
  classification/deadline boundary once, not three times.
- SR-04 shares cleanup and abort semantics with SR-03.
- SR-05 and SR-06 should consume the classification produced for SR-01/02
  rather than defining a second taxonomy.

### SR-01 — Gemini 429 did not advance the combo

**Status: unverified runtime issue. No root cause has been established.**

Reported symptom: Gemini returned HTTP 429, but the router appeared to keep
waiting on Gemini instead of falling back to the next eligible combo candidate.

Relevant implementation areas to inspect (not a diagnosis):

- `src/sse/handlers/chat.js` — combo expansion and the call into
  `handleComboChat`, including the Antigravity 409/429-specific path.
- `open-sse/services/combo.js` — the candidate loop, health skips,
  `checkFallbackError`, and the `comboFallbackRemaining` hint passed to the
  executor.
- `open-sse/services/accountFallback.js` and `open-sse/services/routeFailureClassifier.js`
  — 429 classification, cooldown, and chainability decisions.
- `open-sse/executors/base.js` — in-place retry and base-URL fallback, including
  the `comboFallbackRemaining` predicate.
- `open-sse/executors/gemini-cli.js` — Gemini `RetryInfo.retryDelay` parsing.
- `src/sse/services/comboHealthHooks.js` and
  `src/sse/services/antigravityQuota.js` — route health and quota refresh paths.

Existing tests that cover adjacent behavior:

- `tests/unit/combo-routing.test.js` — candidate order, round-robin, and health
  skip behavior.
- `tests/unit/base-executor-retry.test.js` — base-URL fallback on 429 and the
  retry-hook veto path.
- `tests/unit/error-taxonomy.test.js` — 429 classification and bounded cooldowns.
- `tests/unit/retry-metadata.test.js` — retry/reset metadata handling.
- `tests/unit/route-health-state.test.js` — cooldown and half-open transitions.
- `tests/unit/antigravity-quota-routing.test.js` — Antigravity 409/429 routing.

None of these reproduces the report end-to-end (client request → combo →
Gemini 429 → next candidate).

Evidence needed before any fix:

- the combo name, ordered candidates, and which candidate returned 429;
- the upstream status/body and any `Retry-After` or reset hint;
- timestamps showing retry, wait, or stall behavior, and whether the client
  stayed connected;
- the router log for that request (redacted), including the
  `logicalRequestId`;
- whether a later candidate was eligible and healthy;
- the exact request shape, since capability filtering can remove candidates.

Do not mark this item Done or declare a cause until the behavior is reproduced
with that evidence.

### Work item links

| ID | Notion page |
| --- | --- |
| SR-01 | https://app.notion.com/p/3ff02b8c13d0816c8303d2206af87abc |
| SR-02 | https://app.notion.com/p/3ff02b8c13d081758414c3a7f9e48456 |
| SR-03 | https://app.notion.com/p/3ff02b8c13d081589871fbca021c28a3 |
| SR-04 | https://app.notion.com/p/3ff02b8c13d08125b9b3e21919ae4795 |
| SR-05 | https://app.notion.com/p/3ff02b8c13d081ef96aed8b40fada01d |
| SR-06 | https://app.notion.com/p/3ff02b8c13d081269e1cd727b04e722b |
| SR-07 | https://app.notion.com/p/3ff02b8c13d081e69e61ed112a16aaf8 |
| SR-08 | https://app.notion.com/p/3ff02b8c13d081d5a946feac7fd449cb |
