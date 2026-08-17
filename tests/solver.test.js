import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { solveModel } from '../src/solver/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(name) {
  const model = JSON.parse(
    readFileSync(path.join(__dirname, 'fixtures', `${name}.model.json`), 'utf8')
  );
  const expected = JSON.parse(
    readFileSync(path.join(__dirname, 'fixtures', `${name}.expected.json`), 'utf8')
  );
  return { model, expected };
}

function byNode(arr, id) {
  return arr.find((x) => x.node === id);
}

function byElement(arr, id) {
  return arr.find((x) => x.element === id);
}

function assertClose(actual, expected, tol, message) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${message}: expected ${expected}, got ${actual} (tol ${tol})`
  );
}

test('triangle truss — displacements, reactions, element forces, equilibrium', () => {
  const { model, expected } = loadFixture('truss-triangle');
  const results = solveModel(model);
  const tol = expected.tolerance;

  for (const exp of expected.displacements) {
    const got = byNode(results.displacements, exp.node);
    assert.ok(got, `missing displacement for node ${exp.node}`);
    assertClose(got.ux, exp.ux, tol.displacement, `node ${exp.node} ux`);
    assertClose(got.uy, exp.uy, tol.displacement, `node ${exp.node} uy`);
    assertClose(got.rz, exp.rz, tol.displacement, `node ${exp.node} rz`);
  }

  for (const exp of expected.reactions) {
    const got = byNode(results.reactions, exp.node);
    assert.ok(got, `missing reaction for node ${exp.node}`);
    assertClose(got.rx, exp.rx, tol.force, `node ${exp.node} rx`);
    assertClose(got.ry, exp.ry, tol.force, `node ${exp.node} ry`);
    assertClose(got.mz, exp.mz, tol.force, `node ${exp.node} mz`);
  }

  for (const exp of expected.elementForces) {
    const got = byElement(results.elementForces, exp.element);
    assert.ok(got, `missing element forces for ${exp.element}`);
    assertClose(got.axialForce, exp.axialForce, tol.force, `${exp.element} axialForce`);
    assertClose(got.axialStress, exp.axialStress, tol.stress, `${exp.element} axialStress`);
  }

  // Global equilibrium: catches assembly/sign-convention bugs point-value checks might miss.
  const sumRx = results.reactions.reduce((s, r) => s + r.rx, 0);
  const sumRy = results.reactions.reduce((s, r) => s + r.ry, 0);
  assertClose(sumRx + 4000, 0, 1e-6, 'global equilibrium sum Fx (reactions + applied load)');
  assertClose(sumRy - 10000, 0, 1e-6, 'global equilibrium sum Fy (reactions + applied load)');
});

test('triangle truss — inactive rz DOFs reported in diagnostics', () => {
  const { model } = loadFixture('truss-triangle');
  const results = solveModel(model);

  assert.ok(results.diagnostics, 'diagnostics field must be present');
  for (const nodeId of ['A', 'B', 'C']) {
    assert.ok(
      results.diagnostics.inactiveDofs.includes(`${nodeId}.rz`),
      `${nodeId}.rz should be auto-excluded (truss-only node) per the 3-DOF/node rule`
    );
  }
});

test('propped cantilever — statically indeterminate beam, sign conventions', () => {
  const { model, expected } = loadFixture('propped-cantilever');
  const results = solveModel(model);
  const tol = expected.tolerance;

  for (const exp of expected.displacements) {
    const got = byNode(results.displacements, exp.node);
    assert.ok(got, `missing displacement for node ${exp.node}`);
    assertClose(got.ux, exp.ux, tol.displacement, `node ${exp.node} ux`);
    assertClose(got.uy, exp.uy, tol.displacement, `node ${exp.node} uy`);
    assertClose(got.rz, exp.rz, tol.displacement, `node ${exp.node} rz`);
  }

  for (const exp of expected.reactions) {
    const got = byNode(results.reactions, exp.node);
    assert.ok(got, `missing reaction for node ${exp.node}`);
    assertClose(got.rx, exp.rx, tol.force, `node ${exp.node} rx`);
    assertClose(got.ry, exp.ry, tol.force, `node ${exp.node} ry`);
    assertClose(got.mz, exp.mz, tol.moment, `node ${exp.node} mz`);
  }

  for (const exp of expected.elementForces) {
    const got = byElement(results.elementForces, exp.element);
    assert.ok(got, `missing element forces for ${exp.element}`);
    assertClose(got.axialForceI, exp.axialForceI, tol.force, `${exp.element} axialForceI`);
    assertClose(got.shearI, exp.shearI, tol.force, `${exp.element} shearI`);
    assertClose(got.momentI, exp.momentI, tol.moment, `${exp.element} momentI`);
    assertClose(got.axialForceJ, exp.axialForceJ, tol.force, `${exp.element} axialForceJ`);
    assertClose(got.shearJ, exp.shearJ, tol.force, `${exp.element} shearJ`);
    assertClose(got.momentJ, exp.momentJ, tol.moment, `${exp.element} momentJ`);
  }

  // shearJ (internal, -15000) must NOT collapse to the same sign as R_B.ry (reaction, +15000) —
  // see the sign-convention gotcha documented in docs/04-TRACK-C-VALIDATION.md.
  const rB = byNode(results.reactions, 'B');
  const e1 = byElement(results.elementForces, 'e1');
  assert.ok(
    Math.sign(e1.shearJ) !== Math.sign(rB.ry),
    'shearJ (internal shear) must have opposite sign to R_B.ry (support reaction) at the same node'
  );

  const rA = byNode(results.reactions, 'A');
  assertClose(rA.ry + rB.ry, 40000, tol.force, 'reaction sum equals total UDL wL (w=10000, L=4)');
});

test('propped cantilever — reactions/internal forces invariant to E and I, rotation is not', () => {
  const { model } = loadFixture('propped-cantilever');
  const base = solveModel(model);

  const altered = JSON.parse(JSON.stringify(model));
  altered.elements[0].I *= 3;
  altered.elements[0].E *= 2;
  const altResults = solveModel(altered);

  const baseRA = byNode(base.reactions, 'A');
  const altRA = byNode(altResults.reactions, 'A');
  assertClose(altRA.ry, baseRA.ry, 1e-3, 'R_A.ry must be invariant to E/I (statically indeterminate correctness check)');
  assertClose(altRA.mz, baseRA.mz, 1e-3, 'R_A.mz must be invariant to E/I');

  const baseEf = byElement(base.elementForces, 'e1');
  const altEf = byElement(altResults.elementForces, 'e1');
  assertClose(altEf.shearI, baseEf.shearI, 1e-3, 'shearI must be invariant to E/I');
  assertClose(altEf.momentI, baseEf.momentI, 1e-3, 'momentI must be invariant to E/I');

  // Sanity check the invariance assertions above aren't vacuously true: rotation SHOULD change.
  const baseDisp = byNode(base.displacements, 'B');
  const altDisp = byNode(altResults.displacements, 'B');
  assert.notEqual(altDisp.rz, baseDisp.rz, 'rotation at B should change when I changes');
});
