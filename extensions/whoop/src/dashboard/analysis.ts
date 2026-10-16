// Deeper, still descriptive insights. Each function states its own minimum
// sample and returns `ready: false` (or an empty list) instead of a shaky
// number. Nothing here is a diagnosis, a prediction, or a training plan.
import {
  daysThrough,
  localDate,
  localMinutes,
  napsOnDate,
  shiftDate,
  workoutZones,
  type DailyStats,
  type StoredRecord,
  type WhoopRecord,
} from './whoop'
import { sleepBalance, sleepTiming, workoutHours } from './insights'
import {
  average,
  correlationStrength,
  fisherInterval,
  median,
  robustZ,
  sampleSd,
  spearman,
} from './stats'

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
const byDateMap = (days: DailyStats[]) =>
  new Map(days.map((day) => [day.date, day]))
const weekdayOf = (date: string) =>
  (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7
const isWeekend = (date: string) => weekdayOf(date) >= 5
const workoutDate = (workout: WhoopRecord) =>
  workout.start ? localDate(workout.start, workout.timezone_offset) : null

// ---------------------------------------------------------------------------
// A. Relationships with confidence
// ---------------------------------------------------------------------------
export const MIN_RELATIONSHIP_DAYS = 20
export interface Relationship {
  key: string
  factor: string
  outcome: string
  rho: number
  n: number
  interval: [number, number]
  strength: ReturnType<typeof correlationStrength>
  clear: boolean
  reading: string
}

export function relationships(allDays: DailyStats[], days: DailyStats[]) {
  const byDate = byDateMap(allDays)
  const previousStrain = (day: DailyStats) =>
    byDate.get(shiftDate(day.date, -1))?.strain ?? null
  const bedtime = (day: DailyStats) => sleepTiming([day]).nights[0]?.bed ?? null
  const needMet = (day: DailyStats) =>
    day.sleepHours != null && day.sleepNeededHours
      ? (day.sleepHours / day.sleepNeededHours) * 100
      : null
  const restorative = (day: DailyStats) =>
    day.deepHours != null && day.remHours != null
      ? day.deepHours + day.remHours
      : null
  const pairs: {
    key: string
    factor: string
    outcome: string
    x: (day: DailyStats) => number | null
    y: (day: DailyStats) => number | null
    higherX: string
  }[] = [
    {
      key: 'sleep-recovery',
      factor: 'time asleep',
      outcome: 'recovery',
      x: (d) => d.sleepHours,
      y: (d) => d.recovery,
      higherX: 'More sleep',
    },
    {
      key: 'need-recovery',
      factor: 'sleep need met',
      outcome: 'recovery',
      x: needMet,
      y: (d) => d.recovery,
      higherX: 'Meeting more of your sleep need',
    },
    {
      key: 'restorative-recovery',
      factor: 'restorative sleep',
      outcome: 'recovery',
      x: restorative,
      y: (d) => d.recovery,
      higherX: 'More deep and REM sleep',
    },
    {
      key: 'bedtime-recovery',
      factor: 'bedtime',
      outcome: 'recovery',
      x: bedtime,
      y: (d) => d.recovery,
      higherX: 'A later bedtime',
    },
    {
      key: 'consistency-recovery',
      factor: 'sleep consistency',
      outcome: 'recovery',
      x: (d) => d.sleepConsistency,
      y: (d) => d.recovery,
      higherX: 'More consistent sleep timing',
    },
    {
      key: 'strain-recovery',
      factor: 'previous-day strain',
      outcome: 'recovery',
      x: previousStrain,
      y: (d) => d.recovery,
      higherX: 'A harder previous day',
    },
    {
      key: 'sleep-hrv',
      factor: 'time asleep',
      outcome: 'HRV',
      x: (d) => d.sleepHours,
      y: (d) => d.hrv,
      higherX: 'More sleep',
    },
    {
      key: 'strain-hrv',
      factor: 'previous-day strain',
      outcome: 'HRV',
      x: previousStrain,
      y: (d) => d.hrv,
      higherX: 'A harder previous day',
    },
  ]
  const results: Relationship[] = []
  for (const pair of pairs) {
    const xs: number[] = []
    const ys: number[] = []
    for (const day of days) {
      const x = pair.x(day)
      const y = pair.y(day)
      if (isNumber(x) && isNumber(y)) {
        xs.push(x)
        ys.push(y)
      }
    }
    if (xs.length < MIN_RELATIONSHIP_DAYS) continue
    const result = spearman(xs, ys)
    if (!result) continue
    const interval = fisherInterval(result.rho, result.n)
    if (!interval) continue
    const clear = interval[0] > 0 || interval[1] < 0
    results.push({
      key: pair.key,
      factor: pair.factor,
      outcome: pair.outcome,
      rho: result.rho,
      n: result.n,
      interval,
      strength: correlationStrength(result.rho),
      clear,
      reading: clear
        ? `${pair.higherX} went with ${result.rho > 0 ? 'higher' : 'lower'} ${pair.outcome}.`
        : `No clear link between ${pair.factor} and ${pair.outcome} in this period.`,
    })
  }
  return results.sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho))
}

