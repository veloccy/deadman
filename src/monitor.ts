// The switch's memory: one Durable Object holds the last ping of every source, the state of every
// check, which state each channel has been told, and when a run last finished in full.
//
// A Durable Object, not KV: every ping and every evaluation runs one at a time against strongly
// consistent storage, so the minute's evaluation always reads the latest ping and two evaluations
// cannot both decide to send the same alert. KV is eventually consistent (a write can take a minute
// or more to be seen elsewhere, which is the whole threshold) and last-write-wins, so it can both
// miss a ping and double an alert.
//
// Every method is synchronous over the object's synchronous storage (`ctx.storage.kv`): no await
// anywhere, so no other call can interleave with a read-modify-write. The Worker probes and
// delivers; this object only decides. A run holds a lease: evaluating needs it, and the Worker
// renews it just before sending, so a run whose lease ran out (and may have been taken over)
// sends nothing.

import { DurableObject } from "cloudflare:workers";
import {
  type Alert,
  heartbeatDown,
  heartbeatUp,
  missedOutage,
  uptimeDown,
  uptimeUp,
} from "./alerts";
import type { Channel, Env } from "./config";

export type Status = "up" | "down";

export interface CheckState {
  status: Status;
  /** When it entered this status (or was first seen). */
  since: number;
  /** Uptime checks: failures in a row. */
  failures: number;
  /** What to say about the current status; null until the first change. */
  alert: Alert | null;
  /** The last status each channel was told about. Starts up: nothing is said about a healthy start. */
  notified: Record<Channel, Status>;
  /** An outage a channel never heard about, to tell it once it is over; null when none. */
  missed: Record<Channel, Alert | null>;
}

export interface ProbeResult {
  name: string;
  url: string;
  ok: boolean;
  detail: string;
}

export interface Observation {
  /** The channels in use. Only these are owed anything; the state of the others is left alone. */
  channels: Channel[];
  heartbeats: { source: string; silentAfterMs: number }[];
  uptime: { failuresBeforeAlert: number; results: ProbeResult[] };
}

/** One message owed to one channel: the check's current status, or an outage it missed. */
export interface Pending {
  check: string;
  channel: Channel;
  what: "status" | "missed";
  status: Status;
  alert: Alert;
}

interface Lease {
  token: string;
  until: number;
}

/** Longer than a run's probes or its parallel deliveries can take (each at most 20 s), under a minute. */
export const LEASE_MS = 50_000;

const fresh = (now: number): CheckState => ({
  status: "up",
  since: now,
  failures: 0,
  alert: null,
  notified: { webhook: "up", email: "up" },
  missed: { webhook: null, email: null },
});

export class Monitor extends DurableObject<Env> {
  private get kv() {
    return this.ctx.storage.kv;
  }

  ping(source: string, at: number): void {
    const key = `ping:${source}`;
    const last = this.kv.get<number>(key);
    if (last === undefined || at > last) this.kv.put(key, at);
  }

  lastPing(source: string): number | undefined {
    return this.kv.get<number>(`ping:${source}`);
  }

  check(id: string): CheckState | undefined {
    return this.kv.get<CheckState>(`check:${id}`);
  }

  /** One run at a time: null while another run holds the lease. */
  begin(): string | null {
    const held = this.kv.get<Lease>("lease");
    const now = Date.now();
    if (held !== undefined && held.until > now) return null;
    const token = crypto.randomUUID();
    this.kv.put("lease", { token, until: now + LEASE_MS } satisfies Lease);
    return token;
  }

  /** Extends the lease if this run still holds it; false if it ran out or another run took it. */
  renew(token: string): boolean {
    if (!this.holds(token)) return false;
    this.kv.put("lease", { token, until: Date.now() + LEASE_MS } satisfies Lease);
    return true;
  }

  end(token: string): void {
    if (this.kv.get<Lease>("lease")?.token === token) this.kv.delete("lease");
  }

  /** A run probed, judged and delivered everything: what `GET /status` reports. */
  finished(token: string, at: number): void {
    if (this.holds(token)) this.kv.put("lastFullRun", at);
  }

  lastFullRun(): number | undefined {
    return this.kv.get<number>("lastFullRun");
  }

  /**
   * Apply this minute's observations and return every message some channel has not yet taken;
   * null (and nothing applied) if this run no longer holds the lease.
   */
  evaluate(token: string, now: number, seen: Observation): Pending[] | null {
    if (!this.holds(token)) return null;
    const pending: Pending[] = [];
    const settle = (id: string, state: CheckState) => {
      this.kv.put(`check:${id}`, state);
      for (const channel of seen.channels) {
        const missed = state.missed[channel];
        if (missed !== null) {
          pending.push({ check: id, channel, what: "missed", status: "down", alert: missed });
        }
        if (state.alert !== null && state.notified[channel] !== state.status) {
          pending.push({
            check: id,
            channel,
            what: "status",
            status: state.status,
            alert: state.alert,
          });
        }
      }
    };
    // Back up: a channel that heard the "down" hears the recovery; one that never did hears of the
    // outage instead, start to end.
    const recover = (id: string, state: CheckState, back: Alert, what: string) => {
      for (const channel of seen.channels) {
        if (state.notified[channel] !== "down") {
          state.missed[channel] = missedOutage(id, what, state.since, now);
        }
      }
      state.alert = back;
      state.status = "up";
      state.since = now;
    };

    for (const { source, silentAfterMs } of seen.heartbeats) {
      const id = `heartbeat:${source}`;
      const state = this.check(id) ?? fresh(now);
      const lastPing = this.lastPing(source);
      // A source that has never pinged is timed from when the switch first watched it.
      const watching = this.watchingSince(source, now);
      const silent = now - (lastPing ?? watching) > silentAfterMs;
      if (silent && state.status === "up") {
        state.status = "down";
        state.since = now;
        state.alert = heartbeatDown(id, source, now, lastPing, watching, silentAfterMs);
      } else if (!silent && state.status === "down") {
        const back = heartbeatUp(id, source, now, state.since);
        recover(id, state, back, `The heartbeat from ${source}`);
      }
      settle(id, state);
    }

    for (const r of seen.uptime.results) {
      const id = `uptime:${r.name}`;
      const state = this.check(id) ?? fresh(now);
      if (r.ok) {
        state.failures = 0;
        if (state.status === "down") {
          const back = uptimeUp(id, r.name, r.url, now, state.since);
          recover(id, state, back, `${r.name} (${r.url})`);
        }
      } else {
        state.failures += 1;
        if (state.status === "up" && state.failures >= seen.uptime.failuresBeforeAlert) {
          state.status = "down";
          state.since = now;
          state.alert = uptimeDown(id, r.name, r.url, state.failures, r.detail);
        }
      }
      settle(id, state);
    }

    return pending;
  }

  /** A channel took a message: never send it there again. */
  delivered(id: string, p: Pick<Pending, "channel" | "what" | "status">): void {
    const state = this.check(id);
    if (state === undefined) return;
    if (p.what === "missed") state.missed[p.channel] = null;
    else state.notified[p.channel] = p.status;
    this.kv.put(`check:${id}`, state);
  }

  private holds(token: string): boolean {
    const held = this.kv.get<Lease>("lease");
    return held !== undefined && held.token === token && held.until > Date.now();
  }

  private watchingSince(source: string, now: number): number {
    const key = `watching:${source}`;
    const since = this.kv.get<number>(key);
    if (since !== undefined) return since;
    this.kv.put(key, now);
    return now;
  }
}
