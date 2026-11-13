import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Env, NAME } from "../src/config";
import worker, { runChecks, STATUS_FRESH_MS, type WebhookAlert } from "../src/index";
import type { Monitor } from "../src/monitor";

// The stand-ins of vitest.config.ts.
const SECRET = "test-ping-secret-for-the-cluster-source";
const WEBHOOK = "https://pager.test/hook/test-hook-token";
const MINUTE = 60_000;
const TARGETS = {
  website: "https://www.shop.test/",
  api: "https://api.shop.test/health",
  worker: "https://worker.shop.test/health",
};

interface Email {
  to: unknown;
  from: unknown;
  subject: string;
  text: string;
}

/** Every outbound call the Worker makes, answered by the test: uptime targets and the webhook. */
class World {
  down = new Set<string>();
  /** A target answering something other than 200 "ok". */
  answers = new Map<string, () => Response>();
  webhookStatus = 200;
  /** The webhook never answers; the call ends only when its signal aborts. */
  webhookHangs = false;
  /** The webhook's answer to one alert, when it is not simply `webhookStatus`. */
  webhookAnswer: ((alert: WebhookAlert) => Response | undefined) | undefined;
  emailFails = false;
  /** The alerts the webhook took (answered 2xx), in order. */
  posts: WebhookAlert[] = [];
  /** How each request to the webhook was made. */
  webhookRequests: { method: string; contentType: string | null; redirect: string }[] = [];
  emails: Email[] = [];
  probes: string[] = [];
  redirects = new Map<string, string>();
  /** Runs while a probe of this URL is in flight, once. */
  duringProbe = new Map<string, () => Promise<void>>();
  overrides: Partial<Env> = {};
  /** Settings and bindings this world's Worker does not have at all. */
  missing: Exclude<keyof Env, "MONITOR">[] = [];

  env(): Env {
    const made: Env = {
      ...env,
      EMAIL: {
        send: async (message: Email) => {
          if (this.emailFails) throw new Error("email service unavailable");
          this.emails.push(message);
          return { messageId: `m${this.emails.length}` };
        },
      } as unknown as SendEmail,
      ...this.overrides,
    };
    for (const key of this.missing) delete made[key];
    return made;
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (request.url === WEBHOOK) {
      this.webhookRequests.push({
        method: request.method,
        contentType: request.headers.get("content-type"),
        redirect: request.redirect,
      });
      if (this.webhookHangs) {
        return new Promise((_, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason));
        });
      }
      if (this.webhookStatus !== 200) {
        return new Response("rate limited", { status: this.webhookStatus });
      }
      const alert = (await request.json()) as WebhookAlert;
      const answer = this.webhookAnswer?.(alert);
      if (answer !== undefined) return answer;
      this.posts.push(alert);
      return Response.json({ incidentIds: ["x"] }, { status: 202 });
    }
    this.probes.push(request.url);
    this.redirects.set(request.url, request.redirect);
    const during = this.duringProbe.get(request.url);
    if (during !== undefined) {
      this.duringProbe.delete(request.url);
      await during();
    }
    if (this.down.has(request.url)) return new Response("bad gateway", { status: 502 });
    return this.answers.get(request.url)?.() ?? new Response("ok\n");
  };

  titles = () => this.posts.map((p) => p.title);
  subjects = () => this.emails.map((e) => e.subject);
  clear() {
    this.posts = [];
    this.emails = [];
    this.probes = [];
  }
}

