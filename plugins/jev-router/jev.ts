// Shared Jev client + state distillation. No dependency on @opencode/plugin,
// so Cursor-side TS (if ever needed) and unit tests can import it directly.

export const DEFAULT_ENDPOINT = "https://api.typesafe.ai";
export const DEFAULT_OPENROUTER_ENDPOINT = "https://openrouter.ai";
export const DEFAULT_MODEL = "jev-latest";
export const DEFAULT_OPENROUTER_MODEL = "typesafe/jev-1.13";

export type Provider = "typesafe" | "openrouter";

export interface JevOptions {
  apiKey: string;
  provider?: Provider;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
}

export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string }
  | { type: "score"; instructions: string; criteria: string[] };

export interface SystemOneResponse {
  model: string;
  answers: Record<string, any>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class JevError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(`${status}: ${message}`);
  }
}

/** Resolve the request URL + model for a provider. Exported for tests. */
export function decisionsRequest(opts: JevOptions): { url: string; model: string } {
  const provider = opts.provider ?? "typesafe";
  if (provider === "openrouter") {
    const base = (opts.endpoint || DEFAULT_OPENROUTER_ENDPOINT).replace(/\/$/, "");
    const path = base.endsWith("/api/alpha/decisions") ? "" : "/api/alpha/decisions";
    return { url: `${base}${path}`, model: opts.model ?? DEFAULT_OPENROUTER_MODEL };
  }
  const base = (opts.endpoint || DEFAULT_ENDPOINT).replace(/\/$/, "");
  return { url: `${base}/v1/systemone`, model: opts.model ?? DEFAULT_MODEL };
}

/** POST a decision request with a hard timeout. Returns null on any failure (fail open). */
export async function systemOne(
  state: unknown,
  questions: Record<string, Question>,
  opts: JevOptions,
): Promise<SystemOneResponse | null> {
  const { url, model } = decisionsRequest(opts);
  const timeoutMs = opts.timeoutMs ?? 8000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({ state, questions, model }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as SystemOneResponse;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Ranked [name, prob] pairs from a Choice answer, best first. */
export function ranked(choiceAnswer: any): Array<[string, number]> {
  const probs = choiceAnswer?.probabilities ?? {};
  return Object.entries(probs)
    .map(([k, v]) => [k, Number(v)] as [string, number])
    .sort((a, b) => b[1] - a[1]);
}

/** Confidence = top probability minus mean of the rest (matches TypeSafe docs). */
export function confidence(probs: Record<string, number>): number {
  const vals = Object.values(probs).map(Number).sort((a, b) => b - a);
  if (vals.length < 2) return vals[0] ?? 0;
  const rest = vals.slice(1).reduce((s, v) => s + v, 0) / (vals.length - 1);
  return vals[0] - rest;
}

// ---------------------------------------------------------------------------
// State distillation. Jev caps state at 32k tokens; the agent transcript is far
// larger, so the plugin compresses recent history into < maxChars of prose.
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role?: string;
  text?: string;
  content?: unknown;
}

function messageText(m: ChatMessage): string {
  if (typeof m.text === "string") return m.text;
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) =>
        typeof p === "string"
          ? p
          : typeof p?.text === "string"
            ? p.text
            : "",
      )
      .join(" ")
      .trim();
  }
  return "";
}

/**
 * Distil the tail of a transcript into a short state object:
 * last user request, last tool outcome, current phase hint.
 */
export function distillState(
  messages: ChatMessage[],
  maxChars = 4000,
): { request: string; recent_context: string } {
  const texts = messages.map((m) => ({
    role: m.role ?? "unknown",
    text: messageText(m).slice(0, 1500),
  }));
  const lastUser = [...texts].reverse().find((m) => m.role === "user");
  const tail = texts.slice(-6).map((m) => `${m.role}: ${m.text}`);
  let recent = tail.join("\n");
  if (recent.length > maxChars) recent = recent.slice(-maxChars);
  return {
    request: lastUser?.text.slice(0, 2000) ?? "",
    recent_context: recent,
  };
}

