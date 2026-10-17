export type RecordKind = 'cycle' | 'recovery' | 'sleep' | 'workout'
export interface WhoopRecord {
  id?: string | number
  cycle_id?: number
  sleep_id?: string
  start?: string
  end?: string | null
  created_at?: string
  updated_at?: string
  timezone_offset?: string
  score_state?: 'SCORED' | 'PENDING_SCORE' | 'UNSCORABLE'
  nap?: boolean
  sport_name?: string
  sport_id?: number
  score?: {
    recovery_score?: number
    resting_heart_rate?: number
    hrv_rmssd_milli?: number
    spo2_percentage?: number
    skin_temp_celsius?: number
    user_calibrating?: boolean
    strain?: number
    kilojoule?: number
    average_heart_rate?: number
    max_heart_rate?: number
    sleep_performance_percentage?: number
    sleep_efficiency_percentage?: number
    sleep_consistency_percentage?: number
    respiratory_rate?: number
    distance_meter?: number
    altitude_gain_meter?: number
    altitude_change_meter?: number
    percent_recorded?: number
    stage_summary?: {
      total_in_bed_time_milli?: number
      total_awake_time_milli?: number
      total_no_data_time_milli?: number
      total_light_sleep_time_milli?: number
      total_slow_wave_sleep_time_milli?: number
      total_rem_sleep_time_milli?: number
      disturbance_count?: number
      sleep_cycle_count?: number
    }
    sleep_needed?: {
      baseline_milli?: number
      need_from_sleep_debt_milli?: number
      need_from_recent_strain_milli?: number
      need_from_recent_nap_milli?: number
    }
    zone_durations?: Record<string, number>
  } | null
}

export interface StoredRecord {
  kind: RecordKind
  data: WhoopRecord
}
export interface DashboardData {
  user: { firstName: string; lastName: string; email: string }
  syncedAt: string | null
  syncing: boolean
  syncError: string | null
  needsReconnect: boolean
  records: StoredRecord[]
}

export interface DailyStats {
  date: string
  cycleId: string
  recovery: number | null
  strain: number | null
  hrv: number | null
  rhr: number | null
  sleepHours: number | null
  sleepPerformance: number | null
  sleepEfficiency: number | null
  sleepConsistency: number | null
  sleepNeededHours: number | null
  remHours: number | null
  deepHours: number | null
  lightHours: number | null
  awakeHours: number | null
  spo2: number | null
  skinTemp: number | null
  respiratoryRate: number | null
  calories: number | null
  recoveryState: string
  sleepStart: string | null
  sleepEnd: string | null
  timezoneOffset: string
  recoveryCalibrating: boolean
  sleepState: string
  sleepBaselineHours: number | null
  sleepDebtHours: number | null
  sleepStrainHours: number | null
  sleepNapCreditHours: number | null
  inBedHours: number | null
  noDataHours: number | null
  disturbanceCount: number | null
  sleepCycleCount: number | null
  averageHeartRate: number | null
  maxHeartRate: number | null
}

const numeric = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
const hours = (value: unknown) => {
  const n = numeric(value)
  return n === null ? null : n / 3_600_000
}

// Minutes east of UTC for a WHOOP offset such as "+02:00".
export function offsetMinutes(offset = '+00:00') {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset)
  return match
    ? (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '-' ? -1 : 1)
    : 0
}
const shiftedToLocal = (iso: string, offset?: string) =>
  new Date(new Date(iso).getTime() + offsetMinutes(offset) * 60_000)

// Use the recorded offset, not the browser's timezone or UTC midnight.
export function localDate(iso: string, offset = '+00:00'): string {
  return shiftedToLocal(iso, offset).toISOString().slice(0, 10)
}

// Wall-clock time in the recorded timezone, e.g. "11:42 PM".
export function localTime(iso: string, offset = '+00:00'): string {
  return shiftedToLocal(iso, offset).toLocaleTimeString('en', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  })
}

// Minutes since local midnight in the recorded timezone.
export function localMinutes(iso: string, offset = '+00:00'): number {
  const local = shiftedToLocal(iso, offset)
  return local.getUTCHours() * 60 + local.getUTCMinutes()
}