// ---------------------------------------------------------------------------
// B. Unusual nights: several signals leaving their own recent range together.
// ---------------------------------------------------------------------------
export const MIN_SIGNAL_BASELINE = 14
export const SIGNAL_THRESHOLD = 2
export const signalDefinitions = [
  { key: 'rhr', label: 'Resting heart rate', unit: 'bpm', direction: 1 },
  { key: 'hrv', label: 'HRV', unit: 'ms', direction: -1 },
  {
    key: 'respiratoryRate',
    label: 'Respiratory rate',
    unit: 'rpm',
    direction: 1,
  },
  { key: 'skinTemp', label: 'Skin temperature', unit: '°C', direction: 1 },
] as const
type SignalKey = (typeof signalDefinitions)[number]['key']
export interface UnusualSignal {
  key: SignalKey
  label: string
  unit: string
  value: number
  median: number
  z: number
}
export interface UnusualNight {
  date: string
  signals: UnusualSignal[]
}

export function unusualNights(allDays: DailyStats[], days: DailyStats[]) {
  const usable = (day: DailyStats, key: SignalKey) =>
    key === 'respiratoryRate' || !day.recoveryCalibrating
  const nights: UnusualNight[] = []
  let evaluated = 0
  let building = 0
  for (const day of days) {
    const start = shiftDate(day.date, -30)
    const flagged: UnusualSignal[] = []
    let scored = 0
    for (const signal of signalDefinitions) {
      const value = day[signal.key]
      if (!isNumber(value) || !usable(day, signal.key)) continue
      const baseline = allDays
        .filter(
          (other) =>
            other.date >= start &&
            other.date < day.date &&
            isNumber(other[signal.key]) &&
            usable(other, signal.key),
        )
        .map((other) => other[signal.key] as number)
      if (baseline.length < MIN_SIGNAL_BASELINE) continue
      scored++
      const z = robustZ(value, baseline)
      if (z === null) continue
      if (z * signal.direction >= SIGNAL_THRESHOLD)
        flagged.push({
          key: signal.key,
          label: signal.label,
          unit: signal.unit,
          value,
          median: median(baseline)!,
          z,
        })
    }
    if (scored >= 2) evaluated++
    else if (signalDefinitions.some((s) => isNumber(day[s.key]))) building++
    if (flagged.length >= 2) nights.push({ date: day.date, signals: flagged })
  }
  return { nights: nights.reverse(), evaluated, building }
}

// ---------------------------------------------------------------------------
// C. HRV readiness band on log HRV (geometric means shown in ms).
// ---------------------------------------------------------------------------
export const HRV_ROLLING = 7
export const HRV_BASELINE = 28
export interface ReadinessPoint {
  date: Date
  day: string
  value: number | null // 7-day geometric mean, ms
  low: number | null
  high: number | null
  median: number | null // 28-day geometric mean, ms
  calibrating: boolean
}

