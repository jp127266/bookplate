// The app's API, answered in the browser.
//
// This edition of Bookplate has no server process: nginx serves the built
// pages, the EPUB library (BASE/library/), and a data folder (BASE/data/) that
// accepts WebDAV PUT and DELETE. Pages still call apiFetch("/api/…") as the
// server edition did; the routes below answer from JSON files in that folder:
//
//   books.json               { books: Book[] }
//   progress.json            { progress: ProgressEntry[] }
//   vocabulary.json          { words: VocabEntry[] }
//   notes/<bookId>.md        one markdown file per book
//   notes-images/<bookId>/…  images pasted into those notes
//   covers/<bookId>.jpg      cropped covers
//   reading/<bookId>.json    where the reader left off
//
// Sign-in is nginx's basic auth, so there are no accounts here.

import { Book, ProgressEntry, VocabEntry } from "./types";
import { isValidBook, isValidProgress, isValidVocab } from "./validate";
import { SEARCH_FIELDS, OpenLibraryDoc, toSearchResults } from "./openLibrary";
import { newId } from "./id";

// next.config.ts sets the base path and exposes it here.
export const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
export const DATA = `${BASE}/data`;

// ── The data folder ────────────────────────────────────────────────────────

export class StoreError extends Error {}

export async function readJson<T>(name: string, fallback: T): Promise<T> {
  const res = await fetch(`${DATA}/${name}`, { cache: "no-store" });
  if (res.status === 404) return fallback;
  if (!res.ok) throw new StoreError(`Reading ${name} failed (${res.status})`);
  return (await res.json()) as T;
}

export async function readText(path: string): Promise<string | null> {
  const res = await fetch(`${DATA}/${path}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new StoreError(`Reading ${path} failed (${res.status})`);
  return res.text();
}

export async function writeFile(path: string, body: BodyInit, type: string): Promise<void> {
  const res = await fetch(`${DATA}/${path}`, { method: "PUT", body, headers: { "Content-Type": type } });
  if (!res.ok) throw new StoreError(`Saving ${path} failed (${res.status})`);
}

export async function removeFile(path: string): Promise<void> {
  const res = await fetch(`${DATA}/${path}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new StoreError(`Deleting ${path} failed (${res.status})`);
}

// nginx's JSON directory listing; a missing folder is an empty one.
export async function listDir(path: string): Promise<{ name: string; type: string }[]> {
  const res = await fetch(`${DATA}/${path.replace(/\/?$/, "/")}`, { cache: "no-store" });
  if (res.status === 404) return [];
  if (!res.ok) throw new StoreError(`Listing ${path} failed (${res.status})`);
  return res.json();
}

// Read-modify-write of the shared JSON files, one at a time, so two saves
// started together can't overwrite each other's changes.
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

export function updateJson<T>(name: string, fallback: T, change: (value: T) => T): Promise<T> {
  return exclusive(async () => {
    const next = change(await readJson(name, fallback));
    await writeFile(name, JSON.stringify(next), "application/json");
    return next;
  });
}

type BooksFile = { books: Book[] };
type ProgressFile = { progress: ProgressEntry[] };
type VocabFile = { words: VocabEntry[] };

export const loadBooks = async () => (await readJson<BooksFile>("books.json", { books: [] })).books;
export const updateBooks = (change: (books: Book[]) => Book[]) =>
  updateJson<BooksFile>("books.json", { books: [] }, (f) => ({ books: change(f.books) }));

// ── Helpers shared by the routes ───────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function bodyJson(init?: RequestInit): unknown {
  try {
    return JSON.parse(String(init?.body ?? ""));
  } catch {
    return null;
  }
}

const SAFE = /^[a-zA-Z0-9_-]+$/;

// A cover or notes-image URL in the data folder → its path inside it.
export function dataPath(url: string | undefined): string | null {
  const path = url?.split("?")[0];
  return path?.startsWith(`${DATA}/`) ? path.slice(DATA.length + 1) : null;
}

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

