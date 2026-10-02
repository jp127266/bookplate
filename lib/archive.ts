// Export and import, in the browser, in the server edition's zip format:
//
//   manifest.json                     { format: "bookplate-export", formatVersion: 1, … }
//   library.json                      { books: [...] }
//   vocabulary.json                   { words: [...] }
//   progress.json                     { progress: [...] }
//   notes/<bookId>.md                 one markdown file per book
//   notes/images/<bookId>/<file>      images pasted into those notes
//   covers/<bookId>.jpg               cropped covers
//   reading/<bookId>.json             where the reader left off (this edition only)
//
// Inside the zip, image URLs use the server edition's paths (/api/covers/…,
// /api/notes/images/…), so an export from either edition imports into both.

import { strFromU8, strToU8, unzipSync, zipSync, Zippable } from "fflate";
import { Book, ProgressEntry, VocabEntry } from "./types";
import { isValidBook, isValidProgress, isValidVocab } from "./validate";
import { DATA, listDir, readJson, readText, updateBooks, updateJson, writeFile } from "./api";

export const FORMAT_VERSION = 1;

const toPortable = (s: string) =>
  s.replaceAll(`${DATA}/covers/`, "/api/covers/").replaceAll(`${DATA}/notes-images/`, "/api/notes/images/");
const fromPortable = (s: string) =>
  s.replaceAll("/api/covers/", `${DATA}/covers/`).replaceAll("/api/notes/images/", `${DATA}/notes-images/`);

async function fetchBytes(path: string): Promise<Uint8Array | null> {
  const res = await fetch(`${DATA}/${path}`, { cache: "no-store" });
  return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
}

export async function buildExport(): Promise<Blob> {
  const [{ books }, { words }, { progress }] = await Promise.all([
    readJson<{ books: Book[] }>("books.json", { books: [] }),
    readJson<{ words: VocabEntry[] }>("vocabulary.json", { words: [] }),
    readJson<{ progress: ProgressEntry[] }>("progress.json", { progress: [] }),
  ]);
  const portableBooks = books.map((b) => (b.coverImage ? { ...b, coverImage: toPortable(b.coverImage) } : b));
  const files: Zippable = {
    "manifest.json": strToU8(
      JSON.stringify(
        { format: "bookplate-export", formatVersion: FORMAT_VERSION, edition: "static", exportedAt: new Date().toISOString() },
        null,
        2
      ) + "\n"
    ),
    "library.json": strToU8(JSON.stringify({ books: portableBooks }, null, 2) + "\n"),
    "vocabulary.json": strToU8(JSON.stringify({ words }, null, 2) + "\n"),
    "progress.json": strToU8(JSON.stringify({ progress }, null, 2) + "\n"),
  };
  for (const f of await listDir("notes")) {
    if (!f.name.endsWith(".md")) continue;
    const id = f.name.slice(0, -3);
    const md = await readText(`notes/${f.name}`);
    if (md !== null) files[`notes/${f.name}`] = strToU8(toPortable(md));
    for (const img of await listDir(`notes-images/${id}`)) {
      const data = await fetchBytes(`notes-images/${id}/${img.name}`);
      if (data) files[`notes/images/${id}/${img.name}`] = [data, { level: 0 }];
    }
  }
  for (const f of await listDir("covers")) {
    const data = await fetchBytes(`covers/${f.name}`);
    if (data) files[`covers/${f.name}`] = [data, { level: 0 }]; // JPEGs don't compress further
  }
  for (const f of await listDir("reading")) {
    const data = await fetchBytes(`reading/${f.name}`);
    if (data) files[`reading/${f.name}`] = data;
  }
  return new Blob([zipSync(files, { level: 6 }) as Uint8Array<ArrayBuffer>], { type: "application/zip" });
}

export interface ImportSummary {
  books: number;
  words: number;
  notes: number;
  images: number;
  skipped: number;
}

export class ImportError extends Error {}

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
const SAFE_FILE = /^[a-zA-Z0-9_-]+\.(jpg|jpeg|png|gif|webp)$/i;
const TYPE_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

