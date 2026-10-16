// FORM's MCP server: a small, read-mostly tool surface over the same data and
// insight code the dashboard uses. Kept free of server-only imports so it can
// be exercised in tests with demo data over an in-memory transport.
//
// Design rules (MCP best practice, and keeping an agent's context lean):
// - Eight tools with verb_noun names, one job each, defaults that do the
//   common thing, hard caps on row counts, and an explicit `fields` picker.
// - Every tool returns compact, rounded JSON as both `structuredContent`
//   (validated by an output schema) and a single text block, never prose.
// - Descriptions carry units and semantics once; the server `instructions`
//   carry the data model once; nothing is repeated per row.
// - Tools are annotated read-only/idempotent except `sync_now`.
import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  buildDailyStats,
  daysThrough,
  localDate,
  localTime,
  napsOnDate,
  shiftDate,
  sleepDuration,
  workoutZones,
  type DailyStats,
  type DashboardData,
  type StoredRecord,
  type WhoopRecord,
} from './whoop'
import {
  healthMetrics,
  personalBaseline,
  reading,
  readingStatus,
  statusLabels,
} from './health'
import {
  byWeekday,
  clockFromNight,
  loadLabel,
  recoveryByPriorStrain,
  recoveryBySleepNeed,
  recoveryMix,
  sleepBalance,
  sleepTiming,
  sportBreakdown,
  streak,
  trainingLoad,
  volume,
  weekInReview,
  workoutHours,
  workoutsThrough,
} from './insights'
import {
  bounceBack,
  coverage,
  eveningSessions,
  hardDaySequences,
  highlights,
  hrvReadiness,
  monotony,
  monotonyLabel,
  monthAgainstMonth,
  morningAfterBySport,
  napEffect,
  regularity,
  relationships,
  sleepArchitecture,
  socialJetlag,
  stability,
  unusualNights,
  weekendVersusWeekday,
  zoneTotals,
} from './analysis'

export const MCP_SERVER_NAME = 'form-whoop'
export const MCP_SERVER_VERSION = '1.0.0'

export interface McpDataSource {
  /** Everything the dashboard would load for the connected account, or null when nobody is connected. */
  load: () => Promise<DashboardData | null>
  /** Start the same 90-day reconcile the dashboard runs. May throw an Error whose `message` is a WHOOP error code. */
  sync: () => Promise<{ syncing: boolean }>
}

// ---------------------------------------------------------------------------
// Compaction helpers: round, drop nulls the reader can infer, keep keys short.
// ---------------------------------------------------------------------------
const r = (value: number | null | undefined, decimals = 0) =>
  value == null || !Number.isFinite(value)
    ? null
    : Number(value.toFixed(decimals))
const zone = (score: number | null) =>
  score == null ? null : score >= 67 ? 'high' : score >= 34 ? 'moderate' : 'low'
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .describe('Physiological day (YYYY-MM-DD), labelled by wake-up date')
const rangeSchema = z
  .union([z.literal(7), z.literal(30), z.literal(90)])
  .default(30)
  .describe('Window length in days ending on `end`')

export const DAY_FIELDS = [
  'recovery',
  'strain',
  'calories',
  'hrv',
  'rhr',
  'respiratoryRate',
  'spo2',
  'skinTemp',
  'sleepHours',
  'sleepNeededHours',
  'sleepPerformance',
  'sleepEfficiency',
  'sleepConsistency',
  'deepHours',
  'remHours',
  'lightHours',
  'awakeHours',
  'disturbances',
  'bedtime',
  'wake',
] as const
type DayField = (typeof DAY_FIELDS)[number]
const DEFAULT_FIELDS: DayField[] = [
  'recovery',
  'strain',
  'sleepHours',
  'hrv',
  'rhr',
]

function dayField(day: DailyStats, field: DayField) {
  switch (field) {
    case 'recovery':
      return r(day.recovery)
    case 'strain':
      return r(day.strain, 1)
    case 'calories':
      return r(day.calories)
    case 'hrv':
      return r(day.hrv, 1)
    case 'rhr':
      return r(day.rhr)
    case 'respiratoryRate':
      return r(day.respiratoryRate, 1)
    case 'spo2':
      return r(day.spo2, 1)
    case 'skinTemp':
      return r(day.skinTemp, 1)
    case 'sleepHours':
      return r(day.sleepHours, 2)
    case 'sleepNeededHours':
      return r(day.sleepNeededHours, 2)
    case 'sleepPerformance':
      return r(day.sleepPerformance)
    case 'sleepEfficiency':
      return r(day.sleepEfficiency, 1)
    case 'sleepConsistency':
      return r(day.sleepConsistency)
    case 'deepHours':
      return r(day.deepHours, 2)
    case 'remHours':
      return r(day.remHours, 2)
    case 'lightHours':
      return r(day.lightHours, 2)
    case 'awakeHours':
      return r(day.awakeHours, 2)
    case 'disturbances':
      return day.disturbanceCount
    case 'bedtime':
      return day.sleepStart
        ? localTime(day.sleepStart, day.timezoneOffset)
        : null
    case 'wake':
      return day.sleepEnd ? localTime(day.sleepEnd, day.timezoneOffset) : null
  }
}

