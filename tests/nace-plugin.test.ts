import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { drexError, drexAnswer, startFakeNace, type FakeNace, type Recorded } from "./fake-nace";

// index.ts imports the host's SDK, which is only installed under plugins/jev-router.
// The plugin's own logic is what runs here, so the SDK is stood in for. The module has
// to be mocked before index.ts loads, hence the dynamic import.
mock.module("@opencode/plugin", () => ({ Plugin: { define: (spec: unknown) => spec } }));
const { default: plugin } = (await import("../plugins/jev-router/index")) as { default: { setup: (ctx: any) => Promise<void> } };

type Handler = (event: any) => unknown;

/** The slice of the OpenCode plugin context that setup touches. Every hook the plugin registers lands in `handlers`. */
function stubContext(options: Record<string, unknown>) {
  const handlers: Handler[] = [];
  const permissionHandlers: Handler[] = [];
  const hook = async (_name: string, fn: Handler) => void handlers.push(fn);
  const noop = async () => undefined;
  const ctx = {
    options,
    model: { list: async () => [] },
    skill: { list: async () => ({ data: [{ name: "pdf-fill", description: "fill pdfs" }] }) },
    session: { hook, switchAgent: noop, context: noop },
    tool: { hook, list: async () => ({ data: [{ id: "shell", description: "run a command" }] }), transform: noop },
    permission: { hook: async (_name: string, fn: Handler) => void permissionHandlers.push(fn) },
  };
  return { ctx: ctx as any, handlers, permissionHandlers };
}

describe("the plugin against nace", () => {
  let fake: FakeNace;
  let errors: string[];
  let errorSpy: ReturnType<typeof spyOn>;
  let fetchSpy: ReturnType<typeof spyOn>;
  const saved = { ...process.env };
  beforeEach(() => {
    fake = startFakeNace();
    errors = [];
    errorSpy = spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
    fetchSpy = spyOn(globalThis, "fetch");
    for (const k of Object.keys(process.env)) if (/^(JEV_|NACE_|TYPESAFE_|OPENROUTER_)/.test(k)) delete process.env[k];
    Object.assign(process.env, {
      NACE_API_KEY: "nace_sk_testkey",
      NACE_BASE_URL: `${fake.url}/v1`,
      TYPESAFE_API_KEY: "ts-key",
      TYPESAFE_ENDPOINT: fake.url,
    });
  });
  afterEach(() => {
    errorSpy.mockRestore();
    fetchSpy.mockRestore();
    fake.stop();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  async function setupAndFire(options: Record<string, unknown>) {
    const { ctx, handlers } = stubContext(options);
    await plugin.setup(ctx);
    for (const h of handlers) {
      await Promise.resolve(h({ messages: [{ role: "user", text: "fill the pdf form" }], system: [], action: "write", resources: ["a.txt"], tool: "shell", args: {}, input: {}, output: {} })).catch(() => undefined);
    }
  }

  test("an unknown JEV_PROVIDER: setup returns, prints one line naming the valid values, and sends nothing anywhere", async () => {
    process.env["JEV_PROVIDER"] = "nace_sk_pasted_by_mistake";
    await setupAndFire({});
    expect(errors).toEqual([
      "[jev-router] unknown JEV_PROVIDER (valid values: typesafe, openrouter, nace); Jev calls will be skipped (fail open).",
    ]);
    expect(fake.requests).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a typo in the provider option behaves the same", async () => {
    await setupAndFire({ provider: "naec" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("unknown provider option (valid values: typesafe, openrouter, nace)");
    expect(errors[0]).not.toContain("naec");
    expect(fake.requests).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("the same setup with the provider spelled right does call Nace", async () => {
    process.env["JEV_PROVIDER"] = "nace";
    await setupAndFire({});
    expect(errors.filter((e) => /unknown|No API key/.test(e))).toEqual([]);
    expect(fake.requests.length).toBeGreaterThan(0);
  });

  test.each([[42], [true], [{}], [["nace"]]])("a provider option that is not a string (%j) still loads the plugin, prints the one fixed line and sends nothing", async (provider) => {
    await setupAndFire({ provider });
    expect(errors).toEqual([
      "[jev-router] unknown provider option (valid values: typesafe, openrouter, nace); Jev calls will be skipped (fail open).",
    ]);
    expect(fake.requests).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe("the permission hook", () => {
    const hostRule = () => ({ action: "write", resources: ["a.txt"], sessionID: "s1", effect: "allow", message: undefined as string | undefined });

    async function evaluate(options: Record<string, unknown>) {
      process.env["JEV_PROVIDER"] = "nace";
      const { ctx, permissionHandlers } = stubContext({ clarify: "off", ...options });
      await plugin.setup(ctx);
      const event = hostRule();
      for (const h of permissionHandlers) await h(event);
      return { event, registered: permissionHandlers.length };
    }

    const deny = (r: Recorded) => {
      const res = drexAnswer(r);
      return res.json().then((body: any) => {
        if (body.answers.verdict) body.answers.verdict = { type: "choice", choice: "deny", confidence: 0.9, probabilities: { allow: 0.05, ask: 0.05, deny: 0.9 } };
        return Response.json(body);
      });
    };

    test("autoPermission is off by default: with clarify on and calm, no verdict is asked for and the host's rule stands", async () => {
      fake.respond = async (r) => {
        const body = await (await drexAnswer(r)).json();
        for (const [id, q] of Object.entries<any>(r.body.questions)) if (q.type === "noul") body.answers[id].noul = 0.1;
        return Response.json(body);
      };
      const { event } = await evaluate({ clarify: "suggest" });
      expect(fake.requests).toHaveLength(1);
      expect(Object.keys(fake.requests[0].body.questions)).toEqual(["underspecified"]);
      expect(event.effect).toBe("allow");
      expect(event.message).toBeUndefined();
    });

    test("autoPermission off and clarify off registers no permission hook at all", async () => {
      const { registered } = await evaluate({});
      expect(registered).toBe(0);
      expect(fake.requests).toHaveLength(0);
    });

    test("autoPermission on does ask for the verdict and applies it", async () => {
      fake.respond = deny;
      const { event } = await evaluate({ autoPermission: true });
      expect(Object.keys(fake.requests[0].body.questions)).toEqual(["verdict", "risk"]);
      expect(event.effect).toBe("deny");
      expect(event.message).toContain("verdict=deny");
    });

    test.each([
      ["a 401", () => drexError(401, "authentication_error")],
      ["a 500", () => drexError(500, "internal_error")],
      ["an answer with no verdict", () => Response.json({ model: "drex-max-v1.1", answers: {} })],
    ])("%s leaves the host's rule alone: no deny, no ask, no message", async (_name, respond) => {
      fake.respond = respond;
      const { event } = await evaluate({ autoPermission: true });
      expect(fake.requests).toHaveLength(1);
      expect(event.effect).toBe("allow");
      expect(event.message).toBeUndefined();
    });
  });
});
