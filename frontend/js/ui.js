// UI building blocks: DOM helper, loading/empty/error states, cards,
// badges, tables, inline SVG charts and toasts. No framework, no build.

// ------------------------------------------------------------------ DOM

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value !== undefined && value !== null) {
      node.setAttribute(key, value);
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function h(tag, attrs, ...children) {
  return el(tag, attrs, ...children);
}

export function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// ----------------------------------------------------------------- toasts

export function toast(message, tone = 'info', timeout = 4200) {
  const host = document.getElementById('toasts');
  const node = el('div', { class: `toast ${tone}` }, message);
  host.append(node);
  setTimeout(() => node.remove(), timeout);
}

// ---------------------------------------------------------------- states

export function loadingView(label = 'Loading…') {
  return el(
    'div',
    { class: 'state', role: 'status' },
    el('div', { class: 'spinner', 'aria-hidden': 'true' }),
    el('p', {}, label)
  );
}

export function emptyView(icon, title, message, action) {
  const node = el(
    'div',
    { class: 'state' },
    el('div', { class: 'icon', 'aria-hidden': 'true' }, icon),
    el('h3', {}, title),
    el('p', {}, message)
  );
  if (action) node.append(el('div', {}, action));
  return node;
}

export function errorView(error, onRetry) {
  const message =
    error?.message ?? 'Something went wrong.';
  const details =
    error?.details && typeof error.details === 'object' ? JSON.stringify(error.details, null, 2) : null;
  return el(
    'div',
    { class: 'state error', role: 'alert' },
    el('div', { class: 'icon', 'aria-hidden': 'true' }, '⚠️'),
    el('h3', {}, 'Request failed'),
    el('p', {}, message),
    details
      ? el('pre', { class: 'mono', style: 'max-width:520px;text-align:left;white-space:pre-wrap' }, details)
      : null,
    onRetry ? el('button', { class: 'btn', onclick: onRetry }, 'Try again') : null
  );
}

/**
 * Render a data-driven view with loading / error / empty / success handling.
 * `load` returns the payload (or null for "empty"); `render` builds the
 * success DOM. `empty` is the icon+title+message triple for an empty payload.
 */
export function asyncView(load, render, empty, { heading } = {}) {
  const wrap = el('div');
  const run = async () => {
    wrap.replaceChildren(loadingView(heading ? `Loading ${heading}…` : 'Loading…'));
    try {
      const data = await load();
      if (data === null || data === undefined) {
        wrap.replaceChildren(emptyView(empty.icon, empty.title, empty.message, empty.action));
      } else {
        wrap.replaceChildren(render(data));
      }
    } catch (error) {
      wrap.replaceChildren(errorView(error, run));
    }
  };
  run();
  return wrap;
}

// ----------------------------------------------------------------- badges

export function classificationBadge(classification) {
  const value = String(classification ?? 'UNKNOWN').toUpperCase();
  const cls =
    value === 'BREAKING' ? 'breaking' : value === 'NON_BREAKING' ? 'non-breaking' : 'unknown';
  return el('span', { class: `badge ${cls}` }, value.replace('_', ' '));
}

export function statusBadge(status) {
  const value = String(status ?? '').toUpperCase();
  const cls = value === 'PUBLISHED' ? 'published' : value === 'PROPOSED' ? 'proposed' : 'neutral';
  return el('span', { class: `badge ${cls}` }, value);
}

export function outcomeBadge(outcome) {
  const value = String(outcome ?? '').toUpperCase();
  const cls = value === 'PUBLISHED' ? 'published' : value === 'BLOCKED' ? 'blocked' : 'neutral';
  return el('span', { class: `badge ${cls}` }, value);
}

export function toneBadge(text, cls = 'neutral') {
  return el('span', { class: `badge ${cls}` }, text);
}

// ------------------------------------------------------------------ cards

export function statCard(label, value, sub = null, valueClass = '') {
  return el(
    'div',
    { class: 'card stat' },
    el('span', { class: 'label' }, label),
    el('span', { class: `value ${valueClass}` }, value),
    sub ? el('span', { class: 'sub' }, sub) : null
  );
}

export function card(title, ...children) {
  // Titles may carry trusted markup (e.g. a muted suffix); user data inside
  // them must be escaped by the caller with escapeHtml().
  const heading =
    typeof title === 'string' && title.includes('<') ? el('h2', { html: title }) : el('h2', {}, title);
  return el('div', { class: 'card' }, heading, ...children);
}

// ----------------------------------------------------------------- tables

export function dataTable(headers, rows, { clickableRow } = {}) {
  const table = el(
    'table',
    { class: 'data' },
    el(
      'thead',
      {},
      el('tr', {}, headers.map((headerText) => el('th', {}, headerText)))
    ),
    el('tbody', {}, rows.map((cells, index) => el('tr', {}, cells)))
  );
  if (clickableRow) {
    table.querySelectorAll('tbody tr').forEach((row, index) => {
      row.classList.add('clickable');
      row.addEventListener('click', () => clickableRow(index));
    });
  }
  return el('div', { class: 'table-wrap' }, table);
}

// ------------------------------------------------------------------ charts

// Grouped horizontal bar chart (inline SVG). One bar row per label, one
// segment per series entry. Widths are proportional to the value.
export function hBarChart({ labels, series, max }) {
  const W = 720;
  const rowH = 34;
  const labelW = 150;
  const valueW = 46;
  const barW = W - labelW - valueW - 16;
  const top = 8;
  const H = top + labels.length * rowH + 8;
  const totalMax = max ?? Math.max(1, ...labels.map((_, li) => series.reduce((sum, s) => sum + s.values[li], 0)));

  const svg = el('svg', {
    class: 'chart',
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': 'Bar chart',
  });
  const ns = 'http://www.w3.org/2000/svg';
  labels.forEach((labelText, li) => {
    const y = top + li * rowH;
    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', 0);
    label.setAttribute('y', y + rowH / 2 + 4);
    label.setAttribute('font-size', '12.5');
    label.setAttribute('fill', '#5a6a7e');
    label.textContent = labelText.length > 22 ? `${labelText.slice(0, 21)}…` : labelText;
    svg.append(label);

    let x = labelW;
    const total = series.reduce((sum, s) => sum + s.values[li], 0);
    for (const s of series) {
      const value = s.values[li] ?? 0;
      if (value <= 0) continue;
      const w = Math.max(2, (value / totalMax) * barW);
      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', x);
      rect.setAttribute('y', y + 5);
      rect.setAttribute('width', w);
      rect.setAttribute('height', rowH - 14);
      rect.setAttribute('rx', 3);
      rect.setAttribute('fill', s.color);
      const title = document.createElementNS(ns, 'title');
      title.textContent = `${labelText} — ${s.name}: ${value}`;
      rect.append(title);
      svg.append(rect);
      x += w;
    }
    const value = document.createElementNS(ns, 'text');
    value.setAttribute('x', labelW + barW + 8);
    value.setAttribute('y', y + rowH / 2 + 4);
    value.setAttribute('font-size', '12.5');
    value.setAttribute('fill', '#1c2430');
    value.setAttribute('font-weight', '600');
    value.textContent = String(total);
    svg.append(value);
  });
  const legend = el(
    'div',
    { class: 'legend' },
    series.map((s) =>
      el('span', { class: 'key' }, el('span', { class: 'swatch', style: `background:${s.color}` }), s.name)
    )
  );
  return el('div', {}, svg, legend);
}

// Donut chart (inline SVG) for two-way or few-slice ratios.
export function donutChart({ slices, centerLabel, centerValue }) {
  const size = 180;
  const stroke = 26;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const total = slices.reduce((sum, s) => sum + s.value, 0);

  const svg = el('svg', {
    class: 'chart',
    viewBox: `0 0 ${size} ${size}`,
    width: size,
    height: size,
    role: 'img',
    'aria-label': 'Donut chart',
    style: 'display:block;margin:0 auto',
  });
  const ns = 'http://www.w3.org/2000/svg';
  const bg = document.createElementNS(ns, 'circle');
  bg.setAttribute('cx', size / 2);
  bg.setAttribute('cy', size / 2);
  bg.setAttribute('r', r);
  bg.setAttribute('fill', 'none');
  bg.setAttribute('stroke', '#eef1f6');
  bg.setAttribute('stroke-width', stroke);
  svg.append(bg);

  let offset = 0;
  if (total > 0) {
    for (const slice of slices) {
      if (slice.value <= 0) continue;
      const fraction = slice.value / total;
      const circle = document.createElementNS(ns, 'circle');
      circle.setAttribute('cx', size / 2);
      circle.setAttribute('cy', size / 2);
      circle.setAttribute('r', r);
      circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke', slice.color);
      circle.setAttribute('stroke-width', stroke);
      circle.setAttribute('stroke-dasharray', `${fraction * c} ${c}`);
      circle.setAttribute('stroke-dashoffset', -offset * c);
      circle.setAttribute('transform', `rotate(-90 ${size / 2} ${size / 2})`);
      const title = document.createElementNS(ns, 'title');
      title.textContent = `${slice.name}: ${slice.value}`;
      circle.append(title);
      svg.append(circle);
      offset += fraction;
    }
  }

  const center = document.createElementNS(ns, 'text');
  center.setAttribute('x', size / 2);
  center.setAttribute('y', size / 2 + 2);
  center.setAttribute('text-anchor', 'middle');
  center.setAttribute('font-size', '22');
  center.setAttribute('font-weight', '700');
  center.setAttribute('fill', '#1c2430');
  center.textContent = String(centerValue ?? total);
  svg.append(center);
  if (centerLabel) {
    const sub = document.createElementNS(ns, 'text');
    sub.setAttribute('x', size / 2);
    sub.setAttribute('y', size / 2 + 18);
    sub.setAttribute('text-anchor', 'middle');
    sub.setAttribute('font-size', '11');
    sub.setAttribute('fill', '#8b98ab');
    sub.textContent = centerLabel;
    svg.append(sub);
  }

  const legend = el(
    'div',
    { class: 'legend', style: 'justify-content:center' },
    slices.map((s) =>
      el('span', { class: 'key' }, el('span', { class: 'swatch', style: `background:${s.color}` }), `${s.name} (${s.value})`)
    )
  );
  return el('div', {}, svg, legend);
}

// -------------------------------------------------------------------- misc

export function chips(values) {
  if (!values?.length) return el('span', { class: 'empty-inline' }, 'none');
  return el('span', {}, values.map((value) => el('span', { class: 'chip' }, value)));
}

export function pageHead(title, subtitle, actions = []) {
  return el(
    'div',
    { class: 'page-head' },
    el('div', {}, el('h1', {}, title), subtitle ? el('p', {}, subtitle) : null),
    el('div', { class: 'form-row', style: 'flex:0 0 auto' }, actions)
  );
}
