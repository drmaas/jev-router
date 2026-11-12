// Local stand-in for a decisions endpoint. Records every request and answers with the
// Drex /v1/systemone shape, so tests can assert what the plugin and hooks put on the wire.

export interface Recorded {
  path: string;
  headers: Headers;
  body: any;
}

export interface FakeNace {
  url: string;
  requests: Recorded[];
  respond: (r: Recorded) => Response | Promise<Response>;
  stop: () => void;
}

export const REQUEST_ID = "req_0123456789abcdef0123456789abcdef";

/** Answers every question by type, in the shapes openapi.json defines: a choice picks its first option,
 *  a noul says 0.8 with confidence max(noul, 1 - noul), a score of level 1 carries a probability per level index. */
export function drexAnswer(r: Recorded): Response {
  const answers: Record<string, unknown> = {};
  for (const [id, q] of Object.entries<any>(r.body.questions)) {
    if (q.type === "choice") {
      const options = Object.keys(q.criteria);
      const rest = (0.3 / Math.max(1, options.length - 1));
      const probabilities = Object.fromEntries(options.map((o, i) => [o, i === 0 ? 0.7 : rest]));
      answers[id] = { type: "choice", choice: options[0], confidence: 0.7, probabilities };
    } else if (q.type === "score") {
      const levels = Array.isArray(q.criteria) ? q.criteria : Object.values<string>(q.criteria);
      const probabilities = Object.fromEntries(levels.map((_, i) => [String(i), i === 1 ? 0.7 : 0.3 / Math.max(1, levels.length - 1)]));
      answers[id] = { type: "score", score: 1, legend: levels, probabilities, confidence: 0.7 };
    } else {
      answers[id] = { type: "noul", noul: 0.8, confidence: 0.8 };
    }
  }
  return Response.json({
    model: r.body.model,
    answers,
    usage: { input_tokens: 42, output_tokens: 7 },
    evaluation_time_ms: 12.5,
    request_id: REQUEST_ID,
  });
}

export function drexError(status: number, type: string): Response {
  return Response.json(
    { error: { type, message: "secret-free message" }, request_id: REQUEST_ID },
    { status },
  );
}

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

/** Bun's fetch sends loopback requests through http_proxy too. Name the loopback hosts in no_proxy so a stand-in on this machine is reached whatever the shell sets. */
function bypassProxyForLoopback(): void {
  for (const name of ["no_proxy", "NO_PROXY"]) {
    const have = (process.env[name] ?? "").split(",").map((h) => h.trim()).filter(Boolean);
    process.env[name] = [...new Set([...have, ...LOOPBACK])].join(",");
  }
}

export function startFakeNace(): FakeNace {
  bypassProxyForLoopback();
  const fake: FakeNace = {
    url: "",
    requests: [],
    respond: drexAnswer,
    stop: () => server.stop(true),
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const recorded: Recorded = {
        path: new URL(req.url).pathname,
        headers: req.headers,
        body: await req.json().catch(() => null),
      };
      fake.requests.push(recorded);
      return fake.respond(recorded);
    },
  });
  fake.url = `http://127.0.0.1:${server.port}`;
  return fake;
}
