// Deterministic WHOOP v2 fixture: the records the fake WHOOP API serves, and the dashboard's goldens are computed from.
// Run `node extensions/whoop/test/fixtures/generate.mjs` to rewrite whoop-fixture.json (commit the result).
//
// Coverage on purpose: a few days before 2026-08-25 (outside the default history), a timezone change (a trip to
// -04:00), calibrating first days, naps (scored, pending, unscorable), a pending and an unscorable recovery, a cycle
// without a recovery, a day without SpO2/skin temperature, workouts of several sports (some in the evening, some with
// distance, one pending, one unscorable, one without zone durations), and today's cycle still open.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const FIXTURE_NOW = "2026-10-16T12:00:00.000Z";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FIRST = Date.parse("2026-08-20T00:00:00Z");
const LAST = Date.parse("2026-10-16T00:00:00Z");
const USER = 21_337;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260825);
const between = (lo, hi) => lo + (hi - lo) * rand();
const round = (v, d) => Number(v.toFixed(d));
const iso = (t) => new Date(t).toISOString();
const hex = (n, len) => n.toString(16).padStart(len, "0");
const uuid = (kind, i) => `${hex(kind, 8)}-${hex(i % 0xffff, 4)}-4${hex(i, 3)}-8${hex(kind % 0xfff, 3)}-${hex(i * 7919, 12)}`;

const SPORTS = [
  ["running", 0],
  ["weightlifting", 45],
  ["cycling", 1],
  ["functional_fitness", 48],
  ["yoga", 44],
];

function offsetFor(day) {
  // A trip: 2026-10-05 to 2026-10-08 at -04:00, else +02:00.
  return day >= Date.parse("2026-10-05T00:00:00Z") && day <= Date.parse("2026-10-08T00:00:00Z") ? "-04:00" : "+02:00";
}
const offsetMs = (o) => (o.startsWith("-") ? -1 : 1) * (Number(o.slice(1, 3)) * 60 + Number(o.slice(4, 6))) * 60_000;