async function deleteNotes(bookId: string): Promise<void> {
  await removeFile(`notes/${bookId}.md`);
  const images = await listDir(`notes-images/${bookId}`);
  await Promise.all(images.map((f) => removeFile(`notes-images/${bookId}/${f.name}`)));
}

// ── Routes ─────────────────────────────────────────────────────────────────

type Handler = (m: RegExpMatchArray, url: URL, init?: RequestInit) => Promise<Response>;

const routes: [string, RegExp, Handler][] = [
  ["GET", /^\/api\/books$/, async () => json({ books: await loadBooks() })],

  [
    "PUT",
    /^\/api\/books\/([^/]+)$/,
    async (m, _u, init) => {
      const book = bodyJson(init);
      if (!SAFE.test(m[1]) || !isValidBook(book) || book.id !== m[1]) return json({ error: "Invalid book" }, 400);
      await updateBooks((books) => [...books.filter((b) => b.id !== book.id), book]);
      return json({ ok: true });
    },
  ],

  [
    "DELETE",
    /^\/api\/books\/([^/]+)$/,
    async (m) => {
      const id = m[1];
      if (!SAFE.test(id)) return json({ error: "Invalid book id" }, 400);
      let removed: Book | undefined;
      await updateBooks((books) => {
        removed = books.find((b) => b.id === id);
        return books.filter((b) => b.id !== id);
      });
      await updateJson<ProgressFile>("progress.json", { progress: [] }, (f) => ({
        progress: f.progress.filter((e) => e.bookId !== id),
      }));
      await deleteNotes(id);
      const cover = dataPath(removed?.coverImage);
      if (cover) await removeFile(cover);
      await removeFile(`reading/${id}.json`);
      return json({ ok: true });
    },
  ],

  [
    "GET",
    /^\/api\/progress$/,
    async () => {
      const { progress } = await readJson<ProgressFile>("progress.json", { progress: [] });
      return json({ progress: [...progress].sort((a, b) => a.date.localeCompare(b.date)) });
    },
  ],

  [
    "PUT",
    /^\/api\/progress\/([^/]+)$/,
    async (m, _u, init) => {
      const bookId = m[1];
      const body = bodyJson(init) as Record<string, unknown> | null;
      const entry = { ...body, bookId };
      if (!isValidProgress(entry)) return json({ error: "Invalid progress" }, 400);
      const book = (await loadBooks()).find((b) => b.id === bookId);
      if (!book) return json({ error: "No such book" }, 404);
      if (entry.page != null && book.pages && entry.page > book.pages) {
        return json({ error: `This book has ${book.pages} pages` }, 400);
      }
      const clean: ProgressEntry = { bookId, date: entry.date, page: entry.page ?? undefined, percent: entry.percent };
      await updateJson<ProgressFile>("progress.json", { progress: [] }, (f) => ({
        progress: [...f.progress.filter((e) => !(e.bookId === bookId && e.date === clean.date)), clean],
      }));
      return json({ ok: true });
    },
  ],

  [
    "DELETE",
    /^\/api\/progress\/([^/]+)$/,
    async (m, url) => {
      const date = url.searchParams.get("date") ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Invalid date" }, 400);
      await updateJson<ProgressFile>("progress.json", { progress: [] }, (f) => ({
        progress: f.progress.filter((e) => !(e.bookId === m[1] && e.date === date)),
      }));
      return json({ ok: true });
    },
  ],

  [
    "GET",
    /^\/api\/notes$/,
    async () => {
      const files = await listDir("notes");
      return json({ ids: files.filter((f) => f.name.endsWith(".md")).map((f) => f.name.slice(0, -3)) });
    },
  ],

  [
    "GET",
    /^\/api\/notes\/([^/]+)$/,
    async (m) =>
      SAFE.test(m[1]) ? json({ notes: await readText(`notes/${m[1]}.md`) }) : json({ error: "Invalid book id" }, 400),
  ],

  [
    "PUT",
    /^\/api\/notes\/([^/]+)$/,
    async (m, _u, init) => {
      const id = m[1];
      const notes = (bodyJson(init) as { notes?: unknown } | null)?.notes;
      if (!SAFE.test(id) || typeof notes !== "string" || notes.length > 2 * 1024 * 1024) {
        return json({ error: "Invalid notes payload" }, 400);
      }
      await writeFile(`notes/${id}.md`, notes, "text/markdown; charset=utf-8");
      // Every save doubles as garbage collection for pasted-then-removed images.
      const images = await listDir(`notes-images/${id}`);
      await Promise.all(
        images
          .filter((f) => !notes.includes(`${DATA}/notes-images/${id}/${f.name}`))
          .map((f) => removeFile(`notes-images/${id}/${f.name}`))
      );
      return json({ ok: true });
    },
  ],

  [
    "DELETE",
    /^\/api\/notes\/([^/]+)$/,
    async (m) => {
      if (!SAFE.test(m[1])) return json({ error: "Invalid book id" }, 400);
      await deleteNotes(m[1]);
      return json({ ok: true });
    },
  ],

  [
    "POST",
    /^\/api\/notes\/images$/,
    async (_m, _u, init) => {
      const form = init?.body as FormData;
      const file = form.get("file");
      const bookId = form.get("bookId");
      if (!(file instanceof Blob) || typeof bookId !== "string" || !SAFE.test(bookId)) {
        return json({ error: "Invalid upload" }, 400);
      }
      const ext = EXT_BY_TYPE[file.type];
      if (!ext) return json({ error: "Unsupported image type" }, 415);
      const path = `notes-images/${bookId}/${newId()}.${ext}`;
      await writeFile(path, file, file.type);
      return json({ path: `${DATA}/${path}` });
    },
  ],

  [
    "POST",
    /^\/api\/covers$/,
    async (_m, _u, init) => {
      const form = init?.body as FormData;
      const file = form.get("file");
      const id = form.get("id");
      if (!(file instanceof Blob) || typeof id !== "string" || !SAFE.test(id)) {
        return json({ error: "Invalid upload" }, 400);
      }
      await writeFile(`covers/${id}.jpg`, file, "image/jpeg");
      return json({ path: `${DATA}/covers/${id}.jpg` });
    },
  ],

  [
    "GET",
    /^\/api\/vocabulary$/,
    async () => json({ words: (await readJson<VocabFile>("vocabulary.json", { words: [] })).words }),
  ],

  [
    "PUT",
    /^\/api\/vocabulary\/([^/]+)$/,
    async (m, _u, init) => {
      const word = bodyJson(init);
      if (!SAFE.test(m[1]) || !isValidVocab(word) || word.id !== m[1]) return json({ error: "Invalid word" }, 400);
      await updateJson<VocabFile>("vocabulary.json", { words: [] }, (f) => ({
        words: [...f.words.filter((w) => w.id !== word.id), word],
      }));
      return json({ ok: true });
    },
  ],

  [
    "DELETE",
    /^\/api\/vocabulary\/([^/]+)$/,
    async (m) => {
      await updateJson<VocabFile>("vocabulary.json", { words: [] }, (f) => ({
        words: f.words.filter((w) => w.id !== m[1]),
      }));
      return json({ ok: true });
    },
  ],

  ["GET", /^\/api\/define$/, async (_m, url) => define(url.searchParams.get("word")?.trim() ?? "")],

  [
    "GET",
    /^\/api\/booksearch$/,
    async (_m, url) => {
      const q = url.searchParams.get("q")?.trim();
      if (!q) return json({ results: [] });
      const res = await fetch(
        `https://openlibrary.org/search.json?limit=8&fields=${SEARCH_FIELDS}&q=` + encodeURIComponent(q)
      );
      if (!res.ok) return json({ error: "Search failed" }, 502);
      const data: { docs?: OpenLibraryDoc[] } = await res.json();
      return json({ results: toSearchResults(data.docs) });
    },
  ],

  ["GET", /^\/api\/booksearch\/cover$/, async (_m, url) => coverImage(url.searchParams)],
];

