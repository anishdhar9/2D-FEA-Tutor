// Small dense-matrix helpers shared by the solver modules.
//
// Deliberately tiny and dependency-free (no typed arrays needed at these
// sizes) — this exists purely so truss.js/beam.js/assemble.js don't each
// reimplement matrix multiply/transpose/solve. Pure computation only, no
// Node-only APIs.

/** @returns {number[][]} a rows x cols matrix of zeros */
export function zerosMatrix(rows, cols) {
  return Array.from({ length: rows }, () => new Array(cols).fill(0));
}

/** @returns {number[]} a length-n vector of zeros */
export function zerosVector(n) {
  return new Array(n).fill(0);
}

/** @returns {number[][]} the transpose of A */
export function matTranspose(A) {
  const rows = A.length;
  const cols = A[0].length;
  const T = zerosMatrix(cols, rows);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      T[j][i] = A[i][j];
    }
  }
  return T;
}

/** @returns {number[][]} A * B */
export function matMultiply(A, B) {
  const rows = A.length;
  const inner = B.length;
  const cols = B[0].length;
  const C = zerosMatrix(rows, cols);
  for (let i = 0; i < rows; i++) {
    for (let k = 0; k < inner; k++) {
      const a = A[i][k];
      if (a === 0) continue;
      for (let j = 0; j < cols; j++) {
        C[i][j] += a * B[k][j];
      }
    }
  }
  return C;
}

/** @returns {number[]} A * v */
export function matVecMultiply(A, v) {
  const rows = A.length;
  const cols = A[0].length;
  const out = new Array(rows).fill(0);
  for (let i = 0; i < rows; i++) {
    let sum = 0;
    for (let j = 0; j < cols; j++) {
      sum += A[i][j] * v[j];
    }
    out[i] = sum;
  }
  return out;
}

/**
 * Hand-rolled Gaussian elimination with partial pivoting, solving A x = b
 * for x. Not a library call — deliberately explicit so every elimination
 * step stays inspectable for a future "show your work" panel.
 *
 * @param {number[][]} A square matrix (n x n)
 * @param {number[]} b length-n vector
 * @returns {number[]} solution x
 */
export function gaussianEliminationSolve(A, b) {
  const n = b.length;
  if (n === 0) return [];

  // Work on copies so callers keep their originals untouched.
  const M = A.map((row) => row.slice());
  const rhs = b.slice();

  for (let col = 0; col < n; col++) {
    // Partial pivot: swap in the largest-magnitude entry in this column.
    let pivotRow = col;
    let maxVal = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r][col]);
      if (v > maxVal) {
        maxVal = v;
        pivotRow = r;
      }
    }
    if (maxVal < 1e-12) {
      throw new Error(
        'Singular system: free-DOF stiffness matrix is singular (unstable mechanism or ' +
          'missing supports) — cannot solve.'
      );
    }
    if (pivotRow !== col) {
      [M[col], M[pivotRow]] = [M[pivotRow], M[col]];
      [rhs[col], rhs[pivotRow]] = [rhs[pivotRow], rhs[col]];
    }

    const pivot = M[col][col];
    for (let r = col + 1; r < n; r++) {
      const factor = M[r][col] / pivot;
      if (factor === 0) continue;
      for (let c = col; c < n; c++) {
        M[r][c] -= factor * M[col][c];
      }
      rhs[r] -= factor * rhs[col];
    }
  }

  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = rhs[i];
    for (let j = i + 1; j < n; j++) {
      sum -= M[i][j] * x[j];
    }
    x[i] = sum / M[i][i];
  }
  return x;
}
