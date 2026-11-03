"use client";
import { useState } from "react";
/**
 * The sharing line (M1-F2-R1): always at the top of the input card, before anything is pasted, so
 * the operator can share a Google Sheet or Drive folder first. Copy puts the address on the clipboard.
 */
export default function ShareBox({ email }: { email: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="sa">To use a Google Sheet or Drive folder, share it with <code>{email}</code> as Viewer. <button className="btn ghost sm" type="button" onClick={async () => { await navigator.clipboard.writeText(email); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied" : "Copy"}</button><p className="help">Viewer is enough; we only read. We never change your files.</p></div>;
}
