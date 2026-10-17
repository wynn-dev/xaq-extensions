// Small, dependency-free statistics used by the insight panels. Every function
// returns null instead of guessing when there is not enough data.

export function median(values: number[]) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

// Median absolute deviation scaled to be comparable with a standard deviation.
export function mad(values: number[]) {
  const centre = median(values)
  if (centre === null) return null
  const deviation = median(values.map((value) => Math.abs(value - centre)))
  return deviation === null ? null : deviation * 1.4826
}

export function average(values: number[]) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null
}

export function sampleSd(values: number[]) {
  if (values.length < 2) return null
  const centre = average(values)!
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - centre) ** 2, 0) /
      (values.length - 1),
  )
}

// Robust z-score: distance from the baseline median in MAD units.
export function robustZ(value: number, baseline: number[]) {
  const centre = median(baseline)
  const spread = mad(baseline)
  if (centre === null || spread === null || spread === 0) return null
  return (value - centre) / spread
}

// Average ranks, ties share the mean of the positions they occupy.
export function ranks(values: number[]) {
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value)
  const result = new Array<number>(values.length)
  for (let i = 0; i < order.length;) {
    let j = i
    while (j + 1 < order.length && order[j + 1].value === order[i].value) j++
    const rank = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) result[order[k].index] = rank
    i = j + 1
  }
  return result
}

// Spearman's rank correlation: a monotonic association in [-1, 1].
export function spearman(x: number[], y: number[]) {
  const n = Math.min(x.length, y.length)
  if (n < 3) return null
  const rx = ranks(x.slice(0, n))
  const ry = ranks(y.slice(0, n))
  const mx = average(rx)!
  const my = average(ry)!
  let cov = 0
  let vx = 0
  let vy = 0
  for (let i = 0; i < n; i++) {
    cov += (rx[i] - mx) * (ry[i] - my)
    vx += (rx[i] - mx) ** 2
    vy += (ry[i] - my) ** 2
  }
  if (vx === 0 || vy === 0) return null
  return { rho: cov / Math.sqrt(vx * vy), n }
}

// 95% interval for a correlation via Fisher's z transform.
export function fisherInterval(
  rho: number,
  n: number,
): [number, number] | null {
  if (n < 4) return null
  const clamped = Math.max(-0.999999, Math.min(0.999999, rho))
  const z = Math.atanh(clamped)
  const se = 1 / Math.sqrt(n - 3)
  return [Math.tanh(z - 1.96 * se), Math.tanh(z + 1.96 * se)]
}

export function correlationStrength(rho: number) {
  const size = Math.abs(rho)
  return size < 0.2
    ? 'negligible'
    : size < 0.4
      ? 'weak'
      : size < 0.6
        ? 'moderate'
        : 'strong'
}
