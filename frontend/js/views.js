// The seven dashboard areas, wired to real backend responses only.
//   #/dashboard   overview metrics, charts, recent activity, workflow
//   #/services    registry: services, versions, registration
//   #/specs       specification management: versions, upload, validation
//   #/diff        semantic diff + compatibility classification
//   #/consumers   consumer registry & dependency management
//   #/impact      consumer impact analysis
//   #/publishing  publishing gate + publish history

import { get, post, put, ApiError } from './api.js';
import {
  el,
  formatDateTime,
  loadingView,
  emptyView,
  errorView,
  asyncView,
  classificationBadge,
  statusBadge,
  outcomeBadge,
  toneBadge,
  statCard,
  card,
  dataTable,
  hBarChart,
  donutChart,
  chips,
  pageHead,
  toast,
} from './ui.js';

// ------------------------------------------------------------------ intent
// Cross-view deep links (e.g. a version row's "Impact" button) pass a small
// intent object; the target view consumes it once on load.

const intent = { serviceId: null, versionId: null, fromVersionId: null };
export function setIntent(partial) {
  Object.assign(intent, partial);
}
export function takeIntent() {
  const value = { ...intent };
  for (const key of Object.keys(intent)) intent[key] = null;
  return value;
}

// ------------------------------------------------------------------ shared

async function loadServices() {
  const services = await get('/services');
  return services ?? [];
}

async function loadVersions(serviceId) {
  const versions = await get(`/services/${serviceId}/versions`);
  return versions ?? [];
}

function serviceSelect({ services, value, onChange, placeholder = 'Select a service…' }) {
  const select = el('select', { class: 'service-select', onchange: (e) => onChange(e.target.value) },
    el('option', { value: '' }, placeholder),
    services.map((service) =>
      el('option', { value: service.id, ...(value === service.id ? { selected: '' } : {}) }, service.name)
    )
  );
  return select;
}

async function versionSelect({ serviceId, value, onChange, placeholder = 'Select a version…' }) {
  const select = el('select', { class: 'version-select' });
  try {
    const versions = await loadVersions(serviceId);
    select.append(el('option', { value: '' }, placeholder));
    select.append(
      ...versions.map((version) =>
        el(
          'option',
          { value: version.id, ...(value === version.id ? { selected: '' } : {}) },
          `${version.versionLabel} (${version.status.toLowerCase()})`
        )
      )
    );
  } catch (error) {
    select.append(el('option', { value: '' }, 'Could not load versions'));
  }
  select.addEventListener('change', (e) => onChange(e.target.value));
  return select;
}

/**
 * Re-run the view after a mutation. `view` is a function taking the route
 * params, invoked by the router.
 */
function rerun(viewFactory, routeParams) {
  const host = document.getElementById('view');
  host.replaceChildren(viewFactory(...(routeParams ?? [])));
}

// ================================================================== DASHBOARD

const WORKFLOW_STEPS = [
  {
    title: 'Register the provider service',
    desc: 'Create the API service in the registry (POST /api/services).',
    go: '#/services',
    done: (m) => m.services.total > 0,
  },
  {
    title: 'Upload the initial specification',
    desc: 'Store the current OpenAPI document (POST /api/specs/upload).',
    go: '#/specs',
    done: (m) => m.specs.totalVersions > 0,
  },
  {
    title: 'Publish the baseline version',
    desc: 'Make the current version the published baseline (POST /api/specs/publish).',
    go: '#/publishing',
    done: (m) => m.specs.published > 0,
  },
  {
    title: 'Upload a proposed version',
    desc: 'Store the next version you want to publish (POST /api/specs/upload).',
    go: '#/specs',
    done: (m) => m.specs.proposed > 0,
  },
  {
    title: 'Register consumer declarations',
    desc: 'Declare which operations and fields each consumer sends/reads (POST /api/consumers).',
    go: '#/consumers',
    done: (m) => m.services.consumerCount > 0,
  },
  {
    title: 'Import starter-kit declarations',
    desc: 'One click imports all four starter-kit consumer files (POST /api/consumers/import).',
    go: '#/consumers',
    done: (m) => m.services.consumerCount > 0,
  },
  {
    title: 'Run the semantic diff',
    desc: 'Compare the proposed version against the published baseline (GET /api/specs/diff).',
    go: '#/diff',
    done: () => false, // an action, not a state
    always: true,
  },
  {
    title: 'Review the compatibility classification',
    desc: 'Every change is classified BREAKING / NON_BREAKING / UNKNOWN by the rule engine.',
    go: '#/diff',
    done: (m) => m.compatibility.analyzedVersionCount > 0,
  },
  {
    title: 'Run the consumer impact analysis',
    desc: 'Find registered consumers affected by each change (GET /api/specs/:id/impact).',
    go: '#/impact',
    done: (m) => m.compatibility.analyzedVersionCount > 0,
  },
  {
    title: 'Review affected consumers',
    desc: 'Read the plain-language findings before touching the publish button.',
    go: '#/impact',
    done: (m) => m.compatibility.analyzedVersionCount > 0,
  },
  {
    title: 'Attempt to publish',
    desc: 'The publishing gate decides PUBLISHED or BLOCKED from trusted backend state (POST /api/specs/publish).',
    go: '#/publishing',
    done: (m) => m.publishing.attemptCount > 0,
  },
  {
    title: 'Monitor the dashboard',
    desc: 'Every metric above is computed from the live database — no mock data.',
    go: '#/dashboard',
    done: () => true,
  },
];

export function dashboardView() {
  const head = pageHead('Dashboard', 'Live metrics from the Contract Guard database.');
  const wrap = el('div', {}, head);

  wrap.append(
    asyncView(
      async () => {
        const metrics = await get('/metrics');
        return metrics && metrics.services.total === 0 && metrics.specs.totalVersions === 0
          ? null
          : metrics;
      },
      (metrics) => renderDashboard(metrics),
      {
        icon: '📊',
        title: 'Nothing registered yet',
        message:
          'The database is empty. Register a service, upload a specification and publish the baseline to see live metrics.',
        action: el('a', { class: 'btn primary', href: '#/services' }, 'Register a service'),
      }
    )
  );
  return wrap;
}

