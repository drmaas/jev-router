import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  NACE,
  NACE_CLIENT,
  choiceMargin,
  confidence,
  decisionsRequest,
  naceUrlProblem,
  ranked,
  resolveBackend,
  systemOne,
  type JevOptions,
  type Question,
} from "../plugins/jev-router/jev";
import { REQUEST_ID, drexError, startFakeNace, type FakeNace } from "./fake-nace";

const questions: Record<string, Question> = {
  which: {
    type: "choice",
    instructions: "Which skill?",
    criteria: { "pdf-fill": "fill pdfs", "pptx-author": "write decks" },
  },
  "gate::acts_on_user_system": { type: "noul", instructions: "Acts on files?" },
};

describe("resolveBackend", () => {
  test("nace is chosen by the option or JEV_PROVIDER, with its own key, endpoint and model", () => {
    const env = { NACE_API_KEY: "nace_sk_x", NACE_BASE_URL: "https://console.nace.ai/v1", NACE_MODEL: "drex-latest" };
    for (const b of [resolveBackend({ provider: "nace" }, env), resolveBackend({}, { ...env, JEV_PROVIDER: "nace" })]) {
      expect(b).toEqual({
        provider: "nace",
        apiKey: "nace_sk_x",
        endpoint: "https://console.nace.ai/v1",
        model: "drex-latest",
      });
    }
  });

  test("a NACE_API_KEY alone never selects nace", () => {
    expect(resolveBackend({}, { NACE_API_KEY: "nace_sk_x" }).provider).toBe("typesafe");
    expect(resolveBackend({}, { NACE_API_KEY: "nace_sk_x", OPENROUTER_API_KEY: "sk-or" }).provider).toBe("openrouter");
  });

  test("typesafe and openrouter resolve as before", () => {
    expect(resolveBackend({}, { TYPESAFE_API_KEY: "ts", OPENROUTER_API_KEY: "sk-or" })).toEqual({
      provider: "typesafe",
      apiKey: "ts",
      endpoint: "",
      model: "jev-latest",
    });
    expect(resolveBackend({}, { OPENROUTER_API_KEY: "sk-or", TYPESAFE_ENDPOINT: "https://x" })).toEqual({
      provider: "openrouter",
      apiKey: "sk-or",
      endpoint: "https://x",
      model: "typesafe/jev-1.13",
    });
  });

  test("nace without NACE_API_KEY has no key, whatever other keys and endpoints are set", () => {
    const b = resolveBackend(
      { provider: "nace" },
      { TYPESAFE_API_KEY: "ts", OPENROUTER_API_KEY: "sk-or", TYPESAFE_ENDPOINT: "https://other", TYPESAFE_MODEL: "jev-latest", JEV_ENDPOINT: "https://other" },
    );
    expect(b).toEqual({ provider: "nace", apiKey: "", endpoint: "", model: "drex-max-v1.1", problem: "No API key set (NACE_API_KEY)" });
  });

  test("an empty NACE_BASE_URL or NACE_MODEL means unset, as in the hooks", () => {
    const b = resolveBackend({ provider: "nace" }, { NACE_API_KEY: "k", NACE_BASE_URL: "", NACE_MODEL: "" });
    expect(decisionsRequest(b)).toEqual({ url: "https://console.nace.ai/v1/systemone", model: NACE.defaultModel });
  });

  test("the option beats JEV_PROVIDER", () => {
    expect(resolveBackend({ provider: "openrouter" }, { JEV_PROVIDER: "nace" }).provider).toBe("openrouter");
  });

  test("an unknown provider never throws and never falls back to another one", () => {
    const keys = { TYPESAFE_API_KEY: "ts", OPENROUTER_API_KEY: "sk-or", NACE_API_KEY: "nace_sk_x" };
    const line = (source: string) => `unknown ${source} (valid values: typesafe, openrouter, nace)`;
    const viaOption = resolveBackend({ provider: "nacee", apiKey: "ts" }, keys);
    expect(viaOption.apiKey).toBe("");
    expect(viaOption.problem).toBe(line("provider option"));
    const viaEnv = resolveBackend({}, { ...keys, JEV_PROVIDER: "Drex" });
    expect(viaEnv.apiKey).toBe("");
    expect(viaEnv.problem).toBe(line("JEV_PROVIDER"));
  });

  test.each([[42], [true], [{}], [["nace"]]])("a provider option that is not a string (%j) is an unknown provider, not a crash", (option) => {
    const b = resolveBackend({ provider: option }, { TYPESAFE_API_KEY: "ts", NACE_API_KEY: "nace_sk_x" });
    expect(b.apiKey).toBe("");
    expect(b.problem).toBe("unknown provider option (valid values: typesafe, openrouter, nace)");
  });

  test("a null or empty provider option is unset: JEV_PROVIDER or key detection decides", () => {
    for (const option of [null, "", "  "]) {
      expect(resolveBackend({ provider: option }, { JEV_PROVIDER: "nace", NACE_API_KEY: "k" }).provider).toBe("nace");
      expect(resolveBackend({ provider: option }, { OPENROUTER_API_KEY: "sk-or" }).provider).toBe("openrouter");
    }
  });

  test("the unknown-provider line never echoes what was set, which may be a key pasted into the wrong variable", () => {
    const pasted = "nace_sk_pasted_by_mistake";
    expect(resolveBackend({}, { JEV_PROVIDER: pasted }).problem).not.toContain(pasted);
    expect(resolveBackend({ provider: pasted }, {}).problem).not.toContain(pasted);
  });

  test("a valid provider option wins over a bad JEV_PROVIDER, and names are case and space insensitive", () => {
    expect(resolveBackend({ provider: "openrouter" }, { JEV_PROVIDER: "nacee", OPENROUTER_API_KEY: "sk-or" }).problem).toBeUndefined();
    expect(resolveBackend({}, { JEV_PROVIDER: "  NACE ", NACE_API_KEY: "k" }).provider).toBe("nace");
    expect(resolveBackend({}, { JEV_PROVIDER: "" }).provider).toBe("typesafe");
  });

  test("with only NACE_API_KEY set the missing-key hint says Nace needs JEV_PROVIDER=nace", () => {
    const hint = resolveBackend({}, { NACE_API_KEY: "nace_sk_x" }).problem;
    expect(hint).toBe(
      "No API key set (TYPESAFE_API_KEY or OPENROUTER_API_KEY); NACE_API_KEY is set, but Nace needs JEV_PROVIDER=nace",
    );
  });

  test("the missing-key hint is the one the TypeSafe user always had when no Nace key is set", () => {
    expect(resolveBackend({}, {}).problem).toBe("No API key set (TYPESAFE_API_KEY or OPENROUTER_API_KEY)");
    expect(resolveBackend({}, { TYPESAFE_API_KEY: "ts" }).problem).toBeUndefined();
  });

  test("a missing Nace key names NACE_API_KEY only", () => {
    expect(resolveBackend({ provider: "nace" }, { TYPESAFE_API_KEY: "ts" }).problem).toBe("No API key set (NACE_API_KEY)");
  });
});

