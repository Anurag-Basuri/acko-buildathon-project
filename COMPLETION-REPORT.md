# Contract Guard — Combined Completion Report

**Status: all 8 increments complete. Full test suite green (309/309). Dev smoke test green (15 steps + SPA check).**

Contract Guard is an API-contract registry and compatibility-governance service: teams register
provider services and OpenAPI specifications, register consumer dependency declarations, and the
platform compares spec versions, classifies every change (BREAKING / NON_BREAKING / UNKNOWN),
analyzes the impact on registered consumers, and governs publication with a deterministic,
policy-configurable rule engine. Metrics surface the state of the registry.

---

## 0. How to run (exact steps)

```powershell
cd backend

# one-time
npm install                          # postinstall runs prisma generate

# 1. Dev database — embedded PostgreSQL, no system install / container needed
npm run db:up                        # listens on 127.0.0.1:5432
                                     # user/password: contractguard / contractguard
                                     # data lives in backend/.embedded-pg/ (disposable; delete to reset)

# 2. Migrations (idempotent)
npm run db:deploy

# 3. Start the API + the static SPA (served at /)
npm run start                        # or: npm run dev (nodemon)
# -> http://localhost:3000

# 4. Tests — no dev DB required: every embedded-DB suite boots its own
#    throwaway Postgres on a distinct port (55432-55440)
npm test                             # 18 suites, 309 tests, ~40s
```

`.env` (never committed) holds `DATABASE_URL`, `PORT=3000`, `NODE_ENV=development`.
A Neon-hosted `DATABASE_URL` works in place of the embedded DB.

### Verified end-to-end smoke (dev environment)

With `db:up` + `db:deploy` + `start` running, the following 15-step walk-through was executed
against the live API (and re-ran green):

| # | Step | Result |
|---|------|--------|
| 1 | `GET /api/health` | `api ok` |
| 2 | `POST /api/services` — register `quote-api` + `policy-api` | 201 ×2 |
| 3 | `POST /api/specs/validate` + `/upload` — store valid v1 specs | OpenAPI 3.0.3, both `isInitialVersion=true` |
| 4 | `POST /api/consumers` + `PUT /api/consumers/:id` — mobile-app declares `POST /quotes` | dependency stored, method normalized |
| 5 | `GET /api/services/:id/consumers` — provider view | `consumers=mobile-app` |
| 6 | `POST /api/specs/publish` (quote v1) | `PUBLISHED`, code `INITIAL_VERSION_PUBLISHED` |
| 7 | `POST /api/specs/publish` (policy v1) | `PUBLISHED`, code `INITIAL_VERSION_PUBLISHED` |
| 8 | `POST /api/consumers/import` — starter-kit declarations | 4 consumers (3 new, 1 existing), **7 dependencies upserted**, 3 `claims-api` uses reported unresolved and **never created** |
| 9 | `POST /api/specs/upload` — proposed quote v3 | baseline correctly = quote v1 |
| 10 | `GET /api/specs/diff?fromVersionId=v1&toVersionId=v3` | 8 changes: 3 breaking, 5 unknown (incl. `PARAMETER_RENAMED`) |
| 11 | `GET /api/specs/:id/impact` (quote v3) | 6 findings; affected = mobile-app (reads removed `premium.breakdown[].amount`) + notifications-svc (sends old path param `id`) |
| 12 | `POST /api/specs/publish` (quote v3) | **BLOCKED**, code `UNKNOWN_CHANGES` (rule G precedes rule D) |
| 13 | policy v3: upload + impact + publish | impact finding for `payments-svc` (reads removed `legacyCode`); publish **BLOCKED**, code `BREAKING_CHANGES_AFFECT_CONSUMERS` |
| 14 | `GET /api/specs/:id/publish-history` + `GET /api/metrics` + `/api/metrics/publishing` | history rows carry `decisionDetails.code`; metrics: 4 attempts, successRate 0.5, `blockedByCode={UNKNOWN_CHANGES:1, BREAKING_CHANGES_AFFECT_CONSUMERS:1}` |
| 15 | SPA at `/` | `index.html` + all 4 static assets served; all 7 hash-route areas wired |