export function hrvReadiness(
  allDays: DailyStats[],
  end: string,
  count: number,
) {
  const logByDate = new Map(
    allDays
      .filter(
        (day) => isNumber(day.hrv) && day.hrv > 0 && !day.recoveryCalibrating,
      )
      .map((day) => [day.date, Math.log(day.hrv!)]),
  )
  const rawByDate = new Map(
    allDays
      .filter((day) => isNumber(day.hrv) && !day.recoveryCalibrating)
      .map((day) => [day.date, day.hrv!]),
  )
  const window = (
    endDate: string,
    length: number,
    source: Map<string, number>,
  ) => {
    const values: number[] = []
    for (let i = 0; i < length; i++) {
      const value = source.get(shiftDate(endDate, -i))
      if (value !== undefined) values.push(value)
    }
    return values
  }
  const series: ReadinessPoint[] = []
  for (let i = count - 1; i >= 0; i--) {
    const day = shiftDate(end, -i)
    const rolling = window(day, HRV_ROLLING, logByDate)
    const base = window(day, HRV_BASELINE, logByDate)
    const baseMean = base.length >= 20 ? average(base) : null
    const baseSd = base.length >= 20 ? sampleSd(base) : null
    series.push({
      date: new Date(`${day}T12:00:00`),
      day,
      value: rolling.length >= 4 ? Math.exp(average(rolling)!) : null,
      low:
        baseMean !== null && baseSd !== null
          ? Math.exp(baseMean - 0.5 * baseSd)
          : null,
      high:
        baseMean !== null && baseSd !== null
          ? Math.exp(baseMean + 0.5 * baseSd)
          : null,
      median: baseMean !== null ? Math.exp(baseMean) : null,
      calibrating: false,
    })
  }
  const latest = series.at(-1)!
  const raw7 = window(end, HRV_ROLLING, rawByDate)
  const cv = raw7.length >= 4 ? (sampleSd(raw7)! / average(raw7)!) * 100 : null
  const status =
    latest.value === null || latest.low === null || latest.high === null
      ? null
      : latest.value < latest.low
        ? 'below'
        : latest.value > latest.high
          ? 'above'
          : 'within'
  return {
    series,
    latest,
    status,
    cv,
    rollingCount: window(end, HRV_ROLLING, logByDate).length,
    baselineCount: window(end, HRV_BASELINE, logByDate).length,
    ready: status !== null,
  }
}

// ---------------------------------------------------------------------------
// D. Load, monotony, zones, regularity, social jetlag.
// ---------------------------------------------------------------------------
export function monotony(allDays: DailyStats[], end: string) {
  const week = (endDate: string) => {
    const strains = daysThrough(allDays, endDate, 7)
      .map((day) => day.strain)
      .filter(isNumber)
    const load = strains.reduce((sum, value) => sum + value, 0)
    const sd = sampleSd(strains)
    const value =
      strains.length >= 5 && sd !== null && sd > 0
        ? average(strains)! / sd
        : null
    return {
      days: strains.length,
      load,
      monotony: value,
      trainingStrain: value === null ? null : load * value,
    }
  }
  return { current: week(end), previous: week(shiftDate(end, -7)) }
}
export function monotonyLabel(value: number | null) {
  if (value === null) return 'Not enough days'
  return value < 1.5 ? 'Varied' : value < 2 ? 'Fairly even' : 'Monotonous'
}

export function zoneTotals(workouts: WhoopRecord[]) {
  const totals = Array.from({ length: 6 }, () => 0)
  let sessions = 0
  for (const workout of workouts) {
    const { zones, total } = workoutZones(workout)
    if (!total) continue
    sessions++
    zones.forEach((zone) => {
      totals[zone.index] += zone.milliseconds ?? 0
    })
  }
  const total = totals.reduce((sum, value) => sum + value, 0)
  const hours = totals.map((value) => value / 3_600_000)
  const share = (indices: number[]) =>
    total ? indices.reduce((sum, i) => sum + totals[i], 0) / total : null
  return {
    sessions,
    hours,
    totalHours: total / 3_600_000,
    easy: share([0, 1, 2]),
    moderate: share([3]),
    hard: share([4, 5]),
  }
}