let world: World;
beforeEach(() => {
  world = new World();
  vi.spyOn(globalThis, "fetch").mockImplementation(world.fetch);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

const stub = () => env.MONITOR.get(env.MONITOR.idFromName("monitor"));

/** Makes the running run's lease look expired, as if its probes had taken too long. */
const expireLease = () =>
  runInDurableObject(stub(), (_: Monitor, state) => {
    const lease = state.storage.kv.get<{ token: string; until: number }>("lease");
    if (lease !== undefined) state.storage.kv.put("lease", { ...lease, until: 0 });
  });

async function ping(source: string, authorization?: string, method = "POST") {
  const headers: Record<string, string> = authorization ? { authorization } : {};
  return worker.fetch(
    new Request(`https://switch.test/ping/${source}`, { method, headers }),
    world.env(),
  );
}

const status = () => worker.fetch(new Request("https://switch.test/status"), world.env());

const run = (at: number) => runChecks(world.env(), at);

/** What a run that could not deliver said, or "" if it delivered everything. */
const failure = (at: number) =>
  run(at).then(
    () => "",
    (e: unknown) => String(e),
  );

describe("POST /ping/<source>", () => {
  it("accepts the source's secret", async () => {
    const response = await ping("cluster", `Bearer ${SECRET}`);
    expect(response.status).toBe(204);
  });

  it("refuses a wrong, missing or differently sized secret", async () => {
    expect((await ping("cluster", "Bearer nope")).status).toBe(401);
    expect((await ping("cluster", `Bearer ${SECRET}x`)).status).toBe(401);
    expect((await ping("cluster", SECRET)).status).toBe(401);
    expect((await ping("cluster")).status).toBe(401);
  });

  it("knows only configured sources and only POST", async () => {
    expect((await ping("someone-else", `Bearer ${SECRET}`)).status).toBe(404);
    expect((await ping("cluster", `Bearer ${SECRET}`, "GET")).status).toBe(405);
  });

  it("a refused ping does not count as a heartbeat", async () => {
    const t0 = Date.now();
    await run(t0);
    await ping("cluster", "Bearer nope");
    await run(t0 + 6 * MINUTE);
    expect(world.titles()).toEqual(["No heartbeat from cluster"]);
  });
});

describe("heartbeat", () => {
  it("alerts once when a source goes silent, once when it is back, nothing in between", async () => {
    const t0 = Date.now();
    expect((await ping("cluster", `Bearer ${SECRET}`)).status).toBe(204);

    await run(t0 + 4 * MINUTE);
    expect(world.posts).toEqual([]);

    await run(t0 + 6 * MINUTE);
    expect(world.titles()).toEqual(["No heartbeat from cluster"]);
    expect(world.posts[0]?.body).toContain("has not pinged since");
    expect(world.emails).toHaveLength(1);
    expect(world.emails[0]).toMatchObject({
      to: "oncall@shop.test",
      from: { email: "alerts@mail.shop.test", name: "Alerts" },
      subject: "No heartbeat from cluster",
      text: world.posts[0]?.body,
    });

    world.clear();
    await run(t0 + 7 * MINUTE);
    await run(t0 + 30 * MINUTE);
    expect(world.posts).toEqual([]);
    expect(world.emails).toEqual([]);

    // The pings are stamped with the Worker's clock; the checks run on scheduled time ahead of it.
    await ping("cluster", `Bearer ${SECRET}`);
    await run(Date.now() + MINUTE);
    expect(world.titles()).toEqual(["Heartbeat from cluster is back"]);
    expect(world.subjects()).toEqual(["Heartbeat from cluster is back"]);

    world.clear();
    await run(Date.now() + 2 * MINUTE);
    expect(world.posts).toEqual([]);
    expect(world.emails).toEqual([]);
  });

  it("a source that never pings alerts once its threshold has passed since watching began", async () => {
    const t0 = Date.now();
    await run(t0);
    await run(t0 + 5 * MINUTE);
    expect(world.posts).toEqual([]);
    await run(t0 + 5 * MINUTE + 1);
    expect(world.titles()).toEqual(["No heartbeat from cluster"]);
    expect(world.posts[0]?.body).toContain("has never pinged");
  });

  it("a ping that lands while a run is probing is seen by that run", async () => {
    // watched since ten minutes ago, never pinged: this run would alert
    await run(Date.now() - 10 * MINUTE);
    world.duringProbe.set(TARGETS.api, async () => {
      expect((await ping("cluster", `Bearer ${SECRET}`)).status).toBe(204);
    });
    await run(Date.now());
    expect(world.posts).toEqual([]);
    expect(world.emails).toEqual([]);
  });
});

describe("uptime", () => {
  it("alerts after N failures in a row, once; recovers once; a lone failure says nothing", async () => {
    const t0 = Date.now();
    await ping("cluster", `Bearer ${SECRET}`);
    world.down.add(TARGETS.api);

    await run(t0 + 10_000);
    await run(t0 + 20_000);
    expect(world.posts).toEqual([]);
    expect(world.probes).toEqual(expect.arrayContaining(Object.values(TARGETS)));

    await run(t0 + 30_000);
    expect(world.titles()).toEqual(["api is down"]);
    expect(world.posts[0]?.body).toBe(
      "https://api.shop.test/health failed 3 checks in a row from outside. Last: HTTP 502.",
    );
    expect(world.subjects()).toEqual(["api is down"]);

    world.clear();
    await run(t0 + 40_000);
    await run(t0 + 50_000);
    expect(world.posts).toEqual([]);

    world.down.clear();
    await run(t0 + 60_000);
    expect(world.titles()).toEqual(["api is back up"]);
    expect(world.subjects()).toEqual(["api is back up"]);

    world.clear();
    world.down.add(TARGETS.api);
    await run(t0 + 70_000);
    world.down.clear();
    await run(t0 + 80_000);
    world.down.add(TARGETS.api);
    await run(t0 + 90_000);
    await run(t0 + 100_000);
    expect(world.posts).toEqual([]);
  });

  it("a timeout counts as a failure and says so", async () => {
    const t0 = Date.now();
    await ping("cluster", `Bearer ${SECRET}`);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new Request(input, init).url;
      if (url === TARGETS.worker) throw new DOMException("timed out", "TimeoutError");
      return world.fetch(input, init);
    });
    for (const s of [10_000, 20_000, 30_000]) await run(t0 + s);
    expect(world.titles()).toEqual(["worker is down"]);
    expect(world.posts[0]?.body).toContain("Last: no answer within 10 s.");
  });

  it("a health route is not followed through redirects, and must answer exactly ok", async () => {
    const t0 = Date.now();
    await ping("cluster", `Bearer ${SECRET}`);
    world.answers.set(
      TARGETS.api,
      () => new Response(null, { status: 302, headers: { location: "https://login.test/" } }),
    );
    world.answers.set(TARGETS.worker, () => new Response("<html>parked</html>"));
    for (const s of [10_000, 20_000, 30_000]) await run(t0 + s);

    expect(world.redirects.get(TARGETS.api)).toBe("manual");
    expect(world.redirects.get(TARGETS.worker)).toBe("manual");
    expect(world.redirects.get(TARGETS.website)).toBe("follow");
    expect(world.titles().sort()).toEqual(["api is down", "worker is down"]);
    const body = (title: string) => world.posts.find((p) => p.title === title)?.body;
    expect(body("api is down")).toContain("Last: HTTP 302 to https://login.test/.");
    expect(body("worker is down")).toContain('Last: HTTP 200 but the body was not "ok".');
  });
});

