/** Render an IEEE-754 float32 using the spelling produced by Float.toString. */
export function float32ToJavaString(value: number): string {
  const float32 = Math.fround(value);
  if (Number.isNaN(float32)) {
    return "NaN";
  }
  if (float32 === Number.POSITIVE_INFINITY) {
    return "Infinity";
  }
  if (float32 === Number.NEGATIVE_INFINITY) {
    return "-Infinity";
  }
  if (Object.is(float32, -0)) {
    return "-0.0";
  }
  if (float32 === 0) {
    return "0.0";
  }

  let shortest = "";
  for (let precision = 1; precision <= 9; precision += 1) {
    const candidate = float32.toPrecision(precision);
    if (Math.fround(Number(candidate)) === float32) {
      shortest = candidate;
      break;
    }
  }

  return formatFloat32Candidate(shortest || String(float32), float32);
}

function formatFloat32Candidate(candidate: string, float32: number): string {
  const match = /^(-?)(\d+(?:\.\d+)?)(?:e([+-]?\d+))?$/i.exec(candidate);
  if (!match) {
    return candidate;
  }

  const sign = match[1]!;
  const mantissa = match[2]!;
  const decimalPosition = mantissa.indexOf(".") === -1 ? mantissa.length : mantissa.indexOf(".");
  const allDigits = mantissa.replace(".", "");
  const firstSignificantDigit = allDigits.search(/[1-9]/);
  const digits = allDigits.slice(firstSignificantDigit).replace(/0+$/, "") || "0";
  const exponent = Number(match[3] ?? 0) + decimalPosition - firstSignificantDigit - 1;
  const magnitude = Math.abs(float32);
  if (magnitude < 1e-3 || magnitude >= 1e7) {
    return `${sign}${digits[0]}.${digits.slice(1) || "0"}E${exponent}`;
  }

  const outputDecimalPosition = exponent + 1;
  if (outputDecimalPosition <= 0) {
    return `${sign}0.${"0".repeat(-outputDecimalPosition)}${digits}`;
  }
  if (outputDecimalPosition >= digits.length) {
    return `${sign}${digits}${"0".repeat(outputDecimalPosition - digits.length)}.0`;
  }
  return `${sign}${digits.slice(0, outputDecimalPosition)}.${digits.slice(outputDecimalPosition)}`;
}