export function generate() {
  const cycles = [];
  const sleeps = [];
  const recoveries = [];
  const workouts = [];
  let n = 0;
  for (let day = FIRST; day <= LAST; day += DAY) {
    n++;
    const tz = offsetFor(day);
    const off = offsetMs(tz);
    const isToday = day === LAST;
    // Local wake 06:00–08:00, so UTC = local - offset.
    const wake = day + between(6, 8) * HOUR - off;
    const asleepH = between(5.6, 8.9);
    const awakeH = between(0.3, 0.9);
    const inBed = (asleepH + awakeH) * HOUR;
    const bedtime = wake - inBed;
    const cycleId = 1_200_000 + n;
    const sleepId = uuid(0x51ee9, n);
    const updated = iso(wake + 40 * 60_000);
    const nextWake = day + DAY + 7 * HOUR - offsetMs(offsetFor(day + DAY));
    const strain = round(between(4, 19.5), 6);
    cycles.push({
      id: cycleId,
      user_id: USER,
      created_at: iso(wake + 5 * 60_000),
      updated_at: updated,
      start: iso(wake - inBed),
      end: isToday ? null : iso(nextWake - inBed),
      timezone_offset: tz,
      score_state: "SCORED",
      score: { strain: isToday ? round(strain / 3, 6) : strain, kilojoule: round(between(7000, 14000), 4), average_heart_rate: Math.round(between(58, 78)), max_heart_rate: Math.round(between(140, 192)) },
    });
    const light = asleepH * between(0.45, 0.55) * HOUR;
    const deep = asleepH * between(0.15, 0.25) * HOUR;
    const rem = asleepH * HOUR - light - deep;
    const sleepPending = n === 56; // one main sleep still pending
    sleeps.push({
      id: sleepId,
      cycle_id: cycleId,
      v1_id: null,
      user_id: USER,
      created_at: iso(wake + 2 * 60_000),
      updated_at: updated,
      start: iso(bedtime),
      end: iso(wake),
      timezone_offset: tz,
      nap: false,
      score_state: sleepPending ? "PENDING_SCORE" : "SCORED",
      ...(sleepPending
        ? {}
        : {
            score: {
              stage_summary: {
                total_in_bed_time_milli: Math.round(inBed),
                total_awake_time_milli: Math.round(awakeH * HOUR),
                total_no_data_time_milli: n % 9 === 0 ? 600_000 : 0,
                total_light_sleep_time_milli: Math.round(light),
                total_slow_wave_sleep_time_milli: Math.round(deep),
                total_rem_sleep_time_milli: Math.round(rem),
                sleep_cycle_count: Math.round(between(3, 6)),
                disturbance_count: Math.round(between(0, 14)),
              },
              sleep_needed: {
                baseline_milli: Math.round(7.6 * HOUR),
                need_from_sleep_debt_milli: Math.round(between(0, 1.2) * HOUR),
                need_from_recent_strain_milli: Math.round(between(0, 0.6) * HOUR),
                need_from_recent_nap_milli: n % 5 === 1 ? -Math.round(between(0.2, 0.6) * HOUR) : 0,
              },
              respiratory_rate: round(between(13.4, 16.2), 6),
              sleep_performance_percentage: Math.round(between(55, 100)),
              sleep_consistency_percentage: Math.round(between(50, 95)),
              sleep_efficiency_percentage: round(between(82, 97), 6),
            },
          }),
    });
    // Naps every 5th day; one pending, one unscorable.
    if (n % 5 === 0) {
      const napStart = wake + between(5, 8) * HOUR;
      const napState = n === 55 ? "PENDING_SCORE" : n === 40 ? "UNSCORABLE" : "SCORED";
      sleeps.push({
        id: uuid(0x0a9, n),
        cycle_id: cycleId,
        v1_id: null,
        user_id: USER,
        created_at: iso(napStart + HOUR),
        updated_at: iso(napStart + HOUR),
        start: iso(napStart),
        end: iso(napStart + between(0.3, 1.1) * HOUR),
        timezone_offset: tz,
        nap: true,
        score_state: napState,
        ...(napState === "SCORED"
          ? {
              score: {
                stage_summary: {
                  total_in_bed_time_milli: 40 * 60_000,
                  total_awake_time_milli: 5 * 60_000,
                  total_no_data_time_milli: 0,
                  total_light_sleep_time_milli: Math.round(between(15, 30) * 60_000),
                  total_slow_wave_sleep_time_milli: Math.round(between(0, 10) * 60_000),
                  total_rem_sleep_time_milli: Math.round(between(0, 8) * 60_000),
                  sleep_cycle_count: 1,
                  disturbance_count: 1,
                },
                sleep_needed: { baseline_milli: 0, need_from_sleep_debt_milli: 0, need_from_recent_strain_milli: 0, need_from_recent_nap_milli: 0 },
                respiratory_rate: round(between(13.4, 16.2), 6),
                sleep_performance_percentage: null,
                sleep_consistency_percentage: null,
                sleep_efficiency_percentage: round(between(80, 95), 6),
              },
            }
          : {}),
      });
    }
    // Recovery: none on one day, pending and unscorable once each, calibrating the first four days.
    if (n !== 17) {
      const state = n === 57 ? "PENDING_SCORE" : n === 37 ? "UNSCORABLE" : "SCORED";
      recoveries.push({
        cycle_id: cycleId,
        sleep_id: sleepId,
        user_id: USER,
        created_at: iso(wake + 10 * 60_000),
        updated_at: updated,
        score_state: state,
        ...(state === "SCORED"
          ? {
              score: {
                user_calibrating: n <= 4,
                recovery_score: Math.round(between(18, 98)),
                resting_heart_rate: Math.round(between(46, 62)),
                hrv_rmssd_milli: round(between(38, 110), 6),
                ...(n === 29 ? {} : { spo2_percentage: round(between(94, 99), 6), skin_temp_celsius: round(between(33, 34.6), 6) }),
              },
            }
          : {}),
      });
    }
    // Workouts: 0–2 a day.
    const count = isToday ? 0 : rand() < 0.25 ? 0 : rand() < 0.75 ? 1 : 2;
    for (let k = 0; k < count; k++) {
      const [sport, sportId] = SPORTS[Math.floor(rand() * SPORTS.length)];
      const localHour = k === 0 ? (rand() < 0.3 ? between(18, 21) : between(9, 13)) : between(15, 17);
      const start = day + localHour * HOUR - off;
      const mins = between(25, 110);
      const end = start + mins * 60_000;
      const id = uuid(0x30c0, n * 10 + k);
      const state = n === 44 && k === 0 ? "UNSCORABLE" : n === 54 && k === 0 ? "PENDING_SCORE" : "SCORED";
      const total = mins * 60_000;
      const z = [0.05, 0.15, 0.3, 0.3, 0.15, 0.05].map((f) => Math.round(total * f * between(0.7, 1.3)));
      workouts.push({
        id,
        v1_id: null,
        user_id: USER,
        created_at: iso(end + 3 * 60_000),
        updated_at: iso(end + 20 * 60_000),
        start: iso(start),
        end: iso(end),
        timezone_offset: tz,
        sport_name: sport,
        sport_id: sportId,
        score_state: state,
        ...(state === "SCORED"
          ? {
              score: {
                strain: round(between(4, 17), 6),
                average_heart_rate: Math.round(between(110, 160)),
                max_heart_rate: Math.round(between(150, 195)),
                kilojoule: round(between(600, 3500), 4),
                percent_recorded: round(between(92, 100), 4),
                ...(sport === "running" || sport === "cycling" ? { distance_meter: round(between(3000, 42000), 3), altitude_gain_meter: round(between(5, 400), 3), altitude_change_meter: round(between(-20, 20), 3) } : {}),
                ...(n % 13 === 0
                  ? {}
                  : { zone_durations: { zone_zero_milli: z[0], zone_one_milli: z[1], zone_two_milli: z[2], zone_three_milli: z[3], zone_four_milli: z[4], zone_five_milli: z[5] } }),
              },
            }
          : {}),
      });
    }
  }
  return {
    now: FIXTURE_NOW,
    profile: { user_id: USER, email: "parity@example.com", first_name: "Pat", last_name: "Rity" },
    cycles,
    sleeps,
    recoveries,
    workouts,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = new URL("./whoop-fixture.json", import.meta.url);
  writeFileSync(out, JSON.stringify(generate(), null, 1) + "\n");
  console.log(`wrote ${fileURLToPath(out)}`);
}
