// Deliberately simple baseline for the isolated optimization demonstration.
export function sumTo(n) {
  if (!Number.isSafeInteger(n) || n < 0 || n > 100000000) throw new RangeError('n must be a safe integer in 0..100000000');
  let sum = 0;
  for (let i = 1; i <= n; i++) sum += i;
  return sum;
}