// ── Outside services (all allow cross-origin requests) ─────────────────────

// Open Library's cover by id, falling back to iTunes ebook artwork.
async function coverImage(p: URLSearchParams): Promise<Response> {
  const id = p.get("id");
  const size = p.get("s") ?? "L";
  const title = p.get("t")?.trim() ?? "";
  const author = p.get("a")?.trim() ?? "";
  if (id && /^\d+$/.test(id) && /^[SML]$/.test(size)) {
    try {
      const res = await fetch(`https://covers.openlibrary.org/b/id/${id}-${size}.jpg`);
      if (res.ok) {
        const blob = await res.blob();
        // Open Library returns a tiny placeholder for missing covers.
        if (blob.size > 500) return new Response(blob, { headers: { "Content-Type": blob.type || "image/jpeg" } });
      }
    } catch {
      // Unreachable from this network — try iTunes.
    }
  }
  if (size === "L" && title) {
    try {
      const term = encodeURIComponent(`${title} ${author}`.trim());
      const res = await fetch(`https://itunes.apple.com/search?term=${term}&media=ebook&limit=1`);
      if (res.ok) {
        const data: { results?: { artworkUrl100?: string }[] } = await res.json();
        const art = data.results?.[0]?.artworkUrl100;
        if (art) {
          const img = await fetch(art.replace(/100x100bb\.jpg$/, "900x0w.jpg"));
          if (img.ok) return new Response(await img.blob(), { headers: { "Content-Type": "image/jpeg" } });
        }
      }
    } catch {
      // No cover anywhere.
    }
  }
  return new Response("Not found", { status: 404 });
}