describe("the webhook channel", () => {
  it("posts each alert as JSON in the plain-alert shape, and nothing more", async () => {
    const t0 = Date.now();
    await run(t0);
    await run(t0 + 6 * MINUTE);
    expect(world.posts).toEqual([
      {
        title: "No heartbeat from cluster",
        body: expect.stringContaining("has never pinged"),
        key: "heartbeat:cluster",
        status: "firing",
        severity: "page",
        source: NAME,
      },
    ]);
    expect(world.webhookRequests).toEqual([
      { method: "POST", contentType: "application/json", redirect: "manual" },
    ]);
  });

  it("fires under a key that is the check's own, and resolves that same key", async () => {
    const t0 = Date.now();
    await run(t0);
    world.down.add(TARGETS.api);
    await run(t0 + 6 * MINUTE);
    await run(t0 + 7 * MINUTE);
    await run(t0 + 8 * MINUTE);
    const said = () =>
      world.posts
        .map(({ key, status, severity }) => ({ key, status, severity }))
        .sort((a, b) => a.key.localeCompare(b.key));
    expect(said()).toEqual([
      { key: "heartbeat:cluster", status: "firing", severity: "page" },
      { key: "uptime:api", status: "firing", severity: "page" },
    ]);

    world.clear();
    world.down.clear();
    await ping("cluster", `Bearer ${SECRET}`);
    await run(Date.now() + MINUTE);
    expect(said()).toEqual([
      { key: "heartbeat:cluster", status: "resolved", severity: "page" },
      { key: "uptime:api", status: "resolved", severity: "page" },
    ]);
    expect(world.titles().sort()).toEqual(["Heartbeat from cluster is back", "api is back up"]);
  });

  it("the next outage of the same check fires under the same key again", async () => {
    const t0 = Date.now();
    await ping("cluster", `Bearer ${SECRET}`);
    let at = t0;
    for (const up of [false, true, false]) {
      if (up) world.down.clear();
      else world.down.add(TARGETS.website);
      for (let i = 0; i < 3; i++) await run((at += 10_000));
    }
    expect(world.posts.map(({ key, status }) => ({ key, status }))).toEqual([
      { key: "uptime:website", status: "firing" },
      { key: "uptime:website", status: "resolved" },
      { key: "uptime:website", status: "firing" },
    ]);
  });

  it("an answer outside 200-299 is not a receipt, and neither is a redirect", async () => {
    const t0 = Date.now();
    await run(t0);
    world.webhookAnswer = () =>
      new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } });
    expect(await failure(t0 + 6 * MINUTE)).toContain("the webhook answered 302");
    world.webhookAnswer = undefined;
    world.webhookStatus = 500;
    expect(await failure(t0 + 7 * MINUTE)).toContain("the webhook answered 500");
    expect(world.posts).toEqual([]);
  });

  it("a failure never puts the webhook's URL in the error", async () => {
    const t0 = Date.now();
    await run(t0);
    world.webhookAnswer = () => {
      throw new Error(`could not connect to ${WEBHOOK}`);
    };
    const said = await failure(t0 + 6 * MINUTE);
    expect(said).toContain("webhook for heartbeat:cluster (status): could not connect to WEBHOOK_URL");
    expect(said).not.toContain("pager.test");
  });
});