describe("a selected backend reads only its own settings", () => {
  let fake: FakeNace;
  let other: FakeNace;
  beforeEach(() => {
    fake = startFakeNace();
    other = startFakeNace();
  });
  afterEach(() => {
    fake.stop();
    other.stop();
  });
  const naceEnv = () => ({ NACE_API_KEY: "nace_sk_envkey", NACE_BASE_URL: `${fake.url}/v1` });
  const send = (options: Parameters<typeof resolveBackend>[0], env: Record<string, string>) =>
    systemOne({}, questions, { ...resolveBackend(options, env), timeoutMs: 2000 });

  test("the generic model option, which the repo's own opencode.jsonc sets to jev-latest, never reaches a Nace request", async () => {
    await send({ provider: "nace", model: "jev-latest" }, naceEnv());
    expect(fake.requests[0].body.model).toBe(NACE.defaultModel);
  });

  test("the generic endpoint option never receives the Nace key", async () => {
    await send({ provider: "nace", endpoint: other.url }, naceEnv());
    expect(other.requests).toHaveLength(0);
    expect(fake.requests).toHaveLength(1);
  });

  test("the generic apiKey option is never sent to Nace", async () => {
    await send({ provider: "nace", apiKey: "ts-key-from-options" }, naceEnv());
    expect(fake.requests[0].headers.get("authorization")).toBe("Bearer nace_sk_envkey");
  });

  test("Nace settings never reach a TypeSafe or OpenRouter request", async () => {
    const env = { ...naceEnv(), NACE_MODEL: "drex-max-v1.1", TYPESAFE_API_KEY: "ts-key", TYPESAFE_ENDPOINT: other.url };
    await send({}, env);
    expect(fake.requests).toHaveLength(0);
    expect(other.requests[0].headers.get("authorization")).toBe("Bearer ts-key");
    expect(other.requests[0].body.model).toBe("jev-latest");
    expect(other.requests[0].headers.get("x-nace-client")).toBeNull();
    const or = resolveBackend({}, { ...naceEnv(), NACE_MODEL: "drex-max-v1.1", OPENROUTER_API_KEY: "sk-or" });
    expect(or).toEqual({ provider: "openrouter", apiKey: "sk-or", endpoint: "", model: "typesafe/jev-1.13" });
  });
});