export function regularity(days: DailyStats[]) {
  const { nights } = sleepTiming(days)
  const bedtimes = nights.map((night) => night.bed)
  const centre = median(bedtimes)
  const within = (minutes: number) =>
    centre === null
      ? null
      : bedtimes.filter((bed) => Math.abs(bed - centre) <= minutes).length /
        bedtimes.length
  return {
    nights: nights.length,
    medianBedtime: centre,
    within30: within(30),
    within60: within(60),
  }
}

export const MIN_WEEKEND_NIGHTS = 4
export function socialJetlag(days: DailyStats[]) {
  const { nights } = sleepTiming(days)
  const midSleep = (night: { bed: number; wake: number }) =>
    (night.bed + night.wake) / 2
  const weekend = nights.filter((night) => isWeekend(night.date))
  const weekday = nights.filter((night) => !isWeekend(night.date))
  const weekendMid = average(weekend.map(midSleep))
  const weekdayMid = average(weekday.map(midSleep))
  return {
    weekendNights: weekend.length,
    weekdayNights: weekday.length,
    weekendMid,
    weekdayMid,
    shift:
      weekendMid !== null && weekdayMid !== null
        ? weekendMid - weekdayMid
        : null,
    ready: weekend.length >= MIN_WEEKEND_NIGHTS && weekday.length >= 8,
  }
}

export function weekendVersusWeekday(days: DailyStats[]) {
  const pick = (weekend: boolean, key: 'recovery' | 'sleepHours' | 'strain') =>
    days
      .filter((day) => isWeekend(day.date) === weekend)
      .map((day) => day[key])
      .filter(isNumber)
  const metric = (
    key: 'recovery' | 'sleepHours' | 'strain',
    label: string,
  ) => ({
    key,
    label,
    weekend: average(pick(true, key)),
    weekday: average(pick(false, key)),
    weekendCount: pick(true, key).length,
    weekdayCount: pick(false, key).length,
  })
  return [
    metric('recovery', 'Recovery'),
    metric('sleepHours', 'Time asleep'),
    metric('strain', 'Strain'),
  ]
}

// ---------------------------------------------------------------------------
// E. Further descriptive views.
// ---------------------------------------------------------------------------
export function balanceSeries(allDays: DailyStats[], days: DailyStats[]) {
  return days.map((day) => {
    const balance = sleepBalance(allDays, day.date)
    return {
      date: day.date,
      hours: balance.count ? balance.hours : null,
      nights: balance.count,
    }
  })
}

export const MIN_EPISODES = 3
export function bounceBack(days: DailyStats[]) {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date))
  const episodes: { start: string; days: number; recovered: string }[] = []
  let censored = 0
  for (let i = 0; i < sorted.length; i++) {
    const day = sorted[i]
    if (day.recovery == null || day.recovery >= 34) continue
    let found = false
    for (let j = i + 1; j < sorted.length; j++) {
      const later = sorted[j]
      if (later.recovery != null && later.recovery >= 67) {
        const gap = Math.round(
          (new Date(`${later.date}T12:00:00Z`).getTime() -
            new Date(`${day.date}T12:00:00Z`).getTime()) /
            86_400_000,
        )
        episodes.push({ start: day.date, days: gap, recovered: later.date })
        found = true
        break
      }
    }
    if (!found) censored++
  }
  return {
    episodes,
    censored,
    median: median(episodes.map((episode) => episode.days)),
    ready: episodes.length >= MIN_EPISODES,
  }
}