function compactDay(day: DailyStats) {
  return {
    date: day.date,
    timezone: day.timezoneOffset,
    recovery: r(day.recovery),
    recoveryZone: zone(day.recovery),
    strain: r(day.strain, 1),
    calories: r(day.calories),
    hrv: r(day.hrv, 1),
    rhr: r(day.rhr),
    respiratoryRate: r(day.respiratoryRate, 1),
    spo2: r(day.spo2, 1),
    skinTemp: r(day.skinTemp, 1),
    sleep: {
      hours: r(day.sleepHours, 2),
      neededHours: r(day.sleepNeededHours, 2),
      performance: r(day.sleepPerformance),
      efficiency: r(day.sleepEfficiency, 1),
      consistency: r(day.sleepConsistency),
      deepHours: r(day.deepHours, 2),
      remHours: r(day.remHours, 2),
      lightHours: r(day.lightHours, 2),
      awakeHours: r(day.awakeHours, 2),
      inBedHours: r(day.inBedHours, 2),
      disturbances: day.disturbanceCount,
      cycles: day.sleepCycleCount,
      bedtime: day.sleepStart
        ? localTime(day.sleepStart, day.timezoneOffset)
        : null,
      wake: day.sleepEnd ? localTime(day.sleepEnd, day.timezoneOffset) : null,
      need: {
        baselineHours: r(day.sleepBaselineHours, 2),
        debtHours: r(day.sleepDebtHours, 2),
        strainHours: r(day.sleepStrainHours, 2),
        napCreditHours: r(day.sleepNapCreditHours, 2),
      },
    },
    dailyHeartRate: {
      average: r(day.averageHeartRate),
      max: r(day.maxHeartRate),
    },
    states: {
      recovery: day.recoveryState,
      sleep: day.sleepState,
      calibrating: day.recoveryCalibrating,
    },
  }
}

function compactWorkout(workout: WhoopRecord) {
  const score = workout.score_state === 'SCORED' ? workout.score : null
  const hours = workoutHours(workout)
  return {
    id: String(workout.id),
    date: workout.start
      ? localDate(workout.start, workout.timezone_offset)
      : null,
    start: workout.start
      ? localTime(workout.start, workout.timezone_offset)
      : null,
    sport: (workout.sport_name ?? 'workout').replaceAll('_', ' '),
    durationMin: hours == null ? null : Math.round(hours * 60),
    strain: r(score?.strain, 1),
    averageHr: r(score?.average_heart_rate),
    maxHr: r(score?.max_heart_rate),
    calories:
      score?.kilojoule == null ? null : Math.round(score.kilojoule / 4.184),
    distanceKm:
      score?.distance_meter == null ? null : r(score.distance_meter / 1000, 2),
    scored: workout.score_state ?? null,
  }
}

function text(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    structuredContent: data as Record<string, unknown>,
  }
}
function failure(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true as const,
  }
}

// ---------------------------------------------------------------------------
interface Loaded {
  data: DashboardData
  days: DailyStats[]
  workouts: WhoopRecord[]
  latest: DailyStats
}

async function loadOrFail(
  source: McpDataSource,
): Promise<Loaded | ReturnType<typeof failure>> {
  const data = await source.load()
  if (!data)
    return failure(
      'No WHOOP account is connected to this dashboard yet. Open the dashboard and use Connect WHOOP.',
    )
  const days = buildDailyStats(data.records)
  const latest = days.at(-1)
  if (!latest)
    return failure(
      data.syncing
        ? 'The first sync is still running. Try again in a minute.'
        : 'No days have been synced yet. Call sync_now, then try again.',
    )
  const workouts = data.records
    .filter((record) => record.kind === 'workout' && record.data.start)
    .map((record) => record.data)
    .sort((a, b) => (b.start ?? '').localeCompare(a.start ?? ''))
  return { data, days, workouts, latest }
}
const isFailure = (value: unknown): value is ReturnType<typeof failure> =>
  typeof value === 'object' && value !== null && 'isError' in value

function resolveEnd(loaded: Loaded, end?: string) {
  if (!end) return loaded.latest.date
  return end > loaded.latest.date ? loaded.latest.date : end
}