---

## 1. Increment 1 — Service registry ✅

`backend/src/services/service.service.js`, `routes/services.routes.js`.

- `Service` model: unique `name`, `owner`, optional `description`, timestamps.
- `POST /api/services` (201; 400 `VALIDATION_ERROR`; 409 `DUPLICATE_SERVICE`),
  `GET /api/services`, `GET /api/services/:id` (404 `SERVICE_NOT_FOUND`, 400 `INVALID_ID`).
- Services double as the registry for both providers and consumers (increment 5).

## 2. Increment 2 — Specification management ✅

`backend/src/services/spec.service.js`, `spec-validator.js`, `routes/specs.routes.js`.

- `POST /api/specs/validate` — **always HTTP 200** with
  `{ valid, format, openApiVersion, errors }`: the verdict is the payload, not an error.
  Accepts YAML/JSON OpenAPI 3.x; rejects Swagger 2.0 explicitly; reports parse errors,
  structure errors and residual `$ref`s.
- `POST /api/specs/upload` — body `{ serviceId, versionLabel, content }` → 201
  `ApiVersion` with `status: 'PROPOSED'`, `isInitialVersion`, `baselineVersionId`
  (409 `DUPLICATE_VERSION` on duplicate label; invalid specs are rejected without persisting).
- `GET /api/services/:id/versions` — metadata list (plain array in `data`).
- `GET /api/specs/:id` — metadata + stored content (404 `SPEC_VERSION_NOT_FOUND`).
- **Baseline = latest PUBLISHED version** (`updatedAt desc, createdAt desc`); there is no
  mutable baseline pointer.

## 3. Increment 3 — OpenAPI normalizer ✅

`backend/src/services/spec-normalizer.js` (14 unit tests + integration coverage).

- Flattens `$ref`s, merges path-level and operation-level parameters (operation-level wins),
  canonicalizes path templates, records `required` lists deterministically, and reports
  unsupported constructs with JSON pointers (discriminators, `patternProperties`,
  OpenAPI 3.1 union types) instead of silently dropping them.
- **Flag:** this increment's files were found absent from disk at the start of the current
  session (the increment-3 work did not survive on disk) and was rebuilt and re-covered by
  tests before later increments were built on top of it.

## 4. Increment 4 — Comparator, classifier, comparison API ✅

`backend/src/services/spec-comparator.js`, `compatibility-rules.js`, `comparison.service.js`.

- **Positional path-template matching**: `/quotes/{id}` ≡ `/quotes/{quoteId}` (parameters
  paired by position); a pure rename is reported as `PARAMETER_RENAMED`, other structural
  renames are reported. Property order and `$ref`-vs-inline layout are irrelevant.
- Change conventions: `request.*`, `parameters.<name>`, `response.<status>[.<ct>].*`
  (e.g. `response.201.premium.breakdown[].amount`); array segments use `[]`;
  `ENDPOINT_REMOVED` carries `method: null`.
- 29-rule classifier, first-match-wins; anything with no rule → `UNKNOWN` (rule `NO_RULE`) —
  **UNKNOWN is never treated as NON_BREAKING**. Rule set covers endpoints, methods,
  parameters (add/remove/requiredness/type/enum/rename), request body, content types,
  responses (status, content type, field add/remove, type, requiredness, enum).
- `GET /api/specs/diff?fromVersionId=…&toVersionId=…` — `changeCount`,
  `breakingChangeCount`, `nonBreakingChangeCount`, `unknownChangeCount`, and every change
  with `classification`, `ruleId`, plain-language `reason` (400 `INVALID_COMPARISON` across
  services; deterministic; reversed comparison inverts directional changes).

## 5. Increment 5 — Consumer registry & dependency management ✅

### Declaration format (starter-kit) and storage

```yaml
consumer: mobile-app
team: Mobile
uses:
- provider: quote-api
  method: POST
  path: /quotes
  sends: [vehicle.make, vehicle.cc, rider.age]
  reads: [quoteId, status, premium.total, premium.breakdown[].label, premium.breakdown[].amount]
```