// ---------------------------------------------------------------------------
// Two-call skill suggestion (TypeSafe skill_suggestion cookbook, condensed).
// Call 1: Choice over the full roster + 3 gate Nouls in one request.
// Call 2: Choice over the top-3 shortlist + one fits-Noul per candidate.
// Returns at most one skill name, or null for "suggest nothing".
// ---------------------------------------------------------------------------

export const GATE_QUESTIONS: Record<string, string> = {
  acts_on_user_system:
    "Is the assistant being asked to act on the user's files, accounts, devices, or online services, rather than only to explain or advise?",
  would_follow_documented_procedure:
    "Would a careful expert answering this consult a specific documented procedure or set of commands, rather than answering from general understanding?",
  prose_suffices:
    "Could a knowledgeable generalist fully satisfy this request in prose, with no tools, no documentation, and no access to the user's files or accounts?",
};

const INVERTED = new Set(["prose_suffices"]);

export interface RosterEntry {
  name: string;
  description: string;
  detail?: string;
}

export async function suggestSkill(
  request: string,
  recentContext: string,
  roster: RosterEntry[],
  opts: JevOptions & { gateThreshold?: number; fitsThreshold?: number },
): Promise<string | null> {
  if (roster.length === 0) return null;
  const gateThreshold = opts.gateThreshold ?? 0.3;
  const fitsThreshold = opts.fitsThreshold ?? 0.3;
  const state = { request, recent_context: recentContext };

  const wideQuestions: Record<string, Question> = {
    which: {
      type: "choice",
      instructions:
        "Which of these skills, if any, is the right one to load to help with the user's latest request?",
      criteria: Object.fromEntries(
        roster.map((s) => [s.name, s.description]),
      ),
    },
  };
  for (const [key, text] of Object.entries(GATE_QUESTIONS)) {
    wideQuestions[`gate::${key}`] = { type: "noul", instructions: text };
  }
  const wide = await systemOne(state, wideQuestions, opts);
  if (!wide) return null;

  const gateVals = Object.entries(wide.answers)
    .filter(([k]) => k.startsWith("gate::"))
    .map(([k, a]) => {
      const v = Number(a?.noul ?? 0.5);
      return INVERTED.has(k.slice(6)) ? 1 - v : v;
    });
  const gate = gateVals.reduce((s, v) => s + v, 0) / Math.max(1, gateVals.length);
  if (gate < gateThreshold) return null;

  const order = ranked(wide.answers["which"]).slice(0, 3);
  if (order.length === 0) return null;
  const shortlist = order.map(([name]) => name);
  const byName = new Map(roster.map((s) => [s.name, s]));

  const narrowQuestions: Record<string, Question> = {
    which: {
      type: "choice",
      instructions:
        "Exactly one of these skills is the right one to load for the user's latest request. Which one? Read what each actually does, not just its name.",
      criteria: Object.fromEntries(
        shortlist.map((n) => {
          const e = byName.get(n);
          const detail = e?.detail ?? e?.description ?? n;
          return [n, `${e?.description ?? n} — ${detail.slice(0, 700)}`];
        }),
      ),
    },
  };
  for (const n of shortlist) {
    narrowQuestions[`fits::${n}`] = {
      type: "noul",
      instructions: `Does the skill '${n}' do the specific thing the user's request asks for? It is described as: ${byName.get(n)?.description ?? n}`,
    };
  }
  const narrow = await systemOne(state, narrowQuestions, opts);
  if (!narrow) return null;

  const fits = Object.entries(narrow.answers)
    .filter(([k]) => k.startsWith("fits::"))
    .map(([, a]) => Number(a?.noul ?? 0));
  if (fits.length > 0 && Math.max(...fits) < fitsThreshold) return null;
  const winner = narrow.answers["which"]?.choice;
  return typeof winner === "string" ? winner : null;
}

/** System-prompt block appended after the roster (verbatim from the cookbook). */
export function suggestionBlock(names: string[]): string {
  const body =
    names.length > 0
      ? `Relevant to the current request: ${names.join(", ")}. Ignore this if it does not fit what you actually asked for.`
      : "No skill in the roster appears relevant to this request.";
  return `\n\n<skill_relevance>\n${body}\n</skill_relevance>`;
}

