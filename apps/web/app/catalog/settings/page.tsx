import "@/components/catalog/pages.css";
import SettingsList from "@/components/settings/SettingsList";
import { db } from "@/lib/db";
import { settingsView } from "@/lib/settings";
import { SETTINGS_TITLE } from "@/lib/settings-copy";
import { requireRole } from "@/lib/user";

export const dynamic = "force-dynamic";

// M12-S1: the plain admin list of every business setting, until the full Settings screens (M12-S2). Admin only;
// owner-only settings can be changed by owners only. A change applies from the next batch.
export default async function SettingsPage() {
  const admin = await requireRole("admin");
  const view = await settingsView(db(), admin.email);
  return (
    <main>
      <div className="hdr">
        <div>
          <h1>{SETTINGS_TITLE}</h1>
          <p className="lead">Changes apply from the next batch. Batches that are running keep the settings they started with.</p>
        </div>
      </div>
      <SettingsList view={view} />
    </main>
  );
}