- **Consumers are `Service` records** (upserted by name; `owner` = `team`).
- `ConsumerDependency` rows with a **unique 4-tuple**
  `(consumerServiceId, providerServiceId, method, path)`; `sends` / `reads` stored verbatim
  (Json arrays, nested `a.b.c` and array `a[].b` notation preserved).
- `PUT /api/consumers/:id` is an **explicit full replacement**: listed dependencies are
  upserted, existing ones missing from the body are deleted, `[]` clears the set
  (documented deviation from a merge semantic).

### Endpoints

| Method & path | Behaviour |
|---|---|
| `POST /api/consumers` | register consumer (201; 409 `DUPLICATE_SERVICE`) |
| `GET /api/consumers` | all consumers with dependencies grouped by provider |
| `GET /api/consumers/:id` | consumer + `uses` + `consumedBy` (404 `CONSUMER_NOT_FOUND`) |
| `PUT /api/consumers/:id` | replace dependency set (400 `PROVIDER_NOT_FOUND` for unknown provider) |
| `GET /api/services/:id/consumers` | registered consumers of a provider, grouped |
| `POST /api/consumers/import` | empty body → starter-kit YAML files from disk; `{declarations:[…]}` → from body |

### Import behaviour (verified with the real starter-kit fixtures — read-only)

- Providers resolved **by name** against registered services; **never created implicitly**.
- Each use validated against the provider's **latest PUBLISHED** spec. Per-use statuses:
  `validated`, `operation_mismatch` (declared path no longer matches, e.g. after a rename),
  `invalid_operation` (operation absent), `field_mismatches` (declared field not found in the
  published schema), `pending_validation` (no published spec yet — declarations preserved),
  `unresolved_provider` (provider not registered — reported per use, nothing created);
  malformed declarations → `parse_error`, reported but not fatal.
- **Idempotent**: re-importing the same declarations changes no counts (upserts on the
  4-tuple).

### Real run results

- 4 consumers: `mobile-app`, `partner-portal`, `notifications-svc`, `payments-svc`.
- 10 declared uses: quote-api ×4, policy-api ×3, claims-api ×3.
- With quote-api v1 and policy-api v1 published: **7 dependencies persisted** (validated);
  the 3 claims-api uses reported `unresolved_provider` (claims-api is not registered) and
  were not stored.
- When quote-api's published baseline is v3 (path renamed to `/quotes/{quoteId}`), the
  mobile-app/notifications-svc GET declarations report `operation_mismatch` — the rename is
  surfaced to consumers at import time.

## 6. Increment 6 — Consumer impact analysis ✅

### API

`GET /api/specs/:id/impact` (id = **proposed** version). Errors: initial version →
400 `NO_PUBLISHED_BASELINE`; id == current baseline → 400 `INVALID_ANALYSIS`; malformed →
400 `INVALID_ID`; unknown → 404.

Each call runs semantic comparison + classification + impact analysis **against the current
published baseline**, then persists an **immutable `AnalysisRun`** — repeated calls preserve
full history (each run carries `dependencyFingerprint` = sha256 of the sorted
`[consumer, method, path, sorted sends, sorted reads]` tuples, `specContentHash`, counts,
affected counts, `classifiedChanges` and the full `impact` payload).

### Matching rules

- **Operation matching**: path templates paired positionally (`{id}` ≡ `{quoteId}`); method
  must match; a removed endpoint affects every consumer of the path (any method).
- **Field matching**: token-aware, bidirectional prefix relationship —
  `customer.name` ≠ `customer.nameSuffix` (segment boundary); a removed **parent** object
  affects declared **descendants**, and a declared parent object is affected by nested
  changes; array markers are tolerated (`items[]` ≡ `items`).
- **Direction**: `sends` match request-side changes (`request.*`, `parameters.<name>`);
  `reads` match response-side changes (`response.<status>[.<ct>].*`).
- **Requirement introduction**: a new *required* request field produces a finding for
  consumers that declare the operation but do **not** send the field.
- **Operation-level changes** affect all consumers of the operation.
- **Findings are never duplicated** — one finding per (dependency × change).

### Summary semantics