describe("decisionsRequest nace", () => {
  test("default is console.nace.ai /v1/systemone on drex-max-v1.1", () => {
    expect(decisionsRequest({ apiKey: "k", provider: "nace" })).toEqual({
      url: "https://console.nace.ai/v1/systemone",
      model: "drex-max-v1.1",
    });
  });
  test("the default is a fixed model id, not an alias", () => {
    expect(NACE.defaultModel).toMatch(/^drex-[a-z0-9.-]+$/);
    expect(NACE.defaultModel).not.toContain("latest");
  });
  test("endpoint and model overrides", () => {
    expect(decisionsRequest({ apiKey: "k", provider: "nace", endpoint: "https://drex.nace.ai/v1/", model: "drex-latest" })).toEqual({
      url: "https://drex.nace.ai/v1/systemone",
      model: "drex-latest",
    });
  });
});

describe("naceUrlProblem", () => {
  test("https and loopback http are fine", () => {
    expect(naceUrlProblem("https://console.nace.ai/v1/systemone")).toBeNull();
    expect(naceUrlProblem("http://127.0.0.1:3000/v1/systemone")).toBeNull();
    expect(naceUrlProblem("http://localhost:3000/v1/systemone")).toBeNull();
    expect(naceUrlProblem("http://[::1]:3000/v1/systemone")).toBeNull();
  });

  test("each refusal says its own reason, not a hint that fits only one of them", () => {
    expect(naceUrlProblem("http://console.nace.ai/v1/systemone")).toBe("plain http is only allowed to localhost, 127.0.0.1 or ::1");
    expect(naceUrlProblem("https://user:pw@console.nace.ai/v1/systemone")).toBe("the URL contains credentials");
    expect(naceUrlProblem("ftp://console.nace.ai/v1/systemone")).toBe("the scheme must be https");
    expect(naceUrlProblem("not a url")).toBe("not a valid URL");
  });
});

