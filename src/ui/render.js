// src/ui/render.js
//
// Renders a Model JSON + Results JSON pair (per docs/01-CONTRACTS.md) onto an
// SVG element: undeformed geometry, a scaled deformed-shape overlay, elements
// color-coded by axial stress/force sign+magnitude, and reaction arrows
// (including moment-reaction curved-arrow symbols at fixed supports).
//
// Pure display/geometry only — every number drawn here comes straight out of
// the Results JSON handed in; nothing is computed by a solver. Verified
// against the two mock fixtures in tests/fixtures/mock-*.json, which hardcode
// the acceptance-test numbers from docs/02-TRACK-A-SOLVER.md.

import {
  createSvgEl,
  worldToScreen,
  computeFitView,
  drawSupportSymbol,
  drawArrow,
  drawMomentSymbol,
  buildArrowDefs,
  classifySupport,
  formatLabel,
} from './canvas.js';

function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function nodeById(model, id) {
  return model.nodes.find((n) => n.id === id);
}

function dispById(results, id) {
  return (results.displacements || []).find((d) => d.node === id) || { ux: 0, uy: 0, rz: 0 };
}

/**
 * Suggest a deformation scale factor that makes the largest nodal
 * displacement render at roughly 15% of the model's characteristic span —
 * displacements in real structures are almost always too small to see at a
 * literal 1:1 scale, so a sane non-1 default (paired with the UI's slider)
 * is the normal, expected way to look at a deformed shape, not a hack.
 */
export function computeDefaultScaleFactor(model, results) {
  const nodes = model.nodes || [];
  if (nodes.length === 0) return 1;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-6);
  let maxDisp = 0;
  for (const d of results.displacements || []) {
    maxDisp = Math.max(maxDisp, Math.hypot(d.ux, d.uy));
  }
  if (maxDisp === 0) return 1;
  return (0.15 * span) / maxDisp;
}

function elementForceValue(ef) {
  // Truss elements report axialStress directly; beam elements (per the
  // contract's elementForces shape) only report end forces/moments, no
  // single stress value. Fall back to axialForceI as the coloring signal for
  // beams so a beam under pure bending (axial ≈ 0) reads as visually neutral
  // rather than mis-colored.
  if (typeof ef.axialStress === 'number') return { value: ef.axialStress, unit: 'Pa' };
  if (typeof ef.axialForceI === 'number') return { value: ef.axialForceI, unit: 'N' };
  return { value: 0, unit: '' };
}

function stressColor(value, maxAbs) {
  const neutral = [148, 163, 184]; // slate-400
  if (!maxAbs || !Number.isFinite(value) || value === 0) return `rgb(${neutral.join(',')})`;
  const t = Math.min(Math.abs(value) / maxAbs, 1);
  const target = value > 0 ? [37, 99, 235] : [220, 38, 38]; // tension=blue, compression=red
  const rgb = neutral.map((c, i) => Math.round(c + (target[i] - c) * t));
  return `rgb(${rgb.join(',')})`;
}

/**
 * Render undeformed + deformed geometry, stress coloring, supports, and
 * reactions into `svg`. Options:
 *   svg           SVG root element to draw into (cleared and rebuilt each call)
 *   model         Model JSON (nodes/elements/supports/loads)
 *   results       Results JSON (displacements/reactions/elementForces)
 *   scaleFactor   deformation scale multiplier (from the UI's slider)
 *   showUndeformed  default true
 */
export function renderResults({ svg, model, results, scaleFactor = 1, showUndeformed = true }) {
  clearChildren(svg);
  const w = svg.clientWidth || 600;
  const h = svg.clientHeight || 400;

  const view = computeFitView(model.nodes, w, h, 64);

  svg.appendChild(buildArrowDefs({
    arrowId: 'fea-load-arrowhead', arrowColor: '#0f766e',
    momentId: 'fea-moment-arrowhead', momentColor: '#9333ea',
  }));
  svg.appendChild(buildArrowDefs({
    arrowId: 'fea-reaction-arrowhead', arrowColor: '#15803d',
    momentId: 'fea-reaction-moment-arrowhead', momentColor: '#9333ea',
  }));

  const content = createSvgEl('g');
  svg.appendChild(content);

  // Max magnitude for the stress/force color scale, computed across all
  // elements so colors are comparable to each other within this model.
  let maxAbs = 0;
  for (const ef of results.elementForces || []) {
    maxAbs = Math.max(maxAbs, Math.abs(elementForceValue(ef).value));
  }

  if (showUndeformed) drawUndeformed(content, view, model);
  drawDeformed(content, view, model, results, scaleFactor, maxAbs);
  drawSupports(content, view, model);
  drawAppliedLoads(content, view, model);
  drawReactions(content, view, model, results);

  return { view };
}

function drawUndeformed(content, view, model) {
  const g = createSvgEl('g', { class: 'undeformed' });
  for (const e of model.elements) {
    const ni = nodeById(model, e.nodeI);
    const nj = nodeById(model, e.nodeJ);
    if (!ni || !nj) continue;
    const pi = worldToScreen(view, ni.x, ni.y);
    const pj = worldToScreen(view, nj.x, nj.y);
    g.appendChild(createSvgEl('line', {
      x1: pi.x, y1: pi.y, x2: pj.x, y2: pj.y,
      stroke: '#cbd5e1', 'stroke-width': 1.5, 'stroke-dasharray': '5,4',
    }));
  }
  for (const n of model.nodes) {
    const p = worldToScreen(view, n.x, n.y);
    g.appendChild(createSvgEl('circle', { cx: p.x, cy: p.y, r: 3, fill: '#cbd5e1' }));
  }
  content.appendChild(g);
}