describe("delivery", () => {
  it("retries only the channel that failed, and the run fails loudly meanwhile", async () => {
    const t0 = Date.now();
    await run(t0);
    world.webhookStatus = 429;
    await expect(run(t0 + 6 * MINUTE)).rejects.toThrow(/webhook for heartbeat:cluster \(status\)/);
    expect(world.emails).toHaveLength(1);

    world.webhookStatus = 200;
    await run(t0 + 7 * MINUTE);
    expect(world.titles()).toEqual(["No heartbeat from cluster"]);
    expect(world.emails).toHaveLength(1);

    await run(t0 + 8 * MINUTE);
    expect(world.posts).toHaveLength(1);
  });

  it("an email failure is retried the same way", async () => {
    const t0 = Date.now();
    await run(t0);
    world.emailFails = true;
    await expect(run(t0 + 6 * MINUTE)).rejects.toThrow(/email for heartbeat:cluster/);
    world.emailFails = false;
    await run(t0 + 7 * MINUTE);
    expect(world.posts).toHaveLength(1);
    expect(world.emails).toHaveLength(1);
  });

  it("a recovery tells a channel that missed the outage about the whole outage, once", async () => {
    const t0 = Date.now();
    await ping("cluster", `Bearer ${SECRET}`);
    world.down.add(TARGETS.website);
    world.webhookStatus = 429;
    await run(t0 + 10_000);
    await run(t0 + 20_000);
    await expect(run(t0 + 30_000)).rejects.toThrow(/webhook for uptime:website/);
    await expect(run(t0 + 40_000)).rejects.toThrow(/webhook for uptime:website/);
    expect(world.subjects()).toEqual(["website is down"]);

    // back up while the webhook still owes the "down"
    world.down.clear();
    world.webhookStatus = 200;
    world.clear();
    await run(t0 + 50_000);
    expect(world.subjects()).toEqual(["website is back up"]);

    // First the check's own key is resolved, in case the "down" did arrive; then the outage
    // itself, once, as a notice under a key no other alert will ever carry.
    const title = "website (https://www.shop.test/) was down for 0 min";
    const downAt = new Date(t0 + 30_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const body = expect.stringMatching(
      /was down from .*Z to .*Z\. The alert when it went down did not reach this channel/,
    );
    expect(world.posts).toEqual([
      { title, body, key: "uptime:website", status: "resolved", severity: "page", source: NAME },
      {
        title,
        body,
        key: `uptime:website:missed:${downAt}`,
        status: "firing",
        severity: "notify",
        source: NAME,
      },
    ]);

    world.clear();
    await run(t0 + 60_000);
    await run(t0 + 70_000);
    expect(world.posts).toEqual([]);
    expect(world.emails).toEqual([]);
  });

  it("a missed outage the webhook only half took is sent again whole, and the email is not", async () => {
    const t0 = Date.now();
    await ping("cluster", `Bearer ${SECRET}`);
    world.down.add(TARGETS.website);
    world.webhookStatus = 429;
    await run(t0 + 10_000);
    await run(t0 + 20_000);
    await expect(run(t0 + 30_000)).rejects.toThrow(/webhook for uptime:website/);

    world.down.clear();
    world.webhookStatus = 200;
    world.webhookAnswer = (alert) =>
      alert.severity === "notify" ? new Response("try later", { status: 503 }) : undefined;
    world.clear();
    await expect(run(t0 + 40_000)).rejects.toThrow(/webhook for uptime:website \(missed\)/);
    expect(world.posts.map((p) => p.status)).toEqual(["resolved"]);
    expect(world.subjects()).toEqual(["website is back up"]);

    world.webhookAnswer = undefined;
    world.clear();
    await run(t0 + 50_000);
    expect(world.posts.map((p) => [p.status, p.severity])).toEqual([
      ["resolved", "page"],
      ["firing", "notify"],
    ]);
    expect(world.emails).toEqual([]);

    world.clear();
    await run(t0 + 60_000);
    expect(world.posts).toEqual([]);
  });

  it("a hung webhook gives up at its timeout without holding back the email", async () => {
    world.overrides = { DELIVERY_TIMEOUT_SECONDS: 1 };
    const t0 = Date.now();
    await run(t0);
    world.webhookHangs = true;
    const started = Date.now();
    await expect(run(t0 + 6 * MINUTE)).rejects.toThrow(
      /webhook for heartbeat:cluster \(status\): no answer within 1 s/,
    );
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(world.subjects()).toEqual(["No heartbeat from cluster"]);

    world.webhookHangs = false;
    await run(t0 + 7 * MINUTE);
    expect(world.titles()).toEqual(["No heartbeat from cluster"]);
    expect(world.emails).toHaveLength(1);
  });
});

describe("channels", () => {
  it("the webhook alone is enough: nothing of the email channel has to exist", async () => {
    world.overrides = { CHANNELS: ["webhook"] };
    world.missing = ["EMAIL", "ALERT_EMAIL_FROM", "ALERT_EMAIL_TO"];
    const t0 = Date.now();
    await run(t0);
    await run(t0 + 6 * MINUTE);
    expect(world.titles()).toEqual(["No heartbeat from cluster"]);
    expect((await status()).status).toBe(200);
    expect((await ping("cluster", `Bearer ${SECRET}`)).status).toBe(204);
  });

  it("email alone is enough: no webhook URL has to exist", async () => {
    world.overrides = { CHANNELS: ["email"] };
    world.missing = ["WEBHOOK_URL"];
    const t0 = Date.now();
    await run(t0);
    await run(t0 + 6 * MINUTE);
    expect(world.subjects()).toEqual(["No heartbeat from cluster"]);
    expect(world.webhookRequests).toEqual([]);
    expect((await status()).status).toBe(200);
  });

  it("a channel that is set up but not listed is never used", async () => {
    for (const [listed, unused] of [
      ["email", "webhook"],
      ["webhook", "email"],
    ] as const) {
      world.overrides = { CHANNELS: [listed], HEARTBEATS: { [unused]: { silentAfterSeconds: 300 } } };
      world.overrides[`PING_SECRET_${unused.toUpperCase()}`] = SECRET;
      const t0 = Date.now();
      await run(t0);
      await run(t0 + 6 * MINUTE);
    }
    expect(world.subjects()).toEqual(["No heartbeat from webhook"]);
    expect(world.titles()).toEqual(["No heartbeat from email"]);
  });

  it("no channel at all stops every ping and every check", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const none: unknown[] = [[], "webhook", ["sms"], ["webhook", "sms"], ["email", "email"]];
    for (const channels of none) {
      world.overrides = { CHANNELS: channels };
      await expect(run(Date.now())).rejects.toThrow(/CHANNELS must list at least one of/);
    }
    world.overrides = {};
    world.missing = ["CHANNELS"];
    await expect(run(Date.now())).rejects.toThrow(
      /CHANNELS must list at least one of "webhook" and "email", each once/,
    );
    expect((await ping("cluster", `Bearer ${SECRET}`)).status).toBe(500);
    expect((await status()).status).toBe(500);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("CHANNELS"));
    expect(world.probes).toEqual([]);
  });

  it("a listed channel must be set up in full", async () => {
    world.missing = ["WEBHOOK_URL"];
    await expect(run(Date.now())).rejects.toThrow(/WEBHOOK_URL is not set/);
    world.missing = ["ALERT_EMAIL_TO"];
    await expect(run(Date.now())).rejects.toThrow(/ALERT_EMAIL_TO must be set to an email address/);
    world.missing = ["ALERT_EMAIL_FROM"];
    await expect(run(Date.now())).rejects.toThrow(/ALERT_EMAIL_FROM must be set to an email/);
    world.missing = ["EMAIL"];
    await expect(run(Date.now())).rejects.toThrow(/EMAIL, the email-sending binding, is missing/);
  });
});

