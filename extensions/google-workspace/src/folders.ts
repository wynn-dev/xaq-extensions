// Putting a file the extension just created into a Drive folder (sheets_create, slides_create). The Sheets and Slides
// create calls can't name a folder, so the file is created in My Drive and then moved with Drive files.update
// (addParents=<folder>, removeParents=root). That works under drive.file, because the app created the file.

import { z } from "zod";
import { DRIVE, type GoogleClient, GoogleError } from "./google.ts";
import { InputError } from "./tool.ts";
import { fileId } from "./util.ts";

export const folderIdInput = z
  .string()
  .min(1)
  .max(500)
  .optional()
  .describe("A Drive folder to put the new file in: its id or link (default: My Drive). The account must be able to add files to it.");

/** The folder to move into, or undefined for My Drive (none given, or "root"). Validated before anything is created. */
export function folderIdOf(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  const id = fileId(input, "folder id", true);
  return id === "root" ? undefined : id;
}

/** Moves a file the extension created out of My Drive's root into the folder. Returns its parents afterwards. */
export async function moveIntoFolder(g: GoogleClient, id: string, folderId: string): Promise<string[]> {
  const res = await g.json<{ id?: string; parents?: string[] }>("PATCH", `${DRIVE}/files/${encodeURIComponent(id)}`, {
    query: { addParents: folderId, removeParents: "root", supportsAllDrives: true, fields: "id,parents" },
    body: {},
  });
  return res.parents ?? [folderId];
}

/** The error for a file that was created but whose next step failed: it names the file, and keeps the error's kind. */
export function afterCreate(err: unknown, made: string, step: string): Error {
  const msg = `${made}, but ${step}${(err as Error)?.message ?? String(err)}`;
  if (err instanceof GoogleError) return new GoogleError(err.code, msg, err.status);
  return new InputError(msg);
}
