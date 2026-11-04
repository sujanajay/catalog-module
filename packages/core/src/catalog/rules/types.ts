// M5 channel rules engine: shared shapes (docs/program/requirements/M5-channel-rules.md section 3.2). A rule is one
// checkable statement about one piece of content on one channel; a ruleset is all rules at one version; a snapshot is
// the frozen copy of one ruleset version a batch uses from start to end. Plain value lists and interfaces only, so the
// database schema, the seed and (from M5-S2) the pure evaluate() can all import them.

export const RULE_COMPONENTS = ["image", "title", "bullets", "description", "keywords", "attributes", "size_chart", "a_plus", "video", "file"] as const;
export const RULE_SEVERITIES = ["block", "warn"] as const;
/** How much we trust the source (.runs/2026-11-02-channel-rules.md evidence scale). */
export const EVIDENCE_GRADES = ["documented", "reported", "assumed", "playbook"] as const;
export const RULE_STATUSES = ["draft", "active", "superseded", "retired"] as const;
export const RULE_LANGUAGES = ["en", "ar", "any"] as const;
export const RULE_MARKETS = ["GCC", "IN", "AE", "SA"] as const;
/** The audience words of M2's `audience` attribute; a rule with audience null applies to every audience. */
export const RULE_AUDIENCES = ["women", "men", "unisex", "baby", "kids", "teen"] as const;
export const CONFLICT_SEVERITIES = ["high", "medium", "low"] as const;
export const CONFLICT_STATUSES = ["open", "decided"] as const;
export const RULESET_STATUSES = ["draft", "published"] as const;
export const RULE_OUTCOMES = ["pass", "fail", "not_applicable", "needs_judge"] as const;
export const CHANNEL_STATUSES = ["draft", "active", "retired"] as const;
export const PUSH_METHODS = ["portal_file", "managed_by_channel", "api_read_only"] as const;
export const IMAGE_POLICY_STATUSES = ["active", "retired"] as const;

export type RuleComponent = (typeof RULE_COMPONENTS)[number];
export type RuleSeverity = (typeof RULE_SEVERITIES)[number];
export type EvidenceGrade = (typeof EVIDENCE_GRADES)[number];
export type RuleStatus = (typeof RULE_STATUSES)[number];
export type RuleLanguage = (typeof RULE_LANGUAGES)[number];
export type RuleMarket = (typeof RULE_MARKETS)[number];
export type RuleAudience = (typeof RULE_AUDIENCES)[number];
export type ConflictSeverity = (typeof CONFLICT_SEVERITIES)[number];
export type ConflictStatus = (typeof CONFLICT_STATUSES)[number];
export type RuleOutcome = (typeof RULE_OUTCOMES)[number];
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];
export type PushMethod = (typeof PUSH_METHODS)[number];

/** `categoryScope` value that means every category. */
export const ALL_SCOPE = "all";

/**
 * One version of one rule (M5 3.2 `Rule`). `channel` is a registry channel id or "all"; a rule may name a channel the
 * registry does not hold yet (Myntra), and then applies to no batch until that channel is added (decision D10).
 * `categoryScope` is a list of M2 taxonomy node ids, or ["all"] (decision D9); `datasetScope` keeps the dataset's own
 * scope word(s) exactly. `audience` narrows a rule to some audiences (null: every audience).
 */
export interface Rule {
  id: string;
  version: number;
  rulesetVersion: number;
  channel: string;
  market: RuleMarket | null;
  categoryScope: string[];
  datasetScope: unknown;
  audience: RuleAudience[] | null;
  brandScope: string;
  language: RuleLanguage;
  component: RuleComponent;
  field: string;
  operator: string;
  value: unknown;
  text: string | null;
  declaredSeverity: RuleSeverity;
  evidence: EvidenceGrade;
  confirmedBy: string | null;
  source: string;
  conflictsWith: string[];
  checkable: boolean;
  judgeMethod: string | null;
  status: RuleStatus;
  reason: string;
  createdBy: string;
}

