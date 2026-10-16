// Descriptive insights computed from the user's own days. Everything here is
// a plain average, count, or spread over recorded WHOOP data. Nothing is a
// prediction, a target, or a medical assessment.
import {
  daysThrough,
  localDate,
  localMinutes,
  mean,
  shiftDate,
  type DailyStats,
  type WhoopRecord,
} from './whoop'

export type Direction = 'up' | 'down' | 'neutral'

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

export function standardDeviation(values: number[]) {
  if (values.length < 2) return null
  const average = values.reduce((sum, value) => sum + value, 0) / values.length
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      (values.length - 1),
  )
}

// ---------------------------------------------------------------------------
// Week in review: 7 days through the selected day against the 7 before.
// ---------------------------------------------------------------------------
export type MetricKey = 'recovery' | 'sleepHours' | 'strain' | 'hrv' | 'rhr'
export interface WeekMetric {
  key: MetricKey
  label: string
  better: Direction
  current: number | null
  previous: number | null
  currentCount: number
  previousCount: number
}

export function weekInReview(days: DailyStats[], end: string) {
  const current = daysThrough(days, end, 7)
  const previous = daysThrough(days, shiftDate(end, -7), 7)
  const metric = (
    key: MetricKey,
    label: string,
    better: Direction,
  ): WeekMetric => ({
    key,
    label,
    better,
    current: mean(current.map((day) => day[key])),
    previous: mean(previous.map((day) => day[key])),
    currentCount: current.filter((day) => day[key] != null).length,
    previousCount: previous.filter((day) => day[key] != null).length,
  })
  return {
    start: shiftDate(end, -6),
    end,
    previousStart: shiftDate(end, -13),
    previousEnd: shiftDate(end, -7),
    metrics: [
      metric('recovery', 'Recovery', 'up'),
      metric('sleepHours', 'Time asleep', 'up'),
      metric('strain', 'Strain', 'neutral'),
      metric('hrv', 'HRV', 'up'),
      metric('rhr', 'Resting heart rate', 'down'),
    ],
  }
}

// ---------------------------------------------------------------------------
// Recovery mix: how the range's days fell across WHOOP's recovery zones.
// ---------------------------------------------------------------------------
export function recoveryMix(days: DailyStats[]) {
  const scored = days.filter((day) => day.recovery != null)
  const high = scored.filter((day) => day.recovery! >= 67).length
  const low = scored.filter((day) => day.recovery! < 34).length
  return {
    high,
    moderate: scored.length - high - low,
    low,
    unscored: days.length - scored.length,
    scored: scored.length,
    total: days.length,
  }
}

// ---------------------------------------------------------------------------
// Recovery drivers: average recovery grouped by the night or day before it.
// ---------------------------------------------------------------------------
export const MIN_BUCKET_DAYS = 3
export interface Bucket {
  label: string
  detail: string
  count: number
  average: number | null
}

function bucketize<T>(
  items: T[],
  definitions: { label: string; detail: string; test: (item: T) => boolean }[],
  value: (item: T) => number,
): Bucket[] {
  return definitions.map((definition) => {
    const members = items.filter(definition.test)
    return {
      label: definition.label,
      detail: definition.detail,
      count: members.length,
      average: mean(members.map(value)),
    }
  })
}

export const enoughVariety = (buckets: Bucket[]) =>
  buckets.filter((bucket) => bucket.count >= MIN_BUCKET_DAYS).length >= 2

// The sleep that opens a cycle precedes that cycle's recovery score.
export function recoveryBySleepNeed(days: DailyStats[]) {
  const nights = days.filter(
    (day) =>
      day.recovery != null &&
      day.sleepHours != null &&
      isNumber(day.sleepNeededHours) &&
      day.sleepNeededHours > 0,
  )
  const ratio = (day: DailyStats) => day.sleepHours! / day.sleepNeededHours!
  return bucketize(
    nights,
    [
      {
        label: 'Met sleep need',
        detail: '95% of need or more',
        test: (day) => ratio(day) >= 0.95,
      },
      {
        label: 'Slightly short',
        detail: '80–95% of need',
        test: (day) => ratio(day) >= 0.8 && ratio(day) < 0.95,
      },
      {
        label: 'Well short',
        detail: 'Under 80% of need',
        test: (day) => ratio(day) < 0.8,
      },
    ],
    (day) => day.recovery!,
  )
}

export function recoveryByPriorStrain(
  allDays: DailyStats[],
  days: DailyStats[],
) {
  const byDate = new Map(allDays.map((day) => [day.date, day]))
  const pairs = days.flatMap((day) => {
    const previous = byDate.get(shiftDate(day.date, -1))
    return day.recovery != null && previous?.strain != null
      ? [{ recovery: day.recovery, strain: previous.strain }]
      : []
  })
  return bucketize(
    pairs,
    [
      {
        label: 'After a light day',
        detail: 'Strain under 10',
        test: (pair) => pair.strain < 10,
      },
      {
        label: 'After a moderate day',
        detail: 'Strain 10–14',
        test: (pair) => pair.strain >= 10 && pair.strain < 14,
      },
      {
        label: 'After a hard day',
        detail: 'Strain 14 or more',
        test: (pair) => pair.strain >= 14,
      },
    ],
    (pair) => pair.recovery,
  )
}

// ---------------------------------------------------------------------------
// Sleep timing: bedtime and wake time on a clock that starts at 6 PM so a
// bedtime after midnight still sorts after one before it.
// ---------------------------------------------------------------------------
export const NIGHT_START = 18 * 60

export interface Night {
  date: string
  bed: number // minutes after 6 PM
  wake: number // minutes after 6 PM, always after `bed`
  sleepHours: number | null
}

