export function halfToFloat(value: number): number {
  const sign = value & 0x8000 ? -1 : 1;
  const exponent = (value >> 10) & 0x1f;
  const fraction = value & 0x03ff;

  if (exponent === 0) {
    return fraction === 0 ? sign * 0 : sign * 2 ** -14 * (fraction / 1024);
  }
  if (exponent === 0x1f) {
    return fraction === 0 ? sign * Infinity : Number.NaN;
  }
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

export function decodeFloat16(source: Uint16Array): Float32Array {
  const output = new Float32Array(source.length);
  for (let index = 0; index < source.length; index += 1) {
    output[index] = halfToFloat(source[index]);
  }
  return output;
}

export function normalizeFloat16(
  source: Uint16Array,
  minimum: number,
  maximum: number,
): Float32Array {
  const output = new Float32Array(source.length);
  const span = Math.max(maximum - minimum, Number.EPSILON);
  for (let index = 0; index < source.length; index += 1) {
    const value = halfToFloat(source[index]);
    output[index] = Number.isFinite(value)
      ? Math.min(1, Math.max(0, (value - minimum) / span))
      : -1;
  }
  return output;
}

