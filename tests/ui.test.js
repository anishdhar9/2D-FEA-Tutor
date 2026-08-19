// tests/ui.test.js
//
// Track B (UI) unit tests. NOT specified as a task in docs/03-TRACK-B-UI.md —
// that doc only calls out browser-driven verification against mock JSON,
// which was done separately with Playwright (see the Track B completion
// report). This file exists because 00-OVERVIEW.md's repo layout lists
// `tests/ui.test.js` without 03-TRACK-B-UI.md ever specifying its contents,
// which reads as an oversight worth filling in lightly rather than ignoring.
//
// Scope: only the DOM-free, pure functions exported from src/ui/canvas.js
// and src/ui/render.js — state serialization, coordinate transforms, and
// support classification. These were deliberately written with zero
// `document`/`window` access at the top of canvas.js specifically so they
// could be exercised here under Node's built-in test runner without a
// browser. Anything that touches the DOM (SVG drawing, popovers, results
// tables) is out of scope for this file by design — it was verified
// interactively in a real Chromium instance instead, per the Track B task's
// explicit instruction to check UI work in a real browser, which a jsdom-style
// unit test would not actually substitute for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  createInitialState,
  buildModelJSON,
  classifySupport,
  worldToScreen,
  screenToWorld,
  computeFitView,
  nextNodeId,
  nextElementId,
  formatLabel,
  angleDegrees,
  segmentLength,
  snapAngleDegrees,
  pointFromLengthAngle,
  computeDrawEndpoint,
} from '../src/ui/canvas.js';
import { computeDefaultScaleFactor } from '../src/ui/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixtureJson(name) {
  return JSON.parse(readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

test('createInitialState: fresh state is empty and id counters start at 1', () => {
  const s = createInitialState();
  assert.deepEqual(s.nodes, []);
  assert.deepEqual(s.elements, []);
  assert.deepEqual(s.supports, {});
  assert.equal(nextNodeId(s), 'N1');
  assert.equal(nextElementId(s), 'e1');
});

test('buildModelJSON: empty state serializes to a schema-valid empty Model', () => {
  const model = buildModelJSON(createInitialState());
  assert.deepEqual(model, {
    meta: { units: 'SI' },
    nodes: [],
    elements: [],
    supports: [],
    loads: { nodal: [], distributed: [] },
  });
});

test('buildModelJSON: reproduces the triangle-truss acceptance-test Model shape exactly', () => {
  const state = createInitialState();
  state.nodes = [
    { id: 'A', x: 0, y: 0 },
    { id: 'B', x: 4, y: 0 },
    { id: 'C', x: 2, y: 3 },
  ];
  state.elements = [
    { id: 'e1', type: 'truss', nodeI: 'A', nodeJ: 'B', E: 200e9, A: 500e-6 },
    { id: 'e2', type: 'truss', nodeI: 'B', nodeJ: 'C', E: 200e9, A: 500e-6 },
    { id: 'e3', type: 'truss', nodeI: 'A', nodeJ: 'C', E: 200e9, A: 500e-6 },
  ];
  state.supports = {
    A: { kind: 'pin', ux: true, uy: true, rz: false },
    B: { kind: 'roller', ux: false, uy: true, rz: false },
  };
  state.nodalLoads = { C: { fx: 4000, fy: -10000, mz: 0 } };

  const model = buildModelJSON(state);
  const expected = loadFixtureJson('mock-truss-triangle.model.json');
  assert.deepEqual(model, expected);
});

test('buildModelJSON: truss elements never serialize an I field, beam elements always do', () => {
  const state = createInitialState();
  state.nodes = [{ id: 'A', x: 0, y: 0 }, { id: 'B', x: 1, y: 0 }];
  state.elements = [
    { id: 'e1', type: 'truss', nodeI: 'A', nodeJ: 'B', E: 200e9, A: 500e-6, I: 8e-6 }, // I present internally but must not leak into truss output
    { id: 'e2', type: 'beam', nodeI: 'A', nodeJ: 'B', E: 200e9, A: 500e-6, I: 8e-6 },
  ];
  const model = buildModelJSON(state);
  assert.equal('I' in model.elements[0], false, 'truss element must not serialize I');
  assert.equal(model.elements[1].I, 8e-6, 'beam element must serialize I');
});

test('buildModelJSON: a node with no support entry is omitted from supports[] (implicitly free)', () => {
  const state = createInitialState();
  state.nodes = [{ id: 'A', x: 0, y: 0 }];
  const model = buildModelJSON(state);
  assert.deepEqual(model.supports, []);
});

test('classifySupport: maps booleans to the standard symbol kind', () => {
  assert.equal(classifySupport(null), 'free');
  assert.equal(classifySupport({ ux: true, uy: true, rz: false }), 'pin');
  assert.equal(classifySupport({ ux: false, uy: true, rz: false }), 'roller');
  assert.equal(classifySupport({ ux: true, uy: true, rz: true }), 'fixed');
});

test('worldToScreen / screenToWorld: round-trip inverse for an arbitrary view', () => {
  const view = { scale: 73.5, originX: 212, originY: 480 };
  for (const [x, y] of [[0, 0], [4, 0], [2, 3], [-1.5, 6.25]]) {
    const screen = worldToScreen(view, x, y);
    const back = screenToWorld(view, screen.x, screen.y);
    assert.ok(Math.abs(back.x - x) < 1e-9, `x round-trip: ${back.x} vs ${x}`);
    assert.ok(Math.abs(back.y - y) < 1e-9, `y round-trip: ${back.y} vs ${y}`);
  }
});

test('worldToScreen: y is flipped (model y-up, screen y-down)', () => {
  const view = { scale: 10, originX: 0, originY: 0 };
  const p = worldToScreen(view, 0, 5);
  assert.equal(p.y, -50, 'a positive world y must map to a negative (upward) screen y offset from origin');
});

test('computeFitView: fits the triangle-truss node bounding box within the viewport with margin', () => {
  const model = loadFixtureJson('mock-truss-triangle.model.json');
  const width = 800, height = 600, padding = 50;
  const view = computeFitView(model.nodes, width, height, padding);
  for (const n of model.nodes) {
    const p = worldToScreen(view, n.x, n.y);
    assert.ok(p.x >= padding - 1 && p.x <= width - padding + 1, `node ${n.id} x=${p.x} within padded viewport`);
    assert.ok(p.y >= padding - 1 && p.y <= height - padding + 1, `node ${n.id} y=${p.y} within padded viewport`);
  }
});

test('computeFitView: empty node list falls back to a centered default view, not NaN/Infinity', () => {
  const view = computeFitView([], 800, 600);
  assert.ok(Number.isFinite(view.scale));
  assert.ok(Number.isFinite(view.originX));
  assert.ok(Number.isFinite(view.originY));
});

test('formatLabel: plain decimal for ordinary force/reaction magnitudes, not scientific notation', () => {
  // Regression test for a real bug found via this same test: the original
  // threshold (>=1000) meant a completely ordinary load like 4000 N rendered
  // as "4.00e+3" on canvas arrows — bad for a teaching tool where students
  // expect to read force values the way they'd write them by hand.
  assert.equal(formatLabel(0), '0');
  assert.equal(formatLabel(4000), '4000');
  assert.equal(formatLabel(-10000), '-10000');
  assert.equal(formatLabel(25000), '25000');
  assert.equal(formatLabel(9614.803401), '9614.803');
});

test('formatLabel: falls back to scientific notation only for genuinely extreme magnitudes', () => {
  assert.ok(formatLabel(19229606.802475).includes('e'), 'multi-million Pa stress should use scientific notation');
  assert.ok(formatLabel(0.0000001).includes('e'), 'sub-millirad rotation should use scientific notation');
});

test('computeDefaultScaleFactor: triangle truss (translation-dominated) gives a finite, positive scale', () => {
  const model = loadFixtureJson('mock-truss-triangle.model.json');
  const results = loadFixtureJson('mock-truss-triangle.results.json');
  const scale = computeDefaultScaleFactor(model, results);
  assert.ok(Number.isFinite(scale) && scale > 0, `expected a finite positive scale, got ${scale}`);
});

test('computeDefaultScaleFactor: propped cantilever (rotation-only deflection) still gives a usable non-trivial scale', () => {
  // Regression test for a real bug found during browser verification: both
  // nodes in this fixture have ux=uy=0 exactly (fixed + roller), so a naive
  // "max nodal translation" heuristic computes maxDisp=0 and falls back to
  // scale=1 — far too small to render the bending that comes entirely from
  // end rotation (rz). See render.js's computeDefaultScaleFactor doc comment.
  const model = loadFixtureJson('mock-propped-cantilever.model.json');
  const results = loadFixtureJson('mock-propped-cantilever.results.json');
  const scale = computeDefaultScaleFactor(model, results);
  assert.ok(Number.isFinite(scale) && scale > 1, `expected a scale well above the maxDisp=0 fallback of 1, got ${scale}`);
});

// ---------------------------------------------------------------------------
// Draw-drag geometry: angleDegrees, segmentLength, snapAngleDegrees,
// pointFromLengthAngle, computeDrawEndpoint (drag-from-node-to-draw-element,
// angle snapping, and the element inspector's Length/Angle fields).
// ---------------------------------------------------------------------------

test('angleDegrees: standard math convention, 0deg=+x, 90deg=+y, CCW positive', () => {
  assert.equal(angleDegrees(0, 0, 1, 0), 0);
  assert.equal(angleDegrees(0, 0, 0, 1), 90);
  assert.equal(angleDegrees(0, 0, -1, 0), 180);
  assert.equal(angleDegrees(0, 0, 0, -1), -90);
  assert.ok(Math.abs(angleDegrees(0, 0, 1, 1) - 45) < 1e-9);
});

test('segmentLength: Euclidean distance between two points', () => {
  assert.equal(segmentLength(0, 0, 3, 4), 5);
  assert.equal(segmentLength(1, 1, 1, 1), 0);
});

test('snapAngleDegrees: snaps to the nearest 45deg multiple within tolerance', () => {
  assert.equal(snapAngleDegrees(44, 45, 7), 45);
  assert.equal(snapAngleDegrees(46, 45, 7), 45);
  assert.equal(snapAngleDegrees(38.5, 45, 7), 45);
  assert.equal(snapAngleDegrees(0, 45, 7), 0);
  assert.equal(snapAngleDegrees(90, 45, 7), 90);
});

test('snapAngleDegrees: leaves the angle unchanged when outside tolerance', () => {
  assert.equal(snapAngleDegrees(30, 45, 7), 30);
  assert.equal(snapAngleDegrees(20, 45, 7), 20);
});

test('snapAngleDegrees: wraps correctly across the 0/360 boundary', () => {
  assert.equal(snapAngleDegrees(358, 45, 7), 0);
  assert.equal(snapAngleDegrees(-2, 45, 7), 0);
  assert.equal(snapAngleDegrees(-46, 45, 7), 315);
});

test('pointFromLengthAngle: computes an endpoint at a given length/angle from a start point', () => {
  const p = pointFromLengthAngle(0, 0, 5, 0);
  assert.ok(Math.abs(p.x - 5) < 1e-9 && Math.abs(p.y - 0) < 1e-9);
  const p2 = pointFromLengthAngle(1, 1, 10, 90);
  assert.ok(Math.abs(p2.x - 1) < 1e-9 && Math.abs(p2.y - 11) < 1e-9);
});

test('pointFromLengthAngle / angleDegrees / segmentLength: round-trip inverse', () => {
  const x0 = 2, y0 = -3, length = 7.25, angleDeg = 123.4;
  const p = pointFromLengthAngle(x0, y0, length, angleDeg);
  assert.ok(Math.abs(segmentLength(x0, y0, p.x, p.y) - length) < 1e-9);
  assert.ok(Math.abs(angleDegrees(x0, y0, p.x, p.y) - angleDeg) < 1e-9);
});

test('computeDrawEndpoint: snaps direction near a 45deg multiple but keeps the dragged distance', () => {
  // Cursor sits just 0.3 off the x-axis at a raw distance of ~5.009 — well
  // within the default 7deg tolerance of 0deg.
  const rawLength = segmentLength(0, 0, 5, 0.3);
  const result = computeDrawEndpoint(0, 0, 5, 0.3, true);
  assert.equal(result.angleDeg, 0);
  assert.ok(Math.abs(result.y) < 1e-9, 'snapped endpoint should land exactly on the x-axis');
  assert.ok(Math.abs(result.x - rawLength) < 1e-9, 'x equals the preserved raw drag distance since angle snapped to 0');
  assert.ok(Math.abs(result.length - rawLength) < 1e-9, 'reported length matches the raw dragged distance, unchanged by snapping');
});

test('computeDrawEndpoint: leaves an unsnappable angle untouched', () => {
  const result = computeDrawEndpoint(0, 0, 5, 3, true); // atan2(3,5) ~= 31 deg, far from any 45deg multiple
  const rawAngle = angleDegrees(0, 0, 5, 3);
  assert.ok(Math.abs(result.angleDeg - rawAngle) < 1e-9);
  assert.ok(Math.abs(result.x - 5) < 1e-9 && Math.abs(result.y - 3) < 1e-9);
});

test('computeDrawEndpoint: snapping disabled returns the raw cursor point unchanged even near a snap angle', () => {
  const result = computeDrawEndpoint(0, 0, 5, 0.3, false);
  const rawAngle = angleDegrees(0, 0, 5, 0.3);
  assert.ok(Math.abs(result.angleDeg - rawAngle) < 1e-9);
  assert.ok(Math.abs(result.x - 5) < 1e-9 && Math.abs(result.y - 0.3) < 1e-9);
});

test('computeDrawEndpoint: start point offset from the origin snaps correctly too', () => {
  // Start at (2,2), cursor nearly straight up from it (89.5deg) -> should
  // snap to exactly 90deg, i.e. endpoint lands with the same x as the start.
  const result = computeDrawEndpoint(2, 2, 2.02, 6, true);
  assert.equal(result.angleDeg, 90);
  assert.ok(Math.abs(result.x - 2) < 1e-9, 'snapped to 90deg means endpoint.x equals the start x');
  assert.ok(result.y > 2, 'endpoint should be above the start point');
});
