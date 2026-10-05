import { Plugin } from "@opencode/plugin";
import {
  DEFAULT_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  applyToolThresholds,
  choiceMargin,
  clarifyQuestions,
  distillState,
  failureQuestions,
  failureSignature,
  passesConfidence,
  redirectBlock,
  resolveReviewType,
  reviewGateQuestion,
  reviewTypeQuestions,
  reviewerModelQuestions,
  subagentQuestions,
  suggestSkill,
  suggestionBlock,
  systemOne,
  toolFitsQuestions,
  toolSteerQuestions,
  toolSuggestionBlock,
  ranked,
  type Provider,
  type Question,
} from "./jev.js";

type Mode3 = "off" | "suggest" | "redirect";

interface Options {
  /** "typesafe" (default) or "openrouter". Auto-detected from env when omitted. */
  provider?: Provider;
  /** TypeSafe API key, or OpenRouter key when provider is openrouter. */
  apiKey?: string;
  endpoint?: string;
  model?: string;
  /** Below this mean gate score, suggest nothing. Default 0.3. */
  gateThreshold?: number;
  /** Drop a shortlist whose best fits-Noul is under this. Default 0.3. */
  fitsThreshold?: number;
  /** When true, the permission hook auto-resolves ask -> allow/deny via Jev. Default false. */
  autoPermission?: boolean;
  /** Per-request timeout in ms. Default 8000. Hooks fail open on timeout. */
  timeoutMs?: number;
  /** Max chars for distilled state. Default 4000. */
  maxStateChars?: number;
  // -- New judgements (all fail open; hard modes need confidence, see docs) --
  /** Tool-call steering: suggest (nudge) or redirect (rewrite call). Default "suggest". */
  toolSteering?: Mode3;
  toolGateThreshold?: number;
  toolFitsThreshold?: number;
  /** Min choice confidence for a hard tool redirect. Default 0.7. */
  toolMinConfidence?: number;
  /** Clarify-vs-act on non-read actions: suggest or block (force ask). Default "suggest". */
  clarify?: "off" | "suggest" | "block";
  /** Failure advisor on tool errors. Redirect = imperative directive. Default "suggest". */
  failureAdvisor?: Mode3;
  /** Subagent routing: suggest or redirect (switchAgent). Default "suggest". */
  subagentRouting?: Mode3;
  /** Min confidence for a hard delegation. Default 0.7. */
  subagentMinConfidence?: number;
  /** Code review: suggest (checklist block) or redirect (require review pass). Default "suggest". */
  review?: Mode3;
  /** When to check for review: stop (completion signals), edits (batches), both. Default "stop". */
  reviewTrigger?: "stop" | "edits" | "both";
  /** Edit/write calls per review check in edits/both mode. Default 3. */
  reviewAfterEdits?: number;
  /** Reviewer model: "auto" (Jev picks from roster) or a pinned model id. Default "auto". */
  reviewModel?: string;
  /** Fallback reviewer roster when the model API is unavailable. */
  reviewModels?: string[];
}

interface Resolved {
  provider: Provider;
  apiKey: string;
  endpoint: string;
  model: string;
  gateThreshold: number;
  fitsThreshold: number;
  autoPermission: boolean;
  timeoutMs: number;
  maxStateChars: number;
  toolSteering: Mode3;
  toolGateThreshold: number;
  toolFitsThreshold: number;
  toolMinConfidence: number;
  clarify: "off" | "suggest" | "block";
  failureAdvisor: Mode3;
  subagentRouting: Mode3;
  subagentMinConfidence: number;
  review: Mode3;
  reviewTrigger: "stop" | "edits" | "both";
  reviewAfterEdits: number;
  reviewModel: string;
  reviewModels: string[];
}

