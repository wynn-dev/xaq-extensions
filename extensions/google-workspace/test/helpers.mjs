import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { startFakeGoogle } from "./fake-google.mjs";
import { newStateDir, startExtension } from "./harness.mjs";

export const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/google-fixture.json", import.meta.url), "utf8"));
export const manifest = () => JSON.parse(readFileSync(new URL("../xaq-extension.json", import.meta.url), "utf8"));

export const IDS = {
  folder: "1fOlDeRpLaNnInG0000000000000000aa",
  notes: "1DoCq3PlAnNiNgNoTeS0000000000000000000000aaa",
  agenda: "1DoCoFfSiTeAgEnDa000000000000000000000000bbb",
  budget: "1ShEeTbUdGeT2026000000000000000000000000ccc",
  deck: "1SlIdEsPrOdUcTrEvIeW00000000000000000000ddd",
  pdf: "1PdFsIgNeDcOnTrAcT00000000000000eee",
  shortcut: "1ShOrTcUtToQ3NoTeS000000000000000fff",
  roadmap: "1EnGrOaDmAp0000000000000000000000ggg",
  trashed: "1OlDtRaShEdDoC000000000000000000hhh",
};

/** The fake Google, with the Sheets and Slides fake chained in when it exists (test/fake-sheets-slides.mjs). */
export async function startFake(fx = fixture()) {
  const fake = await startFakeGoogle(fx);
  const extra = new URL("./fake-sheets-slides.mjs", import.meta.url);
  if (existsSync(extra)) {
    const mod = await import(extra.href);
    if (mod.nodeHandler && mod.createFakeSheetsSlides) fake.use(mod.nodeHandler(mod.createFakeSheetsSlides()));
  }
  return fake;
}

/** A fake Google plus the extension spawned against it (fresh state dir unless given). */
export async function setup(opts = {}) {
  const fake = opts.fake ?? (await startFake());
  const token = opts.token ?? "test-token";
  fake.state.validTokens.add(token);
  const stateDir = opts.stateDir ?? newStateDir();
  const ext = startExtension({ stateDir, apiOrigin: fake.origin, extraEnv: opts.extraEnv, credentials: opts.credentials ?? (() => ({ accessToken: token, expiresAt: Date.now() + 3_600_000 })) });
  await ext.initialize();
  return {
    fake,
    ext,
    stateDir,
    /** Calls a tool and returns { text, structured, isError }. */
    async call(name, args = {}) {
      const r = await ext.callTool(name, args);
      return { text: r.content?.map((c) => c.text ?? "").join("\n") ?? "", structured: r.structuredContent, isError: r.isError === true, raw: r };
    },
    async close({ keepFake = false } = {}) {
      await ext.stop();
      if (!keepFake) await fake.close();
    },
  };
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