function drawDeformed(content, view, model, results, scaleFactor, maxAbs) {
  const g = createSvgEl('g', { class: 'deformed' });
  const efById = new Map((results.elementForces || []).map((ef) => [ef.element, ef]));

  for (const e of model.elements) {
    const ni = nodeById(model, e.nodeI);
    const nj = nodeById(model, e.nodeJ);
    if (!ni || !nj) continue;
    const di = dispById(results, e.nodeI);
    const dj = dispById(results, e.nodeJ);
    // KNOWN SIMPLIFICATION (Phase 2 / B11): the deformed shape between a beam
    // element's two nodes is drawn as a straight line through the displaced
    // end points (linear interpolation), ignoring end rotations (rz) and the
    // true cubic Hermite bending curve. This is an explicitly-accepted MVP
    // per docs/03-TRACK-B-UI.md — good enough to see "which way it sagged",
    // not a physically exact bent shape. Truss elements are exact either way
    // (they are straight members regardless).
    const pi = worldToScreen(view, ni.x + di.ux * scaleFactor, ni.y + di.uy * scaleFactor);
    const pj = worldToScreen(view, nj.x + dj.ux * scaleFactor, nj.y + dj.uy * scaleFactor);

    const ef = efById.get(e.id);
    const { value } = ef ? elementForceValue(ef) : { value: 0 };
    const color = stressColor(value, maxAbs);

    const line = createSvgEl('line', {
      x1: pi.x, y1: pi.y, x2: pj.x, y2: pj.y,
      stroke: color, 'stroke-width': e.type === 'beam' ? 5 : 3, 'stroke-linecap': 'round',
    });
    const title = createSvgEl('title');
    title.textContent = ef
      ? (typeof ef.axialStress === 'number'
        ? `${e.id}: axialForce=${formatLabel(ef.axialForce)} N, axialStress=${formatLabel(ef.axialStress)} Pa`
        : `${e.id}: axialForceI=${formatLabel(ef.axialForceI)} N, shearI=${formatLabel(ef.shearI)} N, momentI=${formatLabel(ef.momentI)} N·m, shearJ=${formatLabel(ef.shearJ)} N, momentJ=${formatLabel(ef.momentJ)} N·m`)
      : `${e.id}: no elementForces in results`;
    line.appendChild(title);
    g.appendChild(line);

    const mx = (pi.x + pj.x) / 2;
    const my = (pi.y + pj.y) / 2;
    const label = createSvgEl('text', { x: mx + 6, y: my - 6, 'font-size': 10, 'font-family': 'monospace', fill: '#1e293b' });
    label.textContent = e.id;
    g.appendChild(label);
  }

  for (const n of model.nodes) {
    const d = dispById(results, n.id);
    const p = worldToScreen(view, n.x + d.ux * scaleFactor, n.y + d.uy * scaleFactor);
    g.appendChild(createSvgEl('circle', { cx: p.x, cy: p.y, r: 5, fill: '#1e293b' }));
  }

  content.appendChild(g);
}

function drawSupports(content, view, model) {
  const g = createSvgEl('g', { class: 'supports' });
  for (const s of model.supports || []) {
    const n = nodeById(model, s.node);
    if (!n) continue;
    const p = worldToScreen(view, n.x, n.y);
    drawSupportSymbol(g, p, classifySupport(s));
  }
  content.appendChild(g);
}

function drawAppliedLoads(content, view, model) {
  const g = createSvgEl('g', { class: 'applied-loads' });
  const arrowLen = 40;
  for (const l of model.loads?.nodal || []) {
    const n = nodeById(model, l.node);
    if (!n) continue;
    const mag = Math.hypot(l.fx, l.fy);
    if (mag === 0) continue;
    const p = worldToScreen(view, n.x, n.y);
    const ux = l.fx / mag, uy = l.fy / mag;
    const from = { x: p.x - ux * arrowLen, y: p.y + uy * arrowLen };
    drawArrow(g, from, p, {
      color: '#0f766e', markerId: 'fea-load-arrowhead',
      label: `${formatLabel(l.fx)}, ${formatLabel(l.fy)} N`, labelOffset: { x: 8, y: -8 },
    });
  }
  content.appendChild(g);
}

function drawReactions(content, view, model, results) {
  const g = createSvgEl('g', { class: 'reactions' });
  const arrowLen = 40;
  let maxMz = 0;
  for (const r of results.reactions || []) maxMz = Math.max(maxMz, Math.abs(r.mz || 0));

  for (const r of results.reactions || []) {
    const n = nodeById(model, r.node);
    if (!n) continue;
    const p = worldToScreen(view, n.x, n.y);
    const mag = Math.hypot(r.rx || 0, r.ry || 0);
    if (mag > 1e-9) {
      const ux = r.rx / mag, uy = r.ry / mag;
      const from = { x: p.x - ux * arrowLen, y: p.y + uy * arrowLen };
      drawArrow(g, from, p, {
        color: '#15803d', markerId: 'fea-reaction-arrowhead',
        label: `R: ${formatLabel(r.rx)}, ${formatLabel(r.ry)} N`,
        labelOffset: { x: -8, y: 22 },
      });
    }
    if (Math.abs(r.mz || 0) > 1e-9) {
      drawMomentSymbol(g, p, Math.sign(r.mz), {
        radius: 22, color: '#9333ea', markerId: 'fea-reaction-moment-arrowhead',
        label: `Mz: ${formatLabel(r.mz)} N·m`,
      });
    }
  }
  content.appendChild(g);
}