export function sleepArchitecture(
  allDays: DailyStats[],
  end: string,
  days: DailyStats[],
) {
  const recent = daysThrough(allDays, end, 7)
  const share = (
    day: DailyStats,
    part: 'deepHours' | 'remHours' | 'lightHours',
  ) =>
    day.sleepHours && day[part] != null
      ? (day[part]! / day.sleepHours) * 100
      : null
  const metrics = [
    {
      key: 'deep',
      label: 'Deep sleep share',
      unit: '%',
      value: (d: DailyStats) => share(d, 'deepHours'),
    },
    {
      key: 'rem',
      label: 'REM share',
      unit: '%',
      value: (d: DailyStats) => share(d, 'remHours'),
    },
    {
      key: 'light',
      label: 'Light share',
      unit: '%',
      value: (d: DailyStats) => share(d, 'lightHours'),
    },
    {
      key: 'awake',
      label: 'Awake in bed',
      unit: 'min',
      value: (d: DailyStats) =>
        d.awakeHours == null ? null : d.awakeHours * 60,
    },
    {
      key: 'disturbances',
      label: 'Disturbances',
      unit: '',
      value: (d: DailyStats) => d.disturbanceCount,
    },
    {
      key: 'efficiency',
      label: 'Sleep efficiency',
      unit: '%',
      value: (d: DailyStats) => d.sleepEfficiency,
    },
    {
      key: 'cycles',
      label: 'Sleep cycles',
      unit: '',
      value: (d: DailyStats) => d.sleepCycleCount,
    },
  ]
  return metrics.map((metric) => {
    const recentValues = recent.map(metric.value).filter(isNumber)
    const periodValues = days.map(metric.value).filter(isNumber)
    return {
      key: metric.key,
      label: metric.label,
      unit: metric.unit,
      recent: average(recentValues),
      recentCount: recentValues.length,
      period: average(periodValues),
      periodCount: periodValues.length,
    }
  })
}

export const MIN_GROUP = 5
function compareGroups<T>(
  items: T[],
  split: (item: T) => boolean | null,
  outcomes: { key: string; label: string; value: (item: T) => number | null }[],
  minimum = MIN_GROUP,
) {
  const withFlag = items
    .map((item) => ({ item, flag: split(item) }))
    .filter((entry): entry is { item: T; flag: boolean } => entry.flag !== null)
  const yes = withFlag.filter((entry) => entry.flag).map((entry) => entry.item)
  const no = withFlag.filter((entry) => !entry.flag).map((entry) => entry.item)
  return {
    yesCount: yes.length,
    noCount: no.length,
    ready: yes.length >= minimum && no.length >= minimum,
    outcomes: outcomes.map((outcome) => ({
      key: outcome.key,
      label: outcome.label,
      yes: average(yes.map(outcome.value).filter(isNumber)),
      no: average(no.map(outcome.value).filter(isNumber)),
    })),
  }
}

export function napEffect(
  allDays: DailyStats[],
  days: DailyStats[],
  records: StoredRecord[],
) {
  const byDate = byDateMap(allDays)
  const next = (day: DailyStats) => byDate.get(shiftDate(day.date, 1))
  return compareGroups(
    days.filter((day) => next(day)),
    (day) => napsOnDate(records, day.date).length > 0,
    [
      {
        key: 'recovery',
        label: 'Next-morning recovery',
        value: (d) => next(d)?.recovery ?? null,
      },
      {
        key: 'sleep',
        label: 'Time asleep that night',
        value: (d) => next(d)?.sleepHours ?? null,
      },
      {
        key: 'need',
        label: 'Sleep need that night',
        value: (d) => next(d)?.sleepNeededHours ?? null,
      },
    ],
  )
}

export const EVENING_MINUTES = 19 * 60
export function eveningSessions(
  allDays: DailyStats[],
  days: DailyStats[],
  workouts: WhoopRecord[],
) {
  const byDate = byDateMap(allDays)
  const next = (day: DailyStats) => byDate.get(shiftDate(day.date, 1))
  const sessionsOn = new Map<string, WhoopRecord[]>()
  for (const workout of workouts) {
    const date = workoutDate(workout)
    if (date) sessionsOn.set(date, [...(sessionsOn.get(date) ?? []), workout])
  }
  return compareGroups(
    days.filter((day) => next(day) && sessionsOn.get(day.date)?.length),
    (day) =>
      sessionsOn
        .get(day.date)!
        .some(
          (workout) =>
            workout.end &&
            localMinutes(workout.end, workout.timezone_offset) >=
              EVENING_MINUTES,
        ),
    [
      {
        key: 'efficiency',
        label: 'Sleep efficiency that night',
        value: (d) => next(d)?.sleepEfficiency ?? null,
      },
      {
        key: 'performance',
        label: 'Sleep performance that night',
        value: (d) => next(d)?.sleepPerformance ?? null,
      },
      {
        key: 'recovery',
        label: 'Next-morning recovery',
        value: (d) => next(d)?.recovery ?? null,
      },
    ],
  )
}

