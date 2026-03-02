import { useState } from "react";
import { Layout } from "../components/Layout";
import { useTelegram } from "../hooks/useTelegram";
import { downloadBackup } from "../api/client";

export function Settings() {
  const { haptic } = useTelegram();
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleBackup = async () => {
    haptic.impact("medium");
    setDownloading(true);
    setError(null);
    try {
      await downloadBackup();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Layout backTo="/" title="Settings">
      <div className="space-y-3">
        <div className="bg-tg-secondary rounded-xl p-4">
          <h2 className="font-medium text-sm text-tg mb-1">Database Backup</h2>
          <p className="text-xs text-tg-hint mb-3">
            Download a copy of the SQLite database containing all clients and traffic history.
          </p>
          <button
            onClick={handleBackup}
            disabled={downloading}
            className="w-full px-4 py-3 rounded-xl bg-tg-button text-tg-button font-medium text-sm disabled:opacity-60"
          >
            {downloading ? "Downloading…" : "💾 Download DB Backup"}
          </button>
          {error && (
            <p className="mt-2 text-xs text-tg-destructive">{error}</p>
          )}
        </div>
      </div>
    </Layout>
  );
}
