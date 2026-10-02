import Link from "next/link";

// Section switcher shown in the masthead of every page. Sign-in is nginx's
// basic auth, so there's no account menu — just a link to Settings.
export default function SiteNav({ active }: { active?: "library" | "vocabulary" | "statistics" | "settings" }) {
  const cls = (name: string) => (active === name ? "site-nav-link site-nav-link--active" : "site-nav-link");
  return (
    <nav className="site-nav" aria-label="Sections">
      <Link href="/" className={cls("library")}>
        Library
      </Link>
      <span className="site-nav-sep" aria-hidden>
        ·
      </span>
      <Link href="/vocabulary" className={cls("vocabulary")}>
        Vocabulary
      </Link>
      <span className="site-nav-sep" aria-hidden>
        ·
      </span>
      <Link href="/statistics" className={cls("statistics")}>
        Statistics
      </Link>
      <span className="site-nav-sep" aria-hidden>
        ·
      </span>
      <Link href="/settings" className={cls("settings")}>
        Settings
      </Link>
    </nav>
  );
}