interface WiktDefinition {
  definition?: string;
  examples?: string[];
  parsedExamples?: { example?: string }[];
}
interface WiktUsage {
  partOfSpeech?: string;
  definitions?: WiktDefinition[];
}

// Wiktionary definitions arrive as HTML fragments; the page shows plain text.
function stripHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

async function usagesFor(title: string): Promise<WiktUsage[] | null> {
  const res = await fetch("https://en.wiktionary.org/api/rest_v1/page/definition/" + encodeURIComponent(title));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Lookup failed");
  const data: Record<string, WiktUsage[]> = await res.json();
  return data.en?.length ? data.en : null;
}

async function define(raw: string): Promise<Response> {
  if (!raw) return json({ entry: null });
  const word = raw.toLowerCase();
  try {
    // Wiktionary titles are case-sensitive: lowercase first, then as typed.
    let headword = word;
    let usages = await usagesFor(word);
    if (!usages && raw !== word) {
      headword = raw;
      usages = await usagesFor(raw);
    }
    if (!usages) return json({ entry: null });
    const senses = usages
      .flatMap((u) =>
        (u.definitions ?? []).map((d) => {
          const example = d.parsedExamples?.[0]?.example ?? d.examples?.[0];
          return {
            partOfSpeech: (u.partOfSpeech ?? "").toLowerCase(),
            definition: stripHtml(d.definition ?? ""),
            example: example ? stripHtml(example) || null : null,
            synonyms: [] as string[],
          };
        })
      )
      .filter((s) => s.definition)
      .slice(0, 10);
    return json({ entry: { word: headword, phonetic: null, senses } });
  } catch {
    return json({ error: "Lookup failed" }, 502);
  }
}

// ── Entry points ───────────────────────────────────────────────────────────

export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input, window.location.origin);
  const method = (init?.method ?? "GET").toUpperCase();
  for (const [verb, pattern, handler] of routes) {
    const m = url.pathname.match(pattern);
    if (m && verb === method) {
      try {
        return await handler(m, url, init);
      } catch (e) {
        return json({ error: e instanceof StoreError ? e.message : "Something went wrong" }, 500);
      }
    }
  }
  return json({ error: `No route for ${method} ${url.pathname}` }, 404);
}

export function putJson(path: string, body: unknown): Promise<Response> {
  return apiFetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
