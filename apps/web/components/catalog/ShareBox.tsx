"use client";
import { useState } from "react";
export default function ShareBox({ email }: { email: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="sa">Share it with <code>{email}</code> <button className="btn ghost sm" type="button" onClick={async () => { await navigator.clipboard.writeText(email); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied" : "Copy"}</button><p className="help">Viewer is enough; we only read. We never change your files.</p></div>;
}
