// A dead-man switch and outside-in uptime checks. See README.md.
//
//   POST /ping/<source>   a heartbeat; `Authorization: Bearer <PING_SECRET_<SOURCE>>`
//   GET /status           200 while a full run finished in the last 3 minutes, else 503; something
//                         else has to watch it, since the switch cannot report its own death
//   cron, every minute    probe the uptime targets, judge every check, deliver what is owed

import {
  type Config,
  ConfigError,
  type Env,
  NAME,
  parseConfig,
  type UptimeTarget,
} from "./config";
import type { Pending, ProbeResult } from "./monitor";

export { Monitor } from "./monitor";

/** How long since the last full run `GET /status` still calls healthy. */
export const STATUS_FRESH_MS = 3 * 60_000;

const METRIC = `${NAME}_last_full_run_timestamp_seconds`;

const encoder = new TextEncoder();
const digest = async (s: string) => crypto.subtle.digest("SHA-256", encoder.encode(s));

/** Constant-time: both sides are hashed to the same length first, then compared in full. */
async function secretMatches(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function monitor(env: Env) {
  return env.MONITOR.get(env.MONITOR.idFromName("monitor"));
}

/** `promise`, or a rejection once `ms` have passed; for calls that take no AbortSignal. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function handlePing(request: Request, env: Env, config: Config, source: string) {
  if (request.method !== "POST") {
    return new Response("method not allowed\n", { status: 405, headers: { allow: "POST" } });
  }
  const heartbeat = config.heartbeats.find((h) => h.source === source);
  if (heartbeat === undefined) return new Response("not found\n", { status: 404 });
  const auth = request.headers.get("authorization") ?? "";
  const given = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  if (!(await secretMatches(given, heartbeat.secret))) {
    return new Response("unauthorized\n", { status: 401 });
  }
  await monitor(env).ping(source, Date.now());
  return new Response(null, { status: 204 });
}

/** In Prometheus's text format, so a plain scrape reads it; the status code carries the verdict. */
async function handleStatus(request: Request, env: Env) {
  if (request.method !== "GET") {
    return new Response("method not allowed\n", { status: 405, headers: { allow: "GET" } });
  }
  const last = await monitor(env).lastFullRun();
  const fresh = last !== undefined && Date.now() - last < STATUS_FRESH_MS;
  const body =
    `# HELP ${METRIC} When a run last probed, judged and delivered everything.\n` +
    `# TYPE ${METRIC} gauge\n` +
    `${METRIC} ${last === undefined ? 0 : last / 1000}\n`;
  return new Response(body, {
    status: fresh ? 200 : 503,
    headers: { "content-type": "text/plain; version=0.0.4", "cache-control": "no-store" },
  });
}

async function probe(target: UptimeTarget, timeoutMs: number): Promise<ProbeResult> {
  const { name, url, expectBody } = target;
  try {
    const response = await fetch(url, {
      // A health route answers itself; a redirect there means something else is answering.
      redirect: expectBody === null ? "follow" : "manual",
      cache: "no-store",
      headers: { "user-agent": NAME },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (expectBody === null || !response.ok) {
      await response.body?.cancel();
      const where = response.headers.get("location");
      const detail = `HTTP ${response.status}${where === null ? "" : ` to ${where}`}`;
      return { name, url, ok: response.ok, detail };
    }
    const body = (await response.text()).trim();
    if (body !== expectBody) {
      return {
        name,
        url,
        ok: false,
        detail: `HTTP ${response.status} but the body was not "${expectBody}"`,
      };
    }
    return { name, url, ok: true, detail: `HTTP ${response.status}` };
  } catch (e) {
    const detail =
      e instanceof DOMException && e.name === "TimeoutError"
        ? `no answer within ${timeoutMs / 1000} s`
        : errorText(e);
    return { name, url, ok: false, detail };
  }
}

/** One alert as the webhook receives it. */
export interface WebhookAlert {
  title: string;
  body: string;
  key: string;
  status: "firing" | "resolved";
  severity: "page" | "notify";
  source: string;
}

/**
 * What one owed message is on the webhook. A "down" fires a page under the check's key and the
 * recovery resolves that key. A missed outage is two alerts: first a `resolved` for the check's
 * key, because a "down" this channel was never seen to take may have arrived all the same (it
 * answered too late, say) and must not stay open, then the outage itself as a `notify` under a key
 * of its own. That one is `firing`, since a receiver has nothing to resolve and would drop a
 * `resolved`; nothing resolves it later, so it stays until a person closes it.
 */
function webhookAlerts(p: Pending): WebhookAlert[] {
  const { title, body, key } = p.alert;
  const words = { title, body, source: NAME };
  if (p.what === "missed") {
    return [
      { ...words, key: p.check, status: "resolved", severity: "page" },
      { ...words, key, status: "firing", severity: "notify" },
    ];
  }
  const status = p.status === "down" ? "firing" : "resolved";
  return [{ ...words, key, status, severity: "page" }];
}

async function sendWebhook(url: string, timeoutMs: number, p: Pending) {
  // One deadline for the whole delivery, however many alerts it is.
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    for (const alert of webhookAlerts(p)) {
      const response = await fetch(url, {
        method: "POST",
        // The receiver answers itself; a redirect is not a receipt.
        redirect: "manual",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(alert),
        signal,
      });
      if (!response.ok) {
        const said = (await response.text()).slice(0, 200);
        throw new Error(`the webhook answered ${response.status}: ${said}`);
      }
      await response.body?.cancel();
    }
  } catch (e) {
    const why =
      e instanceof DOMException && e.name === "TimeoutError"
        ? `no answer within ${timeoutMs / 1000} s`
        : errorText(e);
    // The URL is a secret: it never reaches the logs, whatever the failure says.
    throw new Error(why.replaceAll(url, "WEBHOOK_URL"));
  }
}

async function sendEmail(email: NonNullable<Config["email"]>, timeoutMs: number, p: Pending) {
  // The binding takes no signal: a send still going after the timeout may yet arrive, and the
  // retry next minute then makes it two emails. A late duplicate beats a missing alert.
  await within(
    email.binding.send({
      to: email.to,
      from: { email: email.from, name: "Alerts" },
      subject: p.alert.title,
      text: p.alert.body,
    }),
    timeoutMs,
    "email",
  );
}

/** One minute's run. Throws when anything could not be delivered; it is retried next minute. */
export async function runChecks(env: Env, now: number): Promise<void> {
  const config = parseConfig(env);
  const stub = monitor(env);
  const lease = await stub.begin();
  if (lease === null) {
    console.warn(`${NAME}: the previous run still holds the lease; skipping this minute`);
    return;
  }
  try {
    const results = await Promise.all(
      config.uptime.targets.map((t) => probe(t, config.uptime.timeoutMs)),
    );
    const pending = await stub.evaluate(lease, now, {
      channels: config.channels,
      heartbeats: config.heartbeats.map(({ source, silentAfterMs }) => ({ source, silentAfterMs })),
      uptime: { failuresBeforeAlert: config.uptime.failuresBeforeAlert, results },
    });
    // The lease ran out (the probes were slow) and another run may have taken over: it judges
    // and sends; this one must not.
    if (pending === null || (pending.length > 0 && !(await stub.renew(lease)))) {
      console.warn(`${NAME}: this run's lease ran out before sending; leaving it to the next run`);
      return;
    }
    const { webhook, email, deliveryTimeoutMs } = config;
    const send = async (p: Pending) => {
      // A channel is only ever owed something while it is in use, so its settings are there.
      if (p.channel === "webhook" && webhook !== null) {
        return sendWebhook(webhook.url, deliveryTimeoutMs, p);
      }
      if (p.channel === "email" && email !== null) return sendEmail(email, deliveryTimeoutMs, p);
      throw new Error("the channel is not set up");
    };
    // All at once, each with its own timeout, so the slowest bounds the run, well inside the lease.
    const outcomes = await Promise.allSettled(
      pending.map(async (p: Pending) => {
        await send(p);
        await stub.delivered(p.check, p);
      }),
    );
    const failed = outcomes.flatMap((o, i) =>
      o.status === "rejected"
        ? [
            `${pending[i]?.channel} for ${pending[i]?.check} (${pending[i]?.what}): ${errorText(o.reason)}`,
          ]
        : [],
    );
    if (failed.length > 0) {
      throw new Error(`${NAME}: undelivered, retried next minute: ${failed.join("; ")}`);
    }
    await stub.finished(lease, Date.now());
  } finally {
    await stub.end(lease);
  }
}

export default {
  async fetch(request, env) {
    let config: Config;
    try {
      config = parseConfig(env);
    } catch (e) {
      // The details go to the Worker's logs, not to whoever is calling.
      console.error(errorText(e));
      if (e instanceof ConfigError) return new Response("misconfigured\n", { status: 500 });
      throw e;
    }
    const path = new URL(request.url).pathname;
    if (path === "/status") return handleStatus(request, env);
    const ping = path.match(/^\/ping\/([^/]+)$/);
    if (ping?.[1] !== undefined) return handlePing(request, env, config, ping[1]);
    return new Response("not found\n", { status: 404 });
  },

  async scheduled(controller, env) {
    await runChecks(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