export function stability(allDays: DailyStats[], end: string, range: number) {
  const current = daysThrough(allDays, end, range)
  const previous = daysThrough(allDays, shiftDate(end, -range), range)
  const metric = (
    key: 'recovery' | 'hrv' | 'rhr' | 'sleepHours',
    label: string,
    relative: boolean,
  ) => {
    const spread = (list: DailyStats[]) => {
      const values = list.map((day) => day[key]).filter(isNumber)
      const sd = sampleSd(values)
      return {
        count: values.length,
        value:
          sd === null ? null : relative ? (sd / average(values)!) * 100 : sd,
      }
    }
    return {
      key,
      label,
      relative,
      current: spread(current),
      previous: spread(previous),
    }
  }
  return [
    metric('recovery', 'Recovery', false),
    metric('hrv', 'HRV', true),
    metric('rhr', 'Resting heart rate', false),
    metric('sleepHours', 'Time asleep', false),
  ]
}

export function highlights(days: DailyStats[], workouts: WhoopRecord[]) {
  const best = (
    key: 'recovery' | 'hrv' | 'sleepHours' | 'strain',
    pick: 'max' | 'min',
  ) => {
    const scored = days.filter((day) => isNumber(day[key]))
    if (!scored.length) return null
    return scored.reduce((champion, day) =>
      pick === 'max'
        ? day[key]! > champion[key]!
          ? day
          : champion
        : day[key]! < champion[key]!
          ? day
          : champion,
    )
  }
  const lowestRhr = (() => {
    const scored = days.filter((day) => isNumber(day.rhr))
    return scored.length
      ? scored.reduce((a, b) => (b.rhr! < a.rhr! ? b : a))
      : null
  })()
  const hardest = workouts
    .filter(
      (workout) =>
        workout.score_state === 'SCORED' && isNumber(workout.score?.strain),
    )
    .reduce<WhoopRecord | null>(
      (a, b) => (!a || b.score!.strain! > a.score!.strain! ? b : a),
      null,
    )
  const longest = workouts.reduce<WhoopRecord | null>(
    (a, b) => (!a || (workoutHours(b) ?? 0) > (workoutHours(a) ?? 0) ? b : a),
    null,
  )
  return {
    highestRecovery: best('recovery', 'max'),
    highestHrv: best('hrv', 'max'),
    lowestRhr,
    longestSleep: best('sleepHours', 'max'),
    hardestDay: best('strain', 'max'),
    hardestWorkout: hardest,
    longestWorkout: longest,
  }
}

export const MIN_MONTH_DAYS = 20
export function monthAgainstMonth(allDays: DailyStats[], end: string) {
  const recent = daysThrough(allDays, end, 30)
  const previous = daysThrough(allDays, shiftDate(end, -30), 30)
  const metric = (
    key:
      'recovery' | 'hrv' | 'rhr' | 'sleepHours' | 'strain' | 'respiratoryRate',
    label: string,
    better: 'up' | 'down' | 'neutral',
  ) => {
    const values = (list: DailyStats[]) =>
      list.map((day) => day[key]).filter(isNumber)
    return {
      key,
      label,
      better,
      recent: median(values(recent)),
      previous: median(values(previous)),
      recentCount: values(recent).length,
      previousCount: values(previous).length,
    }
  }
  const metrics = [
    metric('recovery', 'Recovery', 'up'),
    metric('hrv', 'HRV', 'up'),
    metric('rhr', 'Resting heart rate', 'down'),
    metric('sleepHours', 'Time asleep', 'up'),
    metric('strain', 'Strain', 'neutral'),
    metric('respiratoryRate', 'Respiratory rate', 'neutral'),
  ]
  return {
    recentStart: shiftDate(end, -29),
    previousStart: shiftDate(end, -59),
    previousEnd: shiftDate(end, -30),
    metrics,
    ready: metrics.some(
      (m) =>
        m.recentCount >= MIN_MONTH_DAYS && m.previousCount >= MIN_MONTH_DAYS,
    ),
  }
}