function statusPayload(loaded: Loaded) {
  const { data, days, latest, workouts } = loaded
  const first = days[0]
  return {
    user: { firstName: data.user.firstName, lastName: data.user.lastName },
    syncedAt: data.syncedAt,
    syncing: data.syncing,
    syncError: data.syncError,
    needsReconnect: data.needsReconnect,
    dataSpan: { first: first.date, latest: latest.date, days: days.length },
    workouts: workouts.length,
    timezone: latest.timezoneOffset,
    latest: {
      date: latest.date,
      recovery: r(latest.recovery),
      recoveryZone: zone(latest.recovery),
      strain: r(latest.strain, 1),
      sleepHours: r(latest.sleepHours, 2),
      hrv: r(latest.hrv, 1),
      rhr: r(latest.rhr),
    },
  }
}

function healthPayload(days: DailyStats[], day: DailyStats) {
  return healthMetrics.map((metric) => {
    const baseline = personalBaseline(days, day.date, metric.key)
    const status = readingStatus(day, metric.key, baseline)
    const value = reading(day, metric.key)
    return {
      metric: metric.key,
      unit: metric.unit,
      value: r(value, metric.decimals),
      status,
      statusLabel: statusLabels[status],
      median: r(baseline.median, metric.decimals),
      range: baseline.ready
        ? [r(baseline.low, metric.decimals), r(baseline.high, metric.decimals)]
        : null,
      priorDays: baseline.count,
    }
  })
}

