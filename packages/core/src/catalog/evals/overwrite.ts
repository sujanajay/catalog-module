// Overwrite contract (spec 10 section 8): a second delivery with one photo altered and one shot
// dropped keeps every link, changes only the altered shot's generation on the selected channels,
// removes the dropped shot's objects there, leaves unselected channels untouched, and records the
// right `change` values and events. An identical third delivery changes nothing and costs nothing.
import type { ChannelId } from "../types";
import { judge, type CheckResult, type CheckSubject } from "./types";

export interface LiveRow { identifier: string; n: number; channel: ChannelId; publicUrl: string; objectPath: string; generation: number | null }
export interface OverwriteInput {
  before: LiveRow[];
  after: LiveRow[];
  selected: ChannelId[];
  altered: { identifier: string; n: number };
  removed: { identifier: string; n: number };
  changes: Map<string, string | null>;
  events: { identifier: string; kind: string }[];
  /** 404 observed on the removed links after the cache window (per public URL). */
  removedGone: Map<string, boolean>;
  report: { removedLinks: number; notRefreshedChannels: ChannelId[] };
  recheck: { ok: number | null; total: number | null };
}

export function checkOverwrite(input: OverwriteInput): CheckResult[] {
  const O = "overwrite" as const, out: CheckResult[] = [], all: CheckSubject = { identifier: "*", n: null, channel: null };
  const key = (r: Pick<LiveRow, "identifier" | "n" | "channel">) => `${r.identifier}|${r.channel}|${r.n}`;
  const afterBy = new Map(input.after.map(r => [key(r), r]));
  let sameUrl = 0, urlChanged = 0, newGen = 0, staleGen = 0, untouchedChanged = 0, removedLive = 0, removedCount = 0;
  for (const row of input.before) {
    const who: CheckSubject = { identifier: row.identifier, n: row.n, channel: row.channel }, next = afterBy.get(key(row));
    const selected = input.selected.includes(row.channel);
    const isRemoved = row.identifier === input.removed.identifier && row.n === input.removed.n && selected;
    const isAltered = row.identifier === input.altered.identifier && row.n === input.altered.n && selected;
    if (isRemoved) {
      removedCount++;
      if (next) removedLive++;
      const gone = input.removedGone.get(row.publicUrl) === true;
      out.push(judge(!next && gone, "overwrite.removed_gone", O, who, next ? "still live" : gone ? "404" : "still served", "404", "GET", !next && gone ? "The removed shot's link is gone." : next ? "The removed shot is still live." : "The removed shot's link still serves bytes after the cache window."));
      continue;
    }
    if (!next) { out.push(judge(false, "overwrite.same_links", O, who, "missing", row.publicUrl, "url", "An output that should stay live disappeared.")); continue; }
    if (next.publicUrl === row.publicUrl && next.objectPath === row.objectPath) sameUrl++; else urlChanged++;
    if (isAltered) { if (next.generation !== row.generation) newGen++; else staleGen++; }
    else if (next.generation !== row.generation) { untouchedChanged++; out.push(judge(false, "overwrite.untouched_unchanged", O, who, String(next.generation), String(row.generation), "generation", selected ? "An unchanged shot got a new generation." : "A channel the batch did not select was rewritten.")); }
  }
  out.push(judge(urlChanged === 0 && sameUrl > 0, "overwrite.same_links", O, all, urlChanged, 0, "links changed", urlChanged ? `${urlChanged} links changed address.` : `All ${sameUrl} remaining links kept their address.`));
  out.push(judge(staleGen === 0 && newGen > 0, "overwrite.altered_new_generation", O, all, `${newGen} new, ${staleGen} stale`, `${input.selected.length} new, 0 stale`, "generations", staleGen ? "The altered photo kept an old generation on some channel." : "The altered photo got a new generation on every selected channel."));
  out.push(judge(untouchedChanged === 0, "overwrite.untouched_unchanged", O, all, untouchedChanged, 0, "generations changed", untouchedChanged ? `${untouchedChanged} untouched outputs were rewritten.` : "Every untouched output kept its generation."));
  out.push(judge(removedLive === 0 && removedCount === input.selected.length, "overwrite.removed_not_live", O, all, removedLive, 0, "still live", removedLive ? `${removedLive} outputs of the removed shot are still live.` : "The removed shot is not live on any selected channel."));
  const unselected = [...new Set(input.before.map(r => r.channel))].filter(ch => !input.selected.includes(ch));
  out.push(judge(unselected.every(ch => input.report.notRefreshedChannels.includes(ch)), "overwrite.not_refreshed_listed", O, all, input.report.notRefreshedChannels.join(",") || "none", unselected.join(",") || "none", "channels", "Channels the batch did not select are listed as not refreshed."));
  out.push(judge(input.report.removedLinks === removedCount, "overwrite.removed_links_reported", O, all, input.report.removedLinks, removedCount, "links", "The report lists every removed link."));
  const removedChange = input.changes.get(input.removed.identifier), alteredChange = input.changes.get(input.altered.identifier);
  out.push(judge(removedChange === "shots_removed", "overwrite.change_shots_removed", O, { identifier: input.removed.identifier, n: null, channel: null }, removedChange ?? "none", "shots_removed", "change", `The product that lost a shot shows change ${removedChange ?? "none"}.`));
  if (input.altered.identifier !== input.removed.identifier) out.push(judge(alteredChange === "updated", "overwrite.change_updated", O, { identifier: input.altered.identifier, n: null, channel: null }, alteredChange ?? "none", "updated", "change", `The product with the altered photo shows change ${alteredChange ?? "none"}.`));
  const others = [...input.changes].filter(([id]) => id !== input.altered.identifier && id !== input.removed.identifier);
  out.push(judge(others.every(([, c]) => c === "unchanged"), "overwrite.change_unchanged", O, all, others.filter(([, c]) => c !== "unchanged").length, 0, "products", "Every other product is unchanged."));
  out.push(judge(input.events.some(e => e.kind === "overwritten") && input.events.some(e => e.kind === "shots_removed"), "overwrite.events", O, all, [...new Set(input.events.map(e => e.kind))].join(","), "overwritten, shots_removed", "events", "The overwritten and shots_removed events were written."));
  out.push(judge(input.recheck.ok !== null && input.recheck.ok === input.recheck.total, "overwrite.recheck", O, all, `${input.recheck.ok} of ${input.recheck.total}`, "N of N", "links", "The independent re-check of the new sheet is complete."));
  return out;
}

