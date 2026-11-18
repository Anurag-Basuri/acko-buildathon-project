# PROGRESS.md: Contract Guard Build Progress & Checkpoint Log

**Candidate:** SDE Intern Candidate  
**Project:** Contract Guard — API Contract Registry & Compatibility Governance  
**Current Milestone:** Checkpoint 2 (Progress Update)  
**Timestamp:** 2026-11-18 21:05 IST  

---

## 1. What Works So Far

### A. Infrastructure & Foundations
- **Runtime & Setup:** Configured Node.js v20+ backend with Express (ES Modules), dotenv configuration, and graceful shutdown signal handlers.
- **Database & ORM:** Initialized Prisma ORM with PostgreSQL. Created local disposable development runner using `embedded-postgres` (`npm run db:up` on port 5432) for zero-config evaluation.
- **Git & Repository Hygiene:** Configured comprehensive `.gitignore` preventing build artifacts, logs, and embedded databases from entering version control. Commits structured in logical, atomic increments.

### B. Service Registry (Must-Have 1)
- **Database Model:** `Service` model with unique name constraint, team ownership, and timestamps.
- **Prisma Migration:** Initial migration `20261118144802_init` generated and applied.
- **Endpoints Implemented:**
  - `GET /api/services` — Lists registered provider services, owners, latest published versions, and version counts.
  - `POST /api/services` — Validates required fields (`name`, `owner`) and creates service records.
  - `GET /api/services/:id` — Fetches full details and all uploaded versions of a service.
  - `GET /api/services/:id/versions` — Returns version history and lifecycle status.
- **Validation & Error Handling:** Input validation via `service.validators.js` returning structured 4xx error envelopes.

### C. Specification Management & Validation Engine (Must-Haves 1 & 2)
- **Database Model:** `ApiVersion` model storing raw specification string (`originalContent`), normalized JSON AST (`parsedContent`), detected OpenAPI version (`openApiVersion`), and status (`PROPOSED` vs `PUBLISHED`).
- **Prisma Migration:** Migration `20261118151023_add_api_version` generated and applied.
- **Validation Engine (`spec-validator.js`):**
  - Syntactic and structural validation for OpenAPI 3.0.x and Swagger 2.0 (via `@apidevtools/swagger-parser` and `js-yaml`).
  - Multi-stage check: file parsing -> structure check -> full `$ref` component resolution.
  - Correctly catches and isolates broken internal references (verified against the typo `ClaimDocumnt` in `claims-api/2-channel-and-notes.yaml`).
- **Endpoints Implemented:**
  - `POST /api/specs/validate` — Pre-flight dry-run validation without persisting.
  - `POST /api/specs/upload` — Ingests specification, validates structure, resolves references, and stores record as `PROPOSED`.
  - `GET /api/specs/:versionId` — Retrieves metadata, parsed content, and analysis status.

### D. Semantic Comparison Engine (Must-Haves 2 & 3)
- **AST Normalization (`spec-normalizer.js`):** Converts dereferenced OpenAPI documents into canonical representations (endpoints, methods, parameters, request body schemas, response schemas, and nested properties).
- **Semantic Differ (`spec-comparator.js`):**
  - Compares endpoints and methods added or removed.
  - Compares query, path, and header parameters.
  - Detects renamed path parameters (e.g. `/quotes/{id}` vs `/quotes/{quoteId}`).
  - Detects changes in request bodies, response status codes, and response body schemas.
  - Detects deep property additions, removals, data type mutations, and constraint changes.

### E. Compatibility Classification Engine (Must-Have 4)
- **Rule Engine (`compatibility-classifier.js`, `compatibility-rules.js`):**
  - Categorizes semantic diffs into `BREAKING`, `NON_BREAKING`, or `UNKNOWN`.
  - Generates clear, human-readable explanations (e.g. *"Field was removed from response, which will break callers reading this field"*).
  - Handles directional breaking rules (new required request property = breaking; new optional response property = safe).

### F. Verification & Test Suite
- Comprehensive unit and integration test suite implemented under `backend/tests/`:
  - `env.test.js`: Environment configuration and validation.
  - `middleware.test.js`: Error handling envelope and 404 handler.
  - `health.test.js`: Healthcheck endpoint and status reporting.
  - `services.test.js`: Service registry validation, deduplication, and retrieval.
  - `specs.test.js`: Pre-flight OpenAPI validation, ref resolution, and upload.
  - `spec-normalizer.test.js`: Schema tree flattening and canonicalization.
  - `spec-comparator.test.js`: Path, parameter, and schema diff detection.
  - `compatibility-classifier.test.js`: Breaking vs non-breaking classification rules.

---

## 2. What's Currently in Progress / Next on Roadmap

1. **Consumer Contract Dependency Registry (Must-Have 5):**
   - Add `ConsumerDependency` model migration to Prisma.
   - Implement ingestion of consumer YAML files (`mobile-app.yaml`, `partner-portal.yaml`, `payments-svc.yaml`, `notifications-svc.yaml`).
   - Implement endpoints: `GET /api/consumers`, `POST /api/consumers`, and `PUT /api/consumers/:id`.

2. **Consumer Impact Analyzer (Must-Have 6):**
   - Correlate detected compatibility changes against active consumer `sends` and `reads`.
   - Implement `ImpactFinding` entity generation.
   - Endpoint: `GET /api/specs/:versionId/impact`.

3. **Safe Publishing Gate & Audit History (Must-Haves 7 & 8):**
   - Implement `POST /api/specs/publish` enforcing strict blocking if any registered consumer is broken.
   - Implement `PublishAttempt` model and audit trail (`GET /api/specs/:versionId/publish-history`, `GET /api/publish-attempts`).

4. **Webhook Notification Integration (Going Further):**
   - Dispatch structured JSON event notifications to mock receiver at `http://localhost:9900`.

5. **Frontend Dashboard (Must-Have 9):**
   - Build React + Vite SPA connecting to the Express API (Dashboard, Registry, Spec Upload, Diff Viewer, Impact Matrix, Publishing History).

6. **System Protection Metrics (Must-Have 10):**
   - Implement `GET /api/metrics` summarizing registered services, consumers, breaking changes detected, and blocked publish attempts.

---

## 3. Plan Adjustments & Rationale

| Adjustment | Previous Plan | Updated Approach | Rationale |
|---|---|---|---|
| **Incremental Prisma Migrations** | Single giant database schema migration upfront | Multi-phase migrations per functional module (`init` -> `api_version` -> `consumer_dependencies`) | Keeps migrations small, verifiable, and isolated; avoids blocking core service features while diffing logic is built. |
| **Local Database Execution** | Relying on host-installed PostgreSQL or external Docker container | Integrated `embedded-postgres` development runner (`npm run db:up`) | Eliminates external dependency hurdles for evaluators; guarantees 100% runnable experience on any machine. |
| **Override Workflow Scope** | Adding an unauthenticated force-publish override endpoint | Strict publishing gate by default; overrides deferred pending explicit PO approval | Aligns with the core mission: stopping breaking changes from hitting production without cross-team review. |