export interface Size {
  w: number;
  h: number;
}

export interface ChannelMargins {
  top: number;
  bottom: number;
  left: number;
  right: number;
  unit: "fraction" | "px";
  sidesOnlyWhenWide?: boolean;
}

/**
 * One version of one channel in the registry: what `ChannelSpec` in channels.ts holds, plus markets, languages,
 * status, push method, file kind and owner (M5 3.2). Those six start empty or null for the seeded channels and are
 * filled by an admin (M5-S5) or M9, never guessed (decision D11).
 */
export interface ChannelRecord {
  id: string;
  version: number;
  rulesetVersion: number;
  label: string;
  group: "P1" | "P2";
  minCanvas: Size;
  targetCanvas: Size;
  margins: ChannelMargins;
  anchor: "centre" | "bottom-centre";
  background: string;
  firstImageBackground: string | null;
  dpi: number;
  fixedCanvas: boolean;
  uniformScaleDefault: boolean;
  sheetText: string;
  notes: string | null;
  markets: string[];
  languages: string[];
  status: ChannelStatus;
  pushMethod: PushMethod | null;
  fileKind: string | null;
  owner: string | null;
  reason: string;
  createdBy: string;
}

/** One version of the ordered shot list for a channel x taxonomy node (M3-F4, stored here). */
export interface ImagePolicy {
  channel: string;
  nodeId: string;
  version: number;
  rulesetVersion: number;
  /** Layer A: required photograph roles in order; "FM|FL" means either role fills the slot. */
  roles: string[];
  /** Layer B: add-on slots such as size chart and video. */
  addOns: string[];
  minCount: number | null;
  maxCount: number | null;
  evidence: EvidenceGrade;
  source: string;
  status: (typeof IMAGE_POLICY_STATUSES)[number];
  reason: string;
  createdBy: string;
}

export interface ConflictDecision {
  id: string;
  option: string;
  reason: string;
  decidedBy: string;
  decidedAt: string;
  rulesetVersion: number;
}

export interface ConflictRecord {
  id: string;
  topic: string;
  severity: ConflictSeverity;
  ruleIds: string[];
  options: string[];
  recommendation: string;
  reasoning: string;
  status: ConflictStatus;
  decision: ConflictDecision | null;
}

/** A taxonomy node as frozen in a snapshot (M2's tree, decision D1). */
export interface CategoryNode {
  id: string;
  parentId: string | null;
  level: string;
  name: string;
  status: string;
}

export interface RulesetSnapshot {
  id: string;
  version: number;
  /** sha256 of the snapshot content without `publishedAt`, so the same content always hashes the same. */
  hash: string;
  publishedAt: string;
  rules: Rule[];
  channels: ChannelRecord[];
  categories: CategoryNode[];
  imagePolicies: ImagePolicy[];
  conflicts: ConflictRecord[];
}

/**
 * What is being checked (M5 3.2), the input of evaluate() (M5-S2). `categoryPath` holds M2 node ids (a leaf alone is
 * enough: its parents follow from the dotted id). `value` is the content itself for text (a string; a list of strings
 * for bullets) or a record of measured facts keyed by field name ("image.background.rgb_min" or "background.rgb_min");
 * a text record may carry the text under `text`. `audience` and `brandName` are optional: rules that need them return
 * not_applicable or needs_judge without them (decision D24).
 */
export interface Subject {
  channel: string;
  market: string | null;
  brandId: string;
  brandName?: string | null;
  categoryPath: string[];
  audience?: RuleAudience | null;
  language: "en" | "ar";
  component: RuleComponent;
  contentVersionId: string | null;
  value: unknown;
}

export interface RuleResult {
  ruleId: string;
  ruleVersion: number;
  outcome: RuleOutcome;
  effectiveSeverity: RuleSeverity;
  measured: unknown;
  message: string;
}
