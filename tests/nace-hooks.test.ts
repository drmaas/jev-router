import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NACE } from "../plugins/jev-router/jev";
import { REQUEST_ID, drexError, startFakeNace, type FakeNace } from "./fake-nace";

const root = join(import.meta.dir, "..");
const hooks = join(root, ".cursor", "hooks");
const python = Bun.which("python3");

const ASK = {
  type: "choice",
  choice: "ask",
  confidence: 0.9,
  probabilities: { allow: 0.05, ask: 0.9, deny: 0.05 },
};

/** Run a hook the way Cursor does: the payload on stdin, the environment as given, JSON on stdout. */
async function runHook(script: string, payload: unknown, env: Record<string, string>) {
  const proc = Bun.spawn([python as string, join(hooks, script)], {
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env["PATH"] ?? "", ...env },
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { stdout: JSON.parse(stdout), stderr };
}

describe("shared nace descriptor", () => {
  test("the plugin and the hooks read identical nace.json", () => {
    const plugin = readFileSync(join(root, "plugins", "jev-router", "nace.json"), "utf-8");
    expect(readFileSync(join(hooks, "nace.json"), "utf-8")).toBe(plugin);
  });
});

describe.skipIf(!python)("cursor hooks against nace", () => {
  let fake: FakeNace;
  beforeEach(() => {
    fake = startFakeNace();
  });
  afterEach(() => fake.stop());

  const nace = () => ({ JEV_PROVIDER: "nace", NACE_API_KEY: "nace_sk_testkey", NACE_BASE_URL: `${fake.url}/v1` });
  const payload = { command: "rm -rf build", cwd: "/work/app" };

  test("a verdict call carries the cursor attribution, key and default model", async () => {
    fake.respond = (r) => Response.json({
      model: r.body.model,
      answers: { verdict: ASK },
      usage: { input_tokens: 31, output_tokens: 5 },
      evaluation_time_ms: 9,
      request_id: REQUEST_ID,
    });
    const { stdout } = await runHook("jev_policy.py", payload, nace());
    const [r] = fake.requests;
    expect(r.path).toBe("/v1/systemone");
    expect(r.headers.get("x-nace-client")).toBe(`jev-router-cursor/${NACE.clientVersion}`);
    expect(NACE.clientVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(r.headers.get("authorization")).toBe("Bearer nace_sk_testkey");
    expect(r.body.model).toBe("drex-max-v1.1");
    expect(Object.keys(r.body.questions)).toEqual(["verdict"]);
    expect(r.body.state.pending_action).toBe("rm -rf build");
    expect(stdout.permission).toBe("ask");
    expect(stdout.user_message).toContain("confidence 0.90");
  });

  test.each(["NACE", "Nace", "  nace  "])("JEV_PROVIDER=%j selects nace, as the plugin's option does", async (spelling) => {
    await runHook("jev_policy.py", payload, { ...nace(), JEV_PROVIDER: spelling });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].headers.get("x-nace-client")).toStartWith("jev-router-cursor/");
    expect(fake.requests[0].headers.get("authorization")).toBe("Bearer nace_sk_testkey");
  });

  test("a trailing slash on NACE_BASE_URL does not double the slash in the path", async () => {
    await runHook("jev_policy.py", payload, { ...nace(), NACE_BASE_URL: `${fake.url}/v1/` });
    expect(fake.requests.map((r) => r.path)).toEqual(["/v1/systemone"]);
  });

  test("the stop hooks make attributed calls too", async () => {
    await runHook("jev_verify.py", { status: "completed", summary: "done" }, nace());
    await runHook("jev_review.py", { status: "completed", summary: "changed auth" }, nace());
    expect(fake.requests.length).toBeGreaterThanOrEqual(2);
    for (const r of fake.requests) expect(r.headers.get("x-nace-client")).toStartWith("jev-router-cursor/");
  });

  test("the default provider sends no nace header and stays on TYPESAFE_ENDPOINT", async () => {
    await runHook("jev_policy.py", payload, { TYPESAFE_API_KEY: "ts-key", TYPESAFE_ENDPOINT: fake.url });
    expect(fake.requests[0].path).toBe("/v1/systemone");
    expect(fake.requests[0].headers.get("x-nace-client")).toBeNull();
    expect(fake.requests[0].body.model).toBe("jev-latest");
  });

  test("a NACE_API_KEY alone does not switch the hooks to nace, and stderr says what it needs", async () => {
    const { stderr } = await runHook("jev_policy.py", payload, { NACE_API_KEY: "nace_sk_testkey", NACE_BASE_URL: `${fake.url}/v1` });
    expect(fake.requests).toHaveLength(0);
    expect(stderr.trim()).toBe(
      "[jev-router] No API key set (TYPESAFE_API_KEY or OPENROUTER_API_KEY); NACE_API_KEY is set, but Nace needs JEV_PROVIDER=nace; Jev calls will be skipped (fail open).",
    );
  });

  test("with no key at all the hooks stay as silent as upstream's", async () => {
    const { stdout, stderr } = await runHook("jev_policy.py", payload, { TYPESAFE_ENDPOINT: fake.url });
    expect(stdout).toEqual({ continue: true, permission: "allow" });
    expect(stderr).toBe("");
  });

  test("a missing NACE_API_KEY allows, names the variable and calls nobody, even with other keys set", async () => {
    const { stdout, stderr } = await runHook("jev_policy.py", payload, {
      JEV_PROVIDER: "nace",
      TYPESAFE_API_KEY: "ts-key",
      TYPESAFE_ENDPOINT: fake.url,
    });
    expect(stdout).toEqual({ continue: true, permission: "allow" });
    expect(stderr.trim()).toBe("[jev-router] No API key set (NACE_API_KEY); Jev calls will be skipped (fail open).");
    expect(fake.requests).toHaveLength(0);
  });

  test.each(["jev_policy.py", "jev_verify.py", "jev_review.py"])(
    "an unknown JEV_PROVIDER in %s prints one line naming the valid values and calls nobody",
    async (script) => {
      const { stdout, stderr } = await runHook(script, { ...payload, status: "completed", summary: "changed auth" }, {
        JEV_PROVIDER: "nace_sk_pasted_by_mistake",
        NACE_API_KEY: "nace_sk_testkey",
        NACE_BASE_URL: `${fake.url}/v1`,
        TYPESAFE_API_KEY: "ts-key",
        TYPESAFE_ENDPOINT: fake.url,
      });
      expect(stdout.permission === undefined || stdout.permission === "allow").toBe(true);
      expect(stderr.trim()).toBe(
        "[jev-router] unknown JEV_PROVIDER (valid values: typesafe, openrouter, nace); Jev calls will be skipped (fail open).",
      );
      expect(stderr).not.toContain("nace_sk_pasted_by_mistake");
      expect(fake.requests).toHaveLength(0);
    },
  );

  test.each([
    [401, "authentication_error"],
    [422, "invalid_request_error"],
  ])("a %i allows and reports type and request id on stderr", async (status, type) => {
    fake.respond = () => drexError(status, type);
    const { stdout, stderr } = await runHook("jev_policy.py", payload, nace());
    expect(stdout).toEqual({ continue: true, permission: "allow" });
    expect(stderr).toContain(`nace request failed: ${status} ${type} request_id=${REQUEST_ID}`);
    expect(stderr).not.toContain("nace_sk_testkey");
    expect(fake.requests).toHaveLength(1);
  });

  test.each([
    ["JEV_PROVIDER=openrouter", { JEV_PROVIDER: "openrouter" }],
    ["auto-detect with only an OpenRouter key", {}],
  ])("a Nace key in the environment is never sent down the OpenRouter branch (%s)", async (_name, choice) => {
    await runHook("jev_policy.py", payload, {
      ...choice,
      OPENROUTER_API_KEY: "sk-or-testkey",
      NACE_API_KEY: "nace_sk_testkey",
      NACE_BASE_URL: `${fake.url}/v1`,
      TYPESAFE_ENDPOINT: fake.url,
    });
    expect(fake.requests.length).toBeGreaterThan(0);
    for (const r of fake.requests) {
      expect(r.headers.get("authorization")).toBe("Bearer sk-or-testkey");
      expect(r.headers.get("x-nace-client")).toBeNull();
    }
  });

  test("a Nace-selected request never goes to TYPESAFE_ENDPOINT, and TYPESAFE_MODEL is not read", async () => {
    const decoy = startFakeNace();
    try {
      await runHook("jev_policy.py", payload, {
        ...nace(),
        TYPESAFE_API_KEY: "ts-key",
        TYPESAFE_ENDPOINT: decoy.url,
        TYPESAFE_MODEL: "jev-1.13",
      });
      expect(decoy.requests).toHaveLength(0);
      expect(fake.requests.length).toBeGreaterThan(0);
      expect(fake.requests[0].body.model).toBe(NACE.defaultModel);
    } finally {
      decoy.stop();
    }
  });

  test("NACE_MODEL picks the model the hooks send", async () => {
    await runHook("jev_policy.py", payload, { ...nace(), NACE_MODEL: "drex-v2.0" });
    expect(fake.requests[0].body.model).toBe("drex-v2.0");
  });

  test("the key is not in the line a timeout, a refused connection or an unparseable body prints", async () => {
    const closed = startFakeNace();
    const refusedUrl = `${closed.url}/v1`;
    closed.stop();
    const call = "import jev_client as j; j.system_one({}, {'q': {'type': 'noul', 'instructions': 'x'}}, timeout=0.3)";
    const cases: Array<[string, string]> = [
      ["timeout", `${fake.url}/v1`],
      ["refused", refusedUrl],
      ["bad json", `${fake.url}/v1`],
    ];
    for (const [name, url] of cases) {
      fake.respond =
        name === "timeout"
          ? () => new Promise<Response>((r) => setTimeout(() => r(new Response("{}")), 1000))
          : () => new Response("nace_sk_testkey is not json", { status: 200 });
      const proc = Bun.spawn([python as string, "-c", call], {
        cwd: hooks,
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: process.env["PATH"] ?? "", ...nace(), NACE_BASE_URL: url },
      });
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;
      expect(stderr.trim(), name).toMatch(/^\[jev-router\] nace request failed: [A-Za-z]+$/);
      expect(stderr, name).not.toContain("nace_sk_testkey");
    }
  });

  test("a redirect is refused and the key never reaches the target", async () => {
    const target = startFakeNace();
    try {
      fake.respond = () => new Response(null, { status: 302, headers: { location: `${target.url}/v1/systemone` } });
      const { stdout, stderr } = await runHook("jev_policy.py", payload, nace());
      expect(stdout).toEqual({ continue: true, permission: "allow" });
      expect(stderr).toContain("nace request failed: 302");
      expect(target.requests).toHaveLength(0);
    } finally {
      target.stop();
    }
  });

  test("plain http to a non-loopback host sends nothing", async () => {
    const { stderr } = await runHook("jev_policy.py", payload, { ...nace(), NACE_BASE_URL: "http://203.0.113.9/v1" });
    expect(stderr.trim()).toBe(
      "[jev-router] nace: refusing to send the key to 203.0.113.9: plain http is only allowed to localhost, 127.0.0.1 or ::1",
    );
    expect(fake.requests).toHaveLength(0);
  });

  test("a URL with no host is refused and the line says \"that URL\"", async () => {
    const { stderr } = await runHook("jev_policy.py", payload, { ...nace(), NACE_BASE_URL: "file:///tmp/nace" });
    expect(stderr.trim()).toBe("[jev-router] nace: refusing to send the key to that URL: the scheme must be https");
    expect(fake.requests).toHaveLength(0);
  });

  test.each(["jev_policy.py", "jev_verify.py", "jev_review.py"])(
    "a NACE_BASE_URL that cannot be parsed fails open in %s and sends nothing",
    async (script) => {
      for (const url of ["http://[::1", "https://[::1:3000"]) {
        const { stdout, stderr } = await runHook(script, { ...payload, status: "completed", summary: "changed auth" }, {
          ...nace(),
          NACE_BASE_URL: url,
        });
        expect(stdout.permission === undefined || stdout.permission === "allow", url).toBe(true);
        expect(stderr.trim(), url).toBe("[jev-router] nace: refusing to send the key to that URL: not a valid URL");
      }
      expect(fake.requests).toHaveLength(0);
    },
  );

  test.each([
    ["https://user:hunter2@console.nace.ai/v1", "the URL contains credentials"],
    ["ftp://console.nace.ai/v1", "the scheme must be https"],
  ])("%s is refused with its own reason", async (url, reason) => {
    const { stderr } = await runHook("jev_policy.py", payload, { ...nace(), NACE_BASE_URL: url });
    expect(stderr.trim()).toBe(`[jev-router] nace: refusing to send the key to console.nace.ai: ${reason}`);
    expect(stderr).not.toContain("hunter2");
    expect(fake.requests).toHaveLength(0);
  });

  test("an empty NACE_BASE_URL or NACE_MODEL means unset, as in the plugin", async () => {
    const proc = Bun.spawn([python as string, "-c", "import jev_client as j; c = j.config(); print(c['url'], c['model'])"], {
      cwd: hooks,
      stdout: "pipe",
      env: { PATH: process.env["PATH"] ?? "", JEV_PROVIDER: "nace", NACE_API_KEY: "nace_sk_testkey", NACE_BASE_URL: "", NACE_MODEL: "" },
    });
    expect((await new Response(proc.stdout).text()).trim()).toBe(`https://console.nace.ai/v1/systemone ${NACE.defaultModel}`);
  });
});
