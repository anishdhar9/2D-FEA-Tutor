// src/ui/canvas.js
//
// SVG-based model builder: node placement, "connect mode" element creation,
// support/load assignment, element property editing, and serialization to the
// frozen Model JSON schema (docs/01-CONTRACTS.md).
//
// Architecture note: the pure geometry/state helpers at the top of this file
// (createInitialState, buildModelJSON, worldToScreen/screenToWorld,
// computeFitView, classifySupport, id generators) never touch `document` or
// `window` — they can be imported and unit-tested under plain Node with zero
// DOM. All DOM/SVG wiring lives behind `initCanvas(refs)`, which is the only
// entry point that requires a browser environment. render.js reuses several
// of the pure/drawing helpers exported here (worldToScreen, computeFitView,
// drawSupportSymbol, drawArrow, drawMomentSymbol, createSvgEl) so the two
// views share one visual vocabulary for symbols.

export const SVG_NS = 'http://www.w3.org/2000/svg';

// ---------------------------------------------------------------------------
// Pure state helpers (DOM-free, unit-testable)
// ---------------------------------------------------------------------------

/** Fresh, empty builder state. */
export function createInitialState() {
  return {
    nodes: [], // { id, x, y }
    elements: [], // { id, type: 'truss'|'beam', nodeI, nodeJ, E, A, I }
    supports: {}, // nodeId -> { kind: 'pin'|'roller'|'fixed', ux, uy, rz }
    nodalLoads: {}, // nodeId -> { fx, fy, mz }
    distributedLoads: {}, // elementId -> { wy }
    selection: null, // { kind: 'node'|'element', id } | null
    connectMode: false,
    connectPending: null, // nodeId awaiting a second click, or null
    nextNodeNum: 1,
    nextElementNum: 1,
  };
}

/** Pure: next auto-assigned node id (N1, N2, ...), never reused. */
export function nextNodeId(state) {
  return `N${state.nextNodeNum}`;
}

/** Pure: next auto-assigned element id (e1, e2, ...), never reused. */
export function nextElementId(state) {
  return `e${state.nextElementNum}`;
}

/**
 * Pure: serialize builder state to exactly the Model JSON schema in
 * 01-CONTRACTS.md. This is the function the integration step (Track D) calls
 * via the module-level `getModel()` export below — keep its output shape
 * locked to the contract: no extra or renamed fields, truss elements omit
 * `I`, supports/loads arrays only contain nodes/elements the user actually
 * touched (a node with no support entry is implicitly "free").
 */
export function buildModelJSON(state) {
  return {
    meta: { units: 'SI' },
    nodes: state.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y })),
    elements: state.elements.map((e) => {
      const out = { id: e.id, type: e.type, nodeI: e.nodeI, nodeJ: e.nodeJ, E: e.E, A: e.A };
      if (e.type === 'beam') out.I = e.I;
      return out;
    }),
    supports: Object.keys(state.supports).map((nodeId) => {
      const s = state.supports[nodeId];
      return { node: nodeId, ux: !!s.ux, uy: !!s.uy, rz: !!s.rz };
    }),
    loads: {
      nodal: Object.keys(state.nodalLoads).map((nodeId) => {
        const l = state.nodalLoads[nodeId];
        return { node: nodeId, fx: l.fx || 0, fy: l.fy || 0, mz: l.mz || 0 };
      }),
      distributed: Object.keys(state.distributedLoads).map((elId) => {
        const l = state.distributedLoads[elId];
        return { element: elId, wy: l.wy || 0 };
      }),
    },
  };
}

/** Pure: classify a support's booleans into the standard symbol kind. */
export function classifySupport(support) {
  if (!support) return 'free';
  if (support.ux && support.uy && support.rz) return 'fixed';
  if (support.ux && support.uy) return 'pin';
  if (support.uy && !support.ux) return 'roller';
  return 'custom';
}

const SUPPORT_PRESETS = {
  free: null,
  pin: { kind: 'pin', ux: true, uy: true, rz: false },
  roller: { kind: 'roller', ux: false, uy: true, rz: false },
  fixed: { kind: 'fixed', ux: true, uy: true, rz: true },
};

/** Pure: world (model, meters, y-up) -> screen (SVG pixels, y-down). */
export function worldToScreen(view, x, y) {
  return { x: view.originX + x * view.scale, y: view.originY - y * view.scale };
}

/** Pure: screen (SVG pixels) -> world (model meters). Inverse of worldToScreen. */
export function screenToWorld(view, sx, sy) {
  return { x: (sx - view.originX) / view.scale, y: (view.originY - sy) / view.scale };
}

/**
 * Pure: compute a view {scale, originX, originY} that fits all nodes inside
 * a `width` x `height` pixel viewport with `padding` px of margin. Never
 * hardcodes a fixed pixels-per-meter scale — adapts to whatever the model's
 * bounding box is, from single-digit-meter models to large ones.
 */
