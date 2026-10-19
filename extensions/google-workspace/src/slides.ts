// Google Slides tools (Slides API v1). Every URL is a fixed base plus encodeURIComponent of a validated id. Slide and
// element ids only ever travel in request bodies.
//
// API reference: https://developers.google.com/workspace/slides/api/reference/rest

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { DRIVE, type GoogleClient, SLIDES } from "./google.ts";
import { type ExtTool, InputError, type ToolOutput, tool } from "./tool.ts";
import { afterCreate, folderIdInput, folderIdOf, moveIntoFolder } from "./folders.ts";
import { fileId } from "./util.ts";

export const SLIDES_BASE = `${SLIDES}/presentations`;
export const DRIVE_FILES_BASE = `${DRIVE}/files`;

const EMU_PER_PT = 12_700;
const MAX_READ_CHARS = 100_000;
const enc = encodeURIComponent;

// ---------------------------------------------------------------------------------------------------------------------
// Ids

/** A presentation id, or the id out of its Google link (util.fileId). */
export function presentationIdOf(input: string): string {
  return fileId(input, "presentation id");
}

/** A Drive file id, or the id out of its Google link (util.fileId). */
export function driveFileIdOf(input: string): string {
  return fileId(input, "Drive file id");
}

// Existing object ids: Google's own can be as short as "p" (the first slide of a new deck).
const EXISTING_ID = /^[A-Za-z0-9_][A-Za-z0-9_\-:]{0,49}$/;

function objectIdOf(input: string, what: string): string {
  const s = input.trim();
  if (!EXISTING_ID.test(s)) throw new InputError(`${what} must be a slide object id as slides_read lists it (letters, digits, _ - :, at most 50).`);
  return s;
}

/** A fresh object id for something we create: 5–50 characters of [A-Za-z0-9_-:], starting [A-Za-z0-9_], as the API requires. */
export function newObjectId(kind: string): string {
  return `xaq_${kind}_${randomBytes(6).toString("hex")}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// The presentation's shape (only what these tools read)

interface TextElement {
  startIndex?: number;
  endIndex?: number;
  paragraphMarker?: { bullet?: { nestingLevel?: number } };
  textRun?: { content?: string };
  autoText?: { content?: string };
}
interface PageElement {
  objectId: string;
  shape?: { shapeType?: string; placeholder?: { type?: string; index?: number }; text?: { textElements?: TextElement[] } };
  table?: { tableRows?: { tableCells?: { text?: { textElements?: TextElement[] } }[] }[] };
  elementGroup?: { children?: PageElement[] };
  image?: unknown;
  video?: unknown;
  sheetsChart?: unknown;
  line?: unknown;
  wordArt?: { renderedText?: string };
}
interface Page {
  objectId: string;
  pageElements?: PageElement[];
  slideProperties?: { notesPage?: Page };
  notesProperties?: { speakerNotesObjectId?: string };
}
interface Presentation {
  presentationId: string;
  title?: string;
  revisionId?: string;
  pageSize?: { width?: { magnitude?: number; unit?: string }; height?: { magnitude?: number; unit?: string } };
  slides?: Page[];
}
interface BatchResponse {
  presentationId?: string;
  replies?: Record<string, any>[];
}

function deckUrl(id: string): string {
  return `https://docs.google.com/presentation/d/${enc(id)}/edit`;
}

async function getDeck(g: GoogleClient, id: string, fields: string): Promise<Presentation> {
  return g.json<Presentation>("GET", `${SLIDES_BASE}/${enc(id)}`, { query: { fields } });
}

async function batchUpdate(g: GoogleClient, id: string, requests: unknown[]): Promise<BatchResponse> {
  return g.json<BatchResponse>("POST", `${SLIDES_BASE}/${enc(id)}:batchUpdate`, { body: { requests } });
}

