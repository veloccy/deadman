// The words of each alert. Written when a check changes state, stored with it, and sent as stored
// until every channel has taken it, so a retry says what was true at the moment it happened.

export interface Alert {
  title: string;
  body: string;
  /**
   * What makes two webhook alerts the same incident. A check's "down" and its recovery carry the
   * check's own id, the same for every outage of it, so the recovery resolves what the "down"
   * opened. A missed outage carries a key of its own.
   */
  key: string;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;

export function heartbeatDown(
  key: string,
  source: string,
  now: number,
  lastPing: number | undefined,
  watchingSince: number,
  silentAfterMs: number,
): Alert {
  const silence =
    lastPing === undefined
      ? `has never pinged since the switch started watching it at ${iso(watchingSince)}`
      : `has not pinged since ${iso(lastPing)} (${minutes(now - lastPing)} ago)`;
  return {
    title: `No heartbeat from ${source}`,
    body:
      `${source} ${silence}; the alert fires after ${minutes(silentAfterMs)} of silence. ` +
      "Whatever sends the heartbeat is down or cannot reach the internet.",
    key,
  };
}

export function heartbeatUp(key: string, source: string, now: number, downSince: number): Alert {
  return {
    title: `Heartbeat from ${source} is back`,
    body: `${source} pinged again by ${iso(now)}; it was reported silent at ${iso(downSince)}.`,
    key,
  };
}

export function uptimeDown(
  key: string,
  name: string,
  url: string,
  failures: number,
  detail: string,
): Alert {
  return {
    title: `${name} is down`,
    body: `${url} failed ${failures} checks in a row from outside. Last: ${detail}.`,
    key,
  };
}

export function uptimeUp(
  key: string,
  name: string,
  url: string,
  now: number,
  downSince: number,
): Alert {
  return {
    title: `${name} is back up`,
    body: `${url} answered again at ${iso(now)}; it was reported down at ${iso(downSince)}.`,
    key,
  };
}

/**
 * For a channel that never took the "down": the outage, start to end, so a recovery never erases
 * an outage nobody heard about. Its key names this one outage: it must not be the check's own, or
 * the notice would stand in the way of the check's next "down".
 */
export function missedOutage(check: string, what: string, downSince: number, now: number): Alert {
  return {
    title: `${what} was down for ${minutes(now - downSince)}`,
    body:
      `${what} was down from ${iso(downSince)} to ${iso(now)}. The alert when it went down ` +
      "did not reach this channel; it is fine again now.",
    key: `${check}:missed:${iso(downSince)}`,
  };
}
