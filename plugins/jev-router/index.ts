import { Plugin } from "@opencode/plugin";
import {
  DEFAULT_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  distillState,
  suggestSkill,
  suggestionBlock,
  systemOne,
  type Provider,
  type Question,
} from "./jev.js";

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
}

function resolveOpts(raw: Options): Required<Omit<Options, "apiKey">> & { apiKey: string } {
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

    // -- Turn steering: rank the skill roster before each model call --------
    await ctx.session.hook("context", async (event) => {
      try {
        if (!opts.apiKey) return;
        const { data: skills } = await ctx.skill.list();
        if (skills.length === 0) return;
        const state = distillState(
          (event.messages ?? []) as Array<{ role?: string; text?: string; content?: unknown }>,
          opts.maxStateChars,
        );
        if (!state.request) return;
        const winner = await suggestSkill(state.request, state.recent_context, skills.map((s) => ({
          name: s.id,
          description: s.description ?? s.id,
          detail: s.content?.slice(0, 1600),
        })), opts);
        event.system.push({
          type: "text",
          text: suggestionBlock(winner ? [winner] : []),
        });
      } catch (err) {
        // Fail open: never break the agent loop.
        console.error("[jev-router] context hook skipped:", err);
      }
    });

    // -- Permission gating (opt-in): resolve ask via Jev --------------------
    if (opts.autoPermission) {
      await ctx.permission.hook("evaluate", async (event) => {
        try {
          if (!opts.apiKey) return;
          if (event.action === "read") return;
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
            opts,
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
            ...opts,
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