export function coverage(
  days: DailyStats[],
  records: StoredRecord[],
  end: string,
  range: number,
) {
  const dates = new Set(days.map((day) => day.date))
  let missing = 0
  for (let i = 0; i < range; i++) if (!dates.has(shiftDate(end, -i))) missing++
  const inRange = (record: StoredRecord) => {
    const stamp = record.data.end ?? record.data.start
    if (!stamp) return false
    const date = localDate(stamp, record.data.timezone_offset)
    return date > shiftDate(end, -range) && date <= end
  }
  const sleeps = records.filter((r) => r.kind === 'sleep' && inRange(r))
  return {
    expected: range,
    days: days.length,
    missing,
    recoveryScored: days.filter((day) => day.recovery != null).length,
    recoveryPending: days.filter((day) => day.recoveryState === 'PENDING_SCORE')
      .length,
    calibrating: days.filter((day) => day.recoveryCalibrating).length,
    sleepScored: days.filter((day) => day.sleepHours != null).length,
    unscorableSleeps: sleeps.filter((r) => r.data.score_state === 'UNSCORABLE')
      .length,
    naps: sleeps.filter((r) => r.data.nap).length,
    workouts: records.filter((r) => r.kind === 'workout' && inRange(r)).length,
    hrvDays: days.filter((day) => day.hrv != null).length,
    spo2Days: days.filter((day) => day.spo2 != null).length,
  }
}

export const MIN_SPORT_SESSIONS = 4
export function morningAfterBySport(
  allDays: DailyStats[],
  workouts: WhoopRecord[],
) {
  const byDate = byDateMap(allDays)
  const groups = new Map<string, { recovery: number[]; sleep: number[] }>()
  for (const workout of workouts) {
    const date = workoutDate(workout)
    if (!date) continue
    const sport = (workout.sport_name ?? 'Workout').replaceAll('_', ' ')
    const next = byDate.get(shiftDate(date, 1))
    const group = groups.get(sport) ?? { recovery: [], sleep: [] }
    if (isNumber(next?.recovery)) group.recovery.push(next.recovery)
    if (isNumber(next?.sleepPerformance))
      group.sleep.push(next.sleepPerformance)
    groups.set(sport, group)
  }
  const rows = [...groups]
    .map(([sport, group]) => ({
      sport,
      sessions: group.recovery.length,
      recovery: average(group.recovery),
      sleepPerformance: average(group.sleep),
    }))
    .filter((row) => row.sessions >= MIN_SPORT_SESSIONS)
    .sort((a, b) => (b.recovery ?? 0) - (a.recovery ?? 0))
  return { rows, ready: rows.length >= 2 }
}

export const HARD_STRAIN = 14
export function hardDaySequences(allDays: DailyStats[], days: DailyStats[]) {
  const byDate = byDateMap(allDays)
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date))
  const isHard = (day: DailyStats | undefined) =>
    day?.strain != null && day.strain >= HARD_STRAIN
  const afterRuns: number[] = []
  const afterSingles: number[] = []
  let runLength = 0
  for (const day of sorted) {
    const previousHard = isHard(byDate.get(shiftDate(day.date, -1)))
    if (isHard(day)) {
      runLength = previousHard ? runLength + 1 : 1
      continue
    }
    if (previousHard && runLength > 0) {
      if (day.recovery != null)
        (runLength >= 2 ? afterRuns : afterSingles).push(day.recovery)
    }
    runLength = 0
  }
  return {
    afterRuns: { count: afterRuns.length, recovery: average(afterRuns) },
    afterSingles: {
      count: afterSingles.length,
      recovery: average(afterSingles),
    },
    ready: afterRuns.length >= 4 && afterSingles.length >= 4,
  }
}
