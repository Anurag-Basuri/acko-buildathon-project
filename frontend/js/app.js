// Contract Guard frontend entry: hash router, navigation, health indicator.
// No framework, no build step — plain ES modules loaded from index.html.

import { dashboardView, servicesView, specsView, diffView, consumersView, impactView, publishingView } from './views.js';
import { get } from './api.js';

const ROUTES = [
  { pattern: /^\/dashboard$/, view: dashboardView, title: 'Dashboard', nav: 'Dashboard' },
  { pattern: /^\/services$/, view: servicesView, title: 'Service registry', nav: 'Services' },
  { pattern: /^\/specs$/, view: specsView, title: 'Specifications', nav: 'Specifications' },
  { pattern: /^\/specs\/([\w-]+)$/, view: (serviceId) => specsView(serviceId), title: 'Specifications', nav: 'Specifications' },
  { pattern: /^\/diff$/, view: diffView, title: 'Diff', nav: 'Diff & classify' },
  { pattern: /^\/consumers$/, view: consumersView, title: 'Consumers', nav: 'Consumers' },
  { pattern: /^\/impact$/, view: impactView, title: 'Impact', nav: 'Impact analysis' },
  { pattern: /^\/publishing$/, view: publishingView, title: 'Publishing', nav: 'Publishing' },
];

const NAV_ITEMS = [
  { label: 'Dashboard', href: '#/dashboard' },
  { label: 'Services', href: '#/services' },
  { label: 'Specifications', href: '#/specs' },
  { label: 'Diff & classify', href: '#/diff' },
  { label: 'Consumers', href: '#/consumers' },
  { label: 'Impact analysis', href: '#/impact' },
  { label: 'Publishing', href: '#/publishing' },
];

function renderNav(activeLabel) {
  const nav = document.getElementById('nav');
  nav.replaceChildren(
    ...NAV_ITEMS.map((item) => {
      const link = document.createElement('a');
      link.href = item.href;
      link.textContent = item.label;
      if (item.label === activeLabel) link.classList.add('active');
      return link;
    })
  );
}

function parseHash() {
  const hash = window.location.hash.replace(/^#/, '') || '/dashboard';
  const clean = hash.split('?')[0] || '/dashboard';
  return clean === '' ? '/dashboard' : clean;
}

function route() {
  const path = parseHash();
  const match = ROUTES.find((entry) => entry.pattern.test(path));

  const viewHost = document.getElementById('view');
  if (!match) {
    renderNav('');
    window.location.hash = '#/dashboard';
    return;
  }

  renderNav(match.nav);
  document.title = `${match.title} — Contract Guard`;
  window.scrollTo(0, 0);

  const [, arg] = path.match(match.pattern);
  const view = match.view ? match.view(arg) : match.view();
  viewHost.replaceChildren(view);
}

async function checkHealth() {
  const node = document.getElementById('health');
  try {
    const data = await get('/health');
    node.textContent = `API ${data.status} · ${data.environment}`;
    node.className = 'footer-health ok';
  } catch {
    node.textContent = 'API unreachable — start the backend (npm run dev)';
    node.className = 'footer-health bad';
  }
}

window.addEventListener('hashchange', route);
route();
checkHealth();
// Re-check the health status periodically so the footer stays honest.
setInterval(checkHealth, 30_000);
