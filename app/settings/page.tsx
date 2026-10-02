import SiteNav from "@/components/SiteNav";
import SettingsPanel from "@/components/SettingsPanel";

export default function SettingsPage() {
  return (
    <main className="page">
      <header className="masthead">
        <p className="masthead-eyebrow">Your Own Personal, Digital Library</p>
        <h1 className="masthead-title">Settings</h1>
        <SiteNav active="settings" />
      </header>
      <SettingsPanel />
      <p className="settings-version">Bookplate {process.env.NEXT_PUBLIC_APP_VERSION} · chandler edition</p>
      <footer className="colophon">— ex libris —</footer>
    </main>
  );
}
