import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { startFakeWhoop } from "./fake-whoop.mjs";
import { newStateDir, startExtension } from "./harness.mjs";

export const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/whoop-fixture.json", import.meta.url), "utf8"));
export const goldens = () => JSON.parse(readFileSync(new URL("./goldens/goldens.json", import.meta.url), "utf8"));

/** A fake WHOOP plus the extension spawned against it (fresh state dir unless given). */
export async function setup(opts = {}) {
  const fake = opts.fake ?? (await startFakeWhoop(opts.fixture ?? fixture()));
  const token = opts.token ?? "test-token";
  fake.state.validTokens.add(token);
  const stateDir = opts.stateDir ?? newStateDir();
  const ext = startExtension({ stateDir, apiOrigin: fake.origin, credentials: opts.credentials ?? (() => ({ accessToken: token, expiresAt: Date.now() + 3_600_000 })) });
  await ext.initialize();
  return {
    fake,
    ext,
    stateDir,
    async close({ keepFake = false } = {}) {
      await ext.stop();
      if (!keepFake) await fake.close();
    },
  };
}

/** Replaces the volatile status fields (syncedAt) in a result, in structuredContent and in the JSON text. */
export function normalise(value, syncedAt = "<syncedAt>") {
  const fix = (o) => {
    if (o && typeof o === "object" && "syncedAt" in o && "needsReconnect" in o) o.syncedAt = syncedAt;
    return o;
  };
  const v = structuredClone(value);
  if (v?.structuredContent) fix(v.structuredContent);
  for (const c of v?.content ?? []) {
    if (c.type === "text" && c.text.startsWith("{")) {
      try {
        const parsed = JSON.parse(c.text);
        if (parsed && "syncedAt" in parsed && "needsReconnect" in parsed) c.text = JSON.stringify(fix(parsed));
      } catch {
        // not JSON
      }
    }
  }
  for (const c of v?.contents ?? []) {
    if (typeof c.text === "string" && c.text.startsWith("{")) {
      const parsed = JSON.parse(c.text);
      if (parsed && "syncedAt" in parsed && "needsReconnect" in parsed) c.text = JSON.stringify(fix(parsed));
    }
  }
  return v;
}

export function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out.sort();
}