// ---------------------------------------------------------------------------
// Shared guardrail + judgement helpers (tool steering, clarify-vs-act,
// failure advisor, subagent routing, code review). Every hard action must
// pass passesConfidence() and degrade to a nudge on Jev null/timeout.
// ---------------------------------------------------------------------------

export type JudgementMode = "off" | "suggest" | "redirect" | "block";

/** Margin of top choice over runner-up. Below minConfidence -> nudge only. */
export function choiceMargin(choiceAnswer: any): number {
  const probs = choiceAnswer?.probabilities ?? {};
  const vals = Object.values(probs).map(Number).sort((a, b) => b - a);
  if (vals.length === 0) return 0;
  if (vals.length === 1) return vals[0];
  return vals[0] - vals[1];
}

/** True when a Choice answer is confident enough for a hard action. */
export function passesConfidence(choiceAnswer: any, minConfidence: number): boolean {
  if (!choiceAnswer || typeof choiceAnswer.choice !== "string") return false;
  const explicit = Number(choiceAnswer.confidence ?? NaN);
  const margin = choiceMargin(choiceAnswer);
  const conf = Number.isFinite(explicit) ? Math.min(explicit, 1) : margin;
  return conf >= minConfidence && margin >= Math.min(minConfidence, 0.2);
}

/** Audit block appended whenever the plugin redirects/blocks. Gradable. */
export function redirectBlock(kind: string, detail: string, confidence: number): string {
  return `\n\n<jev_redirect kind="${kind}" confidence="${confidence.toFixed(2)}">\n${detail}\n</jev_redirect>`;
}

/** Suggestion (nudge-only) block for tool routing. */
export function toolSuggestionBlock(tool: string, reason: string): string {
  return `\n\n<tool_relevance>\nJev suggests tool '${tool}' for the next step: ${reason} Ignore this if it does not fit what you are actually doing.\n</tool_relevance>`;
}

/** Stable signature for identical-retry detection (sorted keys, truncated). */
export function failureSignature(tool: string, input: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(sortKeys(input));
  } catch {
    s = String(input);
  }
  return `${tool}::${s.slice(0, 500)}`;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, val]) => [k, sortKeys(val)]),
    );
  }
  return v;
}

/** Questions for tool-call steering. Wide call: choice over tools + gates. */
export function toolSteerQuestions(
  tools: Array<{ name: string; description: string }>,
): Record<string, Question> {
  const q: Record<string, Question> = {
    which: {
      type: "choice",
      instructions:
        "The agent is about to act. Which single tool is the right one for this step?",
      criteria: Object.fromEntries(tools.map((t) => [t.name, t.description])),
    },
    "gate::action_needed": {
      type: "noul",
      instructions:
        "Does this step genuinely need a tool call, or would prose / reusing a prior result suffice?",
    },
    "gate::already_done": {
      type: "noul",
      instructions:
        "Has this exact action already succeeded in the recent context, so calling again would be redundant?",
    },
  };
  return q;
}

/** Fits-nouls for the tool shortlist (narrow call). */
export function toolFitsQuestions(names: string[], byDesc: Map<string, string>): Record<string, Question> {
  const q: Record<string, Question> = {
    which: {
      type: "choice",
      instructions:
        "Exactly one of these tools is the right one for this step. Which one?",
      criteria: Object.fromEntries(names.map((n) => [n, byDesc.get(n) ?? n])),
    },
  };
  for (const n of names) {
    q[`fits::${n}`] = {
      type: "noul",
      instructions: `Is '${n}' (${byDesc.get(n) ?? n}) the right tool for this step?`,
    };
  }
  return q;
}

/** Clarify-vs-act gate: is the pending action underspecified? */
export function clarifyQuestions(): Record<string, Question> {
  return {
    underspecified: {
      type: "noul",
      instructions:
        "Is the pending action underspecified, ambiguous, or surprising in this context, such that a careful operator would ask the user first?",
    },
  };
}

