// The EPUB library: the unpacked EPUB folders (Apple Books style) that nginx
// serves read-only at BASE/library/, with a JSON directory listing.
//
// Every folder becomes a book on the shelf the first time it's seen. The
// book keeps the folder name in `epub`, which is also how a later sync knows
// it's already shelved. Removing a folder leaves its book (ratings, notes)
// in place; only the Read button stops working.

import { Book, ProgressEntry, VocabEntry } from "./types";
import { apiFetch, BASE, DATA, listDir, loadBooks, readJson, updateBooks, writeFile } from "./api";
import { newId } from "./id";
import { PALETTE } from "./palette";

export const LIBRARY = `${BASE}/library`;
const UNKNOWN_AUTHOR = "Unknown author";

// A path inside the library, one URL-encoded segment at a time.
export function libraryUrl(folder: string, path = ""): string {
  const segments = [folder, ...path.split("/").filter(Boolean)];
  return `${LIBRARY}/${segments.map(encodeURIComponent).join("/")}`;
}

export async function listEpubFolders(): Promise<string[]> {
  const res = await fetch(`${LIBRARY}/`, { cache: "no-store" });
  if (!res.ok) throw new Error(`The EPUB library could not be listed (${res.status})`);
  const entries: { name: string; type: string }[] = await res.json();
  return entries.filter((e) => e.type === "directory" && /\.epub$/i.test(e.name)).map((e) => e.name);
}

