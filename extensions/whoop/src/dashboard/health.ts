import { shiftDate, type DailyStats } from './whoop'

export const BASELINE_DAYS = 30
export const MIN_BASELINE_DAYS = 14
export const healthMetrics = [
  {
    key: 'hrv',
    label: 'Heart rate variability',
    short: 'HRV',
    unit: 'ms',
    decimals: 1,
    description:
      'Nightly HRV, measured as RMSSD. Compare your own readings over time.',
    source: 'WHOOP recovery',
  },
  {
    key: 'rhr',
    label: 'Resting heart rate',
    short: 'Resting heart rate',
    unit: 'bpm',
    decimals: 0,
    description: 'Your resting heart rate reported with this day’s recovery.',
    source: 'WHOOP recovery',
  },
  {
    key: 'respiratoryRate',
    label: 'Respiratory rate',
    short: 'Respiratory rate',
    unit: 'rpm',
    decimals: 1,
    description:
      'Breaths per minute during your main sleep, not a live reading.',
    source: 'WHOOP sleep',
  },
  {
    key: 'spo2',
    label: 'Blood oxygen',
    short: 'Blood oxygen',
    unit: '%',
    decimals: 1,
    description:
      'Blood oxygen saturation (SpO₂). Availability depends on the data WHOOP returns.',
    source: 'WHOOP recovery',
  },
  {
    key: 'skinTemp',
    label: 'Skin temperature',
    short: 'Skin temperature',
    unit: '°C',
    decimals: 1,
    description:
      'Skin temperature, not core body temperature. The change shown is from your FORM median.',
    source: 'WHOOP recovery',
  },
] as const
export type HealthMetricKey = (typeof healthMetrics)[number]['key']
export interface HealthMetric {
  key: string
  label: string
  short: string
  unit: string
  decimals: number
  description: string
  source: string
}
export type ReadingStatus =
  'missing' | 'calibrating' | 'building' | 'within' | 'above' | 'below'

export function reading(day: DailyStats | undefined, key: HealthMetricKey) {
  const value = day?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function isCalibrating(
  day: DailyStats | undefined,
  key: HealthMetricKey,
) {
  return key !== 'respiratoryRate' && day?.recoveryCalibrating === true
}

// Linear-interpolated quantiles. Observed distribution only, not clinical limits.
export function quantile(sorted: number[], fraction: number) {
  if (!sorted.length) return null
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position)
  return (
    sorted[lower] +
    (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower)
  )
}

export function personalBaseline(
  days: DailyStats[],
  date: string,
  key: HealthMetricKey,
) {
  const start = shiftDate(date, -BASELINE_DAYS)
  const byDate = new Map<string, number>()
  for (const day of days) {
    const value = reading(day, key)
    if (
      day.date >= start &&
      day.date < date &&
      value !== null &&
      !isCalibrating(day, key)
    )
      byDate.set(day.date, value)
  }
  const values = [...byDate.values()].sort((a, b) => a - b)
  const ready = values.length >= MIN_BASELINE_DAYS
  return {
    count: values.length,
    ready,
    start,
    end: shiftDate(date, -1),
    median: ready ? quantile(values, 0.5) : null,
    low: ready ? quantile(values, 0.1) : null,
    high: ready ? quantile(values, 0.9) : null,
  }
}
export type PersonalBaseline = ReturnType<typeof personalBaseline>

export function readingStatus(
  day: DailyStats | undefined,
  key: HealthMetricKey,
  baseline: PersonalBaseline,
): ReadingStatus {
  const value = reading(day, key)
  if (value === null) return 'missing'
  if (isCalibrating(day, key)) return 'calibrating'
  if (!baseline.ready) return 'building'
  if (value < baseline.low!) return 'below'
  if (value > baseline.high!) return 'above'
  return 'within'
}

export const statusLabels: Record<ReadingStatus, string> = {
  missing: 'No reading',
  calibrating: 'WHOOP calibrating',
  building: 'Building comparison',
  within: 'Within recent range',
  above: 'Above recent range',
  below: 'Below recent range',
}

export function healthSeries(
  days: DailyStats[],
  date: string,
  key: HealthMetricKey,
  count: number,
) {
  const byDate = new Map(days.map((day) => [day.date, day]))
  return Array.from({ length: count }, (_, i) => {
    const day = shiftDate(date, i - count + 1)
    const record = byDate.get(day)
    const baseline = personalBaseline(days, day, key)
    return {
      date: new Date(`${day}T12:00:00`),
      day,
      value: reading(record, key),
      low: baseline.low,
      high: baseline.high,
      median: baseline.median,
      calibrating: isCalibrating(record, key),
    }
  })
}

export function formatHealth(
  value: number | null,
  metric: HealthMetric,
  withUnit = true,
) {
  if (value === null) return '—'
  return `${value.toFixed(metric.decimals)}${withUnit ? `${metric.unit === '%' ? '' : ' '}${metric.unit}` : ''}`
}

export function signedValue(value: number, decimals = 1) {
  // Do not display −0.0 when rounding a small negative change.
  const rounded = Number(value.toFixed(decimals))
  return `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${Math.abs(rounded).toFixed(decimals)}`
}