/** Failure advisor: what to do after a tool error. */
export function failureQuestions(): Record<string, Question> {
  return {
    next: {
      type: "choice",
      instructions:
        "A tool call just failed. What should the agent do next?",
      criteria: {
        retry_same: "Transient-looking failure; retry the identical call once",
        retry_differently: "Approach looks wrong; change the call or try another tool",
        abort: "Goal is unachievable or further attempts are harmful; stop and report",
        ask_human: "Needs human judgement to proceed safely",
      },
    },
    severity: {
      type: "score",
      instructions: "How severe is this failure if the agent keeps retrying blindly?",
      criteria: ["Harmless to retry", "Wastes time, redirect soon", "Harmful, stop now"],
    },
  };
}

/** Subagent routing choice. Roster entries: id + one-line role. */
export function subagentQuestions(
  subagents: Array<{ name: string; description: string }>,
): Record<string, Question> {
  const criteria: Record<string, string> = { none: "No delegation; handle inline" };
  for (const s of subagents) criteria[s.name] = s.description;
  return {
    delegate: {
      type: "choice",
      instructions:
        "Should this turn be delegated to a subagent, and if so which one? Delegate only when the work is separable and benefits from a fresh context or specialized role.",
      criteria,
    },
  };
}

// -- Code review judgement (two-stage) --------------------------------------

export type ReviewType = "routine" | "adversarial" | "fresh" | "nothing";

/** Stage A: cheap gate — does anything here warrant review at all? */
export function reviewGateQuestion(): Record<string, Question> {
  return {
    needs_review: {
      type: "noul",
      instructions:
        "Did recent changes touch logic, auth, data paths, money, or public APIs — anything where a bug would cost more than a review turn? Typo/comment-only changes do not warrant review.",
    },
  };
}

/** Stage B: which review intensity? Cost ladder encoded in the criteria. */
export function reviewTypeQuestions(): Record<string, Question> {
  return {
    review: {
      type: "choice",
      instructions:
        "Recent changes may warrant review. Pick the cheapest review that covers the risk. Cost ladder: routine (~1 turn, same context checklist) < adversarial (~1-2 turns, actively try to break it) < fresh (~2+ turns on a second model with no prior transcript, only for auth/money/data-loss paths or large diffs). Pick nothing when the gate was borderline and no review is worth a turn.",
      criteria: {
        routine: "Same-context checklist: bugs, edge cases, missing tests",
        adversarial: "Hostile review: security holes, invariant violations, malicious inputs",
        fresh: "Fresh-context review on another model: de-anchored second opinion for high-stakes diffs",
        nothing: "No review worth a turn",
      },
    },
  };
}

/**
 * Reviewer-model choice over the live roster. Policy encoded in the
 * instructions: prefer a different family from the author (de-anchoring is
 * the point), prefer stronger reasoning over speed.
 */
export function reviewerModelQuestions(
  roster: Array<{ id: string; label: string }>,
  authorModel: string,
): Record<string, Question> {
  return {
    reviewer: {
      type: "choice",
      instructions: `Pick the model for a fresh-context code review. The author model was '${authorModel}'. Prefer a different model family (de-anchoring matters more than raw strength); prefer stronger reasoning over speed; never pick the author model when alternatives exist.`,
      criteria: Object.fromEntries(roster.map((m) => [m.id, m.label])),
    },
  };
}

/** Pure threshold application for tool steering (eval + tests). */
export function applyToolThresholds(
  gateAction: number,
  gateRedundant: number, // already_done noul: high => redundant
  fitsMax: number,
  winner: string | null,
  gateThreshold: number,
  fitsThreshold: number,
): { action: "proceed" | "suppress-redundant" | "suggest" | "nothing"; winner: string | null } {
  if (gateAction < gateThreshold) return { action: "nothing", winner: null };
  if (gateRedundant > 1 - gateThreshold) return { action: "suppress-redundant", winner: null };
  if (fitsMax < fitsThreshold || !winner) return { action: "nothing", winner: null };
  return { action: "suggest", winner };
}

/** Pure review-type resolution incl. single-model downgrade rule. */
export function resolveReviewType(
  reviewChoice: string | null,
  rosterSize: number,
): ReviewType {
  if (reviewChoice !== "routine" && reviewChoice !== "adversarial" && reviewChoice !== "fresh") {
    return "nothing";
  }
  if (reviewChoice === "fresh" && rosterSize <= 1) return "adversarial";
  return reviewChoice;
}