function resolveOpts(raw: Options): Resolved {
  const provider: Provider =
    raw.provider ??
    (process.env["TYPESAFE_API_KEY"] ? "typesafe"
      : process.env["OPENROUTER_API_KEY"] ? "openrouter"
        : "typesafe");
  const keyEnv = provider === "openrouter" ? "OPENROUTER_API_KEY" : "TYPESAFE_API_KEY";
  const defaultModel = provider === "openrouter" ? DEFAULT_OPENROUTER_MODEL : DEFAULT_MODEL;
  return {
    provider,
    apiKey: raw.apiKey ?? process.env[keyEnv] ?? "",
    endpoint: raw.endpoint ?? process.env["TYPESAFE_ENDPOINT"] ?? process.env["JEV_ENDPOINT"] ?? "",
    model: raw.model ?? process.env["TYPESAFE_MODEL"] ?? defaultModel,
    gateThreshold: raw.gateThreshold ?? 0.3,
    fitsThreshold: raw.fitsThreshold ?? 0.3,
    autoPermission: raw.autoPermission ?? false,
    timeoutMs: raw.timeoutMs ?? 8000,
    maxStateChars: raw.maxStateChars ?? 4000,
    toolSteering: raw.toolSteering ?? "suggest",
    toolGateThreshold: raw.toolGateThreshold ?? 0.3,
    toolFitsThreshold: raw.toolFitsThreshold ?? 0.3,
    toolMinConfidence: raw.toolMinConfidence ?? 0.7,
    clarify: raw.clarify ?? "suggest",
    failureAdvisor: raw.failureAdvisor ?? "suggest",
    subagentRouting: raw.subagentRouting ?? "suggest",
    subagentMinConfidence: raw.subagentMinConfidence ?? 0.7,
    review: raw.review ?? "suggest",
    reviewTrigger: raw.reviewTrigger ?? "stop",
    reviewAfterEdits: raw.reviewAfterEdits ?? 3,
    reviewModel: raw.reviewModel ?? "auto",
    reviewModels: raw.reviewModels ?? [],
  };
}

interface FailInfo {
  count: number;
  advised: string | null;
}

interface SessionState {
  pendingNudges: string[];
  audit: string[];
  editCount: number;
  lastReviewEdit: number;
  failures: Map<string, FailInfo>;
}

const EDIT_TOOL = /(edit|write|apply|patch|create)/i;
const COMPLETION_CLAIM =
  /\b(done|complete|completed|finished|fixed|all tests pass|ready( for review)?|lgtm)\b/i;

function jevOptsOf(o: Resolved): {
  apiKey: string;
  provider?: Provider;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
} {
  return {
    apiKey: o.apiKey,
    provider: o.provider,
    endpoint: o.endpoint || undefined,
    model: o.model,
    timeoutMs: o.timeoutMs,
  };
}