describe("one run at a time", () => {
  it("two overlapping runs cannot both send", async () => {
    const t0 = Date.now();
    await run(t0);
    await Promise.all([run(t0 + 6 * MINUTE), run(t0 + 6 * MINUTE)]);
    expect(world.posts).toHaveLength(1);
    expect(world.emails).toHaveLength(1);
  });

  it("a run whose lease runs out while probing judges nothing; the run that took over sends", async () => {
    const t0 = Date.now();
    await run(t0);
    // run A stalls in its probes; its lease runs out and run B starts, judges and sends
    world.duringProbe.set(TARGETS.website, async () => {
      await expireLease();
      await run(t0 + 6 * MINUTE);
    });
    await run(t0 + 6 * MINUTE);
    expect(world.posts).toHaveLength(1);
    expect(world.emails).toHaveLength(1);
  });

  it("a run whose lease runs out after judging sends nothing; the run that took over sends", async () => {
    const t0 = Date.now();
    await run(t0);
    // run A has judged ("down", owed to both channels) when its lease runs out and B runs
    const real = world.env();
    const wrapped: Env = {
      ...real,
      MONITOR: {
        idFromName: (name: string) => real.MONITOR.idFromName(name),
        get: (id: DurableObjectId) => {
          const s = real.MONITOR.get(id);
          return new Proxy(s, {
            get(target, prop) {
              if (prop !== "evaluate") return Reflect.get(target, prop);
              return async (...args: Parameters<typeof s.evaluate>) => {
                const pending = await target.evaluate(...args);
                await expireLease();
                await run(t0 + 6 * MINUTE);
                return pending;
              };
            },
          });
        },
      } as unknown as Env["MONITOR"],
    };
    await runChecks(wrapped, t0 + 6 * MINUTE);
    expect(world.posts).toHaveLength(1);
    expect(world.emails).toHaveLength(1);
  });
});