function slideIndex(deck: Presentation, slideId: string): number {
  const ids = (deck.slides ?? []).map((s) => s.objectId);
  const i = ids.indexOf(slideId);
  if (i < 0) throw new InputError(`There's no slide ${slideId} in the deck. Its slides are: ${ids.join(", ") || "(none)"}.`);
  return i;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading text

/** A text body's paragraphs, with bullets as "- " (indented two spaces per nesting level). */
export function textLines(text: { textElements?: TextElement[] } | undefined): string[] {
  const paras: { bullet?: number; text: string }[] = [];
  let cur: { bullet?: number; text: string } | null = null;
  for (const el of text?.textElements ?? []) {
    if (el.paragraphMarker) {
      cur = { bullet: el.paragraphMarker.bullet ? (el.paragraphMarker.bullet.nestingLevel ?? 0) : undefined, text: "" };
      paras.push(cur);
      continue;
    }
    const s = el.textRun?.content ?? el.autoText?.content;
    if (s === undefined) continue;
    if (!cur) {
      cur = { text: "" };
      paras.push(cur);
    }
    cur.text += s;
  }
  return paras
    .map((p) => ({ ...p, text: p.text.replace(/\n$/, "").replace(/\u000b/g, "\n") }))
    .filter((p) => p.text.trim() !== "")
    .map((p) => (p.bullet !== undefined ? `${"  ".repeat(p.bullet)}- ${p.text}` : p.text));
}

const TITLE_TYPES = new Set(["TITLE", "CENTERED_TITLE"]);

interface SlideText {
  title: string;
  body: string[];
  images: number;
}

function collect(elements: PageElement[] | undefined, out: SlideText): void {
  for (const el of elements ?? []) {
    if (el.shape) {
      const lines = textLines(el.shape.text);
      if (TITLE_TYPES.has(el.shape.placeholder?.type ?? "") && !out.title) out.title = lines.join(" ");
      else out.body.push(...lines);
    } else if (el.table) {
      for (const r of el.table.tableRows ?? []) {
        const cells = (r.tableCells ?? []).map((c) => textLines(c.text).join(" "));
        if (cells.some((c) => c !== "")) out.body.push(`| ${cells.join(" | ")} |`);
      }
    } else if (el.elementGroup) {
      collect(el.elementGroup.children, out);
    } else if (el.image) {
      out.images++;
    } else if (el.sheetsChart) {
      out.body.push("[chart]");
    } else if (el.video) {
      out.body.push("[video]");
    } else if (el.wordArt?.renderedText) {
      out.body.push(el.wordArt.renderedText);
    }
  }
}

export function speakerNotes(slide: Page): string {
  const notes = slide.slideProperties?.notesPage;
  const id = notes?.notesProperties?.speakerNotesObjectId;
  if (!notes || !id) return "";
  const shape = (notes.pageElements ?? []).find((e) => e.objectId === id)?.shape;
  return textLines(shape?.text).join("\n");
}

function speakerNotesId(slide: Page): string | undefined {
  return slide.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId;
}

// ---------------------------------------------------------------------------------------------------------------------
// Outline → batchUpdate requests

export interface OutlineSlide {
  title: string;
  bullets?: string[];
  notes?: string;
}
export interface OutlineIds {
  slide: string;
  title: string;
  body: string;
}

function cleanLine(s: string): string {
  return s.replace(/\r\n?|\n|\u000b/g, " ").replace(/[\u0000-\u0008\u000c-\u001f\u007f]/g, "").trim();
}

/** A bullet, keeping its leading tabs (each one is a nesting level for createParagraphBullets). */
function cleanBullet(s: string): string {
  const tabs = /^\t*/.exec(s)?.[0] ?? "";
  return tabs + cleanLine(s.slice(tabs.length).replace(/\t/g, " "));
}

/**
 * The requests that add one outline slide: createSlide with the predefined TITLE_AND_BODY layout, mapping its TITLE
 * and BODY placeholders (index 0) to our own object ids, then the title text and the bullets (a bulleted body). Empty
 * text isn't inserted. Speaker notes need the new slide's notes shape id, which only a later read returns.
 */
export function outlineSlideRequests(item: OutlineSlide, ids: OutlineIds, insertionIndex?: number): Record<string, unknown>[] {
  const createSlide: Record<string, unknown> = { objectId: ids.slide };
  if (insertionIndex !== undefined) createSlide.insertionIndex = insertionIndex;
  createSlide.slideLayoutReference = { predefinedLayout: "TITLE_AND_BODY" };
  createSlide.placeholderIdMappings = [
    { layoutPlaceholder: { type: "TITLE", index: 0 }, objectId: ids.title },
    { layoutPlaceholder: { type: "BODY", index: 0 }, objectId: ids.body },
  ];
  const requests: Record<string, unknown>[] = [{ createSlide }];
  const title = cleanLine(item.title);
  if (title) requests.push({ insertText: { objectId: ids.title, insertionIndex: 0, text: title } });
  const bullets = (item.bullets ?? []).map(cleanBullet).filter((b) => b.replace(/^\t*/, "") !== "");
  if (bullets.length) {
    requests.push({ insertText: { objectId: ids.body, insertionIndex: 0, text: bullets.join("\n") } });
    requests.push({ createParagraphBullets: { objectId: ids.body, textRange: { type: "ALL" }, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" } });
  }
  return requests;
}

export function outlineIds(): OutlineIds {
  const slide = newObjectId("slide");
  return { slide, title: `${slide}_title`, body: `${slide}_body` };
}

function cleanNotes(s: string): string {
  return s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
}

/** Writes speaker notes onto slides just created: reads their notes shape ids, then inserts the text. */
async function fillNotes(g: GoogleClient, id: string, wanted: { slideId: string; notes: string }[]): Promise<number> {
  const todo = wanted.map((w) => ({ ...w, notes: cleanNotes(w.notes) })).filter((w) => w.notes !== "");
  if (todo.length === 0) return 0;
  const deck = await getDeck(g, id, "slides(objectId,slideProperties.notesPage.notesProperties)");
  const byId = new Map((deck.slides ?? []).map((s) => [s.objectId, speakerNotesId(s)]));
  const requests: unknown[] = [];
  for (const w of todo) {
    const shapeId = byId.get(w.slideId);
    if (!shapeId) throw new InputError(`slide ${w.slideId} has no speaker notes box to write into`);
    // The notes shape may not exist yet; inserting into its id creates it (documented on NotesProperties).
    requests.push({ insertText: { objectId: shapeId, insertionIndex: 0, text: w.notes } });
  }
  await batchUpdate(g, id, requests);
  return requests.length;
}

// ---------------------------------------------------------------------------------------------------------------------
// Images

/**
 * An image URL Google's servers can fetch: https, no user:password, at most 2 KB (the API's limit). The extension never
 * fetches it; it's handed to Google in the createImage request.
 */
export function checkImageUrl(raw: string): string {
  const s = raw.trim();
  if (s.length > 2048) throw new InputError("The image URL is longer than the 2 KB Google accepts.");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new InputError("imageUrl isn't a URL.");
  }
  if (u.protocol !== "https:") throw new InputError("imageUrl must be an https:// URL.");
  if (u.username || u.password) throw new InputError("imageUrl can't carry a user name or password.");
  if (!u.hostname.includes(".") || u.hostname === "localhost" || u.hostname.endsWith(".localhost")) {
    throw new InputError("imageUrl must be a public https URL: Google's servers fetch it.");
  }
  return u.href;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Placement = "center" | "full" | "left" | "right";

/** The box (in points) for a simple placement on a page of the given size. */
export function placementBox(placement: Placement, pageW: number, pageH: number): Box {
  const m = Math.round(pageW * 0.05);
  switch (placement) {
    case "full":
      return { x: 0, y: 0, width: pageW, height: pageH };
    case "left":
    case "right": {
      const width = Math.round(pageW / 2 - 1.5 * m);
      const height = Math.round(pageH * 0.7);
      const y = Math.round((pageH - height) / 2);
      return { x: placement === "left" ? m : Math.round(pageW / 2 + m / 2), y, width, height };
    }
    default: {
      const width = Math.round(pageW * 0.6);
      const height = Math.round(pageH * 0.6);
      return { x: Math.round((pageW - width) / 2), y: Math.round((pageH - height) / 2), width, height };
    }
  }
}

function toPt(d: { magnitude?: number; unit?: string } | undefined, fallback: number): number {
  if (!d || typeof d.magnitude !== "number") return fallback;
  return d.unit === "PT" ? d.magnitude : d.magnitude / EMU_PER_PT;
}

export function createImageRequest(objectId: string, url: string, slideId: string, box: Box): Record<string, unknown> {
  return {
    createImage: {
      objectId,
      url,
      elementProperties: {
        pageObjectId: slideId,
        size: { width: { magnitude: box.width, unit: "PT" }, height: { magnitude: box.height, unit: "PT" } },
        transform: { scaleX: 1, scaleY: 1, shearX: 0, shearY: 0, translateX: box.x, translateY: box.y, unit: "PT" },
      },
    },
  };
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif"]);

/**
 * The URL to give Google for a Drive image: the file's Drive thumbnail link, a short-lived URL Drive issues to
 * whoever can read the file, sized up to 1600 px on the long side. That way the file needn't be shared publicly.
 */
async function driveImageUrl(g: GoogleClient, fileId: string): Promise<{ url: string; name: string }> {
  const f = await g.json<{ id?: string; name?: string; mimeType?: string; size?: string; thumbnailLink?: string }>("GET", `${DRIVE_FILES_BASE}/${enc(fileId)}`, {
    query: { fields: "id,name,mimeType,size,thumbnailLink", supportsAllDrives: true },
  });
  const name = f.name ?? fileId;
  if (!f.mimeType || !IMAGE_TYPES.has(f.mimeType)) throw new InputError(`"${name}" is ${f.mimeType ?? "of an unknown type"}; Slides takes PNG, JPEG or GIF images.`);
  if (f.size !== undefined && Number(f.size) >= 50 * 1024 * 1024) throw new InputError(`"${name}" is over the 50 MB Slides accepts.`);
  if (!f.thumbnailLink) throw new InputError(`Drive has no image link for "${name}" yet (it may still be processing). Try again shortly, or pass a public https imageUrl.`);
  let link: URL;
  try {
    link = new URL(f.thumbnailLink);
  } catch {
    throw new InputError(`Drive returned an unusable image link for "${name}".`);
  }
  if (link.protocol !== "https:" || !(link.hostname === "googleusercontent.com" || link.hostname.endsWith(".googleusercontent.com"))) {
    throw new InputError(`Drive returned an unexpected image link for "${name}".`);
  }
  const sized = link.href.replace(/=s\d+$/, "=s1600");
  return { url: sized, name };
}

// ---------------------------------------------------------------------------------------------------------------------
// Inputs

const presentationIdInput = z.string().min(1).max(500).describe("The presentation's id (the part after /d/ in its URL) or its docs.google.com URL.");
const slideIdInput = z.string().min(1).max(50).describe("The slide's object id, as slides_read lists it.");
const bulletsInput = z
  .array(z.string().max(2000))
  .max(50)
  .optional()
  .describe("Bullet points for the body. Start one with a tab per level to nest it (\"\\tsub-point\").");
const notesInput = z.string().max(20_000).optional().describe("Speaker notes.");
const outlineSlide = z.object({ title: z.string().max(500).describe("The slide's title."), bullets: bulletsInput, notes: notesInput });

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const READ_FIELDS = "presentationId,title,revisionId,slides(objectId,pageElements,slideProperties.notesPage(notesProperties,pageElements))";

// ---------------------------------------------------------------------------------------------------------------------
// Tools

const read = tool({
  name: "slides_read",
  title: "Read a slide deck",
  description: "Reads a Google Slides deck: each slide's object id, title, body text (bullets, text boxes, tables) and speaker notes. Optionally only some slides.",
  input: {
    presentationId: presentationIdInput,
    slideIds: z.array(z.string().min(1).max(50)).max(500).optional().describe("Only these slides (object ids)."),
    includeNotes: z.boolean().default(true).describe("Include speaker notes (default true)."),
  },
  risk: "read",
  target: "/presentationId",
  async run(args, g): Promise<ToolOutput> {
    const id = presentationIdOf(args.presentationId);
    const deck = await getDeck(g, id, READ_FIELDS);
    const all = deck.slides ?? [];
    const wanted = args.slideIds?.map((s) => objectIdOf(s, "slideIds"));
    if (wanted) for (const w of wanted) slideIndex(deck, w);
    const out: Record<string, unknown>[] = [];
    const lines = [`# ${deck.title || "(untitled)"}`, `${plural(all.length, "slide")} · ${deckUrl(id)}`];
    let chars = 0;
    let truncated = false;
    for (const [i, slide] of all.entries()) {
      if (wanted && !wanted.includes(slide.objectId)) continue;
      const t: SlideText = { title: "", body: [], images: 0 };
      collect(slide.pageElements, t);
      const notes = args.includeNotes ? speakerNotes(slide) : "";
      const block = [``, `## Slide ${i + 1}: ${t.title || "(no title)"} [id ${slide.objectId}]`, ...t.body];
      if (t.images) block.push(`(${plural(t.images, "image")})`);
      if (notes) block.push(`Notes: ${notes}`);
      const size = block.join("\n").length;
      if (chars + size > MAX_READ_CHARS && out.length > 0) {
        truncated = true;
        break;
      }
      chars += size;
      lines.push(...block);
      const entry: Record<string, unknown> = { position: i + 1, slideId: slide.objectId, title: t.title, body: t.body, images: t.images };
      if (args.includeNotes) entry.notes = notes;
      out.push(entry);
    }
    if (truncated) lines.push("", `Stopped after ${plural(out.length, "slide")} (the text is long): pass slideIds to read the rest.`);
    return { text: lines.join("\n"), structured: { presentationId: id, title: deck.title ?? "", url: deckUrl(id), slideCount: all.length, slides: out, truncated } };
  },
});

const create = tool({
  name: "slides_create",
  title: "Create a slide deck from an outline",
  description:
    "Creates a Google Slides deck in the user's Drive (or in a folder) from an outline: a title slide (the deck title, optional subtitle), then one Title-and-body slide per outline item, with its bullets and speaker notes. Returns the deck's id, URL and slide ids.",
  input: {
    title: z.string().min(1).max(500).describe("The deck's title (also on the title slide)."),
    subtitle: z.string().max(500).optional().describe("The title slide's subtitle."),
    slides: z.array(outlineSlide).max(100).describe("The outline: one { title, bullets?, notes? } per slide."),
    titleSlide: z.boolean().default(true).describe("Keep a title slide first (default true)."),
    folderId: folderIdInput,
  },
  risk: "write",
  async run(args, g): Promise<ToolOutput> {
    if (!args.titleSlide && args.slides.length === 0) throw new InputError("Give at least one slide, or keep the title slide.");
    const folder = folderIdOf(args.folderId);
    const created = await g.json<Presentation>("POST", SLIDES_BASE, { body: { title: args.title } });
    const id = created.presentationId;
    const url = deckUrl(id);
    const made: { position: number; slideId: string; title: string }[] = [];
    if (folder) {
      try {
        await moveIntoFolder(g, id, folder);
      } catch (err) {
        throw afterCreate(err, `Created the deck ${url} (id ${id}) in My Drive, still empty`, "moving it into the folder failed: ");
      }
    }
    try {
      const requests: Record<string, unknown>[] = [];
      const first = created.slides?.[0];
      if (first && args.titleSlide) {
        const shapes = first.pageElements ?? [];
        const titleBox = shapes.find((e) => TITLE_TYPES.has(e.shape?.placeholder?.type ?? ""));
        const subBox = shapes.find((e) => e.shape?.placeholder?.type === "SUBTITLE");
        const title = cleanLine(args.title);
        if (titleBox && title) requests.push({ insertText: { objectId: titleBox.objectId, insertionIndex: 0, text: title } });
        const subtitle = cleanLine(args.subtitle ?? "");
        if (subBox && subtitle) requests.push({ insertText: { objectId: subBox.objectId, insertionIndex: 0, text: subtitle } });
        made.push({ position: 1, slideId: first.objectId, title });
      }
      const notes: { slideId: string; notes: string }[] = [];
      for (const item of args.slides) {
        const ids = outlineIds();
        requests.push(...outlineSlideRequests(item, ids));
        made.push({ position: made.length + 1, slideId: ids.slide, title: cleanLine(item.title) });
        if (item.notes) notes.push({ slideId: ids.slide, notes: item.notes });
      }
      if (first && !args.titleSlide) requests.push({ deleteObject: { objectId: first.objectId } });
      if (requests.length) await batchUpdate(g, id, requests);
      await fillNotes(g, id, notes);
    } catch (err) {
      throw afterCreate(err, `Created the deck ${url} (id ${id})${folder ? ` in folder ${folder}` : ""}`, "filling it in failed: ");
    }
    return {
      text: [`Created "${args.title}"${folder ? ` in folder ${folder}` : ""} with ${plural(made.length, "slide")}: ${url}`, ...made.map((m) => `${m.position}. ${m.title || "(no title)"} [id ${m.slideId}]`)].join("\n"),
      structured: { presentationId: id, url, title: args.title, folderId: folder ?? null, slides: made },
    };
  },
});

const addSlide = tool({
  name: "slides_add_slide",
  title: "Add a slide to a deck",
  description: "Adds a Title-and-body slide to a Google Slides deck from one outline item (title, bullets, speaker notes), at a 1-based position (default: last). Returns its slide id.",
  input: {
    presentationId: presentationIdInput,
    title: z.string().max(500).describe("The slide's title."),
    bullets: bulletsInput,
    notes: notesInput,
    position: z.number().int().min(1).max(10_000).optional().describe("1-based position (default: after the last slide)."),
  },
  risk: "write",
  target: "/presentationId",
  async run(args, g): Promise<ToolOutput> {
    const id = presentationIdOf(args.presentationId);
    const deck = await getDeck(g, id, "presentationId,slides.objectId");
    const count = deck.slides?.length ?? 0;
    if (args.position !== undefined && args.position > count + 1) throw new InputError(`The deck has ${plural(count, "slide")}, so position can be 1 to ${count + 1}.`);
    const ids = outlineIds();
    await batchUpdate(g, id, outlineSlideRequests(args, ids, args.position === undefined ? undefined : args.position - 1));
    if (args.notes) await fillNotes(g, id, [{ slideId: ids.slide, notes: args.notes }]);
    const position = args.position ?? count + 1;
    return { text: `Added slide ${position} "${cleanLine(args.title) || "(no title)"}" [id ${ids.slide}].`, structured: { presentationId: id, slideId: ids.slide, position } };
  },
});

const duplicateSlide = tool({
  name: "slides_duplicate_slide",
  title: "Duplicate a slide",
  description: "Duplicates a slide of a Google Slides deck. The copy goes right after the original, or at a 1-based position. Returns the copy's slide id.",
  input: {
    presentationId: presentationIdInput,
    slideId: slideIdInput,
    position: z.number().int().min(1).max(10_000).optional().describe("1-based position for the copy (default: right after the original)."),
  },
  risk: "write",
  target: "/presentationId",
  async run(args, g): Promise<ToolOutput> {
    const id = presentationIdOf(args.presentationId);
    const slideId = objectIdOf(args.slideId, "slideId");
    const deck = await getDeck(g, id, "presentationId,slides.objectId");
    const from = slideIndex(deck, slideId);
    const total = (deck.slides?.length ?? 0) + 1;
    if (args.position !== undefined && args.position > total) throw new InputError(`With the copy the deck has ${plural(total, "slide")}, so position can be 1 to ${total}.`);
    const copy = newObjectId("copy");
    const requests: unknown[] = [{ duplicateObject: { objectId: slideId, objectIds: { [slideId]: copy } } }];
    const landed = from + 1; // 0-based index of the copy, right after the original
    const target = args.position === undefined ? landed : args.position - 1;
    if (target !== landed) {
      // insertionIndex counts the arrangement before the move, which still holds the copy itself.
      requests.push({ updateSlidesPosition: { slideObjectIds: [copy], insertionIndex: target < landed ? target : target + 1 } });
    }
    await batchUpdate(g, id, requests);
    return { text: `Duplicated slide ${from + 1} [id ${slideId}] as slide ${target + 1} [id ${copy}].`, structured: { presentationId: id, sourceSlideId: slideId, slideId: copy, position: target + 1 } };
  },
});

const deleteSlide = tool({
  name: "slides_delete_slide",
  title: "Delete a slide",
  description: "Deletes a slide, with everything on it and its speaker notes, from a Google Slides deck. Only the deck's version history can bring it back.",
  input: { presentationId: presentationIdInput, slideId: slideIdInput },
  risk: "risky",
  target: "/presentationId",
  async run(args, g): Promise<ToolOutput> {
    const id = presentationIdOf(args.presentationId);
    const slideId = objectIdOf(args.slideId, "slideId");
    // A read first, so only a slide is deleted: deleteObject would delete any element given its id.
    const deck = await getDeck(g, id, READ_FIELDS);
    const i = slideIndex(deck, slideId);
    const t: SlideText = { title: "", body: [], images: 0 };
    collect(deck.slides?.[i]?.pageElements, t);
    await batchUpdate(g, id, [{ deleteObject: { objectId: slideId } }]);
    const remaining = (deck.slides?.length ?? 1) - 1;
    return {
      text: `Deleted slide ${i + 1} "${t.title || "(no title)"}" [id ${slideId}]; ${plural(remaining, "slide")} left.`,
      structured: { presentationId: id, deleted: { slideId, position: i + 1, title: t.title }, remaining },
    };
  },
});

const replaceText = tool({
  name: "slides_replace_text",
  title: "Find and replace text in a deck",
  description: "Replaces every occurrence of some text in a Google Slides deck (shapes and tables), or only on the given slides. Returns how many occurrences changed.",
  input: {
    presentationId: presentationIdInput,
    find: z.string().min(1).max(1000).describe("The text to find."),
    replace: z.string().max(10_000).describe("Its replacement (\"\" removes it)."),
    matchCase: z.boolean().default(true).describe("Case-sensitive (default true)."),
    slideIds: z.array(z.string().min(1).max(50)).max(500).optional().describe("Only on these slides (object ids); default: the whole deck."),
  },
  risk: "write",
  target: "/presentationId",
  async run(args, g): Promise<ToolOutput> {
    const id = presentationIdOf(args.presentationId);
    const req: Record<string, unknown> = { containsText: { text: args.find, matchCase: args.matchCase }, replaceText: args.replace };
    const pages = args.slideIds?.map((s) => objectIdOf(s, "slideIds"));
    if (pages && pages.length) req.pageObjectIds = pages;
    const res = await batchUpdate(g, id, [{ replaceAllText: req }]);
    // proto3 JSON leaves a zero count out.
    const n = Number(res.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0);
    const scope = pages && pages.length ? `on ${plural(pages.length, "slide")}` : "in the deck";
    return { text: n ? `Replaced ${plural(n, "occurrence")} of "${args.find}" ${scope}.` : `No occurrences of "${args.find}" ${scope}; nothing changed.`, structured: { presentationId: id, occurrencesChanged: n } };
  },
});

const insertImage = tool({
  name: "slides_insert_image",
  title: "Insert an image on a slide",
  description:
    "Puts an image on a slide of a Google Slides deck, from a public https URL or a Drive file id. Google's servers fetch the image (the extension never does), once, at insertion: a URL must be publicly reachable, and the image PNG, JPEG or GIF, under 50 MB and 25 megapixels. A Drive image goes in through Drive's short-lived thumbnail link (at most 1600 px on the long side), so it needn't be shared. No local files. Placement: center (default), full, left or right half, or an explicit box in points; the image keeps its aspect ratio inside the box.",
  input: {
    presentationId: presentationIdInput,
    slideId: slideIdInput,
    imageUrl: z.string().min(1).max(2048).optional().describe("A public https:// image URL (Google fetches it)."),
    driveFileId: z.string().min(1).max(500).optional().describe("A Drive image's file id or drive.google.com URL."),
    placement: z.enum(["center", "full", "left", "right"]).default("center"),
    box: z
      .object({ x: z.number().min(-10_000).max(10_000), y: z.number().min(-10_000).max(10_000), width: z.number().min(1).max(10_000), height: z.number().min(1).max(10_000) })
      .optional()
      .describe("An explicit box in points from the slide's top-left (a default slide is 720 × 405 pt); overrides placement."),
  },
  risk: "write",
  target: "/presentationId",
  async run(args, g): Promise<ToolOutput> {
    const id = presentationIdOf(args.presentationId);
    const slideId = objectIdOf(args.slideId, "slideId");
    if ((args.imageUrl === undefined) === (args.driveFileId === undefined)) throw new InputError("Give exactly one of imageUrl and driveFileId.");
    const url = args.imageUrl !== undefined ? checkImageUrl(args.imageUrl) : undefined;
    const fileId = args.driveFileId !== undefined ? driveFileIdOf(args.driveFileId) : undefined;
    const deck = await getDeck(g, id, "presentationId,pageSize,slides.objectId");
    const i = slideIndex(deck, slideId);
    const source = url !== undefined ? { url, name: url } : await driveImageUrl(g, fileId as string);
    const pageW = toPt(deck.pageSize?.width, 720);
    const pageH = toPt(deck.pageSize?.height, 405);
    const box = args.box ?? placementBox(args.placement, pageW, pageH);
    const objectId = newObjectId("img");
    const res = await batchUpdate(g, id, [createImageRequest(objectId, source.url, slideId, box)]);
    const made = res.replies?.[0]?.createImage?.objectId ?? objectId;
    return {
      text: `Inserted ${fileId ? `Drive image "${source.name}"` : "the image"} on slide ${i + 1} [id ${slideId}] at ${box.x},${box.y} pt, ${box.width} × ${box.height} pt [image id ${made}].`,
      structured: { presentationId: id, slideId, imageId: made, box, source: fileId ? { driveFileId: fileId } : { imageUrl: url } },
    };
  },
});

export const slidesTools = [read, create, addSlide, duplicateSlide, deleteSlide, replaceText, insertImage] as ExtTool[];