// ---------------------------------------------------------------------------
export function createFormServer(source: McpDataSource) {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      instructions: [
        'FORM exposes one person’s WHOOP data (up to the last 90 days) and the dashboard’s own descriptive insights.',
        'Data model: a "physiological day" starts with the main sleep and is labelled by its wake-up date (YYYY-MM-DD in the recorded timezone). Recovery 0–100% (high ≥67, low <34), strain 0–21 (nonlinear), HRV in ms (RMSSD), resting HR in bpm, sleep in hours, energy in kcal.',
        'Missing values are null and never zero. Pending or unscorable WHOOP records stay null.',
        'Insights are descriptive statistics over this person’s own days with stated sample sizes; they are not diagnoses or training prescriptions. Prefer get_insights with a `topics` filter to keep responses small.',
        'Start with get_status. Use get_day for one day, list_days for tables, get_trends for period summaries, get_insights for analysis. sync_now is the only tool that changes anything.',
      ].join('\n'),
    },
  )

  // ---- get_status -----------------------------------------------------------
  server.registerTool(
    'get_status',
    {
      title: 'Connection and data status',
      description:
        'Whether a WHOOP account is connected, when it last synced, the span of days available, and the latest day’s headline numbers. Call this first.',
      inputSchema: {},
      outputSchema: {
        user: z.object({ firstName: z.string(), lastName: z.string() }),
        syncedAt: z.string().nullable(),
        syncing: z.boolean(),
        syncError: z.string().nullable(),
        needsReconnect: z.boolean(),
        dataSpan: z.object({
          first: z.string(),
          latest: z.string(),
          days: z.number(),
        }),
        workouts: z.number(),
        timezone: z.string(),
        latest: z.record(z.string(), z.unknown()),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const loaded = await loadOrFail(source)
      if (isFailure(loaded)) return loaded
      return text(statusPayload(loaded))
    },
  )

  // ---- get_day --------------------------------------------------------------
  server.registerTool(
    'get_day',
    {
      title: 'One physiological day',
      description:
        'Every metric for one day: recovery, strain, energy, HRV, resting HR, respiratory rate, SpO₂, skin temperature, the main sleep (stages, need breakdown, bedtime and wake in local time), plus optional workouts, naps, and Health Monitor comparisons against the preceding 30 days. Defaults to the latest day.',
      inputSchema: {
        date: dateSchema.optional(),
        include: z
          .array(z.enum(['workouts', 'naps', 'health']))
          .default(['workouts', 'naps', 'health'])
          .describe('Sections to attach; omit ones you do not need'),
      },
      outputSchema: {
        day: z.record(z.string(), z.unknown()),
        previousDate: z.string().nullable(),
        nextDate: z.string().nullable(),
        workouts: z.array(z.record(z.string(), z.unknown())).optional(),
        naps: z.array(z.record(z.string(), z.unknown())).optional(),
        health: z.array(z.record(z.string(), z.unknown())).optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ date, include }) => {
      const loaded = await loadOrFail(source)
      if (isFailure(loaded)) return loaded
      const { days, workouts, data } = loaded
      const index = date
        ? days.findIndex((day) => day.date === date)
        : days.length - 1
      if (index < 0)
        return failure(
          `No physiological day ${date}. Available: ${days[0].date} to ${loaded.latest.date}; use list_days to see which dates exist.`,
        )
      const day = days[index]
      const payload: Record<string, unknown> = {
        day: compactDay(day),
        previousDate: days[index - 1]?.date ?? null,
        nextDate: days[index + 1]?.date ?? null,
      }
      if (include.includes('workouts'))
        payload.workouts = workouts
          .filter((w) => localDate(w.start!, w.timezone_offset) === day.date)
          .map(compactWorkout)
      if (include.includes('naps'))
        payload.naps = napsOnDate(data.records, day.date).map((nap) => ({
          start: nap.start ? localTime(nap.start, nap.timezone_offset) : null,
          end: nap.end ? localTime(nap.end, nap.timezone_offset) : null,
          asleepHours: r(sleepDuration(nap), 2),
          scored: nap.score_state ?? null,
        }))
      if (include.includes('health')) payload.health = healthPayload(days, day)
      return text(payload)
    },
  )

  // ---- list_days ------------------------------------------------------------
  server.registerTool(
    'list_days',
    {
      title: 'Table of days',
      description:
        'Compact rows for a window of days, newest first, with only the fields you ask for. Default: the last 30 days with recovery, strain, sleepHours, hrv, rhr. Max 90 rows. Hours are decimal (7.5 = 7h 30m).',
      inputSchema: {
        end: dateSchema
          .optional()
          .describe('Last day to include; default latest'),
        days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .default(30)
          .describe('How many days back from `end`'),
        fields: z
          .array(z.enum(DAY_FIELDS))
          .min(1)
          .max(12)
          .default(DEFAULT_FIELDS),
      },
      outputSchema: {
        start: z.string(),
        end: z.string(),
        count: z.number(),
        fields: z.array(z.string()),
        rows: z.array(z.record(z.string(), z.unknown())),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ end, days: count, fields }) => {
      const loaded = await loadOrFail(source)
      if (isFailure(loaded)) return loaded
      const last = resolveEnd(loaded, end)
      const window = daysThrough(loaded.days, last, count)
      const rows = [...window].reverse().map((day) => {
        const row: Record<string, unknown> = { date: day.date }
        for (const field of fields) row[field] = dayField(day, field)
        return row
      })
      return text({
        start: shiftDate(last, 1 - count),
        end: last,
        count: rows.length,
        fields,
        rows,
      })
    },
  )

  // ---- list_workouts --------------------------------------------------------
  server.registerTool(
    'list_workouts',
    {
      title: 'List workouts',
      description:
        'Workouts in a window, newest first, one compact row each (sport, local start, duration, strain, heart rate, energy, distance). Paginate with `cursor`. Use get_workout for zones and elevation.',
      inputSchema: {
        end: dateSchema
          .optional()
          .describe('Last day to include; default latest'),
        days: z.number().int().min(1).max(90).default(30),
        sport: z
          .string()
          .optional()
          .describe('Case-insensitive substring filter, e.g. "run"'),
        limit: z.number().int().min(1).max(50).default(20),
        cursor: z
          .string()
          .optional()
          .describe('Opaque cursor from a previous page'),
      },
      outputSchema: {
        count: z.number(),
        total: z.number(),
        rows: z.array(z.record(z.string(), z.unknown())),
        nextCursor: z.string().nullable(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ end, days: count, sport, limit, cursor }) => {
      const loaded = await loadOrFail(source)
      if (isFailure(loaded)) return loaded
      const last = resolveEnd(loaded, end)
      let rows = workoutsThrough(loaded.workouts, last, count)
      if (sport) {
        const needle = sport.toLowerCase()
        rows = rows.filter((w) =>
          (w.sport_name ?? 'workout')
            .replaceAll('_', ' ')
            .toLowerCase()
            .includes(needle),
        )
      }
      const offset = cursor ? Number.parseInt(cursor, 10) || 0 : 0
      const page = rows.slice(offset, offset + limit)
      return text({
        count: page.length,
        total: rows.length,
        rows: page.map(compactWorkout),
        nextCursor:
          offset + limit < rows.length ? String(offset + limit) : null,
      })
    },
  )

  // ---- get_workout ----------------------------------------------------------
  server.registerTool(
    'get_workout',
    {
      title: 'One workout in detail',
      description:
        'Full details for one workout by id: summary row plus minutes in each of WHOOP’s six heart-rate zones, elevation, share of the session with heart-rate data, and the next morning’s recovery.',
      inputSchema: {
        id: z.string().describe('Workout id from list_workouts or get_day'),
      },
      outputSchema: {
        workout: z.record(z.string(), z.unknown()),
        zonesMin: z.array(z.number().nullable()),
        zonesRecordedMin: z.number(),
        elevationGainM: z.number().nullable(),
        elevationChangeM: z.number().nullable(),
        percentRecorded: z.number().nullable(),
        nextMorning: z.record(z.string(), z.unknown()).nullable(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      const loaded = await loadOrFail(source)
      if (isFailure(loaded)) return loaded
      const workout = loaded.workouts.find((w) => String(w.id) === id)
      if (!workout)
        return failure(
          `No workout with id ${id}. Use list_workouts to find ids.`,
        )
      const zones = workoutZones(workout)
      const score = workout.score_state === 'SCORED' ? workout.score : null
      const date = localDate(workout.start!, workout.timezone_offset)
      const next = loaded.days.find((day) => day.date === shiftDate(date, 1))
      return text({
        workout: compactWorkout(workout),
        zonesMin: zones.zones.map((z) =>
          z.milliseconds == null ? null : Math.round(z.milliseconds / 60_000),
        ),
        zonesRecordedMin: Math.round(zones.total / 60_000),
        elevationGainM: r(score?.altitude_gain_meter),
        elevationChangeM: r(score?.altitude_change_meter),
        percentRecorded: r(score?.percent_recorded, 1),
        nextMorning: next
          ? {
              date: next.date,
              recovery: r(next.recovery),
              hrv: r(next.hrv, 1),
              rhr: r(next.rhr),
              sleepPerformance: r(next.sleepPerformance),
            }
          : null,
      })
    },
  )

  // ---- get_trends -----------------------------------------------------------
  server.registerTool(
    'get_trends',
    {
      title: 'Period summary',
      description:
        'Averages over a 7/30/90-day window ending on `end`, this week against the week before, this month against the month before (medians), recovery zone mix and current high-recovery streak, 7-day vs 28-day training load, and weekday averages.',
      inputSchema: { end: dateSchema.optional(), range: rangeSchema },
      outputSchema: {
        window: z.object({
          start: z.string(),
          end: z.string(),
          days: z.number(),
        }),
        averages: z.record(z.string(), z.unknown()),
        weekInReview: z.record(z.string(), z.unknown()),
        monthAgainstMonth: z.record(z.string(), z.unknown()),
        recoveryMix: z.record(z.string(), z.unknown()),
        trainingLoad: z.record(z.string(), z.unknown()),
        weekdays: z.record(z.string(), z.unknown()),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ end, range }) => {
      const loaded = await loadOrFail(source)
      if (isFailure(loaded)) return loaded
      const last = resolveEnd(loaded, end)
      const window = daysThrough(loaded.days, last, range)
      const avg = (key: keyof DailyStats, decimals = 0) => {
        const values = window
          .map((day) => day[key])
          .filter((v): v is number => typeof v === 'number')
        return values.length
          ? r(values.reduce((a, b) => a + b, 0) / values.length, decimals)
          : null
      }
      const week = weekInReview(loaded.days, last)
      const month = monthAgainstMonth(loaded.days, last)
      const load = trainingLoad(loaded.days, last)
      const high = streak(loaded.days, last, (day) => (day.recovery ?? 0) >= 67)
      const decimals = (key: string) =>
        key === 'sleepHours' ? 2 : key === 'strain' || key === 'hrv' ? 1 : 0
      return text({
        window: {
          start: shiftDate(last, 1 - range),
          end: last,
          days: window.length,
        },
        averages: {
          recovery: avg('recovery'),
          strain: avg('strain', 1),
          sleepHours: avg('sleepHours', 2),
          sleepNeededHours: avg('sleepNeededHours', 2),
          hrv: avg('hrv', 1),
          rhr: avg('rhr'),
          respiratoryRate: avg('respiratoryRate', 1),
          calories: avg('calories'),
        },
        weekInReview: Object.fromEntries(
          week.metrics.map((m) => [
            m.key,
            {
              thisWeek: r(m.current, decimals(m.key)),
              weekBefore: r(m.previous, decimals(m.key)),
              days: [m.currentCount, m.previousCount],
              better: m.better,
            },
          ]),
        ),
        monthAgainstMonth: {
          ready: month.ready,
          ...Object.fromEntries(
            month.metrics.map((m) => [
              m.key,
              {
                recentMedian: r(m.recent, decimals(m.key)),
                priorMedian: r(m.previous, decimals(m.key)),
                days: [m.recentCount, m.previousCount],
              },
            ]),
          ),
        },
        recoveryMix: { ...recoveryMix(window), highStreak: high },
        trainingLoad: {
          sevenDay: r(load.acute, 1),
          twentyEightDay: r(load.chronic, 1),
          ratio: r(load.ratio, 2),
          label: loadLabel(load.ratio),
          thisWeek: (() => {
            const v = volume(workoutsThrough(loaded.workouts, last, 7))
            return {
              sessions: v.sessions,
              hours: r(v.hours, 2),
              calories: r(v.calories),
              averageStrain: r(v.strain, 1),
            }
          })(),
        },
        weekdays: Object.fromEntries(
          (['recovery', 'strain', 'sleepHours'] as const).map((key) => [
            key,
            byWeekday(window, key).map((item) => ({
              day: item.label,
              n: item.count,
              average: r(item.average, decimals(key)),
            })),
          ]),
        ),
      })
    },
  )

  // ---- get_insights ---------------------------------------------------------
  const topics = [
    'relationships',
    'unusual_nights',
    'hrv_readiness',
    'stability',
    'recovery_drivers',
    'bounce_back',
    'hard_days',
    'sleep_timing',
    'sleep_balance',
    'sleep_architecture',
    'naps',
    'monotony',
    'zones',
    'by_sport',
    'evening_sessions',
    'highlights',
    'coverage',
  ] as const
  server.registerTool(
    'get_insights',
    {
      title: 'Descriptive insights',
      description:
        'The dashboard’s Insights tab as data. Each topic reports its sample size and a `ready` flag; when not ready it says what it needs. Ask for specific `topics` to keep the response small. Topics: ' +
        topics.join(', ') +
        '.',
      inputSchema: {
        end: dateSchema.optional(),
        range: rangeSchema,
        topics: z
          .array(z.enum(topics))
          .min(1)
          .optional()
          .describe('Default: all topics'),
      },
      outputSchema: {
        window: z.object({
          start: z.string(),
          end: z.string(),
          days: z.number(),
        }),
        caveat: z.string(),
        topics: z.record(z.string(), z.unknown()),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ end, range, topics: wanted }) => {
      const loaded = await loadOrFail(source)
      if (isFailure(loaded)) return loaded
      const { days: all, workouts: allWorkouts, data } = loaded
      const last = resolveEnd(loaded, end)
      const days = daysThrough(all, last, range)
      const workouts = workoutsThrough(allWorkouts, last, range)
      const selected = new Set(wanted ?? topics)
      const out: Record<string, unknown> = {}
      if (selected.has('relationships'))
        out.relationships = relationships(all, days).map((x) => ({
          factor: x.factor,
          outcome: x.outcome,
          rho: r(x.rho, 2),
          interval95: [r(x.interval[0], 2), r(x.interval[1], 2)],
          n: x.n,
          strength: x.strength,
          clear: x.clear,
          reading: x.reading,
        }))
      if (selected.has('unusual_nights')) {
        const u = unusualNights(all, days)
        out.unusual_nights = {
          checked: u.evaluated,
          building: u.building,
          nights: u.nights.map((n) => ({
            date: n.date,
            signals: n.signals.map((s) => ({
              signal: s.key,
              value: r(s.value, 1),
              usual: r(s.median, 1),
              robustZ: r(s.z, 1),
            })),
          })),
        }
      }
      if (selected.has('hrv_readiness')) {
        const h = hrvReadiness(all, last, range)
        out.hrv_readiness = {
          ready: h.ready,
          status: h.status,
          sevenDayGeometricMeanMs: r(h.latest.value),
          bandMs: h.ready ? [r(h.latest.low), r(h.latest.high)] : null,
          baselineMeanMs: r(h.latest.median),
          sevenDayCvPercent: r(h.cv, 1),
          daysUsed: { rolling: h.rollingCount, baseline: h.baselineCount },
        }
      }
      if (selected.has('stability'))
        out.stability = stability(all, last, range).map((s) => ({
          metric: s.key,
          measure: s.relative ? 'cv%' : 'sd',
          current: r(s.current.value, 1),
          previous: r(s.previous.value, 1),
          days: [s.current.count, s.previous.count],
        }))
      if (selected.has('recovery_drivers'))
        out.recovery_drivers = {
          bySleepNeed: recoveryBySleepNeed(days).map((b) => ({
            group: b.label,
            days: b.count,
            averageRecovery: r(b.average),
          })),
          byPriorStrain: recoveryByPriorStrain(all, days).map((b) => ({
            group: b.label,
            days: b.count,
            averageRecovery: r(b.average),
          })),
          minimumDaysPerGroup: 3,
        }
      if (selected.has('bounce_back')) {
        const b = bounceBack(days)
        out.bounce_back = {
          ready: b.ready,
          medianDays: b.median,
          episodes: b.episodes,
          unresolved: b.censored,
        }
      }
      if (selected.has('hard_days')) {
        const h = hardDaySequences(all, days)
        out.hard_days = {
          ready: h.ready,
          afterRuns: {
            mornings: h.afterRuns.count,
            averageRecovery: r(h.afterRuns.recovery),
          },
          afterSingle: {
            mornings: h.afterSingles.count,
            averageRecovery: r(h.afterSingles.recovery),
          },
        }
      }
      if (selected.has('sleep_timing')) {
        const t = sleepTiming(days)
        const reg = regularity(days)
        const jet = socialJetlag(days)
        out.sleep_timing = {
          nights: t.nights.length,
          averageBedtime: t.bedtime == null ? null : clockFromNight(t.bedtime),
          bedtimeSpreadMin: r(t.bedtimeSpread),
          averageWake: t.wake == null ? null : clockFromNight(t.wake),
          wakeSpreadMin: r(t.wakeSpread),
          bedtimeWithin30MinOfMedian: r(
            reg.within30 == null ? null : reg.within30 * 100,
          ),
          bedtimeWithin60MinOfMedian: r(
            reg.within60 == null ? null : reg.within60 * 100,
          ),
          socialJetlagMin: jet.ready ? r(jet.shift) : null,
          weekendNights: jet.weekendNights,
          weekendVsWeekday: weekendVersusWeekday(days).map((w) => ({
            metric: w.key,
            weekend: r(w.weekend, w.key === 'sleepHours' ? 2 : 1),
            weekday: r(w.weekday, w.key === 'sleepHours' ? 2 : 1),
            days: [w.weekendCount, w.weekdayCount],
          })),
        }
      }
      if (selected.has('sleep_balance')) {
        const balance = sleepBalance(all, last)
        out.sleep_balance = {
          last7NightsVsNeedHours: r(balance.hours, 2),
          nights: balance.count,
        }
      }
      if (selected.has('sleep_architecture'))
        out.sleep_architecture = sleepArchitecture(all, last, days).map(
          (s) => ({
            measure: s.key,
            unit: s.unit,
            last7: r(s.recent, 1),
            period: r(s.period, 1),
            nights: [s.recentCount, s.periodCount],
          }),
        )
      if (selected.has('naps')) {
        const n = napEffect(all, days, data.records)
        out.naps = {
          ready: n.ready,
          napDays: n.yesCount,
          napFreeDays: n.noCount,
          outcomes: n.outcomes.map((o) => ({
            outcome: o.key,
            withNap: r(o.yes, 2),
            without: r(o.no, 2),
          })),
        }
      }
      if (selected.has('monotony')) {
        const m = monotony(all, last)
        const week = (w: typeof m.current) => ({
          days: w.days,
          load: r(w.load, 1),
          monotony: r(w.monotony, 2),
          label: monotonyLabel(w.monotony),
          trainingStrain: r(w.trainingStrain),
        })
        out.monotony = {
          thisWeek: week(m.current),
          weekBefore: week(m.previous),
        }
      }
      if (selected.has('zones')) {
        const z = zoneTotals(workouts)
        out.zones = {
          sessions: z.sessions,
          hoursByZone: z.hours.map((h) => r(h, 2)),
          easyShare: r(z.easy == null ? null : z.easy * 100),
          moderateShare: r(z.moderate == null ? null : z.moderate * 100),
          hardShare: r(z.hard == null ? null : z.hard * 100),
        }
      }
      if (selected.has('by_sport')) {
        const m = morningAfterBySport(all, workouts)
        out.by_sport = {
          breakdown: sportBreakdown(workouts).map((s) => ({
            sport: s.sport,
            sessions: s.sessions,
            hours: r(s.hours, 2),
            averageStrain: r(s.strain, 1),
            calories: r(s.calories),
          })),
          morningAfter: {
            ready: m.ready,
            rows: m.rows.map((row) => ({
              sport: row.sport,
              sessions: row.sessions,
              recovery: r(row.recovery),
              sleepPerformance: r(row.sleepPerformance),
            })),
          },
        }
      }
      if (selected.has('evening_sessions')) {
        const e = eveningSessions(all, days, workouts)
        out.evening_sessions = {
          ready: e.ready,
          eveningDays: e.yesCount,
          earlierDays: e.noCount,
          outcomes: e.outcomes.map((o) => ({
            outcome: o.key,
            evening: r(o.yes, 1),
            earlier: r(o.no, 1),
          })),
        }
      }
      if (selected.has('highlights')) {
        const h = highlights(days, workouts)
        out.highlights = {
          highestRecovery: h.highestRecovery
            ? {
                date: h.highestRecovery.date,
                value: r(h.highestRecovery.recovery),
              }
            : null,
          highestHrv: h.highestHrv
            ? { date: h.highestHrv.date, value: r(h.highestHrv.hrv, 1) }
            : null,
          lowestRhr: h.lowestRhr
            ? { date: h.lowestRhr.date, value: r(h.lowestRhr.rhr) }
            : null,
          longestSleep: h.longestSleep
            ? {
                date: h.longestSleep.date,
                hours: r(h.longestSleep.sleepHours, 2),
              }
            : null,
          hardestDay: h.hardestDay
            ? { date: h.hardestDay.date, strain: r(h.hardestDay.strain, 1) }
            : null,
          hardestWorkout: h.hardestWorkout
            ? compactWorkout(h.hardestWorkout)
            : null,
          longestWorkout: h.longestWorkout
            ? compactWorkout(h.longestWorkout)
            : null,
        }
      }
      if (selected.has('coverage'))
        out.coverage = coverage(days, data.records, last, range)
      return text({
        window: {
          start: shiftDate(last, 1 - range),
          end: last,
          days: days.length,
        },
        caveat:
          'Descriptive statistics over this person’s own days. Not a diagnosis, prediction, or training plan.',
        topics: out,
      })
    },
  )

  // ---- sync_now -------------------------------------------------------------
  server.registerTool(
    'sync_now',
    {
      title: 'Sync from WHOOP',
      description:
        'Start the same 90-day reconcile the dashboard runs. Returns immediately; a sync takes about a minute. Poll get_status until `syncing` is false. WHOOP rate-limits, so do not call this more than once every few minutes.',
      inputSchema: {},
      outputSchema: {
        started: z.boolean(),
        syncing: z.boolean(),
        note: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const data = await source.load()
      if (!data)
        return failure('No WHOOP account is connected to this dashboard yet.')
      if (data.needsReconnect)
        return failure(
          'The WHOOP connection needs to be renewed in the dashboard before syncing.',
        )
      if (data.syncing)
        return text({
          started: false,
          syncing: true,
          note: 'A sync is already running.',
        })
      try {
        const result = await source.sync()
        return text({
          started: true,
          syncing: result.syncing,
          note: result.syncing
            ? 'Sync started; poll get_status.'
            : 'Sync finished.',
        })
      } catch (error) {
        const code = error instanceof Error ? error.message : 'sync_failed'
        return failure(
          code === 'rate_limited'
            ? 'WHOOP rate limit reached. Try again in a few minutes.'
            : code === 'reconnect_required'
              ? 'WHOOP rejected the stored credentials; reconnect in the dashboard.'
              : `Sync did not finish (${code}). Previously synced data is still available.`,
        )
      }
    },
  )

  // ---- resources & prompt ---------------------------------------------------
  server.registerResource(
    'status',
    'whoop://status',
    {
      title: 'Connection and data status',
      description: 'Same as get_status.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const loaded = await loadOrFail(source)
      const body = isFailure(loaded)
        ? { error: loaded.content[0].text }
        : statusPayload(loaded)
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(body),
          },
        ],
      }
    },
  )
  server.registerResource(
    'day',
    new ResourceTemplate('whoop://days/{date}', { list: undefined }),
    {
      title: 'One physiological day',
      description:
        'Metrics for a day (YYYY-MM-DD); same as get_day without workouts, naps, or health.',
      mimeType: 'application/json',
    },
    async (uri, { date }) => {
      const loaded = await loadOrFail(source)
      const day = isFailure(loaded)
        ? undefined
        : loaded.days.find((d) => d.date === String(date))
      const body = isFailure(loaded)
        ? { error: loaded.content[0].text }
        : day
          ? compactDay(day)
          : { error: `No day ${String(date)}` }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(body),
          },
        ],
      }
    },
  )
  server.registerPrompt(
    'weekly_review',
    {
      title: 'Weekly review',
      description:
        'Ask for a short, honest review of the last week against the week before.',
      argsSchema: {
        end: z
          .string()
          .optional()
          .describe('Last day (YYYY-MM-DD); default latest'),
      },
    },
    ({ end }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Review my last 7 days${end ? ` ending ${end}` : ''} using FORM.`,
              'Call get_trends (range 7) and get_insights with topics unusual_nights, hrv_readiness, sleep_timing, monotony.',
              'Write at most 150 words: what moved against the week before, one thing that stood out, and one thing worth keeping. Quote numbers with units. If a panel is not ready, say so instead of guessing. No diagnoses, no training prescriptions.',
            ].join(' '),
          },
        },
      ],
    }),
  )

  return server
}

export type { StoredRecord }