describe("GET /status", () => {
  it("is 503 until a run has finished in full, 200 after, and 503 once that is stale", async () => {
    expect((await status()).status).toBe(503);

    await run(Date.now());
    const fresh = await status();
    expect(fresh.status).toBe(200);
    expect(await fresh.text()).toMatch(
      new RegExp(`^${NAME}_last_full_run_timestamp_seconds \\d+(\\.\\d+)?$`, "m"),
    );

    await runInDurableObject(stub(), (_: Monitor, state) => {
      state.storage.kv.put("lastFullRun", Date.now() - STATUS_FRESH_MS - 1);
    });
    expect((await status()).status).toBe(503);
  });

  it("a run that could not deliver is not a full run", async () => {
    const t0 = Date.now();
    await run(t0);
    await runInDurableObject(stub(), (_: Monitor, state) => {
      state.storage.kv.put("lastFullRun", Date.now() - STATUS_FRESH_MS - 1);
    });
    world.webhookStatus = 500;
    await expect(run(t0 + 6 * MINUTE)).rejects.toThrow(/webhook/);
    expect((await status()).status).toBe(503);
  });

  it("answers only GET", async () => {
    const response = await worker.fetch(
      new Request("https://switch.test/status", { method: "POST" }),
      world.env(),
    );
    expect(response.status).toBe(405);
  });
});