export function buildDailyStats(records: StoredRecord[]): DailyStats[] {
  const recoveries = new Map(
    records
      .filter((r) => r.kind === 'recovery')
      .map((r) => [String(r.data.cycle_id), r.data]),
  )
  const sleeps = new Map(
    records
      .filter((r) => r.kind === 'sleep')
      .map((r) => [String(r.data.id), r.data]),
  )
  return records
    .filter((r) => r.kind === 'cycle' && r.data.start)
    .map(({ data: cycle }) => {
      const recovery = recoveries.get(String(cycle.id))
      const linkedSleep = recovery?.sleep_id
        ? sleeps.get(recovery.sleep_id)
        : undefined
      const sleep =
        linkedSleep && !linkedSleep.nap
          ? linkedSleep
          : records.find(
              (r) =>
                r.kind === 'sleep' &&
                !r.data.nap &&
                String(r.data.cycle_id) === String(cycle.id),
            )?.data
      const r = recovery?.score_state === 'SCORED' ? recovery.score : null
      const s = sleep?.score_state === 'SCORED' ? sleep.score : null
      const c = cycle.score_state === 'SCORED' ? cycle.score : null
      const stages = s?.stage_summary
      const needed = s?.sleep_needed
      const light = numeric(stages?.total_light_sleep_time_milli)
      const deep = numeric(stages?.total_slow_wave_sleep_time_milli)
      const rem = numeric(stages?.total_rem_sleep_time_milli)
      return {
        // WHOOP starts a cycle with its main sleep. Label it by wake-up date
        // so last night's sleep and today's recovery stay together.
        date: localDate(
          sleep?.end ?? cycle.start!,
          sleep?.timezone_offset ?? cycle.timezone_offset,
        ),
        cycleId: String(cycle.id),
        recovery: numeric(r?.recovery_score),
        strain: numeric(c?.strain),
        hrv: numeric(r?.hrv_rmssd_milli),
        rhr: numeric(r?.resting_heart_rate),
        sleepHours:
          light !== null && deep !== null && rem !== null
            ? (light + deep + rem) / 3_600_000
            : null,
        sleepPerformance: numeric(s?.sleep_performance_percentage),
        sleepEfficiency: numeric(s?.sleep_efficiency_percentage),
        sleepConsistency: numeric(s?.sleep_consistency_percentage),
        sleepNeededHours:
          needed && typeof needed.baseline_milli === 'number'
            ? (needed.baseline_milli +
                (needed.need_from_sleep_debt_milli ?? 0) +
                (needed.need_from_recent_strain_milli ?? 0) +
                (needed.need_from_recent_nap_milli ?? 0)) /
              3_600_000
            : null,
        remHours: hours(rem),
        deepHours: hours(deep),
        lightHours: hours(light),
        awakeHours: hours(stages?.total_awake_time_milli),
        spo2: numeric(r?.spo2_percentage),
        skinTemp: numeric(r?.skin_temp_celsius),
        respiratoryRate: numeric(s?.respiratory_rate),
        calories: numeric(c?.kilojoule) === null ? null : c!.kilojoule! / 4.184,
        recoveryState: recovery?.score_state ?? 'PENDING_SCORE',
        recoveryCalibrating: r?.user_calibrating === true,
        sleepState: sleep?.score_state ?? 'PENDING_SCORE',
        sleepBaselineHours: hours(needed?.baseline_milli),
        sleepDebtHours: hours(needed?.need_from_sleep_debt_milli),
        sleepStrainHours: hours(needed?.need_from_recent_strain_milli),
        sleepNapCreditHours: hours(needed?.need_from_recent_nap_milli),
        inBedHours: hours(stages?.total_in_bed_time_milli),
        noDataHours: hours(stages?.total_no_data_time_milli),
        disturbanceCount: numeric(stages?.disturbance_count),
        sleepCycleCount: numeric(stages?.sleep_cycle_count),
        averageHeartRate: numeric(c?.average_heart_rate),
        maxHeartRate: numeric(c?.max_heart_rate),
        sleepStart: sleep?.start ?? null,
        sleepEnd: sleep?.end ?? null,
        timezoneOffset: cycle.timezone_offset ?? '+00:00',
      }
    })
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) || a.cycleId.localeCompare(b.cycleId),
    )
}

export function mean(values: Array<number | null | undefined>) {
  const valid = values.filter(
    (value): value is number =>
      typeof value === 'number' && Number.isFinite(value),
  )
  return valid.length
    ? valid.reduce((sum, value) => sum + value, 0) / valid.length
    : null
}

export function duration(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—'
  const minutes = Math.round(value * 60)
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

export function shiftDate(date: string, amount: number) {
  const shifted = new Date(`${date}T12:00:00Z`)
  shifted.setUTCDate(shifted.getUTCDate() + amount)
  return shifted.toISOString().slice(0, 10)
}

export function daysThrough(days: DailyStats[], end: string, count: number) {
  const start = shiftDate(end, 1 - count)
  return days.filter((day) => day.date >= start && day.date <= end)
}

export function sleepDuration(record: WhoopRecord) {
  if (record.score_state !== 'SCORED') return null
  const stages = record.score?.stage_summary
  const values = [
    stages?.total_light_sleep_time_milli,
    stages?.total_slow_wave_sleep_time_milli,
    stages?.total_rem_sleep_time_milli,
  ]
  return values.every((value) => numeric(value) !== null)
    ? (values as number[]).reduce((sum, value) => sum + value, 0) / 3_600_000
    : null
}

export function napsOnDate(records: StoredRecord[], date: string) {
  return records
    .filter(
      ({ kind, data }) =>
        kind === 'sleep' &&
        data.nap &&
        (data.end || data.start) &&
        localDate((data.end ?? data.start)!, data.timezone_offset) === date,
    )
    .map(({ data }) => data)
    .sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''))
}

export function workoutZones(workout: WhoopRecord) {
  const names = ['zero', 'one', 'two', 'three', 'four', 'five']
  const labels = [
    'Very light',
    'Light',
    'Moderate',
    'Hard',
    'Very hard',
    'Maximum',
  ]
  const raw =
    workout.score_state === 'SCORED' ? workout.score?.zone_durations : undefined
  const zones = names.map((name, index) => {
    const value = numeric(raw?.[`zone_${name}_milli`])
    return {
      index,
      label: labels[index],
      milliseconds: value !== null && value >= 0 ? value : null,
    }
  })
  const total = zones.reduce((sum, zone) => sum + (zone.milliseconds ?? 0), 0)
  return {
    total,
    zones,
    complete: zones.every((zone) => zone.milliseconds !== null),
  }
}