export function computeFitView(nodes, width, height, padding = 48) {
  const DEFAULT_SCALE = 60; // px/m, only used when there is nothing to fit yet
  if (!nodes || nodes.length === 0) {
    return { scale: DEFAULT_SCALE, originX: width / 2, originY: height / 2 };
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y);
    maxY = Math.max(maxY, n.y);
  }
  const spanX = Math.max(maxX - minX, 0.5);
  const spanY = Math.max(maxY - minY, 0.5);
  const availW = Math.max(width - 2 * padding, 10);
  const availH = Math.max(height - 2 * padding, 10);
  const scale = Math.min(availW / spanX, availH / spanY);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { scale, originX: width / 2 - cx * scale, originY: height / 2 + cy * scale };
}

/** Pure: format a number for on-canvas labels (compact, trims noise). */
export function formatLabel(v, maxDp = 3) {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return '0';
  const abs = Math.abs(v);
  // Loads/reactions/stresses in this domain routinely run into the tens or
  // hundreds of thousands (N, Pa) — that's completely ordinary, not a value
  // worth switching to scientific notation for. Only genuinely huge (>=1e6,
  // e.g. raw Pa stress values) or genuinely tiny (<1e-3, e.g. small rotations)
  // magnitudes get the exponential form; everything in between reads as a
  // plain number the way a student would write it by hand.
  if (abs >= 1e6 || abs < 1e-3) return v.toExponential(2);
  return String(Math.round(v * 10 ** maxDp) / 10 ** maxDp);
}

// ---------------------------------------------------------------------------
// SVG drawing helpers (DOM-touching, but reusable by render.js — both this
// builder canvas and the results canvas draw the same support/load/moment
// symbols so students see one consistent visual language throughout).
// ---------------------------------------------------------------------------

export function createSvgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/**
 * Draw a standard structural-engineering support symbol at a screen point.
 * kind: 'pin' | 'roller' | 'fixed'. Pin = hatched triangle (restrains
 * translation, allows rotation). Roller = triangle + circle above a hatched
 * ground line (restrains only the vertical DOF). Fixed = hatched wall glyph
 * directly against the node (restrains translation AND rotation).
 */
export function drawSupportSymbol(parent, pt, kind, opts = {}) {
  const size = opts.size || 18;
  const g = createSvgEl('g', { class: `support support-${kind}` });
  const stroke = opts.stroke || '#334155';
  const fill = opts.fill || '#e2e8f0';

  if (kind === 'fixed') {
    // Hatched wall glyph: a horizontal ground line directly at the node with
    // diagonal hatch marks below it, signalling full fixity (no gap/hinge).
    const y = pt.y;
    const halfW = size * 0.9;
    g.appendChild(createSvgEl('line', {
      x1: pt.x - halfW, y1: y, x2: pt.x + halfW, y2: y, stroke, 'stroke-width': 2,
    }));
    const hatchCount = 6;
    for (let i = 0; i < hatchCount; i++) {
      const hx = pt.x - halfW + (i * (2 * halfW)) / (hatchCount - 1);
      g.appendChild(createSvgEl('line', {
        x1: hx, y1: y, x2: hx - size * 0.35, y2: y + size * 0.5,
        stroke, 'stroke-width': 1.5,
      }));
    }
    parent.appendChild(g);
    return g;
  }

  // pin / roller share a triangle apex-up at the node
  const triH = size;
  const triHalfW = size * 0.8;
  const apex = { x: pt.x, y: pt.y };
  const baseY = pt.y + triH;
  const bl = { x: pt.x - triHalfW, y: baseY };
  const br = { x: pt.x + triHalfW, y: baseY };
  g.appendChild(createSvgEl('polygon', {
    points: `${apex.x},${apex.y} ${bl.x},${bl.y} ${br.x},${br.y}`,
    fill, stroke, 'stroke-width': 1.5,
  }));

  let groundY = baseY;
  if (kind === 'roller') {
    // small circles between the triangle base and the ground line
    const r = size * 0.16;
    const cy = baseY + r + 2;
    for (const dx of [-triHalfW * 0.5, 0, triHalfW * 0.5]) {
      g.appendChild(createSvgEl('circle', { cx: pt.x + dx, cy, r, fill, stroke, 'stroke-width': 1.2 }));
    }
    groundY = cy + r + 2;
  }

  // hatched ground line under the triangle (or rollers)
  g.appendChild(createSvgEl('line', {
    x1: pt.x - triHalfW - 4, y1: groundY, x2: pt.x + triHalfW + 4, y2: groundY,
    stroke, 'stroke-width': 2,
  }));
  const hatchCount = 6;
  for (let i = 0; i < hatchCount; i++) {
    const hx = pt.x - triHalfW - 4 + (i * (2 * (triHalfW + 4))) / (hatchCount - 1);
    g.appendChild(createSvgEl('line', {
      x1: hx, y1: groundY, x2: hx - size * 0.3, y2: groundY + size * 0.4,
      stroke, 'stroke-width': 1.2,
    }));
  }

  parent.appendChild(g);
  return g;
}

