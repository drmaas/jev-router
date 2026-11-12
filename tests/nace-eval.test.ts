import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { startFakeNace, type FakeNace } from "./fake-nace";

const harness = join(import.meta.dir, "eval-harness.ts");

let fake: FakeNace;
beforeEach(() => {
  fake = startFakeNace();
});
afterEach(() => fake.stop());

async function liveEval(env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, harness, "--live"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env["PATH"] ?? "", ...env },
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { stdout, stderr };
}

test("a live eval on Nace reports no cost, because the harness only knows TypeSafe's price", async () => {
  const { stdout } = await liveEval({
    JEV_PROVIDER: "nace",
    NACE_API_KEY: "nace_sk_testkey",
    NACE_BASE_URL: `${fake.url}/v1`,
  });
  const report = JSON.parse(stdout);
  expect(report.mode).toBe("live");
  expect(report.liveMeta.provider).toBe("nace");
  expect(report.liveMeta.totalCalls).toBeGreaterThan(0);
  expect(fake.requests.length).toBeGreaterThan(0);
  expect(Object.keys(report.liveMeta)).not.toContain("totalJevCost");
  expect(Object.keys(report.cells[0]).filter((k) => /cost|saved|net/i.test(k))).toEqual([]);
});

test("a live eval with a mistyped JEV_PROVIDER says so and falls back to the mock, whatever other keys are set", async () => {
  const { stdout, stderr } = await liveEval({ JEV_PROVIDER: "naec", TYPESAFE_API_KEY: "ts-key", TYPESAFE_ENDPOINT: fake.url });
  expect(JSON.parse(stdout).mode).toBe("mock-simulated");
  expect(stderr).toContain("unknown JEV_PROVIDER (valid values: typesafe, openrouter, nace)");
  expect(fake.requests).toHaveLength(0);
});