`summary.basedOn = "registered consumer declarations"`, with
`registeredConsumerCount`, `consumersDeclaringAffectedOperations`, affected
consumers/dependencies/changes counts and `noMatchingDeclaration.consumers` — the
**provider-scoped** list of registered consumers of this provider that declare no affected
operation — with an explicit note: *a missing declaration is NOT proof of safety*.

### Real starter-kit results (verified via API)

| Comparison | Changes | Findings | Affected |
|---|---|---|---|
| quote v1 → v2 | 1 × `PARAMETER_RENAMED` (id→quoteId, UNKNOWN) | 2 | mobile-app, notifications-svc (both send `id`) |
| quote v1 → v3 | 8 (3 breaking, 5 unknown — incl. `breakdown[].amount` → `value`) | 6 | mobile-app (reads `response.201.premium.breakdown[].amount`) + notifications-svc (sends `id`) |
| policy v1 → v3 | 4 breaking (removes `legacyCode` + `holder.phone` across both endpoints) | 1 | payments-svc (reads `response.200.legacyCode`); notifications-svc's `holder.email` read is **not** affected (token boundary) |

## 7. Increment 7 — Publishing governance ✅

### API

- `POST /api/specs/publish` — body `{ versionId }` only. A **blocked publish is a business
  outcome, not a server error**: HTTP 200 with `outcome: 'BLOCKED'`, carrying `code`,
  `reason`, `warnings`, `affectedConsumers`, `attemptId`, `analysisRunId` and
  `decisionDetails` (which embeds the evaluated policy for audit).
- `GET /api/specs/:id/publish-history` — `{ version, attempts[] }` **newest first**; both
  PUBLISHED and BLOCKED attempts are kept; each row carries `outcome`, `reason`, `warnings`,
  `decisionDetails.code`, analysis-run reference, `createdAt`.
- Publishing an already-published version → 409 `ALREADY_PUBLISHED`.

### Rules A–H (deterministic, in-code policy, switchable)

Evaluation order (first match wins):

1. **A** — invalid specification → `BLOCKED INVALID_SPECIFICATION`.
2. **H** — initial version: no comparison is fabricated; existing declarations are checked
   against the operation set → `PUBLISHED INITIAL_VERSION_PUBLISHED` (mismatches warn, or
   block when `initialVersionDeclarationMismatch: 'block'` →
   `INITIAL_DECLARATION_MISMATCH`).
3. **B** — no completed analysis → `BLOCKED ANALYSIS_NOT_COMPLETED`.
4. **C** — analysis stale (fingerprint/hash mismatch) → `BLOCKED STALE_ANALYSIS`.
   Staleness causes (all reported): `published baseline changed`,
   `consumer dependency declarations changed`, `specification content changed`.
5. **G** — any UNKNOWN change → `BLOCKED UNKNOWN_CHANGES` (before the breaking-change
   rules; UNKNOWN is never assumed safe).
6. **D / F** — breaking changes: if registered consumers are affected →
   `BLOCKED BREAKING_CHANGES_AFFECT_CONSUMERS` (list switchable); breaking changes with no
   registered impact publish **with a `BREAKING_NO_REGISTERED_IMPACT` warning** by default,
   or block when `breakingWithoutRegisteredImpact: 'block'`
   (`BREAKING_CHANGES_NO_REVIEW`).
7. **E** — clean → `PUBLISHED ALL_CHECKS_PASSED`.

`PUBLISH_POLICY` (in-code config): `requireCompletedAnalysis`, `requireFreshAnalysis`,
`blockOnUnknownChanges`, `blockBreakingWithAffectedConsumers`,
`breakingWithoutRegisteredImpact`, `initialVersionDeclarationMismatch` — every flag is
exercised by the policy unit tests (18).

### Transactions & concurrency

- One Prisma **interactive transaction** per publish; per-provider serialization via a
  Postgres **advisory transaction lock** (`pg_advisory_xact_lock`, executed with
  `tx.$executeRaw` — `$queryRaw` fails on the VOID return type). Baseline identity and
  analysis freshness are **re-verified inside the transaction**.