/**
 * Draw a straight labeled arrow from `from` to `to` (screen coords), used for
 * point loads and reactions. Arrowhead sits at `to`.
 */
export function drawArrow(parent, from, to, opts = {}) {
  const color = opts.color || '#0f766e';
  const width = opts.width || 2.5;
  const markerId = opts.markerId || 'fea-arrowhead';
  const g = createSvgEl('g', { class: opts.className || 'load-arrow' });
  g.appendChild(createSvgEl('line', {
    x1: from.x, y1: from.y, x2: to.x, y2: to.y,
    stroke: color, 'stroke-width': width, 'marker-end': `url(#${markerId})`,
  }));
  if (opts.label) {
    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2;
    const dx = opts.labelOffset ? opts.labelOffset.x : 8;
    const dy = opts.labelOffset ? opts.labelOffset.y : -6;
    const t = createSvgEl('text', {
      x: mx + dx, y: my + dy, fill: color, 'font-size': 11, 'font-family': 'monospace',
    });
    t.textContent = opts.label;
    g.appendChild(t);
  }
  parent.appendChild(g);
  return g;
}

/**
 * Draw a curved-arrow / torque symbol representing a moment reaction at a
 * screen point. sign > 0 => counterclockwise (contract convention: positive
 * mz is CCW, z out of page), sign < 0 => clockwise.
 */
export function drawMomentSymbol(parent, pt, sign, opts = {}) {
  const r = opts.radius || 16;
  const color = opts.color || '#9333ea';
  const markerId = opts.markerId || 'fea-moment-arrowhead';
  const ccw = sign >= 0;
  const startAngle = -40 * (Math.PI / 180);
  const endAngle = 220 * (Math.PI / 180);
  const a0 = ccw ? startAngle : endAngle;
  const a1 = ccw ? endAngle : startAngle;
  const sx = pt.x + r * Math.cos(a0);
  const sy = pt.y - r * Math.sin(a0); // screen y-down, so flip
  const ex = pt.x + r * Math.cos(a1);
  const ey = pt.y - r * Math.sin(a1);
  const sweep = ccw ? 1 : 0;
  const path = createSvgEl('path', {
    d: `M ${sx} ${sy} A ${r} ${r} 0 1 ${sweep} ${ex} ${ey}`,
    fill: 'none', stroke: color, 'stroke-width': 2.25, 'marker-end': `url(#${markerId})`,
  });
  const g = createSvgEl('g', { class: 'moment-symbol' });
  g.appendChild(path);
  if (opts.label) {
    const t = createSvgEl('text', {
      x: pt.x + r + 6, y: pt.y - r - 4, fill: color, 'font-size': 11, 'font-family': 'monospace',
    });
    t.textContent = opts.label;
    g.appendChild(t);
  }
  parent.appendChild(g);
  return g;
}

/** Standard arrowhead <marker> defs, shared by load/reaction/moment arrows. */
export function buildArrowDefs({
  arrowId = 'fea-arrowhead',
  arrowColor = '#0f766e',
  momentId = 'fea-moment-arrowhead',
  momentColor = '#9333ea',
} = {}) {
  const defs = createSvgEl('defs');
  const marker = createSvgEl('marker', {
    id: arrowId, viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse',
  });
  marker.appendChild(createSvgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: arrowColor }));
  defs.appendChild(marker);

  const marker2 = createSvgEl('marker', {
    id: momentId, viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse',
  });
  marker2.appendChild(createSvgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: momentColor }));
  defs.appendChild(marker2);
  return defs;
}

// ---------------------------------------------------------------------------
// Interactive builder (DOM-dependent)
// ---------------------------------------------------------------------------

let state = createInitialState();
let view = { scale: 60, originX: 0, originY: 0 };
let autoFit = true;
let refs = null;

/** The single function the integration step calls to hand off to the solver. */
export function getModel() {
  return buildModelJSON(state);
}

/** Exposed mainly for tests / debugging — the live internal builder state. */
export function getState() {
  return state;
}

/** Reset the builder to an empty model (used by the "Clear All" button). */
export function resetCanvas() {
  state = createInitialState();
  autoFit = true;
  render();
  notifyChange();
}

function notifyChange() {
  if (refs && typeof refs.onChange === 'function') refs.onChange(getModel());
}

function findElementsTouchingNode(nodeId) {
  return state.elements.filter((e) => e.nodeI === nodeId || e.nodeJ === nodeId);
}

