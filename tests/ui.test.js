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
