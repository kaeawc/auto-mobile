/**
 * Reed-Solomon error-correction codewords over GF(256) as specified by
 * ISO/IEC 18004 section 7.5.2: field polynomial x^8 + x^4 + x^3 + x^2 + 1
 * (0x11D) and generator polynomial prod_{i=0}^{n-1} (x - a^i) with a = 2.
 */

const FIELD_POLYNOMIAL = 0x11d;

const EXP_TABLE: number[] = buildExpTable();
const LOG_TABLE: number[] = buildLogTable(EXP_TABLE);

function buildExpTable(): number[] {
  const table = new Array<number>(512).fill(0);
  let value = 1;
  for (let i = 0; i < 255; i++) {
    table[i] = value;
    value <<= 1;
    if (value & 0x100) {
      value ^= FIELD_POLYNOMIAL;
    }
  }
  // Duplicate so exp[log a + log b] never needs a modulo.
  for (let i = 255; i < 512; i++) {
    table[i] = table[i - 255];
  }
  return table;
}

function buildLogTable(exp: number[]): number[] {
  const table = new Array<number>(256).fill(0);
  for (let i = 0; i < 255; i++) {
    table[exp[i]] = i;
  }
  return table;
}

/** Multiply two GF(256) elements. */
export function gfMultiply(a: number, b: number): number {
  if (a === 0 || b === 0) {
    return 0;
  }
  return EXP_TABLE[LOG_TABLE[a] + LOG_TABLE[b]];
}

/**
 * Generator polynomial of the given degree, as coefficients from the highest
 * power down, excluding the implicit leading 1.
 */
export function rsGeneratorPolynomial(degree: number): number[] {
  // coefficients[0] is the x^degree term (always 1 once complete).
  let coefficients = [1];
  for (let i = 0; i < degree; i++) {
    const root = EXP_TABLE[i];
    const next = new Array<number>(coefficients.length + 1).fill(0);
    for (let j = 0; j < coefficients.length; j++) {
      next[j] ^= coefficients[j];
      next[j + 1] ^= gfMultiply(coefficients[j], root);
    }
    coefficients = next;
  }
  return coefficients.slice(1);
}

/** Error-correction codewords for one block: the remainder of data(x)·x^n / g(x). */
export function rsComputeRemainder(data: readonly number[], ecCount: number): number[] {
  const generator = rsGeneratorPolynomial(ecCount);
  const remainder = new Array<number>(ecCount).fill(0);
  for (const codeword of data) {
    const factor = codeword ^ (remainder.shift() ?? 0);
    remainder.push(0);
    for (let i = 0; i < ecCount; i++) {
      remainder[i] ^= gfMultiply(generator[i], factor);
    }
  }
  return remainder;
}