function deleteNode(nodeId) {
  for (const e of findElementsTouchingNode(nodeId)) {
    delete state.distributedLoads[e.id];
  }
  state.elements = state.elements.filter((e) => e.nodeI !== nodeId && e.nodeJ !== nodeId);
  state.nodes = state.nodes.filter((n) => n.id !== nodeId);
  delete state.supports[nodeId];
  delete state.nodalLoads[nodeId];
}

function deleteElement(elId) {
  state.elements = state.elements.filter((e) => e.id !== elId);
  delete state.distributedLoads[elId];
}

function deleteSelected() {
  if (!state.selection) return;
  if (state.selection.kind === 'node') deleteNode(state.selection.id);
  else if (state.selection.kind === 'element') deleteElement(state.selection.id);
  state.selection = null;
  render();
  notifyChange();
}

function addNodeAt(x, y) {
  const id = nextNodeId(state);
  state.nodes.push({ id, x, y });
  state.nextNodeNum += 1;
  state.selection = { kind: 'node', id };
  render();
  notifyChange();
}

function elementExistsBetween(a, b) {
  return state.elements.some(
    (e) => (e.nodeI === a && e.nodeJ === b) || (e.nodeI === b && e.nodeJ === a)
  );
}

function createElementBetween(a, b) {
  if (a === b || elementExistsBetween(a, b)) return;
  const id = nextElementId(state);
  state.elements.push({ id, type: 'truss', nodeI: a, nodeJ: b, E: 200e9, A: 500e-6, I: 8e-6 });
  state.nextElementNum += 1;
  state.selection = { kind: 'element', id };
}

// ---- pointer handling: click vs. drag-to-pan -------------------------------

let pointerDown = null; // { x, y, dragging, panStart }

function svgSize() {
  const w = refs.svg.clientWidth || 600;
  const h = refs.svg.clientHeight || 400;
  return { w, h };
}

function onPointerDown(evt) {
  if (evt.button !== undefined && evt.button !== 0) return;
  const rect = refs.svg.getBoundingClientRect();
  const sx = evt.clientX - rect.left;
  const sy = evt.clientY - rect.top;
  pointerDown = { x: sx, y: sy, dragging: false, originX: view.originX, originY: view.originY };
  refs.svg.setPointerCapture?.(evt.pointerId);
}

function onPointerMove(evt) {
  if (!pointerDown) return;
  const rect = refs.svg.getBoundingClientRect();
  const sx = evt.clientX - rect.left;
  const sy = evt.clientY - rect.top;
  const dx = sx - pointerDown.x;
  const dy = sy - pointerDown.y;
  if (!pointerDown.dragging && Math.hypot(dx, dy) > 4) {
    pointerDown.dragging = true;
  }
  if (pointerDown.dragging) {
    autoFit = false;
    view.originX = pointerDown.originX + dx;
    view.originY = pointerDown.originY + dy;
    render();
  }
}

function onPointerUp(evt) {
  if (!pointerDown) return;
  const wasDrag = pointerDown.dragging;
  const rect = refs.svg.getBoundingClientRect();
  const sx = evt.clientX - rect.left;
  const sy = evt.clientY - rect.top;
  pointerDown = null;
  if (wasDrag) return; // it was a pan, not a click

  // NOTE: deliberately NOT using evt.target here. onPointerDown calls
  // setPointerCapture on the svg so drag-to-pan keeps receiving move/up
  // events even if the cursor leaves the SVG mid-drag — but per the Pointer
  // Events spec, once an element captures a pointer, evt.target on ALL
  // subsequent events for that pointer (including this pointerup) is
  // redirected to the CAPTURING element itself, not whatever is visually
  // under the cursor. Using evt.target.closest(...) here would silently
  // never match any node/element (svg has no data-node-id ancestor), making
  // every click fall through to "empty canvas". elementFromPoint gives the
  // real hit-tested element regardless of capture.
  const hit = document.elementFromPoint(evt.clientX, evt.clientY);
  const nodeTarget = hit && hit.closest && hit.closest('[data-node-id]');
  const elTarget = !nodeTarget && hit && hit.closest && hit.closest('[data-element-id]');

  if (nodeTarget) {
    handleNodeClick(nodeTarget.getAttribute('data-node-id'));
  } else if (elTarget) {
    handleElementClick(elTarget.getAttribute('data-element-id'));
  } else {
    // empty canvas click
    if (state.connectMode) {
      state.connectPending = null; // clicking empty space cancels a pending connect
      state.selection = null;
    } else {
      const world = screenToWorld(view, sx, sy);
      addNodeAt(round3(world.x), round3(world.y));
      return; // addNodeAt already re-rendered
    }
  }
  render();
  notifyChange();
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

function handleNodeClick(nodeId) {
  if (state.connectMode) {
    if (state.connectPending == null) {
      state.connectPending = nodeId;
      state.selection = { kind: 'node', id: nodeId };
    } else if (state.connectPending === nodeId) {
      state.connectPending = null; // clicked same node again: cancel
    } else {
      createElementBetween(state.connectPending, nodeId);
      state.connectPending = null;
    }
  } else {
    state.selection = { kind: 'node', id: nodeId };
  }
}

function handleElementClick(elId) {
  if (state.connectMode) return; // ignore element clicks while wiring nodes
  state.selection = { kind: 'element', id: elId };
}

function onWheel(evt) {
  evt.preventDefault();
  const rect = refs.svg.getBoundingClientRect();
  const sx = evt.clientX - rect.left;
  const sy = evt.clientY - rect.top;
  const before = screenToWorld(view, sx, sy);
  const factor = evt.deltaY < 0 ? 1.15 : 1 / 1.15;
  view.scale = clampScale(view.scale * factor);
  view.originX = sx - before.x * view.scale;
  view.originY = sy + before.y * view.scale;
  autoFit = false;
  render();
}

function clampScale(s) {
  return Math.min(Math.max(s, 3), 4000);
}

function zoomBy(factor) {
  const { w, h } = svgSize();
  const before = screenToWorld(view, w / 2, h / 2);
  view.scale = clampScale(view.scale * factor);
  view.originX = w / 2 - before.x * view.scale;
  view.originY = h / 2 + before.y * view.scale;
  autoFit = false;
  render();
}

function onKeyDown(evt) {
  const active = document.activeElement;
  const typing = active && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName);
  if ((evt.key === 'Delete' || evt.key === 'Backspace') && !typing) {
    evt.preventDefault();
    deleteSelected();
  } else if (evt.key === 'Escape') {
    closeInspector();
  }
}