export default Plugin.define({
  id: "jev-router",
  async setup(ctx) {
    const opts = resolveOpts((ctx.options ?? {}) as Options);
    if (!opts.apiKey) {
      console.error(
        "[jev-router] No API key set (TYPESAFE_API_KEY or OPENROUTER_API_KEY); Jev calls will be skipped (fail open).",
      );
    }
    const sessions = new Map<string, SessionState>();
    const stateFor = (sid: string): SessionState => {
      let s = sessions.get(sid);
      if (!s) {
        s = { pendingNudges: [], audit: [], editCount: 0, lastReviewEdit: 0, failures: new Map() };
        sessions.set(sid, s);
      }
      return s;
    };

    // Reviewer-model roster: live model list when available, else the option.
    let reviewerRoster: Array<{ id: string; label: string }> = opts.reviewModels.map((m) => ({
      id: m,
      label: m,
    }));
    try {
      const models = await (ctx.model as any)?.list?.();
      if (Array.isArray(models) && models.length > 0) {
        reviewerRoster = models.slice(0, 40).map((m: any) => ({
          id: String(m?.id ?? m?.modelID ?? m?.name ?? JSON.stringify(m)).slice(0, 120),
          label: String(m?.name ?? m?.id ?? "model").slice(0, 160),
        }));
      }
    } catch {
      // Fall back to the reviewModels option (possibly empty -> downgrade fresh).
    }

    // -- Turn steering: rank the skill roster before each model call --------
    // (preserved) + subagent routing nudge + flush of pending tool/review notes.
    await ctx.session.hook("context", async (event) => {
      try {
        const sys = (event as any).system as Array<{ type: string; text: string }>;
        // Drain pending tool/review nudges + redirect audit trail. Queues are
        // consumed once globally (single-session CLI is the norm; entries are
        // advisory text, so cross-session bleed in multi-session use is low harm).
        for (const st of sessions.values()) {
          for (const a of st.audit) sys.push({ type: "text", text: a });
          st.audit = [];
          for (const n of st.pendingNudges) sys.push({ type: "text", text: n });
          st.pendingNudges = [];
        }
        if (!opts.apiKey) return;
        const { data: skills } = await ctx.skill.list();
        const messages = (event.messages ?? []) as Array<{
          role?: string;
          text?: string;
          content?: unknown;
        }>;
        const state = distillState(messages, opts.maxStateChars);
        // Skill steering (existing behavior).
        if (skills.length > 0 && state.request) {
          const winner = await suggestSkill(
            state.request,
            state.recent_context,
            skills.map((s) => ({
              name: s.id,
              description: s.description ?? s.id,
              detail: s.content?.slice(0, 1600),
            })),
            { ...jevOptsOf(opts), gateThreshold: opts.gateThreshold, fitsThreshold: opts.fitsThreshold },
          );
          sys.push({ type: "text", text: suggestionBlock(winner ? [winner] : []) });
        }
        // Subagent routing nudge (suggest-only in v1; redirect via switchAgent
        // happens at prompt time where the session id is known — see below).
        // Kept minimal here: routing verdict is computed in the prompt hook.
      } catch (err) {
        // Fail open: never break the agent loop.
        console.error("[jev-router] context hook skipped:", err);
      }
    });

    // -- Subagent routing + stop-mode review gate at prompt time ------------
    await ctx.session.hook("prompt", async (event) => {
      try {
        if (!opts.apiKey) return;
        const sid = (event as any).sessionID as string;
        const st = stateFor(sid);
        // Flush pending nudges / audit / review blocks into the prompt.
        const prompt = (event as any).prompt;
        const flush = [...st.audit, ...st.pendingNudges];
        st.audit = [];
        st.pendingNudges = [];
        if (flush.length > 0 && prompt && typeof prompt === "object") {
          const extra = flush.join("\n");
          if (typeof (prompt as any).system === "string") (prompt as any).system += extra;
          else if (Array.isArray((event as any).system)) {
            (event as any).system.push({ type: "text", text: extra });
          }
        }
        // Subagent routing verdict (redirect mode: switchAgent when confident).
        if (opts.subagentRouting !== "off") {
          const subagents = [
            { name: "explore", description: "Fast codebase exploration" },
            { name: "general", description: "Multi-step delegated work" },
          ];
          const res = await systemOne(
            { request: String((prompt as any)?.text ?? "").slice(0, 2000) },
            subagentQuestions(subagents),
            jevOptsOf(opts),
          );
          const ans = (res?.answers as any)?.["delegate"];
          const pick = ans?.choice;
          if (pick && pick !== "none" && typeof pick === "string") {
            const conf = Number(ans?.confidence ?? choiceMargin(ans));
            if (opts.subagentRouting === "redirect" && passesConfidence(ans, opts.subagentMinConfidence)) {
              try {
                await ctx.session.switchAgent({ sessionID: sid, agent: pick as any });
                st.audit.push(
                  redirectBlock("subagent", `Delegated to subagent '${pick}'.`, conf),
                );
              } catch {
                st.pendingNudges.push(
                  toolSuggestionBlock(pick, `Delegation suggested (confidence ${conf.toFixed(2)}).`),
                );
              }
            } else {
              st.pendingNudges.push(
                toolSuggestionBlock(pick, `Consider delegating (confidence ${conf.toFixed(2)}).`),
              );
            }
          }
        }
      } catch (err) {
        console.error("[jev-router] prompt hook skipped:", err);
      }
    });

    // -- Tool-call steering: redirect or nudge before execution -------------
    await ctx.tool.hook("execute.before", async (event) => {
      try {
        if (!opts.apiKey || opts.toolSteering === "off") return;
        const ev = event as any;
        if (typeof ev.tool === "string" && ev.tool.startsWith("jev")) return; // no recursion
        const sid = String(ev.sessionID ?? "");
        const st = stateFor(sid);
        const tools = await ctx.tool.list();
        const roster = tools
          .filter((t) => !t.id.startsWith("jev"))
          .slice(0, 40)
          .map((t) => ({ name: t.id, description: (t.description ?? t.id).slice(0, 200) }));
        if (roster.length === 0) return;
        const byDesc = new Map(roster.map((t) => [t.name, t.description]));
        const inputSummary = JSON.stringify(ev.input ?? null).slice(0, 1200);
        const wide = await systemOne(
          { pending_tool: ev.tool, tool_input: inputSummary },
          toolSteerQuestions(roster),
          jevOptsOf(opts),
        );
        if (!wide) return; // fail open
        const gateAction = Number((wide.answers as any)?.["gate::action_needed"]?.noul ?? 0.5);
        const gateRedundant = Number((wide.answers as any)?.["gate::already_done"]?.noul ?? 0);
        const order = ranked((wide.answers as any)?.["which"]).slice(0, 3);
        const shortlist = order.map(([n]) => n);
        let fitsMax = 0;
        let winner: string | null = shortlist[0] ?? null;
        if (shortlist.length > 0) {
          const narrow = await systemOne(
            { pending_tool: ev.tool, tool_input: inputSummary },
            toolFitsQuestions(shortlist, byDesc),
            jevOptsOf(opts),
          );
          if (narrow) {
            const fits = Object.entries((narrow.answers as any) ?? {})
              .filter(([k]) => k.startsWith("fits::"))
              .map(([, a]: [string, any]) => Number(a?.noul ?? 0));
            fitsMax = fits.length > 0 ? Math.max(...fits) : 0;
            const w = (narrow.answers as any)?.["which"];
            winner = typeof w?.choice === "string" ? w.choice : winner;
            if (!passesConfidence(w, opts.toolMinConfidence)) {
              // Low-confidence winner: never redirect, nudge at most.
              const decided = applyToolThresholds(
                gateAction, gateRedundant, fitsMax, winner,
                opts.toolGateThreshold, opts.fitsThreshold,
              );
              if (decided.action === "suggest" && decided.winner && decided.winner !== ev.tool) {
                st.pendingNudges.push(toolSuggestionBlock(decided.winner, "low-confidence alternate."));
              } else if (decided.action === "suppress-redundant") {
                st.pendingNudges.push(
                  `\n\n<tool_relevance>\nThis call looks redundant with recent context; consider reusing the prior result.\n</tool_relevance>`,
                );
              }
              return;
            }
          }
        }
        const decided = applyToolThresholds(
          gateAction, gateRedundant, fitsMax, winner,
          opts.toolGateThreshold, opts.fitsThreshold,
        );
        if (decided.action === "suppress-redundant") {
          // No veto in the API: surface as a strong nudge (flushed next turn).
          st.pendingNudges.push(
            `\n\n<tool_relevance>\nThis '${ev.tool}' call looks redundant with recent context; reuse the prior result instead of re-calling.\n</tool_relevance>`,
          );
          return;
        }
        if (decided.action !== "suggest" || !decided.winner) return;
        if (decided.winner === ev.tool) return;
        if (!byDesc.has(decided.winner)) return;
        if (opts.toolSteering === "redirect") {
          const from = ev.tool as string;
          ev.tool = decided.winner;
          st.audit.push(
            redirectBlock("tool", `Redirected '${from}' -> '${decided.winner}' (fits ${fitsMax.toFixed(2)}).`, fitsMax),
          );
        } else {
          st.pendingNudges.push(toolSuggestionBlock(decided.winner, `fits ${fitsMax.toFixed(2)}. `));
        }
      } catch (err) {
        console.error("[jev-router] tool steering skipped:", err);
      }
    });

    // -- Failure advisor + edit counter after execution ----------------------
    await ctx.tool.hook("execute.after", async (event) => {
      try {
        if (!opts.apiKey) return;
        const ev = event as any;
        const sid = String(ev.sessionID ?? "");
        const st = stateFor(sid);
        const toolName = String(ev.tool ?? "");
        if (/^jev/.test(toolName)) return;
        if (ev.status === "error") {
          const sig = failureSignature(toolName, ev.input);
          const info = st.failures.get(sig) ?? { count: 0, advised: null };
          info.count += 1;
          st.failures.set(sig, info);
          if (opts.failureAdvisor !== "off") {
            const res = await systemOne(
              { failed_tool: toolName, tool_input: JSON.stringify(ev.input ?? null).slice(0, 1200), attempt: info.count },
              failureQuestions(),
              jevOptsOf(opts),
            );
            const next = (res?.answers as any)?.["next"]?.choice;
            if (typeof next === "string") {
              info.advised = next;
              const hard = opts.failureAdvisor === "redirect";
              const directive =
                next === "retry_same"
                  ? null // no intervention needed
                  : hard
                    ? `\n\n<jev_redirect kind="failure" confidence="1.00">\nTool '${toolName}' failed (attempt ${info.count}). Jev verdict: '${next}'. Do NOT retry the identical call; ${next === "abort" ? "stop and report." : next === "ask_human" ? "ask the user before proceeding." : "change the approach or use a different tool."}\n</jev_redirect>`
                    : `\n\n<tool_relevance>\nTool '${toolName}' failed (attempt ${info.count}). Jev suggests '${next}'. Ignore if you have a better read.\n</tool_relevance>`;
              if (directive) {
                try {
                  if (typeof ev.error === "string") ev.error = `${ev.error}${directive}` as any;
                  else if (ev.error && typeof ev.error === "object") {
                    (ev.error as any).message = `${(ev.error as any).message ?? ""}${directive}`;
                  }
                } catch {
                  st.pendingNudges.push(directive);
                }
              }
            }
          }
          return;
        }
        // Success path: edit counting for the review trigger.
        if (EDIT_TOOL.test(toolName)) {
          st.editCount += 1;
          if (
            opts.review !== "off" &&
            (opts.reviewTrigger === "edits" || opts.reviewTrigger === "both") &&
            st.editCount - st.lastReviewEdit >= opts.reviewAfterEdits
          ) {
            await runReviewCheck(sid, st, opts, reviewerRoster, "edits");
          }
        }
      } catch (err) {
        console.error("[jev-router] after-hook skipped:", err);
      }
    });

    async function runReviewCheck(
      sid: string,
      st: SessionState,
      o: Resolved,
      roster: Array<{ id: string; label: string }>,
      why: string,
    ): Promise<void> {
      st.lastReviewEdit = st.editCount;
      const gate = await systemOne(
        { recent_edits: `${st.editCount} edit/write calls this session`, trigger: why },
        reviewGateQuestion(),
        jevOptsOf(o),
      );
      if (!gate) return;
      const p = Number((gate.answers as any)?.["needs_review"]?.noul ?? 0);
      if (p < 0.5) return;
      const typed = await systemOne(
        { recent_edits: `${st.editCount} edit/write calls this session`, trigger: why },
        reviewTypeQuestions(),
        jevOptsOf(o),
      );
      const choice = (typed?.answers as any)?.["review"]?.choice ?? null;
      const kind = resolveReviewType(typeof choice === "string" ? choice : null, roster.length);
      if (kind === "nothing") return;
      const conf = Number((typed?.answers as any)?.["review"]?.confidence ?? choiceMargin((typed?.answers as any)?.["review"]));
      let block: string;
      if (kind === "fresh") {
        let model = o.reviewModel;
        if (model === "auto" && roster.length > 0) {
          let author = "";
          try {
            author = String((await (ctx.session as any)?.get?.(sid))?.model ?? "");
          } catch {
            author = "";
          }
          const pick = await systemOne({ author_model: author || "unknown" }, reviewerModelQuestions(roster, author || "unknown"), jevOptsOf(o));
          const id = (pick?.answers as any)?.["reviewer"]?.choice;
          if (typeof id === "string" && roster.some((m) => m.id === id) && id !== author) {
            model = id;
          } else {
            model = roster.find((m) => m.id !== author)?.id ?? roster[0].id;
          }
        }
        block = o.review === "redirect"
          ? redirectBlock("review", `Fresh-context review REQUIRED on model '${model}': delegate the diff with no prior transcript, then address findings before finishing.`, conf)
          : `\n\n<tool_relevance>\nJev suggests a fresh-context review on model '${model}' (confidence ${conf.toFixed(2)}): delegate the diff with no prior transcript. Ignore if the change is trivial.\n</tool_relevance>`;
      } else if (kind === "adversarial") {
        block = o.review === "redirect"
          ? redirectBlock("review", "Adversarial review REQUIRED: actively try to break the change (security, invariants, hostile inputs) before finishing.", conf)
          : `\n\n<tool_relevance>\nJev suggests an adversarial review pass (confidence ${conf.toFixed(2)}): try to break the change before finishing.\n</tool_relevance>`;
      } else {
        block = o.review === "redirect"
          ? redirectBlock("review", "Routine review REQUIRED: checklist the diff for bugs, edge cases, and missing tests before finishing.", conf)
          : `\n\n<tool_relevance>\nJev suggests a routine review pass (confidence ${conf.toFixed(2)}): checklist the diff before finishing.\n</tool_relevance>`;
      }
      st.pendingNudges.push(block);
    }

    // -- Stop-mode review approximation: completion-claim prefilter ---------
    // OpenCode exposes no stop hook, so "stop" means: the context hook sees a
    // completion claim + edits since the last review. Regex is free; the Jev
    // gate runs only on hits. Cursor gets the precise stop hook (jev_review.py).
    const contextWithStopReview = ctx.session.hook;
    void contextWithStopReview;

    // -- Permission gating (clarify-first, then existing verdict) ------------
    if (opts.autoPermission || opts.clarify !== "off") {
      await ctx.permission.hook("evaluate", async (event) => {
        try {
          if (!opts.apiKey) return;
          if (event.action === "read") return;
          // Clarify-vs-act: underspecified + non-routine -> ask.
          if (opts.clarify !== "off") {
            const c = await systemOne(
              {
                pending_action: event.action,
                resources: [...event.resources].slice(0, 20),
              },
              clarifyQuestions(),
              jevOptsOf(opts),
            );
            const u = Number((c?.answers as any)?.["underspecified"]?.noul ?? 0);
            if (u >= 0.5) {
              event.effect = "ask";
              event.message = `[jev-router] clarify: underspecified (${u.toFixed(2)}); asking the user.`;
              return;
            }
            if (opts.clarify === "suggest" && u >= 0.35) {
              event.message = `[jev-router] clarify note: mildly ambiguous (${u.toFixed(2)}).`;
            }
          }
          if (!opts.autoPermission) return;
          const messages = await ctx.session.context({ sessionID: event.sessionID });
          const state = distillState(
            (messages ?? []) as Array<{ role?: string; text?: string; content?: unknown }>,
            opts.maxStateChars,
          );
          const res = await systemOne(
            {
              ...state,
              pending_action: event.action,
              resources: [...event.resources].slice(0, 20),
            },
            {
              verdict: {
                type: "choice",
                instructions:
                  "The coding agent wants to perform this action. Should it proceed automatically, ask the user first, or be denied?",
                criteria: {
                  allow: "Safe, routine, and reversible in this context",
                  ask: "Potentially destructive, surprising, or needs human judgement",
                  deny: "Dangerous, exfiltrative, or clearly outside the task",
                },
              } satisfies Question,
              risk: {
                type: "score",
                instructions: "How risky is this action in the current context?",
                criteria: ["Routine and reversible", "Needs a second look", "Dangerous, block it"],
              } satisfies Question,
            },
            jevOptsOf(opts),
          );
          const verdict = res?.answers["verdict"]?.choice;
          if (verdict === "allow" || verdict === "ask" || verdict === "deny") {
            event.effect = verdict;
            event.message = `[jev-router] verdict=${verdict} confidence=${Number(res?.answers["verdict"]?.confidence ?? 0).toFixed(2)}`;
          }
        } catch (err) {
          console.error("[jev-router] permission hook skipped:", err);
        }
      });
    }

    // -- Stop-mode review check inside the context hook ----------------------
    // Runs only when: reviewTrigger stop|both, edits happened since last
    // review, and the tail carries a completion claim (cheap regex prefilter).
    if (opts.review !== "off" && (opts.reviewTrigger === "stop" || opts.reviewTrigger === "both")) {
      await ctx.session.hook("context", async (event) => {
        try {
          if (!opts.apiKey) return;
          const messages = (event.messages ?? []) as Array<{ role?: string; text?: string; content?: unknown }>;
          if (messages.length === 0) return;
          // Session id is not exposed on context events; attribute to the
          // single active session when unambiguous.
          const ids = [...sessions.keys()];
          if (ids.length !== 1) return;
          const st = sessions.get(ids[0])!;
          if (st.editCount - st.lastReviewEdit <= 0) return;
          const last = messages[messages.length - 1];
          const text = typeof last?.text === "string" ? last.text : "";
          if (!COMPLETION_CLAIM.test(text)) return;
          await runReviewCheck(ids[0], st, opts, reviewerRoster, "stop");
        } catch (err) {
          console.error("[jev-router] stop-review check skipped:", err);
        }
      });
    }

    // -- On-demand decisions: jev_ask tool ----------------------------------
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "jev",
        description: "System One structured decisions (TypeSafe Jev)",
      });
      editor.add({
        name: "ask",
        description:
          "Ask Jev a typed question (choice/noul/score) about a state. Use for routing, ranking, verification, guardrails. Returns typed answers with probabilities; it never generates text.",
        input: {
          type: "object",
          properties: {
            state: {
              description: "State to judge: object, text, or array of facts. Keep under ~4000 chars.",
            },
            questions: {
              type: "object",
              description:
                'Map of id -> question. Each: {"type":"choice","instructions":str,"criteria":{option:description}} or {"type":"noul","instructions":str} or {"type":"score","instructions":str,"criteria":[level0,level1,...]}.',
              additionalProperties: true,
            },
          },
          required: ["state", "questions"],
          additionalProperties: false,
        },
        options: { namespace: "jev", codemode: true },
        execute: async (input, context) => {
          if (!opts.apiKey) {
            return { content: "jev_ask unavailable: no API key set (TYPESAFE_API_KEY or OPENROUTER_API_KEY)." };
          }
          const { state, questions } = input as {
            state: unknown;
            questions: Record<string, Question>;
          };
          const res = await systemOne(state, questions, {
            ...jevOptsOf(opts),
            timeoutMs: opts.timeoutMs,
          });
          if (!res) return { content: "Jev request failed or timed out." };
          void context;
          return { content: JSON.stringify(res.answers) };
        },
      });
    });
  },
});