export function sleepTiming(days: DailyStats[]) {
  const nights: Night[] = days.flatMap((day) => {
    if (!day.sleepStart || !day.sleepEnd) return []
    const bedClock = localMinutes(day.sleepStart, day.timezoneOffset)
    const wakeClock = localMinutes(day.sleepEnd, day.timezoneOffset)
    const bed = (bedClock - NIGHT_START + 1440) % 1440
    const wake = bed + ((wakeClock - bedClock + 1440) % 1440)
    return [{ date: day.date, bed, wake, sleepHours: day.sleepHours }]
  })
  const bedtimes = nights.map((night) => night.bed)
  const wakes = nights.map((night) => night.wake)
  return {
    nights,
    bedtime: mean(bedtimes),
    wake: mean(wakes),
    bedtimeSpread: standardDeviation(bedtimes),
    wakeSpread: standardDeviation(wakes),
  }
}

export function clockFromNight(minutesAfterSix: number) {
  const minutes =
    (((Math.round(minutesAfterSix) + NIGHT_START) % 1440) + 1440) % 1440
  const hours = Math.floor(minutes / 60)
  return `${((hours + 11) % 12) + 1}:${String(minutes % 60).padStart(2, '0')} ${hours >= 12 ? 'PM' : 'AM'}`
}

export function sleepBalance(days: DailyStats[], end: string, nights = 7) {
  const recent = daysThrough(days, end, nights).filter(
    (day) => day.sleepHours != null && day.sleepNeededHours != null,
  )
  return {
    count: recent.length,
    hours: recent.reduce(
      (sum, day) => sum + day.sleepHours! - day.sleepNeededHours!,
      0,
    ),
  }
}

// ---------------------------------------------------------------------------
// Training load and volume.
// ---------------------------------------------------------------------------
export function trainingLoad(allDays: DailyStats[], end: string) {
  const acute = daysThrough(allDays, end, 7)
    .map((day) => day.strain)
    .filter(isNumber)
  const chronic = daysThrough(allDays, end, 28)
    .map((day) => day.strain)
    .filter(isNumber)
  const acuteAverage = mean(acute)
  const chronicAverage = mean(chronic)
  const ratio =
    acuteAverage != null &&
    chronicAverage != null &&
    chronicAverage > 0 &&
    chronic.length >= 14
      ? acuteAverage / chronicAverage
      : null
  return {
    acute: acuteAverage,
    acuteCount: acute.length,
    chronic: chronicAverage,
    chronicCount: chronic.length,
    ratio,
  }
}

export function loadLabel(ratio: number | null) {
  if (ratio == null) return 'Building history'
  if (ratio > 1.15) return 'Ramping up'
  if (ratio < 0.85) return 'Backing off'
  return 'Steady'
}

export function workoutHours(workout: WhoopRecord) {
  if (!workout.start || !workout.end) return null
  const elapsed =
    new Date(workout.end).getTime() - new Date(workout.start).getTime()
  return elapsed >= 0 ? elapsed / 3_600_000 : null
}

export function workoutsThrough(
  workouts: WhoopRecord[],
  end: string,
  count: number,
) {
  const start = shiftDate(end, 1 - count)
  return workouts.filter((workout) => {
    if (!workout.start) return false
    const date = localDate(workout.start, workout.timezone_offset)
    return date >= start && date <= end
  })
}

export function volume(workouts: WhoopRecord[]) {
  const scored = workouts.filter((workout) => workout.score_state === 'SCORED')
  const kilojoules = scored
    .map((workout) => workout.score?.kilojoule)
    .filter(isNumber)
  return {
    sessions: workouts.length,
    hours: workouts
      .map(workoutHours)
      .filter(isNumber)
      .reduce((sum, hours) => sum + hours, 0),
    calories: kilojoules.length
      ? kilojoules.reduce((sum, kj) => sum + kj, 0) / 4.184
      : null,
    strain: mean(scored.map((workout) => workout.score?.strain)),
  }
}

export function sportBreakdown(workouts: WhoopRecord[]) {
  const groups = new Map<string, WhoopRecord[]>()
  for (const workout of workouts) {
    const sport = (workout.sport_name ?? 'Workout').replaceAll('_', ' ')
    groups.set(sport, [...(groups.get(sport) ?? []), workout])
  }
  return [...groups]
    .map(([sport, members]) => ({ sport, ...volume(members) }))
    .sort((a, b) => b.hours - a.hours || b.sessions - a.sessions)
}

// ---------------------------------------------------------------------------
// Weekday pattern and streaks.
// ---------------------------------------------------------------------------
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const weekdayIndex = (date: string) =>
  (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7

export function byWeekday(days: DailyStats[], key: MetricKey) {
  return WEEKDAYS.map((label, index) => {
    const members = days.filter(
      (day) => weekdayIndex(day.date) === index && day[key] != null,
    )
    return {
      label,
      count: members.length,
      average: mean(members.map((day) => day[key])),
    }
  })
}

// A streak counts consecutive calendar days; a missing day breaks it.
export function streak(
  days: DailyStats[],
  end: string,
  test: (day: DailyStats) => boolean,
) {
  const byDate = new Map(days.map((day) => [day.date, day]))
  let current = 0
  for (let date = end; ; date = shiftDate(date, -1)) {
    const day = byDate.get(date)
    if (!day || !test(day)) break
    current++
  }
  let longest = 0
  let run = 0
  let previous: string | null = null
  for (const day of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
    run =
      test(day) && (previous === null || shiftDate(previous, 1) === day.date)
        ? run + 1
        : test(day)
          ? 1
          : 0
    longest = Math.max(longest, run)
    previous = day.date
  }
  return { current, longest }
}