// ---- inspector popover ------------------------------------------------

function labeledInput(labelText, inputEl) {
  const wrap = document.createElement('label');
  wrap.className = 'fea-field';
  const span = document.createElement('span');
  span.textContent = labelText;
  wrap.appendChild(span);
  wrap.appendChild(inputEl);
  return wrap;
}

function numberInput(value, onInput, opts = {}) {
  const inp = document.createElement('input');
  inp.type = 'number';
  if (opts.step !== undefined) inp.step = opts.step;
  else inp.step = 'any';
  inp.value = value;
  inp.addEventListener('input', () => onInput(parseFloat(inp.value) || 0));
  return inp;
}

function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function renderInspector() {
  const pop = refs.popover;
  clearChildren(pop);
  if (!state.selection) {
    pop.hidden = true;
    return;
  }
  pop.hidden = false;

  if (state.selection.kind === 'node') buildNodeInspector(pop, state.selection.id);
  else buildElementInspector(pop, state.selection.id);

  positionPopover();
}

function closeInspector() {
  state.connectPending = null;
  state.selection = null;
  render();
}

function buildPopoverTitle(text) {
  const title = document.createElement('div');
  title.className = 'fea-pop-title';
  const span = document.createElement('span');
  span.textContent = text;
  title.appendChild(span);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'fea-pop-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', closeInspector);
  title.appendChild(closeBtn);
  return title;
}

function buildNodeInspector(pop, nodeId) {
  const node = state.nodes.find((n) => n.id === nodeId);
  if (!node) {
    pop.hidden = true;
    return;
  }
  pop.appendChild(buildPopoverTitle(`Node ${nodeId}`));

  const coordRow = document.createElement('div');
  coordRow.className = 'fea-row';
  coordRow.appendChild(labeledInput('x (m)', numberInput(node.x, (v) => {
    node.x = v; render(); notifyChange();
  })));
  coordRow.appendChild(labeledInput('y (m)', numberInput(node.y, (v) => {
    node.y = v; render(); notifyChange();
  })));
  pop.appendChild(coordRow);

  const supportSection = document.createElement('div');
  supportSection.className = 'fea-section';
  const supLabel = document.createElement('div');
  supLabel.className = 'fea-subtitle';
  supLabel.textContent = 'Support';
  supportSection.appendChild(supLabel);

  const current = classifySupport(state.supports[nodeId]);
  const radios = document.createElement('div');
  radios.className = 'fea-radio-group';
  for (const kind of ['free', 'pin', 'roller', 'fixed']) {
    const id = `sup-${nodeId}-${kind}`;
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = `support-${nodeId}`;
    input.value = kind;
    input.id = id;
    input.checked = current === kind;
    input.addEventListener('change', () => {
      if (SUPPORT_PRESETS[kind]) state.supports[nodeId] = { ...SUPPORT_PRESETS[kind] };
      else delete state.supports[nodeId];
      render();
      notifyChange();
    });
    label.appendChild(input);
    label.appendChild(document.createTextNode(kind[0].toUpperCase() + kind.slice(1)));
    radios.appendChild(label);
  }
  supportSection.appendChild(radios);
  pop.appendChild(supportSection);

  const loadSection = document.createElement('div');
  loadSection.className = 'fea-section';
  const loadLabel = document.createElement('div');
  loadLabel.className = 'fea-subtitle';
  loadLabel.textContent = 'Nodal load';
  loadSection.appendChild(loadLabel);

  const existingLoad = state.nodalLoads[nodeId] || { fx: 0, fy: 0, mz: 0 };
  const loadRow = document.createElement('div');
  loadRow.className = 'fea-row';
  const setLoad = (key, v) => {
    const l = state.nodalLoads[nodeId] || { fx: 0, fy: 0, mz: 0 };
    l[key] = v;
    if (l.fx === 0 && l.fy === 0 && l.mz === 0) delete state.nodalLoads[nodeId];
    else state.nodalLoads[nodeId] = l;
    render();
    notifyChange();
  };
  loadRow.appendChild(labeledInput('fx (N)', numberInput(existingLoad.fx, (v) => setLoad('fx', v))));
  loadRow.appendChild(labeledInput('fy (N)', numberInput(existingLoad.fy, (v) => setLoad('fy', v))));
  loadRow.appendChild(labeledInput('mz (N·m)', numberInput(existingLoad.mz, (v) => setLoad('mz', v))));
  loadSection.appendChild(loadRow);
  pop.appendChild(loadSection);

  pop.appendChild(deleteButton(() => {
    deleteNode(nodeId);
    state.selection = null;
    render();
    notifyChange();
  }, 'Delete node'));
}

