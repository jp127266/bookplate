"use client";

import { useRef, useState } from "react";
import { buildExport, importArchive, ImportError } from "@/lib/archive";
import { findMissingCovers, syncLibrary } from "@/lib/epub";

type Note = { ok: boolean; text: string } | null;

function Status({ note }: { note: Note }) {
  if (!note) return null;
  return (
    <p className={note.ok ? "settings-note" : "settings-note settings-note--error"} role="status">
      {note.text}
    </p>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

// Sign-in, passwords and accounts belong to nginx in this edition, so
// Settings is down to the library itself.
export default function SettingsPanel() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"export" | "import" | "scan" | null>(null);
  const [exportNote, setExportNote] = useState<Note>(null);
  const [importNote, setImportNote] = useState<Note>(null);
  const [scanNote, setScanNote] = useState<Note>(null);

  const runExport = async () => {
    setBusy("export");
    setExportNote(null);
    try {
      const blob = await buildExport();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `bookplate-export-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch {
      setExportNote({ ok: false, text: "The export failed — is chandler reachable?" });
    } finally {
      setBusy(null);
    }
  };

  const runImport = async (file: File) => {
    setBusy("import");
    setImportNote(null);
    try {
      const s = await importArchive(file);
      setImportNote({
        ok: true,
        text:
          `Imported ${plural(s.books, "book")}, ${plural(s.words, "word")}, ${plural(s.notes, "note")} and ` +
          `${plural(s.images, "image")}.` +
          (s.skipped ? ` ${plural(s.skipped, "unreadable item")} skipped.` : ""),
      });
    } catch (e) {
      setImportNote({ ok: false, text: e instanceof ImportError ? e.message : "The import failed — is chandler reachable?" });
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const runScan = async () => {
    setBusy("scan");
    setScanNote({ ok: true, text: "Looking through the EPUB library…" });
    try {
      let shelved = 0;
      const found = await syncLibrary((added, done, total) => {
        shelved += added.length;
        setScanNote({ ok: true, text: `Shelving new books… ${done} / ${total}` });
      });
      setScanNote({ ok: true, text: "Looking for missing covers…" });
      const covers = await findMissingCovers();
      setScanNote({
        ok: true,
        text:
          (found === 0 ? "Every EPUB is already on the shelf." : `Added ${plural(shelved, "book")} to the shelf.`) +
          (covers ? ` Found ${plural(covers, "missing cover")}.` : ""),
      });
    } catch {
      setScanNote({ ok: false, text: "The EPUB library could not be read — is chandler reachable?" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings">
      <section className="settings-section">
        <h2 className="form-heading">EPUB library</h2>
        <p className="settings-lede">
          Every book in the <code>Books</code> folder on chandler is put on the shelf the first time the library opens.
          After copying new books there, rescan to add them now (nightly, chandler also makes new files readable — if a
          new book won&rsquo;t open, it may need that first).
        </p>
        <button type="button" className="btn btn--primary" disabled={busy !== null} onClick={runScan}>
          {busy === "scan" ? "Scanning…" : "Rescan EPUB library"}
        </button>
        <Status note={scanNote} />
      </section>

      <section className="settings-section">
        <h2 className="form-heading">Export</h2>
        <p className="settings-lede">
          Download everything — books, notes, pasted images, covers, vocabulary and reading positions — as a zip of
          plain JSON, markdown and image files. It&rsquo;s your backup, and it imports into any Bookplate.
        </p>
        <button type="button" className="btn btn--primary" disabled={busy !== null} onClick={runExport}>
          {busy === "export" ? "Packing…" : "Export library"}
        </button>
        <Status note={exportNote} />
      </section>

      <section className="settings-section">
        <h2 className="form-heading">Import</h2>
        <p className="settings-lede">
          Bring in a Bookplate export. Books and words with matching ids are updated; nothing already here is removed.
        </p>
        <div className="settings-row">
          <input
            ref={fileRef}
            type="file"
            accept=".zip,application/zip"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void runImport(file);
            }}
          />
          <button type="button" className="btn" disabled={busy !== null} onClick={() => fileRef.current?.click()}>
            {busy === "import" ? "Importing…" : "Choose a zip…"}
          </button>
        </div>
        <Status note={importNote} />
      </section>
    </div>
  );
}
