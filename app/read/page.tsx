"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Book as EpubBook, Rendition, NavItem, Location } from "epubjs";
import { Book } from "@/lib/types";
import { apiFetch, putJson, readJson, writeFile } from "@/lib/api";
import { libraryUrl, opfPath } from "@/lib/epub";
import { todayIso } from "@/lib/progress";

interface Position {
  cfi: string;
  percent: number | null;
  updatedAt: string;
}

const FONT_SIZES = [80, 90, 100, 110, 120, 135, 150];
const DEFAULT_FONT_STEP = 2; // 100%

// The text size is remembered per device (a phone and a laptop want
// different sizes), for every book. Storage can be unavailable — private
// windows, blocked site data — and then the reader just starts at 100%.
const FONT_KEY = "bookplate.reader.fontStep";

function loadFontStep(): number {
  try {
    const raw = window.localStorage.getItem(FONT_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isInteger(n) && n >= 0 && n < FONT_SIZES.length ? n : DEFAULT_FONT_STEP;
  } catch {
    return DEFAULT_FONT_STEP;
  }
}

function saveFontStep(step: number): void {
  try {
    window.localStorage.setItem(FONT_KEY, String(step));
  } catch {
    // Not remembered this time; the change still applies to this book.
  }
}

// /read?id=<bookId> — reads the book's unpacked EPUB straight from the
// library folder. Where you left off is kept in data/reading/<id>.json, and
// the percentage read goes into the book's progress log once a day.
export default function ReaderPage() {
  const viewRef = useRef<HTMLDivElement>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toc, setToc] = useState<NavItem[]>([]);
  const [tocOpen, setTocOpen] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  const [chapter, setChapter] = useState("");
  const [fontStep, setFontStep] = useState(DEFAULT_FONT_STEP);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("id") ?? "";
    let epub: EpubBook | null = null;
    let cancelled = false;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let loggedPercent: number | null = null;
    const cleanups: (() => void)[] = [];

    (async () => {
      try {
        const res = await apiFetch("/api/books");
        const { books }: { books: Book[] } = await res.json();
        const found = books.find((b) => b.id === id);
        if (!found) throw new Error("This book is no longer on the shelf.");
        if (!found.epub) throw new Error("This book has no EPUB in the library.");
        if (cancelled) return;
        setBook(found);

        // Opening a TBR book starts it.
        if (found.status === "to-read") {
          const started: Book = { ...found, status: "reading" };
          setBook(started);
          void putJson(`/api/books/${found.id}`, started);
        }

        const [{ default: ePub }, opf, saved] = await Promise.all([
          import("epubjs"),
          opfPath(found.epub).catch(() => {
            throw new Error("The EPUB could not be found in the library — was the folder renamed or removed?");
          }),
          readJson<Position | null>(`reading/${id}.json`, null),
        ]);
        if (cancelled || !viewRef.current) return;

        epub = ePub(libraryUrl(found.epub, opf));
        const rendition = epub.renderTo(viewRef.current, {
          width: "100%",
          height: "100%",
          flow: "paginated",
          spread: "auto",
          allowScriptedContent: false,
        });
        renditionRef.current = rendition;
        rendition.themes.default({
          body: { "font-family": "Georgia, 'Times New Roman', serif !important", "line-height": "1.55 !important" },
          img: { "max-width": "100% !important" },
        });
        const step = loadFontStep();
        setFontStep(step);
        rendition.themes.fontSize(`${FONT_SIZES[step]}%`);

        epub.loaded.navigation.then((nav) => !cancelled && setToc(nav.toc));

        const book = epub;
        rendition.on("relocated", (loc: Location) => {
          const cfi = loc.start.cfi;
          const pct = book.locations.length() ? book.locations.percentageFromCfi(cfi) : null;
          setPercent(pct);
          const item = book.navigation?.get(loc.start.href);
          if (item) setChapter(item.label.trim());
          // Save the position a moment after the page settles.
          clearTimeout(saveTimer);
          saveTimer = setTimeout(() => {
            const position: Position = { cfi, percent: pct, updatedAt: new Date().toISOString() };
            void writeFile(`reading/${id}.json`, JSON.stringify(position), "application/json").catch(() => {});
            if (pct !== null) {
              const whole = Math.min(100, Math.round(pct * 100));
              if (whole !== loggedPercent) {
                loggedPercent = whole;
                void putJson(`/api/progress/${id}`, { date: todayIso(), percent: whole }).catch(() => {});
              }
            }
          }, 1500);
        });

        // Arrow keys, inside the book's frame and out.
        const onKey = (e: KeyboardEvent) => {
          if (e.key === "ArrowLeft") void rendition.prev();
          if (e.key === "ArrowRight") void rendition.next();
        };
        rendition.on("keyup", onKey);
        document.addEventListener("keyup", onKey);
        cleanups.push(() => document.removeEventListener("keyup", onKey));

        // Swipes on touch screens.
        let startX: number | null = null;
        rendition.on("touchstart", (e: TouchEvent) => (startX = e.changedTouches[0]?.screenX ?? null));
        rendition.on("touchend", (e: TouchEvent) => {
          const endX = e.changedTouches[0]?.screenX;
          if (startX === null || endX === undefined) return;
          if (endX - startX > 50) void rendition.prev();
          if (startX - endX > 50) void rendition.next();
          startX = null;
        });

        // Tap zones on touch screens: the outer quarters of the page turn it,
        // as in Apple Books. Links (footnotes, contents) and text selection
        // keep working; mouse clicks on desktops are left alone.
        const touchScreen = window.matchMedia("(pointer: coarse)").matches;
        rendition.on("click", (e: MouseEvent) => {
          if (!touchScreen || !viewRef.current) return;
          if ((e.target as Element | null)?.closest?.("a")) return;
          if (!(e.view?.getSelection()?.isCollapsed ?? true)) return;
          // The book's frame scrolls sideways under the view in paginated
          // mode, so measure the tap against the visible area.
          const frame = e.view?.frameElement as HTMLElement | null | undefined;
          if (!frame) return;
          const area = viewRef.current.getBoundingClientRect();
          const x = frame.getBoundingClientRect().left + e.clientX - area.left;
          if (x < area.width * 0.25) void rendition.prev();
          else if (x > area.width * 0.75) void rendition.next();
        });

        await rendition.display(saved?.cfi || undefined);

        // Percentages need a location index: built once, then cached.
        await epub.ready;
        const cached = await readJson<string[] | null>(`reading/${id}.locations.json`, null);
        if (cached) {
          epub.locations.load(JSON.stringify(cached));
        } else {
          await epub.locations.generate(1600);
          void writeFile(`reading/${id}.locations.json`, epub.locations.save(), "application/json").catch(() => {});
        }
        if (cancelled) return;
        const here = rendition.currentLocation() as unknown as Location | undefined;
        if (here?.start) setPercent(epub.locations.percentageFromCfi(here.start.cfi));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "The book could not be opened.");
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(saveTimer);
      cleanups.forEach((c) => c());
      epub?.destroy();
      renditionRef.current = null;
    };
  }, []);

  const changeFont = (delta: number) => {
    const step = Math.min(FONT_SIZES.length - 1, Math.max(0, fontStep + delta));
    setFontStep(step);
    saveFontStep(step);
    renditionRef.current?.themes.fontSize(`${FONT_SIZES[step]}%`);
  };

  const go = (href: string) => {
    setTocOpen(false);
    void renditionRef.current?.display(href);
  };

  if (error) {
    return (
      <main className="page">
        <p className="empty-note">{error}</p>
        <p className="ledger-copy">
          <Link className="notes-back" href="/">
            ← Back to the library
          </Link>
        </p>
      </main>
    );
  }

  return (
    <main className="reader">
      <header className="reader-bar">
        <Link className="notes-back" href={book ? `/?book=${encodeURIComponent(book.id)}` : "/"}>
          ← Library
        </Link>
        <div className="reader-title">
          <span className="reader-book">{book?.title ?? "Opening…"}</span>
          {chapter && <span className="reader-chapter">{chapter}</span>}
        </div>
        <div className="reader-tools">
          <button
            type="button"
            className="btn"
            onClick={() => changeFont(-1)}
            disabled={fontStep === 0}
            aria-label="Smaller text"
          >
            A−
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => changeFont(1)}
            disabled={fontStep === FONT_SIZES.length - 1}
            aria-label="Larger text"
          >
            A+
          </button>
          <button type="button" className="btn" onClick={() => setTocOpen((o) => !o)} aria-expanded={tocOpen}>
            Contents
          </button>
        </div>
      </header>

      {tocOpen && (
        <nav className="reader-toc" aria-label="Contents">
          <TocList items={toc} onGo={go} />
        </nav>
      )}

      <div className="reader-stage">
        <button type="button" className="reader-turn" onClick={() => void renditionRef.current?.prev()} aria-label="Previous page">
          ‹
        </button>
        <div className="reader-view" ref={viewRef} />
        <button type="button" className="reader-turn" onClick={() => void renditionRef.current?.next()} aria-label="Next page">
          ›
        </button>
      </div>

      <footer className="reader-foot">
        {/* Phones: the page-turn arrows live here, at thumb height, instead
            of taking width from the text. Hidden on wider screens. */}
        <button type="button" className="reader-foot-turn" onClick={() => void renditionRef.current?.prev()} aria-label="Previous page">
          ‹
        </button>
        <div className="reader-progress" aria-hidden>
          <div className="reader-progress-fill" style={{ width: `${Math.round((percent ?? 0) * 100)}%` }} />
        </div>
        <span>{percent === null ? "Measuring the book…" : `${Math.round(percent * 100)}% read`}</span>
        <button type="button" className="reader-foot-turn" onClick={() => void renditionRef.current?.next()} aria-label="Next page">
          ›
        </button>
      </footer>
    </main>
  );
}

function TocList({ items, onGo }: { items: NavItem[]; onGo: (href: string) => void }) {
  return (
    <ul>
      {items.map((item) => (
        <li key={item.id || item.href}>
          <button type="button" onClick={() => onGo(item.href)}>
            {item.label.trim()}
          </button>
          {item.subitems && item.subitems.length > 0 && <TocList items={item.subitems} onGo={onGo} />}
        </li>
      ))}
    </ul>
  );
}
