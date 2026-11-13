// Everything the Worker needs, read and checked in one place. A missing or malformed setting is an
// error naming each problem, never a default: an alerting path that quietly does nothing is worse
// than one that fails where someone can see it.

import type { Monitor } from "./monitor";

/**
 * What this Worker calls itself where it has to: the `source` of its webhook alerts, its probes'
 * user agent, the prefix of its metric and of its log lines.
 */
export const NAME = "deadman";

export const CHANNELS = ["webhook", "email"] as const;
export type Channel = (typeof CHANNELS)[number];

export interface Env {
  MONITOR: DurableObjectNamespace<Monitor>;
  CHANNELS?: unknown;
  DELIVERY_TIMEOUT_SECONDS?: unknown;
  HEARTBEATS?: unknown;
  UPTIME?: unknown;
  WEBHOOK_URL?: string;
  EMAIL?: SendEmail;
  ALERT_EMAIL_FROM?: string;
  ALERT_EMAIL_TO?: string;
  [secret: `PING_SECRET_${string}`]: string | undefined;
}

export interface Heartbeat {
  source: string;
  silentAfterMs: number;
  secret: string;
}

export interface UptimeTarget {
  name: string;
  url: string;
  /** A health route: redirects are not followed, and the body must be exactly this (trimmed). */
  expectBody: string | null;
}

export interface Config {
  heartbeats: Heartbeat[];
  uptime: { failuresBeforeAlert: number; timeoutMs: number; targets: UptimeTarget[] };
  /** The channels in use, at least one. Each has its settings below; the others are null. */
  channels: Channel[];
  webhook: { url: string } | null;
  email: { binding: SendEmail; from: string; to: string } | null;
  /** Each delivery (one webhook alert, one email) gives up after this long. */
  deliveryTimeoutMs: number;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`${NAME} is misconfigured: ${problems.join("; ")}`);
    this.name = "ConfigError";
  }
}

const SOURCE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const EMAIL = /^[^@\s]+@([^@\s]+\.[^@\s]+)$/;
const MIN_SECRET = 32;

/** The secret a source's pings must carry: PING_SECRET_<SOURCE>, upper case, `-` as `_`. */
export const secretName = (source: string): `PING_SECRET_${string}` =>
  `PING_SECRET_${source.toUpperCase().replaceAll("-", "_")}`;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isPositiveInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

const placeholder = (v: string) => v.trim() === "" || v.includes("REPLACE");

/** The hosts the example configuration ships with: a deployer has to put their own. */
const isExample = (host: string) => /(^|\.)example\.(com|net|org)$/i.test(host);

/** `echo` is false for a URL that is itself a secret: its problems never quote it. */
function httpsUrl(raw: unknown, what: string, problems: string[], echo = true): string | undefined {
  if (typeof raw !== "string" || placeholder(raw)) {
    problems.push(`${what} is not set`);
    return undefined;
  }
  const shown = echo ? `: ${raw}` : "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`${what} is not a URL${shown}`);
    return undefined;
  }
  if (url.protocol !== "https:") problems.push(`${what} must be https${shown}`);
  if (isExample(url.hostname)) problems.push(`${what} is still the example${shown}`);
  return raw;
}

function emailAddress(raw: unknown, what: string, problems: string[]): string {
  const domain = typeof raw === "string" && !placeholder(raw) ? EMAIL.exec(raw)?.[1] : undefined;
  if (domain === undefined) problems.push(`${what} must be set to an email address`);
  else if (isExample(domain)) problems.push(`${what} is still the example: ${raw}`);
  return typeof raw === "string" ? raw : "";
}

