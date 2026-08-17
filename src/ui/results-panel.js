// src/ui/results-panel.js
//
// Three straightforward JSON-to-table renderings of a Results JSON object
// (docs/01-CONTRACTS.md): displacements, reactions, element forces. No
// computation happens here — every value shown comes directly from the
// Results object passed in.

function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Format a number for a table cell: fixed sig-figs, scientific for extremes. */
function fmt(v, dp = 6) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v ?? '—');
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 1e6 || abs < 1e-6) return v.toExponential(4);
  const s = v.toFixed(dp).replace(/0+$/, '').replace(/\.$/, '');
  return s === '' || s === '-' ? '0' : s;
}

function table(headers, rows) {
  const t = document.createElement('table');
  t.className = 'fea-results-table';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const h of headers) {
    const th = document.createElement('th');
    th.textContent = h;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  t.appendChild(thead);

  const tbody = document.createElement('tbody');
  if (rows.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = headers.length;
    td.className = 'fea-empty-row';
    td.textContent = 'No data';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const cell of row) {
      const td = document.createElement('td');
      td.textContent = cell;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  t.appendChild(tbody);
  return t;
}

/** Displacements table: node, ux, uy (rz shown too — it's in the schema and free to display). */
export function renderDisplacementsTable(container, results) {
  clearChildren(container);
  const rows = (results?.displacements || []).map((d) => [d.node, fmt(d.ux), fmt(d.uy), fmt(d.rz)]);
  container.appendChild(table(['Node', 'ux (m)', 'uy (m)', 'rz (rad)'], rows));
}

/** Reactions table: node, rx, ry (mz shown too, relevant from Phase 2 onward). */
export function renderReactionsTable(container, results) {
  clearChildren(container);
  const rows = (results?.reactions || []).map((r) => [r.node, fmt(r.rx), fmt(r.ry), fmt(r.mz)]);
  container.appendChild(table(['Node', 'Rx (N)', 'Ry (N)', 'Mz (N·m)'], rows));
}

/**
 * Element forces table: element, axial force, stress — plus the beam
 * shear/moment columns when present. Truss and beam rows use different
 * subsets of the Results elementForces shape, so columns not applicable to a
 * given row render as "—" rather than blank.
 */
export function renderElementForcesTable(container, results) {
  clearChildren(container);
  const rows = (results?.elementForces || []).map((ef) => {
    if (ef.type === 'beam' || typeof ef.momentI === 'number') {
      return [
        ef.element, 'beam',
        fmt(ef.axialForceI), '—',
        fmt(ef.shearI), fmt(ef.momentI),
        fmt(ef.shearJ), fmt(ef.momentJ),
      ];
    }
    return [
      ef.element, 'truss',
      fmt(ef.axialForce), fmt(ef.axialStress),
      '—', '—', '—', '—',
    ];
  });
  container.appendChild(table(
    ['Element', 'Type', 'Axial force (N)', 'Axial stress (Pa)', 'Shear I (N)', 'Moment I (N·m)', 'Shear J (N)', 'Moment J (N·m)'],
    rows
  ));
}

/** Convenience: render all three tables into three container elements at once. */
export function renderAllTables({ displacementsEl, reactionsEl, elementForcesEl }, results) {
  if (displacementsEl) renderDisplacementsTable(displacementsEl, results);
  if (reactionsEl) renderReactionsTable(reactionsEl, results);
  if (elementForcesEl) renderElementForcesTable(elementForcesEl, results);
}