function buildElementInspector(pop, elId) {
  const elData = state.elements.find((e) => e.id === elId);
  if (!elData) {
    pop.hidden = true;
    return;
  }
  pop.appendChild(buildPopoverTitle(`Element ${elId} (${elData.nodeI} → ${elData.nodeJ})`));

  const typeRow = document.createElement('div');
  typeRow.className = 'fea-row';
  const typeSelect = document.createElement('select');
  for (const t of ['truss', 'beam']) {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    if (t === elData.type) opt.selected = true;
    typeSelect.appendChild(opt);
  }
  typeSelect.addEventListener('change', () => {
    elData.type = typeSelect.value;
    if (elData.type !== 'beam') delete state.distributedLoads[elId]; // wy only valid on beams
    if (elData.type === 'beam' && elData.I === undefined) elData.I = 8e-6;
    render();
    notifyChange();
  });
  typeRow.appendChild(labeledInput('Type', typeSelect));
  pop.appendChild(typeRow);

  const propRow = document.createElement('div');
  propRow.className = 'fea-row';
  propRow.appendChild(labeledInput('E (Pa)', numberInput(elData.E, (v) => {
    elData.E = v; notifyChange();
  })));
  propRow.appendChild(labeledInput('A (m²)', numberInput(elData.A, (v) => {
    elData.A = v; notifyChange();
  })));
  pop.appendChild(propRow);

  if (elData.type === 'beam') {
    const beamRow = document.createElement('div');
    beamRow.className = 'fea-row';
    beamRow.appendChild(labeledInput('I (m⁴)', numberInput(elData.I ?? 8e-6, (v) => {
      elData.I = v; notifyChange();
    })));
    pop.appendChild(beamRow);

    const distSection = document.createElement('div');
    distSection.className = 'fea-section';
    const distLabel = document.createElement('div');
    distLabel.className = 'fea-subtitle';
    distLabel.textContent = 'Distributed load (UDL)';
    distSection.appendChild(distLabel);
    const wyRow = document.createElement('div');
    wyRow.className = 'fea-row';
    const existingWy = state.distributedLoads[elId]?.wy ?? 0;
    wyRow.appendChild(labeledInput('wy (N/m)', numberInput(existingWy, (v) => {
      if (v === 0) delete state.distributedLoads[elId];
      else state.distributedLoads[elId] = { wy: v };
      render();
      notifyChange();
    })));
    distSection.appendChild(wyRow);
    pop.appendChild(distSection);
  }

  pop.appendChild(deleteButton(() => {
    deleteElement(elId);
    state.selection = null;
    render();
    notifyChange();
  }, 'Delete element'));
}

function deleteButton(onClick, text) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fea-delete-btn';
  btn.textContent = text;
  btn.addEventListener('click', onClick);
  return btn;
}