- `PublishAttempt` is persisted for **both** outcomes; a blocked publish **never changes the
  baseline**; a concurrent-publishs test proves exactly one of two racing publishes wins.

### Verified outcomes (dev smoke)

- quote v1 (initial) → **PUBLISHED** `INITIAL_VERSION_PUBLISHED`.
- quote v3 → **BLOCKED** `UNKNOWN_CHANGES` (5 UNKNOWN changes; rule G precedes D).
- policy v3 → **BLOCKED** `BREAKING_CHANGES_AFFECT_CONSUMERS` —
  `affectedConsumers=[payments-svc]`, reason names the consumer and the 4 breaking changes.

## 8. Increment 8 — Metrics & frontend ✅

### Endpoints (all computed from real DB rows, never cached)

- `GET /api/metrics` — dashboard aggregate.
- `GET /api/metrics/services` — per-service rows.
- `GET /api/metrics/publishing` — publishing deep-dive.

### Metric definitions & aggregation

| Metric | Definition |
|---|---|
| `services.total` | all Service records |
| `services.consumerCount` | services with ≥1 dependency declaration |
| `services.providerCount` | services depended on by ≥1 consumer |
| `specs.totalVersions / published / proposed` | by `ApiVersion.status` |
| `compatibility.analyzedVersionCount` | distinct proposed versions with an `AnalysisRun` |
| `compatibility.analysisRunCount` | raw run count (history) |
| `compatibility.*Changes`, `impact.*Count` | summed over the **latest** `AnalysisRun` per proposed version only (older re-runs are deduped out of aggregates; raw history stays in `analysisRunCount`) |
| `compatibility.latestRuns` | newest run per version, with at/counts/affected |
| `publishing.attemptCount / publishedCount / blockedCount` | by `PublishAttempt.outcome` — **blocked attempts are never counted as successful** |
| `publishing.successRate` | `published / attempts`, **null (not 0) when no attempts** |
| `publishing.blockedByCode` | blocked attempts grouped by `decisionDetails.code` |
| `publishing.recentBlocked` | up to 5 newest blocked attempts (service, version, reason, warnings, analysis ref) |

Empty database returns zeros, null rates and empty collections (verified first on an empty DB
before any seed). Per-service rows carry versions, baselines, dependency counts, attempt
counts and recent blocked attempts; recent-activity feed is newest-first, typed, capped at 10.

### Frontend — static no-build SPA

`frontend/` (served by Express at `/`): `index.html`, `styles.css`,
`js/{api.js, ui.js, app.js, views.js}`. Plain ES modules, hash routing, inline SVG icons,
**real data only** (every screen fetches live endpoints; no mock fallbacks), with loading /
empty / error states throughout. The 7 areas:

| Route | Screen | Data source |
|---|---|---|
| `#/dashboard` | counters, compatibility/impact summary, publish success rate, latest runs | `GET /api/metrics` |
| `#/services` | registry, register form, per-service metrics | `GET /api/services`, `/api/metrics/services` |
| `#/specs` (→ `#/specs/:serviceId`) | versions, validate + upload form, spec detail | `GET /api/services/:id/versions`, `POST /api/specs/validate` + `/upload` |
| `#/diff` | pick two versions → classified change list with reasons | `GET /api/specs/diff` |
| `#/consumers` | consumer list, register, starter-kit import, per-use validation status | `GET /api/consumers`, `POST /api/consumers/import` |
| `#/impact` | findings table + summary + no-matching-declaration warning | `GET /api/specs/:id/impact` |
| `#/publishing` | publish button, decision panel (outcome/code/reason/warnings/affected), history panel | `POST /api/specs/publish`, `GET /api/specs/:id/publish-history` |

## Test results

`npm test` — **18 suites, 309 tests, 309 pass, 0 fail** (~40 s; suites run concurrently, each
embedded-DB suite on its own throwaway Postgres: 55432 services, 55433 specs, 55434
comparison, 55435 compatibility, 55436 consumers, 55438 impact, 55439 publishing, 55440
metrics):