function renderDashboard(metrics) {
  const m = metrics;
  const grid = el('div', { class: 'grid cards-4' },
    statCard('Registered services', m.services.total, `${m.services.consumerCount} consumers · ${m.services.providerCount} providers`),
    statCard('Specification versions', m.specs.totalVersions, `${m.specs.published} published · ${m.specs.proposed} proposed`),
    statCard('Analyzed versions', m.compatibility.analyzedVersionCount, `${m.compatibility.analysisRunCount} total analysis runs (history kept)`),
    statCard('Publish attempts', m.publishing.attemptCount, m.publishing.successRate === null ? 'no attempts yet' : `${Math.round(m.publishing.successRate * 100)}% success rate`)
  );
  const grid2 = el('div', { class: 'grid cards-4' },
    statCard('Breaking changes', m.compatibility.breakingChanges, `of ${m.compatibility.totalChanges} classified changes`, 'tone-breaking'),
    statCard('Unknown changes', m.compatibility.unknownChanges, 'require manual review before publish', 'tone-unknown'),
    statCard('Affected consumers', m.impact.affectedConsumerCount, `${m.impact.affectedDependencyCount} dependencies · ${m.impact.affectedChangeCount} changes`),
    statCard('Blocked publishes', m.publishing.blockedCount, 'blocked attempts are never counted as successful', m.publishing.blockedCount > 0 ? 'tone-breaking' : '')
  );

  const runLabels = m.compatibility.latestRuns.map((run) => `${run.service.name} ${run.versionLabel}`);
  const changeChart = m.compatibility.latestRuns.length
    ? hBarChart({
        labels: runLabels,
        series: [
          { name: 'Breaking', color: 'var(--breaking)', values: m.compatibility.latestRuns.map((run) => run.breakingChanges) },
          { name: 'Non-breaking', color: 'var(--nonbreaking)', values: m.compatibility.latestRuns.map((run) => run.nonBreakingChanges) },
          { name: 'Unknown', color: 'var(--unknown)', values: m.compatibility.latestRuns.map((run) => run.unknownChanges) },
        ],
      })
    : el('p', { class: 'empty-inline' }, 'No versions analyzed yet — run an impact analysis first.');

  const outcomeDonut = m.publishing.attemptCount
    ? donutChart({
        slices: [
          { name: 'Published', value: m.publishing.publishedCount, color: 'var(--nonbreaking)' },
          { name: 'Blocked', value: m.publishing.blockedCount, color: 'var(--breaking)' },
        ],
        centerLabel: 'attempts',
      })
    : el('p', { class: 'empty-inline' }, 'No publish attempts yet.');

  const blockedEntries = Object.entries(m.publishing.blockedByCode ?? {});
  const blockedChart = blockedEntries.length
    ? hBarChart({
        labels: blockedEntries.map(([code]) => code),
        series: [{ name: 'Blocked', color: 'var(--breaking)', values: blockedEntries.map(([, count]) => count) }],
      })
    : el('p', { class: 'empty-inline' }, 'No blocked publishes 🎉');

  const left = el(
    'div',
    { class: 'grid', style: 'gap:16px' },
    card('Compatibility across analyzed versions <span class="muted">(latest run per version — history is not double-counted)</span>', changeChart),
    card('Blocked publish attempts by reason', blockedChart)
  );
  const right = el('div', { class: 'grid', style: 'gap:16px' },
    card('Publishing outcomes', outcomeDonut),
    card('Recent activity', renderActivity(m.recentActivity))
  );

  return el('div', {}, grid, grid2, el('div', { class: 'grid cols-3-2' }, left, right), renderWorkflow(m));
}

function renderActivity(activity) {
  if (!activity?.length) return el('p', { class: 'empty-inline' }, 'No recent activity.');
  return el(
    'div',
    { class: 'activity' },
    activity.map((event) =>
      el(
        'div',
        { class: 'item' },
        el('span', { class: 'when', title: formatDateTime(event.at) }, shortWhen(event.at)),
        el(
          'span',
          { class: 'what' },
          el('span', { class: 'subj' }, toneBadge(event.type.replace(/_/g, ' '), badgeTypeTone(event.type))),
          el('div', {}, el('span', {}, ` ${event.subject}`)),
          el('div', { class: 'detail' }, event.detail)
        )
      )
    )
  );
}

function badgeTypeTone(type) {
  if (type === 'SPEC_PUBLISHED') return 'published';
  if (type === 'PUBLISH_BLOCKED') return 'blocked';
  if (type === 'ANALYSIS_COMPLETED') return 'accent';
  if (type === 'SPEC_UPLOADED') return 'neutral';
  return 'neutral';
}

