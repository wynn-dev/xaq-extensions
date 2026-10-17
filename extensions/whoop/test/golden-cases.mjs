// The requests the goldens cover: every tool (with its argument variants and its error paths), the prompts, the
// resources and the listings. Shared by scripts/goldens.mjs (run against the dashboard's own mcp.ts) and
// test/goldens.test.mjs (run against the built extension under the permission model).

export const DAY_FIELDS = [
  "recovery", "strain", "calories", "hrv", "rhr", "respiratoryRate", "spo2", "skinTemp", "sleepHours", "sleepNeededHours",
  "sleepPerformance", "sleepEfficiency", "sleepConsistency", "deepHours", "remHours", "lightHours", "awakeHours",
  "disturbances", "bedtime", "wake",
];

const ENDS = [undefined, "2026-10-01", "2026-09-10", "2026-08-26"];
const RANGES = [7, 30, 90];

/**
 * @param {{ dates: string[], workoutIds: string[] }} data  the physiological dates and workout ids in the fixture
 * @returns {{ name: string, method: string, params: object, volatile?: string[] }[]}
 */
export function goldenCases({ dates, workoutIds }) {
  const cases = [];
  const add = (name, method, params = {}) => cases.push({ name, method, params });
  const tool = (name, args = {}) => add(`${name} ${JSON.stringify(args)}`, "tools/call", { name, arguments: args });

  add("tools/list", "tools/list");
  add("prompts/list", "prompts/list");
  add("resources/list", "resources/list");
  add("resources/templates/list", "resources/templates/list");
  add("prompts/get weekly_review {}", "prompts/get", { name: "weekly_review", arguments: {} });
  add("prompts/get weekly_review end", "prompts/get", { name: "weekly_review", arguments: { end: "2026-10-01" } });

  add("resources/read whoop://status", "resources/read", { uri: "whoop://status" });
  for (const date of dates) add(`resources/read whoop://days/${date}`, "resources/read", { uri: `whoop://days/${date}` });
  add("resources/read whoop://days/2020-01-01", "resources/read", { uri: "whoop://days/2020-01-01" });

  tool("get_status");

  tool("get_day");
  for (const date of dates) tool("get_day", { date });
  tool("get_day", { date: dates[10], include: ["workouts"] });
  tool("get_day", { date: dates[10], include: ["naps", "health"] });
  tool("get_day", { date: dates[3], include: [] });
  tool("get_day", { date: "2026-08-01" });
  tool("get_day", { date: "not-a-date" });

  tool("list_days");
  tool("list_days", { days: 90 });
  tool("list_days", { days: 1 });
  tool("list_days", { end: "2026-09-30", days: 14, fields: DAY_FIELDS.slice(0, 12) });
  tool("list_days", { days: 60, fields: DAY_FIELDS.slice(8) });
  tool("list_days", { end: "2027-01-01", days: 7, fields: ["bedtime", "wake", "disturbances"] });
  tool("list_days", { end: "2026-08-20", days: 10 });
  tool("list_days", { days: 91 });

  tool("list_workouts");
  tool("list_workouts", { days: 90 });
  tool("list_workouts", { days: 90, limit: 5 });
  tool("list_workouts", { days: 90, limit: 5, cursor: "5" });
  tool("list_workouts", { days: 90, limit: 50, cursor: "40" });
  tool("list_workouts", { days: 90, sport: "run" });
  tool("list_workouts", { days: 90, sport: "FUNCTIONAL fit" });
  tool("list_workouts", { end: "2026-09-15", days: 7 });
  tool("list_workouts", { sport: "curling" });

  for (const id of workoutIds) tool("get_workout", { id });
  tool("get_workout", { id: "no-such-workout" });

  for (const range of RANGES) for (const end of ENDS) tool("get_trends", end ? { end, range } : { range });
  tool("get_trends");

  for (const range of RANGES) for (const end of ENDS) tool("get_insights", end ? { end, range } : { range });
  tool("get_insights");
  tool("get_insights", { range: 90, topics: ["highlights", "coverage"] });
  tool("get_insights", { topics: ["naps", "sleep_timing", "monotony"] });
  tool("get_insights", { topics: [] });

  return cases;
}

/** The fields that legitimately differ between two runs (see README "Parity"): replaced before comparing. */
export const VOLATILE_STATUS_FIELDS = ["syncedAt"];
