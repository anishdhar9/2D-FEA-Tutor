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
 * Suggest a deformation scale factor that makes the largest visible
 * deflection render at roughly 15% of the model's characteristic span —
 * displacements in real structures are almost always too small to see at a
 * literal 1:1 scale, so a sane non-1 default (paired with the UI's slider)
 * is the normal, expected way to look at a deformed shape, not a hack.
 *
 * "Largest visible deflection" is deliberately not just max nodal
 * hypot(ux,uy): a statically-indeterminate single-beam-element case (the
 * Phase 2 acceptance fixture) can have BOTH end nodes at ux=uy=0 exactly
 * (one fully fixed, one a roller) with all of the bending carried by end
 * rotation (rz) — see beamDeformedScreenPoints's cubic Hermite sampling in
 * this file. Nodal-translation-only would compute maxDisp=0 there and fall
 * back to scale=1, which is far too small to show the very sag this tool
 * exists to make visible. So beam elements also contribute an order-of-
 * magnitude estimate of their rotation-driven mid-span deflection.
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
  for (const e of model.elements || []) {
    if (e.type !== 'beam') continue;
    const ni = nodeById(model, e.nodeI);
    const nj = nodeById(model, e.nodeJ);
    if (!ni || !nj) continue;
    const di = dispById(results, e.nodeI);
    const dj = dispById(results, e.nodeJ);
    const L = Math.hypot(nj.x - ni.x, nj.y - ni.y);
    // ~1/8 of theta*L is the mid-span deflection of a beam whose bending is
    // driven purely by one end's rotation (matches the cubic Hermite N4
    // shape function's peak, N4(0.5) = -L/8) — a reasonable order-of-
    // magnitude estimate regardless of the exact boundary conditions.
    maxDisp = Math.max(maxDisp, Math.abs(di.rz || 0) * L * 0.15, Math.abs(dj.rz || 0) * L * 0.15);
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
  const raw = Math.min(Math.abs(value) / maxAbs, 1);
  // sqrt easing: a low-magnitude member (small raw fraction of the model's
  // peak stress) still reads as a clearly-tinted tension/compression color
  // rather than washing out to near-neutral gray, while the peak member
  // still lands on the fully-saturated color at t=1.
  const t = 0.35 + 0.65 * Math.sqrt(raw);
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

/**
 * KNOWN SIMPLIFICATION (Phase 2 / B11) + a deliberate step beyond its MVP
 * floor: docs/03-TRACK-B-UI.md explicitly accepts plain linear interpolation
 * between a beam element's two *displaced end points* as MVP-sufficient, and
 * explicitly defers true cubic-Hermite bending as a nice-to-have. Truss
 * elements use exactly that plain 2-point interpolation below — correct as-is,
 * since a truss member is straight regardless of end rotation (it has none).
 *
 * For beam elements we go one step further and sample the Euler-Bernoulli
 * cubic Hermite shape (the same shape functions implied by the 12EI/L^3 /
 * 6EI/L^2 stiffness terms in docs/02-TRACK-A-SOLVER.md's beam stiffness
 * matrix), using the end rotations (rz) already present in the Results JSON.
 * Reason: the Phase 2 acceptance fixture (propped cantilever) is a *single*
 * beam element whose two end nodes both have ux=uy=0 exactly (one fully
 * fixed, one a roller) — under pure linear interpolation the "deformed"
 * chord between two zero-translation points is indistinguishable from the
 * undeformed line, so the doc's own worked expectation ("should visibly sag
 * more near midspan than at the roller end") would be unrenderable without
 * this. It's additive, not a replacement for the accepted MVP — a straight
 * 2-point line remains a valid, spec-compliant beam rendering too.
 */
function beamDeformedScreenPoints(view, ni, nj, di, dj, scaleFactor, samples = 16) {
  const dx = nj.x - ni.x;
  const dy = nj.y - ni.y;
  const L = Math.hypot(dx, dy) || 1e-9;
  const c = dx / L;
  const s = dy / L;
  // rotate global end displacements into the element's local (axial, transverse) frame
  const u1 = c * di.ux + s * di.uy, v1 = -s * di.ux + c * di.uy, t1 = di.rz || 0;
  const u2 = c * dj.ux + s * dj.uy, v2 = -s * dj.ux + c * dj.uy, t2 = dj.rz || 0;

  const pts = [];
  for (let k = 0; k <= samples; k++) {
    const xi = k / samples;
    const x = xi * L;
    const u = u1 * (1 - xi) + u2 * xi; // axial: linear (decoupled from bending)
    const xi2 = xi * xi, xi3 = xi2 * xi;
    const N1 = 1 - 3 * xi2 + 2 * xi3;
    const N2 = L * (xi - 2 * xi2 + xi3);
    const N3 = 3 * xi2 - 2 * xi3;
    const N4 = L * (xi3 - xi2);
    const v = N1 * v1 + N2 * t1 + N3 * v2 + N4 * t2; // transverse: cubic Hermite bending shape
    const baseX = ni.x + c * x, baseY = ni.y + s * x; // undeformed point along the axis
    const gx = baseX + scaleFactor * (c * u - s * v);
    const gy = baseY + scaleFactor * (s * u + c * v);
    pts.push(worldToScreen(view, gx, gy));
  }
  return pts;
}

function polylinePoints(pts) {
  return pts.map((p) => `${p.x},${p.y}`).join(' ');
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

    const ef = efById.get(e.id);
    const { value } = ef ? elementForceValue(ef) : { value: 0 };
    const color = stressColor(value, maxAbs);
    const strokeWidth = e.type === 'beam' ? 5 : 3;

    let shape;
    let pi, pj;
    if (e.type === 'beam') {
      const pts = beamDeformedScreenPoints(view, ni, nj, di, dj, scaleFactor);
      pi = pts[0];
      pj = pts[pts.length - 1];
      shape = createSvgEl('polyline', {
        points: polylinePoints(pts), fill: 'none',
        stroke: color, 'stroke-width': strokeWidth, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      });
    } else {
      pi = worldToScreen(view, ni.x + di.ux * scaleFactor, ni.y + di.uy * scaleFactor);
      pj = worldToScreen(view, nj.x + dj.ux * scaleFactor, nj.y + dj.uy * scaleFactor);
      shape = createSvgEl('line', {
        x1: pi.x, y1: pi.y, x2: pj.x, y2: pj.y,
        stroke: color, 'stroke-width': strokeWidth, 'stroke-linecap': 'round',
      });
    }

    const title = createSvgEl('title');
    title.textContent = ef
      ? (typeof ef.axialStress === 'number'
        ? `${e.id}: axialForce=${formatLabel(ef.axialForce)} N, axialStress=${formatLabel(ef.axialStress)} Pa`
        : `${e.id}: axialForceI=${formatLabel(ef.axialForceI)} N, shearI=${formatLabel(ef.shearI)} N, momentI=${formatLabel(ef.momentI)} N·m, shearJ=${formatLabel(ef.shearJ)} N, momentJ=${formatLabel(ef.momentJ)} N·m`)
      : `${e.id}: no elementForces in results`;
    shape.appendChild(title);
    g.appendChild(shape);

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