async function fetchXml(url: string): Promise<Document> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} (${res.status})`);
  const doc = new DOMParser().parseFromString(await res.text(), "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error(`${url} is not valid XML`);
  return doc;
}

// Namespace-agnostic lookups: OPF files mix prefixed and unprefixed tags.
function byLocalName(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagName("*")).filter((el) => el.localName === name);
}
const textOf = (el: Element | undefined) => el?.textContent?.replace(/\s+/g, " ").trim() || undefined;

// Where the package document lives, relative to the folder.
export async function opfPath(folder: string): Promise<string> {
  const container = await fetchXml(libraryUrl(folder, "META-INF/container.xml"));
  const path = byLocalName(container, "rootfile")[0]?.getAttribute("full-path");
  if (!path) throw new Error(`${folder}: no rootfile in container.xml`);
  return path;
}

export interface EpubMeta {
  title: string;
  author: string;
  genre?: string;
  isbn?: string;
  coverUrls: string[]; // candidates, best first; the first that decodes wins
  drm: boolean; // content encrypted (Apple FairPlay, Adobe): not readable here
}

export async function readEpubMeta(folder: string): Promise<EpubMeta> {
  const opf = await opfPath(folder);
  const doc = await fetchXml(libraryUrl(folder, opf));
  const dir = opf.includes("/") ? opf.slice(0, opf.lastIndexOf("/") + 1) : "";

  const title = textOf(byLocalName(doc, "title")[0]) ?? folder.replace(/\.epub$/i, "");
  const creators = byLocalName(doc, "creator").map(textOf).filter((c): c is string => !!c);
  const genre = textOf(byLocalName(doc, "subject")[0]);
  const isbn = byLocalName(doc, "identifier")
    .map((el) => textOf(el)?.replace(/^urn:isbn:/i, "").replace(/[^0-9Xx]/g, ""))
    .find((id) => id && (id.length === 10 || id.length === 13));

  // EPUB 3 marks the cover with properties="cover-image"; EPUB 2 points at
  // it from <meta name="cover" content="<item id>">.
  const items = byLocalName(doc, "item");
  const coverId = byLocalName(doc, "meta").find((m) => m.getAttribute("name") === "cover")?.getAttribute("content");
  const cover =
    items.find((i) => (i.getAttribute("properties") ?? "").split(/\s+/).includes("cover-image")) ??
    items.find((i) => coverId && i.getAttribute("id") === coverId) ??
    items.find((i) => /cover/i.test(i.getAttribute("id") ?? "") && (i.getAttribute("media-type") ?? "").startsWith("image/"));
  const href = cover?.getAttribute("href");
  const coverUrls: string[] = [];
  if (href) coverUrls.push(libraryUrl(folder, resolvePath(dir, href)));

  // No cover image declared: follow a cover *page* (the guide's cover
  // reference, or an XHTML item named like one) to its first image.
  if (!href) {
    const pageHref =
      byLocalName(doc, "reference").find((r) => r.getAttribute("type") === "cover")?.getAttribute("href") ??
      items
        .find((i) => /cover/i.test(i.getAttribute("id") ?? "") && /html/.test(i.getAttribute("media-type") ?? ""))
        ?.getAttribute("href");
    const pageImage = pageHref ? await imageInPage(folder, resolvePath(dir, pageHref.split("#")[0])) : undefined;
    if (pageImage) coverUrls.push(pageImage);
  }
  // Last resort: the artwork Apple Books leaves in the folder. It's the only
  // usable cover of a FairPlay-protected book, whose own images are encrypted.
  coverUrls.push(libraryUrl(folder, "iTunesArtwork"));

  const drm = await isDrmProtected(folder);

  return { title, author: creators.join(" & ") || UNKNOWN_AUTHOR, genre, isbn, coverUrls, drm };
}

// Font obfuscation also lists files in encryption.xml, but doesn't stop
// anyone reading the book.
const FONT_OBFUSCATION = new Set(["http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC"]);

// DRM-protected: encryption.xml names any other algorithm — Apple FairPlay
// (http://itunes.apple.com/dataenc) or Adobe's. A sinf.xml alone isn't
// enough: free Apple Books titles carry one with nothing encrypted.
async function isDrmProtected(folder: string): Promise<boolean> {
  const res = await fetch(libraryUrl(folder, "META-INF/encryption.xml")).catch(() => null);
  if (!res?.ok) return false;
  const doc = new DOMParser().parseFromString(await res.text(), "application/xml");
  return byLocalName(doc, "EncryptionMethod").some((m) => !FONT_OBFUSCATION.has(m.getAttribute("Algorithm") ?? ""));
}

// "OEBPS/" + "../images/a.jpg" → "images/a.jpg"; hrefs arrive URL-encoded.
function resolvePath(dir: string, href: string): string {
  const parts: string[] = [];
  for (const seg of (dir + decodeURIComponent(href)).split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

async function imageInPage(folder: string, pagePath: string): Promise<string | undefined> {
  try {
    const res = await fetch(libraryUrl(folder, pagePath));
    if (!res.ok) return undefined;
    const page = new DOMParser().parseFromString(await res.text(), "application/xhtml+xml");
    const img = page.getElementsByTagName("img")[0]?.getAttribute("src");
    const svgImage = byLocalName(page, "image")[0];
    const src = img ?? svgImage?.getAttribute("xlink:href") ?? svgImage?.getAttributeNS("http://www.w3.org/1999/xlink", "href");
    const pageDir = pagePath.includes("/") ? pagePath.slice(0, pagePath.lastIndexOf("/") + 1) : "";
    return src ? libraryUrl(folder, resolvePath(pageDir, src)) : undefined;
  } catch {
    return undefined;
  }
}

// The first candidate that decodes as an image, stored as the book's cover.
async function storeCover(urls: string[], id: string): Promise<string | undefined> {
  for (const url of urls) {
    const stored = await storeCoverThumb(url, id);
    if (stored) return stored;
  }
  return undefined;
}

// The cover scaled to fit 600 × 900 and saved as a JPEG, like the covers
// Bookplate stores for books added by hand. undefined when the file is
// missing or isn't a decodable image (e.g. encrypted).
async function storeCoverThumb(url: string, id: string): Promise<string | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    const bitmap = await createImageBitmap(await res.blob());
    const scale = Math.min(1, 600 / bitmap.width, 900 / bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob) return undefined;
    await writeFile(`covers/${id}.jpg`, blob, "image/jpeg");
    return `${DATA}/covers/${id}.jpg?v=${Date.now()}`;
  } catch {
    return undefined; // the generated cloth cover stands in
  }
}

// Stable binding colour per folder, so the generated cover doesn't change
// between syncs.
function colorFor(folder: string): number {
  let h = 0;
  for (const ch of folder) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % PALETTE.length;
}

// null when the folder can't be read yet — typically a book just copied in
// whose files nginx can't read until chandler's nightly chmod (or one run by
// hand). It's skipped and picked up by a later sync, rather than shelved
// with a made-up title and no author.
async function bookFor(folder: string): Promise<Book | null> {
  const id = newId();
  let meta: EpubMeta;
  try {
    meta = await readEpubMeta(folder);
  } catch {
    return null;
  }
  return {
    id,
    title: meta.title,
    author: meta.author,
    genre: meta.genre,
    isbn: meta.isbn,
    status: "to-read",
    rating: 0,
    colorIndex: colorFor(folder),
    addedAt: new Date().toISOString(),
    epub: folder,
    coverImage: await storeCover(meta.coverUrls, id),
    drm: meta.drm,
  };
}

// Fills in what an EPUB book is missing (run by Settings → Rescan): a cover
// when it has none; title, author, genre and ISBN when it still carries the
// placeholders of a book shelved before its files could be read; and the DRM
// flag for books shelved before it existed. Fields you've set yourself are
// left alone. Returns how many books changed.
export async function repairBooks(): Promise<number> {
  const books = await loadBooks();
  const patches = new Map<string, Partial<Book>>();
  // DRM books are re-checked each time (there are few), so a book that
  // turns out to be readable gets its Read button back.
  const needsWork = (b: Book) => !b.coverImage || b.author === UNKNOWN_AUTHOR || b.drm !== false;
  for (const b of books.filter((b) => b.epub && needsWork(b))) {
    try {
      const meta = await readEpubMeta(b.epub!);
      const patch: Partial<Book> = {};
      if (b.author === UNKNOWN_AUTHOR && meta.author !== UNKNOWN_AUTHOR) {
        patch.author = meta.author;
        if (b.title === b.epub!.replace(/\.epub$/i, "")) patch.title = meta.title;
        if (!b.genre && meta.genre) patch.genre = meta.genre;
        if (!b.isbn && meta.isbn) patch.isbn = meta.isbn;
      }
      if (!b.coverImage) {
        const cover = await storeCover(meta.coverUrls, b.id);
        if (cover) patch.coverImage = cover;
      }
      if (b.drm !== meta.drm) patch.drm = meta.drm;
      if (Object.keys(patch).length) patches.set(b.id, patch);
    } catch {
      // The folder is missing or unreadable — try again on the next rescan.
    }
  }
  if (patches.size) {
    await updateBooks((current) => current.map((b) => (patches.has(b.id) ? { ...b, ...patches.get(b.id) } : b)));
  }
  return patches.size;
}

export interface PruneResult {
  removed: Book[];
  kept: Book[]; // EPUB gone, but the book holds your own data
}

// Takes books off the shelf whose EPUB folder is gone (run by Settings →
// Rescan, never on simply opening the library). A book is kept if it holds
// anything you added: a rating, notes, a reading or finished status,
// progress, or vocabulary — delete those from their dialog if you mean to.
// An empty library listing (drive not mounted?) removes nothing.
export async function pruneMissing(): Promise<PruneResult> {
  const folders = new Set(await listEpubFolders());
  if (folders.size === 0) return { removed: [], kept: [] };
  const [books, noted, progress, vocab] = await Promise.all([
    loadBooks(),
    listDir("notes").then((files) => new Set(files.map((f) => f.name.replace(/\.md$/, "")))),
    readJson<{ progress: ProgressEntry[] }>("progress.json", { progress: [] }),
    readJson<{ words: VocabEntry[] }>("vocabulary.json", { words: [] }),
  ]);
  const tracked = new Set([...progress.progress.map((e) => e.bookId), ...vocab.words.map((w) => w.bookId)]);
  const yours = (b: Book) =>
    b.rating > 0 || b.status !== "to-read" || !!b.dateRead || !!b.notes?.trim() || noted.has(b.id) || tracked.has(b.id);

  const result: PruneResult = { removed: [], kept: [] };
  for (const b of books.filter((b) => b.epub && !folders.has(b.epub))) {
    if (yours(b)) {
      result.kept.push(b);
    } else {
      // The same path as Delete: cover, progress, notes and position go too.
      const res = await apiFetch(`/api/books/${b.id}`, { method: "DELETE" });
      if (res.ok) result.removed.push(b);
    }
  }
  return result;
}

// Shelves every EPUB folder that isn't on the shelf yet, a few at a time,
// saving in batches. `onBatch` receives each batch as it's saved.
export async function syncLibrary(
  onBatch: (added: Book[], done: number, total: number) => void
): Promise<number> {
  const [folders, books] = await Promise.all([listEpubFolders(), loadBooks()]);
  const shelved = new Set(books.map((b) => b.epub).filter(Boolean));
  const todo = folders.filter((f) => !shelved.has(f));
  let done = 0;
  for (let i = 0; i < todo.length; i += 8) {
    const batch = (await Promise.all(todo.slice(i, i + 8).map(bookFor))).filter((b): b is Book => b !== null);
    let saved: Book[] = [];
    await updateBooks((current) => {
      const have = new Set(current.map((b) => b.epub).filter(Boolean));
      saved = batch.filter((b) => !have.has(b.epub));
      return [...current, ...saved];
    });
    done += Math.min(8, todo.length - i);
    onBatch(saved, done, todo.length);
  }
  return todo.length;
}
