# Contract Guard — API Contract Registry & Governance Platform

Contract Guard is an enterprise API contract registry and automated compatibility-governance platform for microservices. It intercepts breaking API changes, maps them to consumer dependencies (`sends` and `reads`), and prevents unsafe schema releases from reaching production.

---

## 1. System Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                          React + Vite Frontend                         │
│   Dashboard · Service registry · Upload · Diff · Impact · Publish history │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTP / REST
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Express application (Node.js ES Modules)                               │
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
│ PostgreSQL (Neon cloud in prod / Embedded PostgreSQL in local dev)     │
│ Persistent relational data + JSONB specification snapshots             │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Prerequisites

* **Node.js:** v20.x or higher (LTS recommended)
* **npm:** v10.x or higher
* **Docker or Podman:** (Optional, for running the mock webhook receiver)
* **Git**

---

## 3. Quickstart: Running Locally from Scratch

### Step 1: Start the Webhook Receiver (Stands in for Slack/Email)
From the project root directory:
```bash
docker compose up --build
```
* Receiver web dashboard: [http://localhost:9900](http://localhost:9900)
* Inspect notifications: `GET http://localhost:9900/api/received`

### Step 2: Install Backend Dependencies
```bash
cd backend
npm install
```

### Step 3: Start the Local Database
Contract Guard includes a zero-dependency embedded PostgreSQL runner (`scripts/postgres.js`):
```bash
npm run db:up
```
* Embedded Postgres starts on `127.0.0.1:5432`.
* Database: `contractguard`
* Connection URL: `postgresql://contractguard:contractguard@127.0.0.1:5432/contractguard`

### Step 4: Run Database Migrations
In a separate terminal:
```bash
cd backend
npx prisma migrate dev
```

### Step 5: Start the Backend Application
```bash
npm run dev
```
* Server starts at: `http://localhost:3000`
* Health check: `http://localhost:3000/api/health`

---

## 4. Running the Automated Test Suite

The test suite runs against native Node.js test runner (`node:test`) and exercises all validation, diffing, and registry rules:

```bash
cd backend
npm test
```

### Test Coverage Highlights:
* `env.test.js` — Verifies fail-fast environment validation and port parsing.
* `middleware.test.js` — Verifies centralized error handling, custom `ApiError`, and 404 envelopes.
* `health.test.js` — Verifies system health endpoints and payload formats.
* `services.test.js` — Verifies service creation, unique name enforcement, and version retrieval.
* `specs.test.js` — Tests OpenAPI 3.0.x parsing, structural integrity, and `$ref` resolution.
* `spec-normalizer.test.js` — Verifies schema AST canonicalization and flattening.
* `spec-comparator.test.js` — Tests deep semantic diffing across paths, parameters, schemas, and types.
* `compatibility-classifier.test.js` — Tests classification rules (breaking vs non-breaking vs unknown).

---

## 5. API Reference & Implemented Endpoints

### A. Health & Diagnostics
* `GET /api/health` — Service health, database connectivity status, and uptime.

### B. Service Registry (Must-Have 1)
* `GET /api/services` — List all registered provider services and latest published versions.
* `POST /api/services` — Register a new provider service (`name`, `owner`, `description`).
* `GET /api/services/:id` — Fetch complete details and all versions for a service.
* `GET /api/services/:id/versions` — List all specification versions for a service.

### C. Specification Management & Validation (Must-Haves 1 & 2)
* `POST /api/specs/validate` — Dry-run validation of YAML/JSON OpenAPI specs without persisting.
* `POST /api/specs/upload` — Ingest, validate, resolve references, and persist a proposed spec version.
* `GET /api/specs/:versionId` — Retrieve metadata and analysis status for an uploaded version.

### D. Semantic Diff & Compatibility (Must-Haves 3 & 4)
* `GET /api/specs/diff?fromVersionId=...&toVersionId=...` — Semantic AST diff between two versions.
* `POST /api/compatibility/check` — Classify differences into breaking, non-breaking, and warnings.

---

## 6. Implementation Status (What Works & What's Next)

| Must-Have # | Feature | Status | Implementation Details |
|---|---|---|---|
| **1** | Service & Spec Registry | **Done** | `Service` & `ApiVersion` Prisma models, CRUD endpoints, input validation. |
| **2** | Shared Components (`$ref`) | **Done** | Full dereferencing via SwaggerParser. Catches typos like `ClaimDocumnt`. |
| **3** | Comparing Versions | **Done** | Semantic AST comparator across paths, verbs, parameters, schemas, and types. |
| **4** | Classifying Changes | **Done** | Direction-aware compatibility rules with human-readable explanations. |
| **5** | Consumers Registry | *In Progress* | `ConsumerDependency` model, YAML ingestion of `sends` and `reads`. |
| **6** | Impact Analysis | *In Progress* | Matching detected breaks to consumer fields (`premium.breakdown[].amount`). |
| **7** | Safe Publishing Gate | *In Progress* | Backend gate blocking publication on consumer impact (HTTP 409). |
| **8** | Changelog & History | *In Progress* | `PublishAttempt` model and audit trail endpoints. |
| **9** | User Interface | *Next* | React + Vite single-page dashboard. |
| **10** | Metrics & Runnable | *In Progress* | Single-command launch, comprehensive test suite; metrics endpoint next. |

---

## 7. Starter Kit Specifications & Evaluation Fixtures

The starter kit contains sample OpenAPI specifications and consumer declarations under `specs/` and `consumers/`:
* **API Specifications (`specs/`):**
  * `specs/quote-api/` (v1.0.0 initial, v1.1.0 reorganized `{id}` -> `{quoteId}`, v2.0.0 `amount` -> `value`, v2.1.0 `ncbPercent` & `taxes`).
  * `specs/policy-api/` (v1.0.0 initial, v1.1.0 `legacyCode` sunset, v2.0.0 `legacyCode` removed, v2.1.0 required `requestedBy`).
  * `specs/claims-api/` (v1.0.0 initial, v1.1.0 broken `$ref: ClaimDocumnt`, v1.1.0 fixed ref, v2.0.0 `amountApproved` relaxed).
* **Consumer Declarations (`consumers/`):**
  * `mobile-app.yaml`, `partner-portal.yaml`, `payments-svc.yaml`, `notifications-svc.yaml`.

*Contract Guard processes these files as read-only fixtures and never mutates original starter files.*