function readZipJson(data: Uint8Array | undefined): unknown {
  if (!data) return null;
  try {
    return JSON.parse(strFromU8(data));
  } catch {
    throw new ImportError("A JSON file in the zip could not be read.");
  }
}

// Records with the same ids as existing ones are overwritten; nothing is deleted.
export async function importArchive(file: Blob): Promise<ImportSummary> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  } catch {
    throw new ImportError("That file isn't a readable zip.");
  }
  const libraryPath = Object.keys(entries)
    .filter((p) => (p === "library.json" || p.endsWith("/library.json")) && !p.includes("__MACOSX/"))
    .sort((a, b) => a.length - b.length)[0];
  if (!libraryPath) throw new ImportError("No library.json found in the zip.");
  const root = libraryPath.slice(0, -"library.json".length);

  let skipped = 0;
  const rawBooks = (readZipJson(entries[libraryPath]) as { books?: unknown[] } | null)?.books;
  if (!Array.isArray(rawBooks)) throw new ImportError("library.json has no books list.");
  const books: Book[] = [];
  for (const b of rawBooks) {
    if (isValidBook(b)) {
      books.push({ ...b, status: b.status ?? "to-read", coverImage: b.coverImage && fromPortable(b.coverImage) });
    } else skipped++;
  }
  const words: VocabEntry[] = [];
  for (const w of (readZipJson(entries[root + "vocabulary.json"]) as { words?: unknown[] } | null)?.words ?? []) {
    if (isValidVocab(w)) words.push(w);
    else skipped++;
  }
  const progress: ProgressEntry[] = [];
  for (const p of (readZipJson(entries[root + "progress.json"]) as { progress?: unknown[] } | null)?.progress ?? []) {
    if (isValidProgress(p)) progress.push(p);
    else skipped++;
  }

  let notes = 0;
  let images = 0;
  for (const [path, data] of Object.entries(entries)) {
    if (!path.startsWith(root) || path.endsWith("/")) continue;
    const rel = path.slice(root.length);
    const bytes = data as Uint8Array<ArrayBuffer>;
    let m: RegExpMatchArray | null;
    if ((m = rel.match(/^notes\/([^/]+)\.md$/)) && SAFE_ID.test(m[1])) {
      await writeFile(`notes/${m[1]}.md`, fromPortable(strFromU8(data)), "text/markdown; charset=utf-8");
      notes++;
    } else if ((m = rel.match(/^notes\/images\/([^/]+)\/([^/]+)$/)) && SAFE_ID.test(m[1]) && SAFE_FILE.test(m[2])) {
      const type = TYPE_BY_EXT[m[2].split(".").pop()!.toLowerCase()];
      await writeFile(`notes-images/${m[1]}/${m[2]}`, new Blob([bytes], { type }), type);
      images++;
    } else if ((m = rel.match(/^covers\/([^/]+)$/)) && SAFE_FILE.test(m[1])) {
      await writeFile(`covers/${m[1]}`, new Blob([bytes], { type: "image/jpeg" }), "image/jpeg");
      images++;
    } else if ((m = rel.match(/^reading\/([^/]+)\.json$/)) && SAFE_ID.test(m[1])) {
      await writeFile(`reading/${m[1]}.json`, strFromU8(data), "application/json");
    }
  }

  const ids = new Set(books.map((b) => b.id));
  await updateBooks((current) => [...current.filter((b) => !ids.has(b.id)), ...books]);
  const wordIds = new Set(words.map((w) => w.id));
  await updateJson<{ words: VocabEntry[] }>("vocabulary.json", { words: [] }, (f) => ({
    words: [...f.words.filter((w) => !wordIds.has(w.id)), ...words],
  }));
  const key = (e: ProgressEntry) => `${e.bookId}|${e.date}`;
  const progressKeys = new Set(progress.map(key));
  await updateJson<{ progress: ProgressEntry[] }>("progress.json", { progress: [] }, (f) => ({
    progress: [...f.progress.filter((e) => !progressKeys.has(key(e))), ...progress],
  }));

  return { books: books.length, words: words.length, notes, images, skipped };
}
