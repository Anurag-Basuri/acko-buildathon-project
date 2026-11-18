# DECISIONS.md: Contract Guard Architecture & Decision Log

This log records every significant architectural, technical, and domain decision made during the design and implementation of Contract Guard, along with context, alternatives considered, trade-offs, and timestamps.

---

### Decision Log

| # | Date & Time (IST) | Area | Decision Summary | Status |
|---|-------------------|------|------------------|--------|
| **ADR-001** | 2026-11-18 17:15 | Architecture | Adopt a Modular Monolith architecture | Approved |
| **ADR-002** | 2026-11-18 17:30 | Tech Stack | Node.js (ES Modules) + Express + PostgreSQL + Prisma ORM + React (Vite) | Approved |
| **ADR-003** | 2026-11-18 18:00 | Database | Dual representation of specs: raw text + normalized JSONB AST | Approved |
| **ADR-004** | 2026-11-18 18:30 | Spec Engine | Pre-flight validation decoupled from ingestion (`validate` vs `upload`) | Approved |
| **ADR-005** | 2026-11-18 19:15 | Differ | AST-based semantic comparison instead of line-based diffing | Approved |
| **ADR-006** | 2026-11-18 19:45 | Governance | Consumer-Driven Contract (CDC) breaking change evaluation | Approved |
| **ADR-007** | 2026-11-18 20:00 | Publishing Gate | Strict blocking of breaking releases impacting active consumers | Approved |
| **ADR-008** | 2026-11-18 20:15 | Development | Local embedded PostgreSQL runner for zero-dependency test execution | Approved |
| **ADR-009** | 2026-11-18 20:30 | Data Model | First-class `AnalysisRun`, `CompatibilityChange`, and `ImpactFinding` entities | Approved |
| **ADR-010** | 2026-11-18 20:45 | API Design | Standardized JSON envelope for success and error responses | Approved |

---

### Detailed Architecture Decision Records (ADRs)

#### ADR-001: Modular Monolith vs Microservices
* **Context:** Contract Guard is an internal developer platform responsible for validating OpenAPI specifications, analyzing diffs, matching consumer dependencies, and enforcing publishing gates.
* **Decision:** Implement Contract Guard as a **modular monolith** with clean module separation (`service-registry`, `spec-management`, `spec-comparator`, `compatibility-classifier`, `consumer-impact`, `publishing-engine`).
* **Rationale:** A modular monolith eliminates network serialization overhead, distributed transactions, and orchestration complexity within a 6-hour build window, while maintaining strict boundaries so components can be broken out into microservices later if necessary.
* **Trade-off:** Requires disciplined internal imports and clear boundary enforcement to prevent tight coupling.

#### ADR-002: Technology Stack Selection
* **Context:** Need high developer velocity, rich OpenAPI 3.0 tooling ecosystem, robust relational database with JSON querying, and a fast reactive UI.
* **Decision:**
  * **Backend:** Node.js (v20+ LTS, ES Modules), Express.js.
  * **Database & ORM:** PostgreSQL (Neon serverless for production; embedded-postgres for local tests), Prisma ORM.
  * **Parser & Schema Tools:** `@apidevtools/swagger-parser` and `js-yaml`.
  * **Frontend:** React + TypeScript + Vite.
* **Rationale:** JavaScript ecosystem offers the strongest native OpenAPI parsing and dereferencing tools (`@apidevtools/swagger-parser`). PostgreSQL's JSONB enables fast indexing and querying of parsed AST schemas.

#### ADR-003: Dual Representation of Specifications
* **Context:** Specifications arrive in YAML or JSON format. Consumers need to inspect/download the exact original uploaded file, while diff and validation engines require a consistent, fully resolved AST.
* **Decision:** Store both `originalContent` (exact text) and `parsedContent` (dereferenced, normalized JSON AST) in `ApiVersion`.
* **Rationale:** Eliminates the need to repeatedly re-parse and re-dereference complex `$ref` trees on every query or diff, while preserving the raw source for auditability and original file downloads.

#### ADR-004: Decoupling Validation from Ingestion (`validate` vs `upload`)
* **Context:** Developers and CI pipelines often want to test whether an OpenAPI specification is valid before creating persistent records.
* **Decision:** Provide a standalone pre-flight endpoint `POST /api/specs/validate` that parses, checks OpenAPI structure, and verifies that all `$ref` pointers resolve without creating database records. `POST /api/specs/upload` also validates internally before saving as `PROPOSED`.
* **Rationale:** Improves developer experience and prevents cluttering the database with draft or invalid test specs.

#### ADR-005: AST-Based Semantic Comparison Engine
* **Context:** Raw textual diffing (like `git diff`) generates false positives when schemas are reordered, components are inlined/factored out, or comments change.
* **Decision:** Normalize OpenAPI specs into an abstract model (Endpoints -> Methods -> Parameters -> Request Bodies -> Response Statuses -> Response Schemas) and compare nodes semantically.
* **Rationale:** Reusable component renaming (e.g. `Premium` renamed to `PremiumDetails` in `quote-api/2`) does not break callers if the underlying schema fields remain compatible. Only semantic breaks are reported.

#### ADR-006: Consumer-Driven Contract (CDC) Impact Analysis
* **Context:** Provider API changes are not inherently breaking in a vacuum; an API change only causes a production outage if an active downstream consumer relies on the affected field or route.
* **Decision:** Evaluate breaking changes against registered `consumer_dependencies` (`sends` and `reads`).
  * If an endpoint changes but no consumer calls it, it is classified as safe to publish.
  * If a removed field is listed under a consumer's `reads` (e.g., `legacyCode` read by `payments-svc`), it is classified as a blocking consumer break.
* **Rationale:** Prevents unnecessary blockers for unused endpoints while providing 100% protection for real consumer traffic paths.

#### ADR-007: Strict Publishing Gate & Deferred Overrides
* **Context:** The problem statement explicitly requires: *"Publishing a version with changes that would break consumers is stopped."*
* **Decision:** By default, `POST /api/specs/publish` strictly blocks any version that impacts registered consumers (returning HTTP 409 Conflict). Unrestricted override functionality is deferred pending formal Product Owner exception policy guidelines.
* **Rationale:** A gate that can be trivially bypassed without cross-team approval defeats the primary governance goal of Contract Guard.

#### ADR-008: Embedded PostgreSQL for Local Dev & Testing
* **Context:** Evaluation and local CI environments may not have a running Docker daemon or pre-installed PostgreSQL instance.
* **Decision:** Include `embedded-postgres` with `scripts/postgres.js` (`npm run db:up`). The test suite boots its own ephemeral database instance.
* **Rationale:** Ensures that evaluators can run `npm test` or `npm run dev` out-of-the-box on macOS, Linux, or Windows/WSL2 with zero manual database provisioning.

#### ADR-009: Decoupled Entity Model for Analysis Runs and Findings
* **Context:** A consumer can update its contract declaration after an API version has been analyzed. If findings were directly hardcoded onto `ApiVersion`, re-evaluations would overwrite historical analysis state.
* **Decision:** Introduce `AnalysisRun`, `CompatibilityChange`, and `ImpactFinding` as discrete relational entities.
* **Rationale:** Enables re-running impact analysis when consumer declarations change without altering the underlying specification version, while preserving full audit history.

#### ADR-010: Standardized API Envelope & Error Format
* **Context:** Frontend and CI tools need predictable error codes and structured details across all endpoints.
* **Decision:** Standardize responses into:
  * Success: `{ "success": true, "data": { ... } }`
  * Error: `{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [...] } }`
* **Rationale:** Eliminates client-side ambiguity and guarantees consistent error consumption.
