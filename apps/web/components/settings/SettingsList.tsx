"use client";

// M12-S1: the plain Settings list. One card per setting: plain label and help, the value at each level, a typed input
// to change it (with the level and one optional reason), and the recent changes with Undo. The full screens (search,
// inheritance display, preview, undo toast) come with M12-S2 and M12-S3.
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ScopeLevel, SettingScope } from "@catalog/core/settings/registry";
import type { SettingView, SettingsView } from "@/lib/settings";
import { LEVEL_WORDS, NOT_IN_USE, OWNER_ONLY, SAVED } from "@/lib/settings-copy";

async function send(url: string, body: unknown): Promise<string | null> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error ?? "That did not save. Try again.";
}

function ValueInput({ setting, value, onChange }: { setting: SettingView; value: string; onChange: (v: string) => void }) {
  const t = setting.type;
  const label = `New value for ${setting.label}`;
  if (t.kind === "switch") {
    return (
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="true">On</option>
        <option value="false">Off</option>
      </select>
    );
  }
  if (t.kind === "choice") {
    return (
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {t.choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
      </select>
    );
  }
  if (t.kind === "emails") return <input aria-label={label} type="text" value={value} onChange={(e) => onChange(e.target.value)} />;
  return (
    <span>
      <input aria-label={label} type="number" min={t.min} max={t.max} step={t.kind === "decimal" ? t.step : 1} value={value} onChange={(e) => onChange(e.target.value)} />
      {t.unit ? ` ${t.unit}` : null}
    </span>
  );
}

function startValue(setting: SettingView): string {
  const now = setting.levels.find((l) => !Object.keys(l.scope).length)?.value ?? setting.default;
  return Array.isArray(now) ? now.join(", ") : String(now);
}

function toValue(setting: SettingView, text: string): unknown {
  switch (setting.type.kind) {
    case "switch": return text === "true";
    case "whole":
    case "decimal": return text.trim() === "" ? text : Number(text);
    default: return text;
  }
}

function SettingCard({ setting, owner, channels }: { setting: SettingView; owner: boolean; channels: SettingsView["channels"] }) {
  const router = useRouter();
  const [value, setValue] = useState(startValue(setting));
  const [level, setLevel] = useState<"all" | ScopeLevel>("all");
  const [where, setWhere] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = setting.ownerOnly && !owner;

  async function run(url: string, body: unknown) {
    setBusy(true);
    setNote(null);
    const problem = await send(url, body);
    setBusy(false);
    setNote(problem ? { text: problem, ok: false } : { text: SAVED, ok: true });
    if (!problem) { setReason(""); router.refresh(); }
  }

  function save() {
    const scope: SettingScope = level === "all" ? {} : level === "channel" ? { channel: where as SettingScope["channel"] } : { [level]: where.trim() };
    void run("/api/settings/changes", { key: setting.key, scope, value: toValue(setting, value), reason: reason.trim() || null });
  }

  return (
    <article className="card" id={setting.key}>
      <h3>{setting.label}</h3>
      <p className="muted">{setting.help}</p>
      <p>
        {setting.ownerOnly ? <span className="pill warn">{OWNER_ONLY}</span> : null}
        {setting.inUse ? null : <span className="pill">{NOT_IN_USE}</span>}
      </p>
      <div className="tw"><table>
        <thead><tr><th>Where</th><th>Value</th><th>Set by</th></tr></thead>
        <tbody>
          {setting.levels.some((l) => !Object.keys(l.scope).length) ? null : <tr><td>Everywhere</td><td>{setting.defaultShown}</td><td>Starting value</td></tr>}
          {setting.levels.map((l) => (
            <tr key={l.versionId}><td>{l.where}</td><td>{l.shown}</td><td>{l.by} on {l.at.slice(0, 10)}</td></tr>
          ))}
        </tbody>
      </table></div>
      {locked ? <p className="muted">Only an owner can change this.</p> : (
        <div className="alias-form">
          <ValueInput setting={setting} value={value} onChange={setValue} />
          {setting.scopes.length ? (
            <select aria-label={`Where ${setting.label} applies`} value={level} onChange={(e) => { setLevel(e.target.value as typeof level); setWhere(""); }}>
              {(["all", ...setting.scopes] as const).map((s) => <option key={s} value={s}>{LEVEL_WORDS[s]}</option>)}
            </select>
          ) : null}
          {level === "channel" ? (
            <select aria-label="Channel" value={where} onChange={(e) => setWhere(e.target.value)}>
              <option value="">Pick a channel</option>
              {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          ) : level !== "all" ? (
            <input aria-label={level === "brand" ? "Brand" : "Category"} type="text" value={where} onChange={(e) => setWhere(e.target.value)} />
          ) : null}
          <input aria-label="Why (optional)" placeholder="Why (optional)" type="text" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button type="button" className="btn primary" disabled={busy || (level !== "all" && !where.trim())} onClick={save}>Apply from the next batch</button>
        </div>
      )}
      {note ? <p role={note.ok ? "status" : "alert"} className={note.ok ? "pill ok" : "pill bad"}>{note.text}</p> : null}
      {setting.history.length ? (
        <details>
          <summary>Changes ({setting.history.length})</summary>
          <ul className="history">
            {setting.history.map((h) => (
              <li key={h.versionId}>
                {h.where}: {h.shown}. {h.by} on {h.at.slice(0, 10)}.{h.reason ? ` ${h.reason}` : ""}{" "}
                {locked || !h.latest ? null : <button type="button" className="btn sm ghost" disabled={busy} onClick={() => void run(`/api/settings/versions/${h.versionId}/revert`, {})}>Undo</button>}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </article>
  );
}

export default function SettingsList({ view }: { view: SettingsView }) {
  return (
    <>
      {view.areas.map((a) => (
        <section key={a.area}>
          <h2>{a.title}</h2>
          {a.settings.map((s) => <SettingCard key={s.key} setting={s} owner={view.owner} channels={view.channels} />)}
        </section>
      ))}
    </>
  );
}