function shortWhen(value) {
  const date = new Date(value);
  const now = Date.now();
  const diff = now - date.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function renderWorkflow(m) {
  const steps = el(
    'div',
    { class: 'workflow' },
    WORKFLOW_STEPS.map((step, index) => {
      const done = step.always ? step.done(m) : step.done(m);
      return el(
        'div',
        { class: `wstep${done ? ' done' : ''}` },
        el('span', { class: 'num' }, done ? '✓' : String(index + 1)),
        el(
          'div',
          { class: 'body' },
          el('div', { class: 'title' }, step.title),
          el('div', { class: 'desc' }, step.desc),
          el('div', { class: 'go' }, el('a', { href: step.go }, done ? 'Open' : 'Go to step'))
        )
      );
    })
  );
  return card('Evaluator workflow <span class="muted">(all twelve steps, wired to the live API)</span>', steps);
}

// ================================================================== SERVICES

export function servicesView() {
  const form = el('div', { style: 'display:none' });
  const nameInput = el('input', { placeholder: 'e.g. policy-api' });
  const ownerInput = el('input', { placeholder: 'e.g. Policy Team' });
  const descInput = el('input', { placeholder: 'optional' });
  const formBody = el(
    'div',
    { class: 'form' },
    el('div', { class: 'form-row' },
      el('div', { class: 'field' }, el('label', {}, 'Name'), nameInput),
      el('div', { class: 'field' }, el('label', {}, 'Owner'), ownerInput),
      el('div', { class: 'field' }, el('label', {}, 'Description'), descInput)
    ),
    el(
      'div',
      {},
      el(
        'button',
        {
          class: 'btn primary',
          onclick: async (e) => {
            e.target.disabled = true;
            try {
              await post('/services', {
                name: nameInput.value.trim(),
                owner: ownerInput.value.trim(),
                description: descInput.value.trim() || undefined,
              });
              toast(`Service "${nameInput.value.trim()}" registered`, 'success');
              rerun(servicesView);
            } catch (error) {
              toast(error.message, 'error');
              e.target.disabled = false;
            }
          },
        },
        'Register service'
      )
    )
  );
  form.append(
    el('div', { class: 'page-head', style: 'margin-bottom:12px' }, el('h2', {}, 'Register a service')),
    formBody
  );

  const head = pageHead('Service registry', 'All registered services — providers and consumers share one identity model.',
    el('button', { class: 'btn primary', onclick: () => { form.style.display = form.style.display === 'none' ? 'block' : 'none'; } }, '＋ Register service')
  );

  const wrap = el('div', {}, head, form);
  wrap.append(
    asyncView(
      async () => {
        const [services, serviceMetrics] = await Promise.all([loadServices(), get('/metrics/services')]);
        return services.length ? { services, serviceMetrics } : null;
      },
      ({ services, serviceMetrics }) => {
        const byId = new Map((serviceMetrics ?? []).map((row) => [row.id, row]));
        return el(
          'div',
          { class: 'card' },
          dataTable(
            ['Service', 'Owner', 'Versions', 'Published', 'Current baseline', 'Consumes', 'Consumers of it', 'Latest analysis'],
            services.map((service) => {
              const row = byId.get(service.id) ?? null;
              return [
                el('a', { href: `#/specs/${service.id}` }, service.name),
                el('span', {}, service.owner),
                el('span', {}, String(row?.versionCount ?? 0)),
                el('span', {}, String(row?.publishedVersionCount ?? 0)),
                row?.currentBaseline ? el('span', {}, row.currentBaseline.versionLabel) : toneBadge('none', 'neutral'),
                el('span', {}, String(row?.dependencyCount ?? 0)),
                el('span', {}, String(row?.consumerDependencyCount ?? 0)),
                row?.latestAnalysis
                  ? el('span', {}, `${row.latestAnalysis.totalChanges} changes · ${row.latestAnalysis.affectedConsumers} affected`)
                  : el('span', { class: 'empty-inline' }, '—'),
              ];
            })
          )
        );
      },
      {
        icon: '🏷️',
        title: 'No services yet',
        message: 'Register the first API service to start the contract governance workflow.',
        action: el('button', { class: 'btn primary', onclick: () => { form.style.display = 'block'; nameInput.focus(); } }, 'Register a service'),
      }
    )
  );
  return wrap;
}

// ================================================================== SPECS

export function specsView(serviceId) {
  if (!serviceId) return specsIndexView();

  const servicesPromise = loadServices();
  const service = servicesPromise.then((list) => list.find((s) => s.id === serviceId) ?? null);

  const headPromise = service.then((s) =>
    pageHead(
      s ? s.name : 'Unknown service',
      s ? `Owner: ${s.owner}` : 'This service no longer exists.',
      s ? [el('a', { class: 'btn', href: '#/services' }, '← All services')] : []
    )
  );

  const wrap = el('div');
  wrap.append(loadingView('Loading service…'));
  (async () => {
    try {
      const s = await service;
      wrap.replaceChildren();
      if (!s) {
        wrap.append(errorView(new ApiError({ status: 404, code: 'SERVICE_NOT_FOUND', message: 'Service not found' })));
        return;
      }
      wrap.append(await headPromise);
      wrap.append(specsUploadCard(s));
      wrap.append(await specsVersionsCard(s));
    } catch (error) {
      wrap.replaceChildren(errorView(error));
    }
  })();
  return wrap;
}

function specsIndexView() {
  const head = pageHead('Specifications', 'Pick a service to manage its versions. New versions are stored as PROPOSED until published.');
  const wrap = el('div', {}, head);
  wrap.append(
    asyncView(
      async () => {
        const services = await loadServices();
        const serviceMetrics = await get('/metrics/services');
        const withVersions = services
          .map((service) => ({ service, row: serviceMetrics.find((row) => row.id === service.id) }))
          .filter((entry) => entry.row && entry.row.versionCount > 0);
        return withVersions.length ? withVersions : null;
      },
      (withVersions) =>
        el(
          'div',
          { class: 'grid cards-3' },
          withVersions.map(({ service, row }) =>
            el(
              'a',
              { class: 'card stat', href: `#/specs/${service.id}`, style: 'text-decoration:none;color:inherit' },
              el('span', { class: 'label' }, service.name),
              el('span', { class: 'value' }, String(row.versionCount), el('small', {}, ' versions')),
              el('span', { class: 'sub' }, row.currentBaseline ? `baseline: ${row.currentBaseline.versionLabel}` : 'no baseline yet')
            )
          )
        ),
      {
        icon: '📄',
        title: 'No specifications yet',
        message: 'Register a service and upload its OpenAPI document to begin.',
        action: el('a', { class: 'btn primary', href: '#/services' }, 'Go to service registry'),
      }
    )
  );
  return wrap;
}

function specsUploadCard(service) {
  const labelInput = el('input', { placeholder: 'e.g. v2', required: '' });
  const contentArea = el('textarea', { placeholder: 'Paste the OpenAPI YAML (or JSON) here…', spellcheck: 'false' });
  const validateOut = el('div', {});
  const uploading = { current: false };

  async function runPreflight() {
    validateOut.replaceChildren(loadingView('Validating…'));
    try {
      const result = await post('/specs/validate', { content: contentArea.value });
      validateOut.replaceChildren(
        el('div', { class: 'note' },
          el('span', {}, toneBadge('VALID', 'published')),
          ` ${result.format.toUpperCase()} ${result.openApiVersion ?? ''} — document is structurally valid.`
        )
      );
    } catch (error) {
      const list = Array.isArray(error.details) ? error.details : [];
      validateOut.replaceChildren(
        el('div', { class: 'note warn' },
          el('span', {}, toneBadge('INVALID', 'blocked')),
          ` ${error.message}${list.length ? ` (${list.length} issue(s))` : ''}`
        )
      );
    }
  }

  const form = el(
    'div',
    { class: 'form' },
    el('div', { class: 'form-row' },
      el('div', { class: 'field' }, el('label', {}, 'Version label'), labelInput)
    ),
    el('div', { class: 'field' },
      el('label', {}, 'Specification content'),
      el('span', { class: 'hint' }, 'OpenAPI 3.0.x YAML or JSON. The document is validated and $refs are resolved before storage.'),
      contentArea
    ),
    validateOut,
    el('div', { class: 'form-row', style: 'align-items:flex-end' },
      el('button', { class: 'btn', onclick: runPreflight }, 'Validate only'),
      el(
        'button',
        {
          class: 'btn primary',
          onclick: async (e) => {
            if (uploading.current) return;
            uploading.current = true;
            e.target.disabled = true;
            try {
              const created = await post('/specs/upload', {
                serviceId: service.id,
                versionLabel: labelInput.value.trim(),
                content: contentArea.value,
              });
              toast(`Uploaded ${created.versionLabel} as PROPOSED`, 'success');
              rerun(specsView, [service.id]);
            } catch (error) {
              toast(error.message, 'error');
              e.target.disabled = false;
              uploading.current = false;
            }
          },
        },
        'Upload version'
      )
    )
  );
  return card(`Upload a new version of ${service.name}`, form);
}

async function specsVersionsCard(service) {
  const versions = await loadVersions(service.id);
  const rows = versions.map((version) => [
    el('span', { class: 'mono' }, version.versionLabel),
    statusBadge(version.status),
    el('span', {}, version.format),
    el('span', { class: 'mono' }, formatDateTime(version.createdAt)),
    el('span', {},
      el('a', { href: '#/diff', onclick: (e) => { e.preventDefault(); setIntent({ serviceId: service.id, versionId: version.id }); location.hash = '#/diff'; } }, 'Diff'),
      '  ',
      el('a', { href: '#/impact', onclick: (e) => { e.preventDefault(); setIntent({ serviceId: service.id, versionId: version.id }); location.hash = '#/impact'; } }, 'Impact'),
      '  ',
      el('a', { href: '#/publishing', onclick: (e) => { e.preventDefault(); setIntent({ serviceId: service.id, versionId: version.id }); location.hash = '#/publishing'; } }, 'Publish')
    ),
  ]);
  if (!versions.length) {
    return card(`Versions of ${service.name}`, el('p', { class: 'empty-inline' }, 'No versions uploaded yet.'));
  }
  return card(`Versions of ${service.name} <span class="muted">(chronological)</span>`, dataTable(['Version', 'Status', 'Format', 'Uploaded', 'Actions'], rows));
}

// ================================================================== DIFF

export function diffView() {
  const { serviceId, versionId } = takeIntent();
  const wrap = el('div');
  wrap.append(pageHead('Semantic diff & classification', 'Compare two versions of a service. Every change is classified by the deterministic rule engine.'));

  const controls = el('div', { class: 'card form', style: 'margin-bottom:16px' });
  const resultHost = el('div');

  (async () => {
    try {
      const services = await loadServices();
      if (!services.length) {
        resultHost.append(emptyView('📄', 'No services registered', 'Register a service and upload at least two specification versions to compare.'));
        wrap.append(controls, resultHost);
        return;
      }
      const serviceSelect = serviceSelect({
        services,
        value: serviceId,
        onChange: (id) => { fromHost.replaceChildren(); toHost.replaceChildren(); },
      });
      const fromHost = el('div');
      const toHost = el('div');

      let fromVersionId = '';
      let toVersionId = '';

      const refreshVersionSelects = async (id) => {
        if (!id) { fromHost.replaceChildren(); toHost.replaceChildren(); return; }
        fromHost.replaceChildren(await versionSelect({ serviceId: id, value: fromVersionId, onChange: (v) => (fromVersionId = v) }));
        toHost.replaceChildren(await versionSelect({ serviceId: id, value: toVersionId, onChange: (v) => (toVersionId = v) }));
      };
      await refreshVersionSelects(serviceSelect.value);
      serviceSelect.addEventListener('change', (e) => { fromVersionId = ''; toVersionId = ''; refreshVersionSelects(e.target.value); });

      // Preselect the proposed version from the intent as the "to" side.
      if (versionId && serviceId === serviceSelect.value) {
        toVersionId = versionId;
        await refreshVersionSelects(serviceSelect.value);
        const toSelect = toHost.querySelector('select');
        if (toSelect) toSelect.value = versionId;
      }

      const runButton = el('button', { class: 'btn primary' }, 'Run diff');
      runButton.addEventListener('click', async () => {
        if (!fromVersionId || !toVersionId) {
          toast('Select both a baseline and a proposed version.', 'error');
          return;
        }
        resultHost.replaceChildren(loadingView('Comparing specifications…'));
        try {
          const report = await get('/specs/diff', { fromVersionId, toVersionId });
          resultHost.replaceChildren(renderDiffReport(report));
        } catch (error) {
          resultHost.replaceChildren(errorView(error, () => runButton.click()));
        }
      });

      controls.append(
        el('div', { class: 'field' }, el('label', {}, 'Service'), serviceSelect),
        el('div', { class: 'form-row' },
          el('div', { class: 'field' }, el('label', {}, 'From (baseline)'), fromHost),
          el('div', { class: 'field' }, el('label', {}, 'To (proposed)'), toHost)
        ),
        el('div', {}, runButton)
      );
    } catch (error) {
      resultHost.append(errorView(error));
    }
    wrap.append(controls, resultHost);
  })();

  return wrap;
}

function renderDiffReport(report) {
  const summary = el('div', { class: 'grid cards-3', style: 'margin-bottom:16px' },
    statCard('Changes', report.changeCount, `between ${report.fromVersion.versionLabel} and ${report.toVersion.versionLabel}`),
    statCard('Breaking', report.breakingChangeCount, 'consumers may break', 'tone-breaking'),
    statCard('Unknown', report.unknownChangeCount, 'need manual review', 'tone-unknown')
  );

  if (!report.changes.length) {
    return el('div', {}, summary, el('div', { class: 'card' }, el('p', { class: 'empty-inline' }, 'No structural changes — the two versions are semantically identical.')));
  }

  const rows = report.changes.map((change) => [
    el('span', { class: 'mono' }, change.changeType),
    el('span', {}, change.method ? `${change.method} ${change.path ?? ''}` : change.path ?? '—'),
    el('span', { class: 'mono' }, change.fieldPath ?? '—'),
    classificationBadge(change.classification),
    el('span', { class: 'mono' }, change.ruleId ?? '—'),
    el('span', { style: 'max-width:520px' }, change.description ?? change.reason ?? ''),
  ]);
  return el('div', {}, summary, el('div', { class: 'card' }, el('h2', {}, 'Changes with classification'), dataTable(['Change', 'Operation', 'Field', 'Classification', 'Rule', 'Description'], rows)));
}

// ================================================================== CONSUMERS

export function consumersView() {
  const wrap = el('div');

  const importReportHost = el('div');
  const registerForm = el('div', { style: 'display:none' });

  const runStarterKitImport = async () => {
    importReportHost.replaceChildren(loadingView('Importing starter-kit declarations…'));
    try {
      const report = await post('/consumers/import', {});
      importReportHost.replaceChildren(renderImportReport(report));
      toast('Starter-kit declarations imported', 'success');
      rerun(consumersView);
    } catch (error) {
      importReportHost.replaceChildren(errorView(error));
    }
  };

  const headActions = el('div', { class: 'form-row', style: 'flex:0 0 auto;gap:8px' },
    el('button', { class: 'btn', onclick: runStarterKitImport }, '⬇ Import starter kit'),
    el('button', {
      class: 'btn primary',
      onclick: () => {
        registerForm.style.display = registerForm.style.display === 'none' ? 'block' : 'none';
      },
    }, '＋ Register consumer')
  );

  const nameInput = el('input', { placeholder: 'e.g. mobile-app' });
  const ownerInput = el('input', { placeholder: 'e.g. Mobile team' });
  registerForm.append(
    el('div', { class: 'card', style: 'margin-bottom:16px' },
      el('h2', {}, 'Register a consumer'),
      el('div', { class: 'form' },
        el('div', { class: 'form-row' },
          el('div', { class: 'field' }, el('label', {}, 'Name'), nameInput),
          el('div', { class: 'field' }, el('label', {}, 'Owner / team'), ownerInput)
        ),
        el('div', {}, el('button', {
          class: 'btn primary',
          onclick: async (e) => {
            e.target.disabled = true;
            try {
              await post('/consumers', { name: nameInput.value.trim(), owner: ownerInput.value.trim() });
              toast(`Consumer "${nameInput.value.trim()}" registered`, 'success');
              rerun(consumersView);
            } catch (error) {
              toast(error.message, 'error');
              e.target.disabled = false;
            }
          },
        }, 'Register'))
      )
    )
  );

  const head = pageHead('Consumer registry', 'Registered consumers and the operations they declare (sends/reads). Import the starter-kit files with one click.');
  const headEl = head.querySelector('.page-head');
  headEl.append(headActions);

  wrap.append(
    head,
    registerForm,
    importReportHost,
    asyncView(
      async () => {
        const consumers = await get('/consumers');
        return consumers?.length ? consumers : null;
      },
      (consumers) => renderConsumersTable(consumers),
      {
        icon: '👥',
        title: 'No consumers registered',
        message: 'Import the starter-kit consumer declarations or register a consumer and declare its dependencies.',
        action: el('button', { class: 'btn primary', onclick: runStarterKitImport }, 'Import starter kit'),
      }
    )
  );

  const detailHost = el('div', { id: 'consumer-detail' });
  wrap.append(detailHost);

  return wrap;
}

function renderConsumersTable(consumers) {
  const detailHost = document.getElementById('consumer-detail');
  const rows = consumers.map((consumer) => [
    el('span', {}, el('strong', {}, consumer.name), el('div', { class: 'empty-inline' }, consumer.owner)),
    el('span', {}, String(consumer.dependencyCount)),
    el('span', {}, consumer.providers.map((provider) => el('span', { class: 'chip' }, provider.name))),
    el('span', {}, consumer.uses.map((use) => el('span', { class: 'chip' }, `${use.method} ${use.path}`))),
  ]);
  const table = dataTable(['Consumer', 'Dependencies', 'Providers', 'Declared operations'], rows, {
    clickableRow: (index) => {
      detailHost.replaceChildren(renderConsumerDetail(consumers[index]));
      detailHost.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },
  });
  return el('div', { class: 'card' }, el('h2', {}, `Registered consumers <span class="muted">(click a row to manage its dependencies)</span>`), table);
}

function renderConsumerDetail(consumer) {
  const deps = consumer.uses.map((use) => ({
    ...use,
    providerName: consumer.providers.find((p) => p.id === use.providerServiceId)?.name ?? '?',
  }));
  const providerOptions = consumer.providers.map((provider) => el('option', { value: provider.id }, provider.name));

  const listHost = el('div');
  function renderList() {
    listHost.replaceChildren(
      ...deps.map((dep, index) =>
        el('div', { class: 'finding' },
          el('div', { class: 'head' },
            el('strong', {}, dep.providerName),
            toneBadge(`${dep.method} ${dep.path}`, 'accent'),
            el('span', { style: 'flex:1' }),
            el('button', { class: 'btn sm', onclick: () => { deps.splice(index, 1); renderList(); } }, 'Remove')
          ),
          el('div', { class: 'meta' },
            el('span', {}, 'sends: ', chips(dep.sends)),
            el('span', {}, 'reads: ', chips(dep.reads))
          )
        )
      )
    );
    if (!deps.length) listHost.append(el('p', { class: 'empty-inline' }, 'No dependencies declared.'));
  }
  renderList();

  const methodInput = el('input', { value: 'GET' });
  const pathInput = el('input', { placeholder: '/resource/{id}' });
  const sendsInput = el('input', { placeholder: 'comma-separated field paths, e.g. policyId, vehicle.make' });
  const readsInput = el('input', { placeholder: 'comma-separated field paths, e.g. status, premium.total' });
  const providerSelect = el('select', {}, el('option', { value: '' }, 'select provider…'), providerOptions);

  const addButton = el('button', { class: 'btn' }, '＋ Add to list');
  addButton.addEventListener('click', () => {
    if (!providerSelect.value) { toast('Select a provider for the new dependency.', 'error'); return; }
    deps.push({
      providerServiceId: providerSelect.value,
      providerName: providerSelect.selectedOptions[0]?.text ?? '?',
      method: methodInput.value.trim().toUpperCase() || 'GET',
      path: pathInput.value.trim(),
      sends: sendsInput.value.split(',').map((s) => s.trim()).filter(Boolean),
      reads: readsInput.value.split(',').map((s) => s.trim()).filter(Boolean),
    });
    methodInput.value = 'GET';
    pathInput.value = '';
    sendsInput.value = '';
    readsInput.value = '';
    renderList();
  });

  const saveButton = el('button', { class: 'btn primary' }, 'Save (replaces all dependencies)');
  saveButton.addEventListener('click', async () => {
    saveButton.disabled = true;
    try {
      await put(`/consumers/${consumer.id}`, {
        dependencies: deps.map((dep) => ({
          providerId: dep.providerServiceId,
          method: dep.method,
          path: dep.path,
          sends: dep.sends,
          reads: dep.reads,
        })),
      });
      toast(`Dependencies of ${consumer.name} saved`, 'success');
      rerun(consumersView);
    } catch (error) {
      toast(error.message, 'error');
      saveButton.disabled = false;
    }
  });

  return el(
    'div',
    { class: 'card', style: 'margin-top:16px' },
    el('h2', {}, `Dependencies of ${consumer.name} <span class="muted">(PUT /api/consumers/:id is an explicit full replacement)</span>`),
    listHost,
    el('div', { class: 'form', style: 'margin-top:12px' },
      el('div', { class: 'form-row' },
        el('div', { class: 'field' }, el('label', {}, 'Provider'), providerSelect),
        el('div', { class: 'field' }, el('label', {}, 'Method'), methodInput),
        el('div', { class: 'field' }, el('label', {}, 'Path'), pathInput),
        el('div', { class: 'field' }, el('label', {}, 'Sends'), sendsInput),
        el('div', { class: 'field' }, el('label', {}, 'Reads'), readsInput)
      ),
      el('div', { class: 'form-row', style: 'justify-content:space-between' }, addButton, saveButton)
    )
  );
}

function renderImportReport(report) {
  const declarations = (report.declarations ?? []).map((declaration) =>
    el('div', { class: 'finding' },
      el('div', { class: 'head' },
        el('strong', {}, declaration.consumer ?? '?'),
        toneBadge(declaration.status, declaration.status === 'ok' ? 'published' : declaration.status === 'unresolved' ? 'neutral' : 'blocked'),
        el('span', { class: 'empty-inline' }, declaration.source ?? '')
      ),
      (declaration.uses ?? []).length
        ? el('div', { class: 'meta' },
            ...declaration.uses.map((use) =>
              el('span', {}, `${use.method} ${use.path}: `, toneBadge(use.status, use.status === 'validated' ? 'published' : use.status === 'pending_validation' ? 'neutral' : 'blocked'), ' ')
            )
          )
        : el('div', { class: 'meta' }, el('span', {}, (declaration.errors ?? []).map((e) => e.message).join('; ') || 'no uses'))
    )
  );
  return el('div', { class: 'card', style: 'margin-bottom:16px' },
    el('h2', {}, `Import report <span class="muted">${report.source}</span>`),
    el('div', { class: 'kv' },
      el('dt', {}, 'Declarations processed'), el('dd', {}, String(report.declarationsProcessed)),
      el('dt', {}, 'Consumers created / existing'), el('dd', {}, `${report.consumersCreated} / ${report.consumersExisting}`),
      el('dt', {}, 'Dependencies upserted'), el('dd', {}, String(report.dependenciesUpserted)),
      el('dt', {}, 'Unresolved providers'), el('dd', {}, report.unresolvedProviders.length ? report.unresolvedProviders.map((u) => u.provider).join(', ') : 'none')
    ),
    el('div', { style: 'margin-top:12px' }, declarations)
  );
}

// ================================================================== IMPACT

export function impactView() {
  const { serviceId, versionId } = takeIntent();
  const wrap = el('div');
  wrap.append(pageHead('Consumer impact analysis', 'Which registered consumers are affected by a proposed version, and why — computed from registered declarations, never from traffic.'));

  const controls = el('div', { class: 'card form', style: 'margin-bottom:16px' });
  const resultHost = el('div');
  wrap.append(controls, resultHost);

  (async () => {
    try {
      const services = await loadServices();
      if (!services.length) {
        resultHost.append(emptyView('📄', 'No services registered', 'Register a service first.'));
        return;
      }
      const serviceSelect = serviceSelect({
        services,
        value: serviceId,
        onChange: (id) => { versionHost.replaceChildren(); resultHost.replaceChildren(); },
      });
      const versionHost = el('div');
      let selectedVersionId = versionId ?? '';

      const refresh = async (id) => {
        if (!id) { versionHost.replaceChildren(); return; }
        const select = await versionSelect({
          serviceId: id,
          value: selectedVersionId,
          onChange: (v) => (selectedVersionId = v),
          placeholder: 'Select the proposed version…',
        });
        versionHost.replaceChildren(select);
      };
      await refresh(serviceSelect.value);
      if (!selectedVersionId) {
        // default to the newest PROPOSED version when the intent gave a service
        try {
          const versions = await loadVersions(serviceSelect.value);
          const proposed = versions.filter((v) => v.status === 'PROPOSED').pop();
          if (proposed) {
            selectedVersionId = proposed.id;
            await refresh(serviceSelect.value);
            versionHost.querySelector('select').value = proposed.id;
          }
        } catch { /* ignore */ }
      }

      const runButton = el('button', { class: 'btn primary' }, 'Run impact analysis');
      runButton.addEventListener('click', async () => {
        if (!selectedVersionId) { toast('Select a proposed version.', 'error'); return; }
        resultHost.replaceChildren(loadingView('Analyzing impact (comparison + classification + impact)…'));
        try {
          const report = await get(`/specs/${selectedVersionId}/impact`);
          resultHost.replaceChildren(renderImpactReport(report));
        } catch (error) {
          if (error.code === 'NO_PUBLISHED_BASELINE') {
            resultHost.replaceChildren(
              emptyView(
                '🚧',
                'No published baseline',
                `${error.message} Publishing the current version first will enable impact analysis.`,
                el('a', { class: 'btn primary', href: '#/publishing', onclick: () => setIntent({ serviceId: serviceSelect.value, versionId: selectedVersionId }) }, 'Go to publishing')
              )
            );
            return;
          }
          resultHost.replaceChildren(errorView(error, () => runButton.click()));
        }
      });

      controls.append(
        el('div', { class: 'field' }, el('label', {}, 'Service'), serviceSelect),
        el('div', { class: 'field' }, el('label', {}, 'Proposed version'), versionHost),
        el('div', {}, runButton)
      );
    } catch (error) {
      resultHost.append(errorView(error));
    }
  })();

  return wrap;
}

function renderImpactReport(report) {
  const summary = el('div', { class: 'grid cards-3', style: 'margin-bottom:16px' },
    statCard('Changes', report.changeCount, `${report.baselineVersion.versionLabel} → ${report.proposedVersion.versionLabel}`),
    statCard('Breaking', report.breakingChangeCount, `unknown: ${report.unknownChangeCount}`, 'tone-breaking'),
    statCard('Affected consumers', report.affectedConsumerCount, `${report.affectedDependencyCount} dependencies · ${report.affectedChangeCount} changes`, report.affectedConsumerCount ? 'tone-breaking' : '')
  );

  const meta = el('div', { class: 'note', style: 'margin-bottom:16px' },
    el('div', { class: 'kv' },
      el('dt', {}, 'Analysis run'), el('dd', { class: 'mono' }, report.analysisRunId),
      el('dt', {}, 'Computed at'), el('dd', {}, formatDateTime(report.computedAt)),
      el('dt', {}, 'Dependency fingerprint'), el('dd', { class: 'mono' }, `${(report.dependencyFingerprint ?? '').slice(0, 16)}…`),
      el('dt', {}, 'Based on'), el('dd', {}, report.impact.summary.basedOn)
    )
  );

  const findings = (report.impact.findings ?? []).length
    ? el('div', {}, report.impact.findings.map(renderFinding))
    : el('div', { class: 'card' }, el('p', { class: 'empty-inline' }, 'No registered consumer is affected by this change set.'));

  const noMatching = report.impact.summary.noMatchingDeclaration.consumers ?? [];
  const note = el('div', { class: 'note warn', style: 'margin-top:16px' },
    el('span', {}, '⚠️ '),
    noMatching.length
      ? `These registered consumers do not declare any affected operation: ${noMatching.map((c) => c.name).join(', ')}. `
      : 'Every registered consumer declares at least one affected operation. ',
    'A missing declaration is NOT proof of safety — the registry may not capture every real-world usage.'
  );

  return el('div', {}, summary, meta, el('div', { class: 'card' }, el('h2', {}, `Findings (${report.impact.findings.length})`), findings), note);
}

function renderFinding(finding) {
  const direction = finding.dependency.direction;
  const dirClass = direction === 'SENDS' ? 'accent' : direction === 'READS' ? 'unknown' : 'neutral';
  return el('div', { class: 'finding' },
    el('div', { class: 'head' },
      el('strong', {}, finding.consumer.name),
      toneBadge(`${finding.operation.method} ${finding.operation.path}`, 'neutral'),
      classificationBadge(finding.change.classification),
      toneBadge(direction, dirClass),
      el('span', { class: 'mono', style: 'margin-left:auto;font-size:12px;color:var(--text-3)' }, finding.change.changeType)
    ),
    el('p', { class: 'reason' }, finding.reason),
    el('div', { class: 'meta' },
      finding.dependency.matchedDeclaredFields?.length
        ? el('span', {}, 'matched declared fields: ', chips(finding.dependency.matchedDeclaredFields))
        : null,
      el('span', {}, `change #${finding.change.changeIndex + 1} of the sorted change list`)
    )
  );
}

// ================================================================== PUBLISHING

export function publishingView() {
  const { serviceId, versionId } = takeIntent();
  const wrap = el('div');
  wrap.append(pageHead('Publishing gate', 'The backend decides PUBLISHED or BLOCKED from trusted state — the request only supplies the version id. A blocked publish is a business outcome, not an error.'));

  const controls = el('div', { class: 'card form', style: 'margin-bottom:16px' });
  const decisionHost = el('div');
  const historyHost = el('div', { id: 'publish-history' });
  wrap.append(controls, decisionHost, historyHost);

  (async () => {
    try {
      const services = await loadServices();
      if (!services.length) {
        decisionHost.append(emptyView('📄', 'No services registered', 'Register a service first.'));
        return;
      }
      const serviceSelect = serviceSelect({
        services,
        value: serviceId,
        onChange: (id) => { versionHost.replaceChildren(); refreshHistory(id); },
      });
      const versionHost = el('div');
      let selectedVersionId = versionId ?? '';

      const refresh = async (id) => {
        if (!id) { versionHost.replaceChildren(); return; }
        const select = await versionSelect({
          serviceId: id,
          value: selectedVersionId,
          onChange: (v) => {
            selectedVersionId = v;
            refreshHistory(serviceSelect.value, v);
          },
          placeholder: 'Select the version to publish…',
        });
        versionHost.replaceChildren(select);
      };
      await refresh(serviceSelect.value);
      if (!selectedVersionId) {
        try {
          const versions = await loadVersions(serviceSelect.value);
          const proposed = versions.filter((v) => v.status === 'PROPOSED').pop();
          if (proposed) {
            selectedVersionId = proposed.id;
            await refresh(serviceSelect.value);
            versionHost.querySelector('select').value = proposed.id;
            refreshHistory(serviceSelect.value, proposed.id);
          }
        } catch { /* ignore */ }
      }

      const publishButton = el('button', { class: 'btn danger' }, '⚡ Attempt publish');
      publishButton.addEventListener('click', async () => {
        if (!selectedVersionId) { toast('Select a version to publish.', 'error'); return; }
        publishButton.disabled = true;
        decisionHost.replaceChildren(loadingView('Evaluating the publishing gate…'));
        try {
          const decision = await post('/specs/publish', { versionId: selectedVersionId });
          decisionHost.replaceChildren(renderDecision(decision));
          refreshHistory(serviceSelect.value, selectedVersionId);
        } catch (error) {
          if (error.code === 'ALREADY_PUBLISHED') {
            decisionHost.replaceChildren(el('div', { class: 'decision-panel published' },
              el('div', { class: 'title-row' }, outcomeBadge('PUBLISHED'), el('h2', {}, 'Already published')),
              el('p', { class: 'reason' }, `${error.message} — duplicate publish requests are rejected with 409 ALREADY_PUBLISHED.`)
            ));
          } else {
            decisionHost.replaceChildren(errorView(error, () => publishButton.click()));
          }
          publishButton.disabled = false;
        }
      });

      controls.append(
        el('div', { class: 'field' }, el('label', {}, 'Service'), serviceSelect),
        el('div', { class: 'field' }, el('label', {}, 'Version to publish'), versionHost),
        el('div', {}, publishButton)
      );

      if (selectedVersionId) refreshHistory(serviceSelect.value, selectedVersionId);
    } catch (error) {
      decisionHost.append(errorView(error));
    }
  })();

  async function refreshHistory(svcId, verId) {
    historyHost.replaceChildren();
    if (!verId) return;
    historyHost.replaceChildren(loadingView('Loading publish history…'));
    try {
      const history = await get(`/specs/${verId}/publish-history`);
      historyHost.replaceChildren(renderHistory(history));
    } catch (error) {
      historyHost.replaceChildren(errorView(error));
    }
  }

  return wrap;
}

function renderDecision(decision) {
  const cls = decision.outcome === 'PUBLISHED' ? 'published' : 'blocked';
  const panel = el('div', { class: `decision-panel ${cls}` },
    el('div', { class: 'title-row' },
      outcomeBadge(decision.outcome),
      el('h2', {}, `${decision.service.name} ${decision.versionLabel}`),
      toneBadge(decision.code, 'neutral')
    ),
    el('p', { class: 'reason' }, decision.reason)
  );
  if (decision.warnings?.length) {
    panel.append(el('ul', { class: 'warnings' }, decision.warnings.map((warning) => el('li', {}, warning))));
  }
  if (decision.affectedConsumers?.length) {
    panel.append(
      el('div', { class: 'meta' },
        el('span', {}, 'Affected consumers: ',
          ...decision.affectedConsumers.map((consumer) => toneBadge(consumer.name, 'blocked'))))
    );
  }
  panel.append(
    el('div', { class: 'meta' },
      el('span', { class: 'mono' }, `attempt: ${decision.attemptId}`),
      decision.analysisRunId ? el('span', { class: 'mono' }, `analysis run: ${decision.analysisRunId.slice(0, 8)}…`) : null
    )
  );
  return panel;
}

function renderHistory(history) {
  const attempts = history.attempts ?? [];
  if (!attempts.length) {
    return card(`Publish history — ${history.version.versionLabel}`, el('p', { class: 'empty-inline' }, 'No publish attempts for this version yet.'));
  }
  const rows = attempts.map((attempt) => [
    outcomeBadge(attempt.outcome),
    el('span', { class: 'mono' }, attempt.decisionDetails?.code ?? '—'),
    el('span', { style: 'max-width:460px' }, attempt.reason),
    el('span', {}, String((attempt.warnings ?? []).length)),
    el('span', { class: 'mono' }, attempt.analysisRun ? `${String(attempt.analysisRun.id).slice(0, 8)}…` : '—'),
    el('span', { class: 'mono' }, formatDateTime(attempt.createdAt)),
  ]);
  return card(`Publish history — ${history.version.versionLabel} <span class="muted">(newest first, both outcomes kept)</span>`,
    dataTable(['Outcome', 'Decision', 'Reason', 'Warnings', 'Analysis run', 'At'], rows));
}