export interface IdenticalInput { before: LiveRow[]; after: LiveRow[]; changes: Map<string, string | null>; work: { matte: number; render: number; copy: number }; events: { kind: string }[] }
export function checkIdentical(input: IdenticalInput): CheckResult[] {
  const O = "overwrite" as const, all: CheckSubject = { identifier: "*", n: null, channel: null };
  const key = (r: LiveRow) => `${r.identifier}|${r.channel}|${r.n}|${r.generation}`;
  const same = input.before.length === input.after.length && input.before.every(r => input.after.some(a => key(a) === key(r)));
  return [
    judge(same, "overwrite.identical_generations", O, all, input.after.length, input.before.length, "live outputs", same ? "An identical re-upload kept every generation." : "An identical re-upload changed a generation or a link."),
    judge(input.work.matte === 0 && input.work.render === 0 && input.work.copy === 0, "overwrite.identical_zero_work", O, all, `${input.work.matte} mattes, ${input.work.render} renders, ${input.work.copy} copies`, "0, 0, 0", "calls", "An identical re-upload must cost nothing."),
    judge([...input.changes.values()].every(c => c === "unchanged") && input.events.some(e => e.kind === "unchanged"), "overwrite.identical_change", O, all, [...new Set(input.changes.values())].join(","), "unchanged", "change", "Every product of an identical re-upload is unchanged."),
  ];
}