describe("systemOne against nace", () => {
  let fake: FakeNace;
  let errors: string[];
  let spy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    fake = startFakeNace();
    errors = [];
    spy = spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
  });
  afterEach(() => {
    spy.mockRestore();
    fake.stop();
  });
  const nace = () => ({ apiKey: "nace_sk_testkey", provider: "nace" as const, endpoint: `${fake.url}/v1`, timeoutMs: 2000 });

  test("sends the attribution header, bearer key, default model and the question ids", async () => {
    const res = await systemOne({ request: "fill the form" }, questions, nace());
    expect(res).not.toBeNull();
    const [r] = fake.requests;
    expect(r.path).toBe("/v1/systemone");
    expect(r.headers.get("x-nace-client")).toBe(NACE_CLIENT);
    expect(NACE_CLIENT).toBe(`jev-router-opencode/${NACE.clientVersion}`);
    expect(NACE_CLIENT).toMatch(/^jev-router-opencode\/\d+\.\d+\.\d+$/);
    expect(NACE_CLIENT.length).toBeLessThanOrEqual(64);
    expect(NACE_CLIENT).toMatch(/^[A-Za-z0-9 ._@+-]+\/[A-Za-z0-9 ._@+-]+$/);
    expect(r.headers.get("authorization")).toBe("Bearer nace_sk_testkey");
    expect(r.body.model).toBe("drex-max-v1.1");
    expect(Object.keys(r.body.questions)).toEqual(["which", "gate::acts_on_user_system"]);
    expect(r.body.state).toEqual({ request: "fill the form" });
  });

  test("keeps probabilities, the choice, the noul and the usage", async () => {
    const res = await systemOne({}, questions, nace());
    expect(res?.answers["which"].choice).toBe("pdf-fill");
    expect(ranked(res?.answers["which"])[0]).toEqual(["pdf-fill", 0.7]);
    expect(choiceMargin(res?.answers["which"])).toBeCloseTo(0.4);
    expect(confidence(res?.answers["which"].probabilities)).toBeCloseTo(0.4);
    expect(res?.answers["gate::acts_on_user_system"].noul).toBe(0.8);
    expect(res?.usage?.input_tokens).toBe(42);
    expect((res as any).request_id).toBe(REQUEST_ID);
  });

  test("typesafe sends no nace header", async () => {
    await systemOne({}, questions, { apiKey: "ts-key", endpoint: fake.url, timeoutMs: 2000 });
    expect(fake.requests[0].path).toBe("/v1/systemone");
    expect(fake.requests[0].headers.get("x-nace-client")).toBeNull();
  });

  test.each([
    [401, "authentication_error"],
    [422, "invalid_request_error"],
    [429, "rate_limit_error"],
  ])("a %i fails open with one stderr line naming type and request id", async (status, type) => {
    fake.respond = () => drexError(status, type);
    expect(await systemOne({}, questions, nace())).toBeNull();
    expect(errors).toEqual([`[jev-router] nace request failed: ${status} ${type} request_id=${REQUEST_ID}`]);
    expect(errors.join()).not.toContain("nace_sk_testkey");
    expect(errors.join()).not.toContain("secret-free message");
  });

  test("a provider failure never retries another provider", async () => {
    fake.respond = () => drexError(401, "authentication_error");
    await systemOne({}, questions, nace());
    expect(fake.requests).toHaveLength(1);
  });

  test("a timeout fails open and says so", async () => {
    fake.respond = () => new Promise<Response>((r) => setTimeout(() => r(new Response("{}")), 500));
    expect(await systemOne({}, questions, { ...nace(), timeoutMs: 50 })).toBeNull();
    expect(errors[0]).toMatch(/nace request failed: (AbortError|TimeoutError)/);
  });

  test("the key is not in the line a timeout, a refused connection or an unparseable body prints", async () => {
    const closed = startFakeNace();
    const refusedUrl = `${closed.url}/v1`;
    closed.stop();
    const cases: Array<[string, Partial<JevOptions>]> = [
      ["timeout", { timeoutMs: 50 }],
      ["refused", { endpoint: refusedUrl }],
      ["bad json", {}],
    ];
    for (const [name, override] of cases) {
      errors.length = 0;
      fake.respond =
        name === "timeout"
          ? () => new Promise<Response>((r) => setTimeout(() => r(new Response("{}")), 500))
          : () => new Response("nace_sk_testkey is not json", { status: 200 });
      expect(await systemOne({}, questions, { ...nace(), ...override })).toBeNull();
      expect(errors, name).toHaveLength(1);
      expect(errors[0], name).toMatch(/^\[jev-router\] nace request failed: [A-Za-z]+$/);
      expect(errors[0], name).not.toContain("nace_sk_testkey");
    }
  });

  test("a redirect is refused and the key never reaches the target", async () => {
    const target = startFakeNace();
    try {
      fake.respond = () => new Response(null, { status: 307, headers: { location: `${target.url}/v1/systemone` } });
      expect(await systemOne({}, questions, nace())).toBeNull();
      expect(target.requests).toHaveLength(0);
    } finally {
      target.stop();
    }
  });

  test("plain http to a non-loopback host sends nothing", async () => {
    const res = await systemOne({}, questions, { ...nace(), endpoint: "http://203.0.113.9/v1" });
    expect(res).toBeNull();
    expect(errors).toEqual(["[jev-router] nace: refusing to send the key to http://203.0.113.9: plain http is only allowed to localhost, 127.0.0.1 or ::1"]);
    expect(fake.requests).toHaveLength(0);
  });

  test.each([
    ["file:///tmp/nace", "that URL", "the scheme must be https"],
    ["not a url", "that URL", "not a valid URL"],
    ["ftp://console.nace.ai:2121/v1", "ftp://console.nace.ai:2121", "the scheme must be https"],
  ])("%s is refused and the line names %s, never \"null\"", async (endpoint, where, reason) => {
    expect(await systemOne({}, questions, { ...nace(), endpoint })).toBeNull();
    expect(errors).toEqual([`[jev-router] nace: refusing to send the key to ${where}: ${reason}`]);
    expect(fake.requests).toHaveLength(0);
  });

  test("a URL with credentials in it is refused with that reason, and the credentials are not echoed", async () => {
    const res = await systemOne({}, questions, { ...nace(), endpoint: "https://user:hunter2@console.nace.ai/v1" });
    expect(res).toBeNull();
    expect(errors).toEqual(["[jev-router] nace: refusing to send the key to https://console.nace.ai: the URL contains credentials"]);
  });
});
