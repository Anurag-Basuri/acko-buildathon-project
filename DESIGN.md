# DESIGN.md: Contract Guard — System Design & Technical Architecture

---

## 1. Executive Summary & Objective

**Contract Guard** is an API contract registry and automated compatibility-governance platform. It provides a centralized registry for microservice OpenAPI specifications, performs semantic AST comparisons across versions, maps detected differences to registered consumer dependencies (`sends` and `reads`), and enforces a strict publishing gate that prevents breaking schema changes from reaching production.

---

## 2. High-Level Architecture

Contract Guard follows a **Modular Monolith** pattern organized into four decoupled tiers:

```
┌────────────────────────────────────────────────────────────────────────┐
│                          React + Vite Frontend                         │
│   Dashboard · Service registry · Upload · Diff · Impact · Publish history │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTP / REST
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Express Application (Node.js ES Modules)                               │
│                                                                        │
│   Service Registry                        Spec Management              │
│   Services and owners                     Upload and validation        │
│                                                                        │
│   Comparison Engine                       Compatibility Engine         │
│   Semantic OpenAPI diff                   Breaking-change rules        │
│                                                                        │
│   Impact Analyzer                         Publishing Engine            │
│   Match changes to consumers              Enforce publish policy       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Prisma ORM                                                             │
│ Data access · Relations · Migrations · Transactions                    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Neon PostgreSQL                                                        │
│ Persistent relational data + JSONB specification snapshots             │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Backend Module Breakdown

The Express application is strictly modularized into 6 core domain engines:

1. **Service Registry Module:**
   - Manages service identity, team ownership, descriptions, and active statuses.
   - Enforces unique service naming across the organization.

2. **Specification Management Module:**
   - Multi-stage intake: YAML/JSON parsing -> OpenAPI 3.0.x structure validation -> recursive internal `$ref` component resolution.
   - Decoupled pre-flight validation (`POST /api/specs/validate`) from persistent ingestion (`POST /api/specs/upload`).
   - Persists dual representation: raw document text for download/audit + normalized JSONB AST for diff engines.

3. **Comparison Engine (`spec-comparator.js` & `spec-normalizer.js`):**
   - Canonicalizes dereferenced OpenAPI specs into an abstract entity tree.
   - Compares endpoints, HTTP methods, path/query/header parameters, request bodies, response status codes, and response schemas.
   - Detects nested object mutations, array item structures, data type changes, and constraint modifications.

4. **Compatibility Engine (`compatibility-classifier.js`):**
   - Direction-aware rule evaluation:
     - **BREAKING:** Endpoint removed, path param renamed, request property added as required, response property removed, enum values narrowed, type changed.
     - **NON_BREAKING:** Endpoint added, optional request property added, response property added, enum values expanded.
     - **WARNING:** `deprecated: true`, `x-sunset` dates approaching or passed.
   - Generates human-readable explanations for every diff.

5. **Impact Analyzer:**
   - Cross-references detected breaking diffs against active `consumer_dependencies`.
   - Traces consumer `sends` (requests) and `reads` (responses via dot/array notation: `premium.breakdown[].amount`).
   - Identifies the exact consumer blast radius (`ImpactFinding`).

6. **Publishing Engine:**
   - Enforces the safe release gate (`POST /api/specs/publish`).
   - Blocks publication (HTTP 409) if any registered consumer is impacted.
   - Maintains an immutable audit trail (`PublishAttempt`) of all allowed and blocked release attempts.

---

## 4. Data Model (Prisma Schema)

The storage layer is built around 7 core relational models in PostgreSQL:

1. **`Service`**: Service identity and ownership (`id`, `name`, `owner`, `description`, `timestamps`).
2. **`ApiVersion`**: Versioned OpenAPI documents (`id`, `serviceId`, `versionLabel`, `originalContent`, `parsedContent` JSONB, `format`, `status: PROPOSED | PUBLISHED`).
3. **`ConsumerDependency`**: Declared consumer usage contracts (`id`, `consumerServiceId`, `providerServiceId`, `method`, `path`, `sends` string[], `reads` string[]).
4. **`AnalysisRun`**: Decoupled evaluation runs (`id`, `proposedVersionId`, `baselineVersionId`, `status`, `summary`).
5. **`CompatibilityChange`**: Discrete semantic diffs (`id`, `analysisRunId`, `changeType`, `method`, `path`, `fieldPath`, `classification: BREAKING | NON_BREAKING | UNKNOWN`, `beforeValue`, `afterValue`, `reason`).
6. **`ImpactFinding`**: Many-to-many join linking a broken change to an affected consumer (`id`, `changeId`, `dependencyId`, `reason`).
7. **`PublishAttempt`**: Release audit trail (`id`, `versionId`, `analysisRunId`, `outcome: PUBLISHED | BLOCKED`, `reason`, `attemptedAt`).

---

## 5. Core REST API Design

| Group | Method | Endpoint | Responsibility |
|---|---|---|---|
| **Services** | `GET` | `/api/services` | List all provider services, owner teams, and latest published versions |
| | `POST` | `/api/services` | Register a new provider service record |
| | `GET` | `/api/services/:id` | Get single service details and full version history |
| | `GET` | `/api/services/:id/versions` | List all versions for a service |
| **Specifications** | `POST` | `/api/specs/validate` | Pre-flight validation of OpenAPI YAML/JSON (structure & `$ref`) |
| | `POST` | `/api/specs/upload` | Ingest and store proposed spec, run semantic diff & consumer impact |
| | `GET` | `/api/specs/:versionId` | Retrieve spec version metadata and analysis state |
| | `GET` | `/api/specs/diff` | Semantic AST diff between two arbitrary versions |
| | `GET` | `/api/specs/:versionId/impact` | Retrieve consumer blast radius for a proposed version |
| **Consumers** | `GET` | `/api/consumers` | List all registered consumer services and their dependencies |
| | `POST` | `/api/consumers` | Register or import consumer contract declaration (`sends`/`reads`) |
| | `PUT` | `/api/consumers/:id` | Update consumer contract when a team migrates off a field |
| **Publishing** | `POST` | `/api/specs/publish` | Safe publishing gate: blocks if breaking consumers, publishes if safe |
| | `GET` | `/api/specs/:versionId/publish-history` | Audit log of all publish attempts for a version |
| | `GET` | `/api/publish-attempts` | System-wide publication audit feed |
| **Metrics** | `GET` | `/api/metrics` | Real-time governance metrics (breakages caught, success rate) |

---

## 6. Key Engineering Principles & Non-Functional Design

1. **Separation of Concerns:** Controllers handle routing and parameter validation; dedicated business engines handle AST traversal, diffing, and rules.
2. **Analysis Caching & Stale Protection:** Heavy dereferencing and diff calculations are persisted in `change_records`. The publishing gate validates that consumer contracts haven't changed before executing a release.
3. **Deterministic Error Handling:** Centralized error middleware returning consistent JSON envelopes:
   `{ "success": false, "error": { "code": "...", "message": "...", "details": [...] } }`
4. **Zero-Config Local Development:** Includes embedded PostgreSQL (`scripts/postgres.js`) allowing evaluators to run migrations and native Node.js tests out-of-the-box.
5. **Fixture Immutability:** Starter kit specifications and consumer contracts in `specs/` and `consumers/` remain read-only test fixtures.