export function parseConfig(env: Env): Config {
  const problems: string[] = [];

  const heartbeats: Heartbeat[] = [];
  if (!isRecord(env.HEARTBEATS) || Object.keys(env.HEARTBEATS).length === 0) {
    problems.push("HEARTBEATS must be an object of at least one source");
  } else {
    for (const [source, value] of Object.entries(env.HEARTBEATS)) {
      if (!SOURCE.test(source)) problems.push(`HEARTBEATS: "${source}" is not a valid source name`);
      if (!isRecord(value) || !isPositiveInt(value.silentAfterSeconds)) {
        problems.push(`HEARTBEATS.${source}.silentAfterSeconds must be a positive whole number`);
        continue;
      }
      const name = secretName(source);
      const secret = env[name];
      if (typeof secret !== "string" || placeholder(secret)) {
        problems.push(`${name} is not set`);
      } else if (secret.length < MIN_SECRET) {
        problems.push(`${name} must be at least ${MIN_SECRET} characters`);
      } else {
        heartbeats.push({ source, silentAfterMs: value.silentAfterSeconds * 1000, secret });
      }
    }
  }

  let uptime: Config["uptime"] = { failuresBeforeAlert: 1, timeoutMs: 1, targets: [] };
  const u = env.UPTIME;
  if (!isRecord(u)) {
    problems.push("UPTIME must be an object");
  } else {
    if (!isPositiveInt(u.failuresBeforeAlert)) {
      problems.push("UPTIME.failuresBeforeAlert must be a positive whole number");
    }
    if (!isPositiveInt(u.timeoutSeconds) || u.timeoutSeconds > 20) {
      problems.push("UPTIME.timeoutSeconds must be a whole number from 1 to 20");
    }
    const targets: UptimeTarget[] = [];
    if (!Array.isArray(u.targets) || u.targets.length === 0) {
      problems.push("UPTIME.targets must list at least one target");
    } else {
      for (const [i, t] of u.targets.entries()) {
        if (!isRecord(t) || typeof t.name !== "string" || t.name.trim() === "") {
          problems.push(`UPTIME.targets[${i}] needs a name`);
          continue;
        }
        if (targets.some((seen) => seen.name === t.name)) {
          problems.push(`UPTIME.targets: "${t.name}" appears twice`);
        }
        const url = httpsUrl(t.url, `UPTIME.targets[${i}].url`, problems);
        if (
          t.expectBody !== undefined &&
          (typeof t.expectBody !== "string" || t.expectBody === "")
        ) {
          problems.push(`UPTIME.targets[${i}].expectBody must be a non-empty string when set`);
          continue;
        }
        const expectBody = typeof t.expectBody === "string" ? t.expectBody : null;
        if (url !== undefined) targets.push({ name: t.name, url, expectBody });
      }
    }
    uptime = {
      failuresBeforeAlert: u.failuresBeforeAlert as number,
      timeoutMs: (u.timeoutSeconds as number) * 1000,
      targets,
    };
  }

  // Which channels are in use is said outright, never read off which settings happen to be
  // there: a forgotten secret must be an error, not a channel quietly switched off.
  const listed: unknown[] = Array.isArray(env.CHANNELS) ? env.CHANNELS : [];
  const channels = CHANNELS.filter((c) => listed.includes(c));
  const unknown = listed.filter((c) => !CHANNELS.some((known) => known === c));
  if (listed.length === 0 || unknown.length > 0 || channels.length !== listed.length) {
    problems.push(
      `CHANNELS must list at least one of ${CHANNELS.map((c) => `"${c}"`).join(" and ")}, each once`,
    );
  }

  let webhook: Config["webhook"] = null;
  if (channels.includes("webhook")) {
    webhook = { url: httpsUrl(env.WEBHOOK_URL, "WEBHOOK_URL", problems, false) ?? "" };
  }

  let email: Config["email"] = null;
  if (channels.includes("email")) {
    const from = emailAddress(env.ALERT_EMAIL_FROM, "ALERT_EMAIL_FROM", problems);
    const to = emailAddress(env.ALERT_EMAIL_TO, "ALERT_EMAIL_TO", problems);
    if (env.EMAIL === undefined) {
      problems.push("EMAIL, the email-sending binding, is missing");
    } else {
      email = { binding: env.EMAIL, from, to };
    }
  }

  const delivery = env.DELIVERY_TIMEOUT_SECONDS;
  if (!isPositiveInt(delivery) || delivery > 15) {
    problems.push("DELIVERY_TIMEOUT_SECONDS must be a whole number from 1 to 15");
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return {
    heartbeats,
    uptime,
    channels,
    webhook,
    email,
    deliveryTimeoutMs: (delivery as number) * 1000,
  };
}
