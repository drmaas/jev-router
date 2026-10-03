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