| Suite | Tests | Coverage |
|---|---|---|
| `services.test.js` | 13 | registry CRUD, duplicates, validation, versions list |
| `specs.test.js` | 21 | validate/upload/versions/detail, 404/400/409 codes |
| `spec-normalizer.test.js` | 14 | $ref resolution, parameter merge, unsupported constructs |
| `spec-comparator.test.js` | 39 | all fixture version jumps, canonical paths, determinism |
| `comparison.test.js` | 15 | diff API, route precedence, cross-service 400 |
| `compatibility-classifier.test.js` | 38 | all 29 rules + edge cases (NO_RULE→UNKNOWN) |
| `compatibility.test.js` | 15 | classification API end-to-end |
| `consumer-declarations.test.js` | 11 | starter-kit parse, verbatim paths, error scoping |
| `consumers.test.js` | 24 | registry, PUT replacement, import (real fixtures), idempotency |
| `dependency-validator.test.js` | 26 | positional ops, token-aware fields, schema resolution |
| `impact-analyzer.test.js` | 28 | matching rules, direction, no-duplicates, determinism |
| `impact.test.js` | 10 | impact API on real fixtures, fingerprints, history |
| `publishing-policy.test.js` | 18 | rules A–H, every policy switch, audit payload |
| `publishing.test.js` | 16 | publish outcomes, staleness (3 causes), concurrency, history |
| `metrics.test.js` | 11 | empty DB, seed via real API, latest-run dedupe, rates |
| `middleware.test.js` | 4 | 404/500/JSON-parse error envelopes |
| `env.test.js` | 3 | fail-fast env validation |
| `health.test.js` | 3 | health envelope |

### Bugs found & fixed in this final session

1. **Post-publish 500**: advisory lock used `tx.$queryRaw` on `pg_advisory_xact_lock`, which
   returns VOID and fails Prisma deserialization (P2010) — switched to `tx.$executeRaw`.
2. **Two impact test expectations** were wrong: `noMatchingDeclaration.consumers` is
   provider-scoped (consumers of *this* provider that declare no affected operation);
   `payments-svc` (a policy-api consumer) was never in scope for quote-api analyses.
3. **Test-suite hang on Windows**: `embedded-postgres`' `stop()` (`taskkill /f /t`) kills the
   postmaster but leaves the `io_worker` forkchild alive; the orphan inherits the stdio
   pipes and keeps the node process alive forever after teardown. Fixed with
   `tests/helpers/postgres-cleanup.js` (kills `--forkchild` postgres processes whose parent
   is dead; live instances — including the dev DB — are untouched) called from every
   embedded-DB suite's deadline-bounded teardown.

## Deviations & flags

1. **Increment 3 rebuilt** — its files were absent from disk; rebuilt and fully re-tested
   (flagged again here for the record).
2. **Frontend stack** — PROGRESS.md sketched "React + Vite"; delivered as a dependency-free
   static SPA served by Express. Rationale: no build tooling, instant load, and the API
   surface is small enough that a framework adds no value. Flagged per the plan.
3. **Blocked publish = HTTP 200** — deliberate: a block is a business decision (with full
   audit payload), not a server error. Only request/identity problems are 4xx.
4. **`PUT /api/consumers/:id` = explicit full replacement** (upsert listed, delete unlisted,
   `[]` clears) — documented API contract, not a merge.

## Known limitations

- Consumer registry is **declaration-based** — no runtime traffic data; `noMatchingDeclaration`
  is explicitly labeled "NOT proof of safety" everywhere it appears.
- `claims-api` (3 of the 10 starter-kit uses) has no registered provider, so those uses stay
  `unresolved_provider` until someone registers it; the deliberately-invalid
  `claims/2-channel-and-notes.yaml` (broken `$ref`) is used for negative tests only.
- No authentication, multi-tenancy, pagination or rate limiting (small internal registry).
- `WEBHOOK_TARGET_URL` is configured in env but not wired to any outbound webhook yet.
- Single-process deployment assumed (advisory locks are per-Postgres; scale out by sharing
  one database).
- Windows-only test quirk handled by the orphan-postgres helper above; on Linux/macOS the
  helper is a no-op (standard `SIGINT` shutdown is used).