function positionPopover() {
  if (!state.selection) return;
  const pop = refs.popover;
  let anchor;
  if (state.selection.kind === 'node') {
    const node = state.nodes.find((n) => n.id === state.selection.id);
    if (!node) return;
    anchor = worldToScreen(view, node.x, node.y);
  } else {
    const elData = state.elements.find((e) => e.id === state.selection.id);
    if (!elData) return;
    const ni = state.nodes.find((n) => n.id === elData.nodeI);
    const nj = state.nodes.find((n) => n.id === elData.nodeJ);
    if (!ni || !nj) return;
    const pi = worldToScreen(view, ni.x, ni.y);
    const pj = worldToScreen(view, nj.x, nj.y);
    anchor = { x: (pi.x + pj.x) / 2, y: (pi.y + pj.y) / 2 };
  }
  const wrapRect = refs.canvasWrap.getBoundingClientRect();
  const popW = pop.offsetWidth || 220;
  const popH = pop.offsetHeight || 120;
  let left = anchor.x + 16;
  let top = anchor.y - popH / 2;
  left = Math.min(Math.max(left, 4), Math.max(wrapRect.width - popW - 4, 4));
  top = Math.min(Math.max(top, 4), Math.max(wrapRect.height - popH - 4, 4));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

// ---- main render --------------------------------------------------------

function render() {
  if (!refs) return;
  const { svg, content } = refs;
  const { w, h } = svgSize();
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');

  if (autoFit) view = computeFitView(state.nodes, w, h);

  clearChildren(content);

  drawAxes(content, w, h);

  // elements (under nodes)
  for (const e of state.elements) {
    drawElement(content, e);
  }
  // distributed load arrows
  for (const e of state.elements) {
    const dl = state.distributedLoads[e.id];
    if (dl) drawDistributedLoad(content, e, dl.wy);
  }
  // support symbols
  for (const n of state.nodes) {
    const s = state.supports[n.id];
    if (s) {
      const p = worldToScreen(view, n.x, n.y);
      drawSupportSymbol(content, p, classifySupport(s));
    }
  }
  // nodal loads
  for (const n of state.nodes) {
    const l = state.nodalLoads[n.id];
    if (l) drawNodalLoad(content, n, l);
  }
  // nodes (on top)
  for (const n of state.nodes) {
    drawNode(content, n);
  }

  updateToolbarUI();
  renderInspector();
}

function drawAxes(content, w, h) {
  const origin = worldToScreen(view, 0, 0);
  const g = createSvgEl('g', { class: 'axes' });
  if (origin.x >= 0 && origin.x <= w) {
    g.appendChild(createSvgEl('line', { x1: origin.x, y1: 0, x2: origin.x, y2: h, stroke: '#e2e8f0', 'stroke-width': 1 }));
  }
  if (origin.y >= 0 && origin.y <= h) {
    g.appendChild(createSvgEl('line', { x1: 0, y1: origin.y, x2: w, y2: origin.y, stroke: '#e2e8f0', 'stroke-width': 1 }));
  }
  content.appendChild(g);
}

function drawNode(content, n) {
  const p = worldToScreen(view, n.x, n.y);
  const selected = state.selection && state.selection.kind === 'node' && state.selection.id === n.id;
  const pending = state.connectPending === n.id;
  const g = createSvgEl('g', { class: 'node', 'data-node-id': n.id });
  g.appendChild(createSvgEl('circle', {
    cx: p.x, cy: p.y, r: 8,
    fill: pending ? '#facc15' : selected ? '#38bdf8' : '#ffffff',
    stroke: '#1e293b', 'stroke-width': selected ? 3 : 2,
  }));
  const label = createSvgEl('text', { x: p.x + 10, y: p.y - 10, 'font-size': 12, 'font-family': 'monospace', fill: '#1e293b' });
  label.textContent = n.id;
  g.appendChild(label);
  content.appendChild(g);
}

function drawElement(content, e) {
  const ni = state.nodes.find((n) => n.id === e.nodeI);
  const nj = state.nodes.find((n) => n.id === e.nodeJ);
  if (!ni || !nj) return;
  const pi = worldToScreen(view, ni.x, ni.y);
  const pj = worldToScreen(view, nj.x, nj.y);
  const selected = state.selection && state.selection.kind === 'element' && state.selection.id === e.id;
  const g = createSvgEl('g', { class: 'element', 'data-element-id': e.id });
  // fat invisible hit-target line, easier to click than the thin visible one
  g.appendChild(createSvgEl('line', {
    x1: pi.x, y1: pi.y, x2: pj.x, y2: pj.y, stroke: 'transparent', 'stroke-width': 14,
  }));
  g.appendChild(createSvgEl('line', {
    x1: pi.x, y1: pi.y, x2: pj.x, y2: pj.y,
    stroke: selected ? '#38bdf8' : '#475569',
    'stroke-width': e.type === 'beam' ? 5 : 2.5,
  }));
  const mx = (pi.x + pj.x) / 2;
  const my = (pi.y + pj.y) / 2;
  const label = createSvgEl('text', {
    x: mx + 6, y: my - 6, 'font-size': 11, 'font-family': 'monospace', fill: '#334155',
  });
  label.textContent = `${e.id} (${e.type})`;
  g.appendChild(label);
  content.appendChild(g);
}

function drawNodalLoad(content, n, load) {
  const p = worldToScreen(view, n.x, n.y);
  const arrowLen = 44;
  const mag = Math.hypot(load.fx, load.fy);
  if (mag === 0) return;
  const ux = load.fx / mag;
  const uy = load.fy / mag;
  // tail away from the node, arrowhead points into the node (standard convention)
  const from = { x: p.x - ux * arrowLen, y: p.y + uy * arrowLen }; // note: +uy because screen y is flipped
  drawArrow(content, from, p, {
    color: '#0f766e',
    label: `${formatLabel(load.fx)}, ${formatLabel(load.fy)} N`,
    labelOffset: { x: 8, y: -8 },
  });
}

function drawDistributedLoad(content, e, wy) {
  const ni = state.nodes.find((n) => n.id === e.nodeI);
  const nj = state.nodes.find((n) => n.id === e.nodeJ);
  if (!ni || !nj || wy === 0) return;
  const nArrows = 6;
  const arrowLen = 26;
  const dir = wy > 0 ? -1 : 1; // wy negative (downward) -> arrow points down (+screen y)
  const g = createSvgEl('g', { class: 'udl' });
  const baseline = [];
  for (let k = 0; k <= nArrows; k++) {
    const t = k / nArrows;
    const wx = ni.x + (nj.x - ni.x) * t;
    const wy2 = ni.y + (nj.y - ni.y) * t;
    const p = worldToScreen(view, wx, wy2);
    const tail = { x: p.x, y: p.y - dir * arrowLen };
    baseline.push(tail);
    drawArrow(g, tail, p, { color: '#b45309', width: 1.5 });
  }
  for (let k = 0; k < baseline.length - 1; k++) {
    g.appendChild(createSvgEl('line', {
      x1: baseline[k].x, y1: baseline[k].y, x2: baseline[k + 1].x, y2: baseline[k + 1].y,
      stroke: '#b45309', 'stroke-width': 1.5,
    }));
  }
  const midTail = baseline[Math.floor(baseline.length / 2)];
  const t = createSvgEl('text', {
    x: midTail.x + 6, y: midTail.y - 4, fill: '#b45309', 'font-size': 11, 'font-family': 'monospace',
  });
  t.textContent = `wy = ${formatLabel(wy)} N/m`;
  g.appendChild(t);
  content.appendChild(g);
}

function updateToolbarUI() {
  if (refs.connectToggleBtn) {
    refs.connectToggleBtn.setAttribute('aria-pressed', String(state.connectMode));
    refs.connectToggleBtn.textContent = state.connectMode
      ? 'Connect Mode: ON (click two nodes)'
      : 'Connect Mode: OFF';
    refs.connectToggleBtn.classList.toggle('active', state.connectMode);
  }
  if (refs.hintEl) {
    refs.hintEl.textContent = state.connectMode
      ? (state.connectPending
        ? `Click a second node to connect to ${state.connectPending} (Esc to cancel).`
        : 'Connect mode: click a node to start an element.')
      : 'Click empty canvas to add a node. Click a node or element to edit it. Delete key removes the selection.';
  }
}

// ---------------------------------------------------------------------------
// Public init
// ---------------------------------------------------------------------------

/**
 * Wire the interactive builder to the given DOM references.
 * refs: {
 *   svg,             SVG root element (required)
 *   canvasWrap,      relatively-positioned wrapper containing svg + popover (required)
 *   popover,         floating inspector panel element (required)
 *   connectToggleBtn, fitViewBtn, clearBtn  buttons (optional)
 *   hintEl,          status text element (optional)
 *   onChange(model)  callback fired after any state mutation (optional)
 * }
 */
export function initCanvas(inputRefs) {
  refs = inputRefs;
  const defs = buildArrowDefs();
  refs.svg.appendChild(defs);
  const content = createSvgEl('g', { id: 'fea-content' });
  refs.svg.appendChild(content);
  refs.content = content;

  refs.svg.addEventListener('pointerdown', onPointerDown);
  refs.svg.addEventListener('pointermove', onPointerMove);
  refs.svg.addEventListener('pointerup', onPointerUp);
  refs.svg.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', () => render());

  if (refs.connectToggleBtn) {
    refs.connectToggleBtn.addEventListener('click', () => {
      state.connectMode = !state.connectMode;
      state.connectPending = null;
      render();
    });
  }
  if (refs.fitViewBtn) {
    refs.fitViewBtn.addEventListener('click', () => {
      autoFit = true;
      render();
    });
  }
  if (refs.zoomInBtn) refs.zoomInBtn.addEventListener('click', () => zoomBy(1.25));
  if (refs.zoomOutBtn) refs.zoomOutBtn.addEventListener('click', () => zoomBy(0.8));
  if (refs.clearBtn) {
    refs.clearBtn.addEventListener('click', () => {
      if (confirm('Clear the entire model?')) resetCanvas();
    });
  }

  render();
  notifyChange();
  return { getModel, getState, resetCanvas };
}