describe("cron handler", () => {
  it("runs the checks at the controller's scheduled time", async () => {
    const t0 = Date.now();
    await run(t0);
    const controller = {
      scheduledTime: t0 + 6 * MINUTE,
      cron: "* * * * *",
      noRetry() {},
    } satisfies ScheduledController;
    await worker.scheduled(controller, world.env());
    expect(world.titles()).toEqual(["No heartbeat from cluster"]);
  });
});

describe("configuration", () => {
  it("a missing secret stops every ping and every check, naming what is missing", async () => {
    world.overrides = { PING_SECRET_CLUSTER: "REPLACE" };
    world.missing = ["WEBHOOK_URL"];
    await expect(run(Date.now())).rejects.toThrow(
      /PING_SECRET_CLUSTER is not set; .*WEBHOOK_URL is not set/,
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const path of ["/ping/cluster", "/status"]) {
      const response = await worker.fetch(
        new Request(`https://switch.test${path}`, {
          method: path === "/status" ? "GET" : "POST",
          headers: { authorization: `Bearer ${SECRET}` },
        }),
        world.env(),
      );
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("misconfigured\n");
    }
    expect(error).toHaveBeenCalledWith(expect.stringContaining("WEBHOOK_URL"));
  });

  it("refuses a short ping secret, a non-https target and placeholders left in the secrets", async () => {
    world.overrides = {
      PING_SECRET_CLUSTER: "short",
      WEBHOOK_URL: "REPLACE",
      ALERT_EMAIL_TO: "REPLACE",
      UPTIME: {
        failuresBeforeAlert: 3,
        timeoutSeconds: 10,
        targets: [{ name: "x", url: "http://x" }],
      },
    };
    await expect(run(Date.now())).rejects.toThrow(
      /PING_SECRET_CLUSTER must be at least 32 characters; .*must be https: http:\/\/x; WEBHOOK_URL is not set; ALERT_EMAIL_TO must be set/,
    );
  });

  it("refuses the hosts of the example configuration", async () => {
    world.overrides = {
      ALERT_EMAIL_FROM: "alerts@example.com",
      UPTIME: {
        failuresBeforeAlert: 3,
        timeoutSeconds: 10,
        targets: [{ name: "api", url: "https://api.example.com/health", expectBody: "ok" }],
      },
    };
    await expect(run(Date.now())).rejects.toThrow(
      /UPTIME\.targets\[0\]\.url is still the example: https:\/\/api\.example\.com\/health; ALERT_EMAIL_FROM is still the example: alerts@example\.com/,
    );
  });

  it("names what is wrong with the webhook URL without quoting it", async () => {
    world.overrides = { WEBHOOK_URL: "http://plain.test/hook/a-token" };
    const said = await failure(Date.now());
    expect(said).toContain("WEBHOOK_URL must be https");
    expect(said).not.toContain("plain.test");

    world.overrides = { WEBHOOK_URL: "not a url, a-token" };
    const again = await failure(Date.now());
    expect(again).toContain("WEBHOOK_URL is not a URL");
    expect(again).not.toContain("a-token");
  });
});
