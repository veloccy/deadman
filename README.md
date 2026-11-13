# deadman

A dead-man switch and uptime checker that runs as one Cloudflare Worker, outside the system it
watches.

Nothing inside a system can report that system's own death. When the cluster is gone, so are the
Prometheus that would have noticed and the Alertmanager that would have told you; an alert a dead
system has to deliver is no alert. So the part that notices silence has to live somewhere else,
be small enough to trust, and be watched in turn. This is that part.

Made by [Veloccy](https://veloccy.com). MIT.

```
 your system                               the Worker (cron, every minute)          you
 ───────────                               ──────────────────────────────          ───
 a heartbeat source ── POST /ping/<source> ──▶ ┐
 (Alertmanager's Watchdog, a cron job)         │
                                               │ ── POST JSON ──▶ a webhook (a pager)
 public URLs ◀── GET, from outside ─────────── ┤
 (a site, a health route)                      │ ── Email Service ──▶ an inbox
                                               │
 something that can alert ── GET /status ────▶ ┘   Monitor (a Durable Object): last pings,
 (your Prometheus)                                 check states, what each channel was told
```

## What it does

**Heartbeats.** Each source you name in `HEARTBEATS` pings `POST /ping/<source>` with
`Authorization: Bearer <its secret>`. A source silent for longer than its `silentAfterSeconds`
raises one alert, and its first ping back raises one recovery. Nothing is sent in between. A
source that has never pinged is timed from the first run that watched it, so a system that never
comes up still alerts. The secret is compared in constant time (both sides are hashed, then
compared with `crypto.subtle.timingSafeEqual`), and a wrong secret, an unknown source or a method
other than POST is refused and does not count as a ping.

**Uptime checks, from outside.** Every minute each URL in `UPTIME.targets` is fetched over the
public internet, uncached. No answer within `timeoutSeconds`, or a status outside 200-299, is a
failure. `failuresBeforeAlert` failures in a row raise one alert, and the first success raises one
recovery. A target with `expectBody` is a health route and is held to more: its redirects are not
followed (a 3xx is a failure, and the alert says where it pointed) and its body, trimmed, must be
exactly that text. A login page or a parked domain answering 200 is not "up".

**Delivery that retries per channel.** There are two channels, a webhook and email, and you use
either or both. The Monitor records, for every check and every channel, the last state that
channel took. A channel that fails is sent the alert again every minute until it takes it, and
the channel that already took it is not sent it twice. Each delivery gives up after
`DELIVERY_TIMEOUT_SECONDS`, and a run's deliveries go out side by side, so a hung webhook does not
hold back the email. While anything is undelivered the run throws, so it shows as failed in the
Worker's logs.

**No outage goes unheard.** If something recovers before a channel ever took its "down" (the
webhook was failing the whole time, say), that channel is told once that it "was down from X to
Y", instead of getting a recovery for an outage it never heard of.

**One run at a time.** A run holds a 50-second lease. Judging needs the lease, and the run renews
it just before sending. A run whose lease ran out judges nothing and sends nothing, because
another run may have taken over. All state lives in one Durable Object, which handles one call at
a time against strongly consistent storage, so a ping that lands in the middle of a run is seen
by that run and two overlapping runs cannot both send the same alert.

**Watching the watcher.** The switch cannot report its own death either. `GET /status` answers
200 while a run finished in full (probed, judged and delivered everything it owed) within the last
3 minutes, and 503 otherwise. The body is one Prometheus gauge,
`deadman_last_full_run_timestamp_seconds`. Point something that can alert at it.

**Configuration that fails loudly.** Every setting and secret is checked on every request and
every run, and there are no defaults. If anything is missing or malformed, every ping and
`/status` answer 500 `misconfigured`, every run fails, and the Worker's logs name each problem.
That covers a placeholder left in a secret, a ping secret under 32 characters, a target that is
not https, a URL or address still pointing at `example.com`, a channel that is listed but not
fully set up, and no channel at all.

## Quick start

You need a Cloudflare account, [Bun](https://bun.sh) and the `cf` CLI, which `bun install` brings
in as a dependency of this repository.

1. Clone the repository and install.

   ```sh
   git clone <this repository> switch && cd switch
   bun install
   bun run test
   ```

2. Edit `cloudflare.config.ts`. Its comments say what each setting is. Put in your account, your
   heartbeat sources, your uptime targets and the channels you want. Each source in `HEARTBEATS`
   needs a `PING_SECRET_<SOURCE>` line at the bottom (the source in upper case, `-` as `_`).

3. Deploy, then set the secrets.

   ```sh
   bun run deploy     # cf build && cf deploy --prebuilt

   bunx cf workers secrets update PING_SECRET_CLUSTER --worker deadman --text "$(openssl rand -hex 32)"
   bunx cf workers secrets update WEBHOOK_URL         --worker deadman --text "https://..."
   bunx cf workers secrets update ALERT_EMAIL_TO      --worker deadman --text "you@your-domain"
   ```

   Keep the ping secret: the source needs it. Set only the secrets of the channels you listed in
   `CHANNELS`. For email, the domain of `ALERT_EMAIL_FROM` must be onboarded to Cloudflare Email
   Service on your account.

4. Check that it runs, and send a ping.

   ```sh
   curl -i https://<your worker>/status        # 200 once the first full run has finished
   curl -i -X POST https://<your worker>/ping/cluster \
     -H "Authorization: Bearer <PING_SECRET_CLUSTER>"      # 204
   ```

   If you do not ping, "No heartbeat from cluster" arrives once `silentAfterSeconds` have passed
   since the first run. That is correct, and it is a good first end-to-end test of your channels.

### Alertmanager's Watchdog as the heartbeat

kube-prometheus ships an alert named `Watchdog` that always fires. Route it to the switch, and
the heartbeat stops when Prometheus, Alertmanager or the network between them and the internet
stops. The switch ignores the body Alertmanager sends; the request is the heartbeat.

```yaml
route:
  routes:
    - receiver: heartbeat
      matchers: ['alertname = "Watchdog"']
      group_wait: 0s
      group_interval: 1m
      repeat_interval: 1m
receivers:
  - name: heartbeat
    webhook_configs:
      - url: https://<your worker>/ping/cluster
        send_resolved: false
        http_config:
          authorization:
            type: Bearer
            credentials: <PING_SECRET_CLUSTER>
```

### Prometheus watching the switch

A scrape of `/status` fails when the answer is 503 or does not come, so `up` is the signal.

```yaml
scrape_configs:
  - job_name: switch
    scheme: https
    metrics_path: /status
    scrape_interval: 1m
    static_configs:
      - targets: ["<your worker's hostname>"]
```

```yaml
- alert: SwitchDown
  expr: up{job="switch"} == 0
  for: 3m
  annotations:
    summary: The dead-man switch has not finished a full run, or cannot be reached.
```

Route that alert somewhere that does not go through the switch.

## The webhook channel

Each alert is one `POST` of JSON to `WEBHOOK_URL`. Any answer in 200-299 is a receipt. Anything
else, a redirect included, is a failure and is retried next minute.

```json
{
  "title": "api is down",
  "body": "https://api.example.com/health failed 3 checks in a row from outside. Last: HTTP 502.",
  "key": "uptime:api",
  "status": "firing",
  "severity": "page",
  "source": "deadman"
}
```

`key` is what ties alerts together. It is `heartbeat:<source>` or `uptime:<target name>`, and it
is the same for every outage of that check.

| When | `status` | `severity` | `key` |
| --- | --- | --- | --- |
| A check goes down | `firing` | `page` | the check's key |
| It recovers | `resolved` | `page` | the same key |
| It recovered, and this channel never took the "down" | `resolved`, then `firing` | `page`, then `notify` | the check's key, then `<the check's key>:missed:<when it went down>` |

The last row is two requests, and the reasons are these. The first resolves the check's key,
because a "down" the switch never saw a receipt for may have arrived all the same (the receiver
answered too late, for example), and an incident left open under that key would swallow the
check's next outage. The second is the notice itself, "was down from X to Y". It is `notify`
because the outage is over and nobody needs waking. It is `firing` because a receiver that keys
incidents has nothing open to resolve and would drop a `resolved`. It has a key of its own so it
can never be mistaken for the check's next "down", and so a retry of it is recognised as the same
notice. Nothing resolves it afterwards; it stays until a person closes it.

`WEBHOOK_URL` is a secret, since such URLs carry a token. It is never written to the logs.

### Pairing it with Vigil

[Vigil](https://github.com/veloccy/vigil) is a pager you run yourself: a phone app and a relay
that pages a team until someone acknowledges. The body above is the plain alert Vigil's relay
accepts, so pairing the two is one setting: `WEBHOOK_URL` is your Vigil team's hook URL,
`https://<your relay>/hook/<token>`.

A "down" opens an incident and pages. The recovery resolves that incident, because it carries
the same key. If the same check goes down again while the incident is still open, Vigil updates
it and does not page a second time. A missed outage arrives as a single quiet notification.

The two cover each other's gap. The switch sends each alert once per channel and does not repeat
it; Vigil repeats a page until someone answers.

## Where it stands, and its limits

- It is new. The tests run the Worker in workerd with every outbound call answered by the test;
  they do not prove a real delivery. Treat your first deployment as the first end-to-end test:
  let a source stay silent, and see the alert arrive on every channel you listed.
- If the switch and the thing that watches `/status` are down at the same moment, nothing alerts.
  Nothing watches the pair. If nothing watches `/status` at all, a broken switch is silent.
- An alert is sent once to each channel that takes it. The switch does not repeat it until
  someone acknowledges; that is the receiver's job.
- A retry can duplicate. The email binding takes no abort signal, so an email that timed out may
  still arrive, and its retry then makes two. A webhook that took an alert but answered after the
  timeout is sent it again; a receiver that keys incidents, as Vigil does, absorbs that.
- Checks run once a minute, on Cloudflare's cron. The shortest outage it can report is
  `failuresBeforeAlert` minutes long, and a heartbeat alert can be up to a minute late.
- Probes leave from Cloudflare's network, from wherever the cron ran. It is one outside view,
  not several regions compared.
- `failuresBeforeAlert` and `timeoutSeconds` are the same for every target.
- At least one heartbeat source and at least one uptime target are required.
- A check is known by its name. Rename or remove a target or a source while it is down and
  nothing resolves the old incident; close it by hand.
- A channel added to `CHANNELS` during an outage is told about that outage on the next run.

## Working on it

```sh
bun run test             # vitest in workerd; no call leaves the machine
bunx tsc --noEmit -p .
bun run dev              # cf dev; copy .dev.vars.example to .dev.vars first
```

| | |
| --- | --- |
| `cloudflare.config.ts` | What is watched and where alerts go. The file you edit. |
| `src/index.ts` | The Worker: the two routes, the probes, the deliveries, the minute's run. |
| `src/monitor.ts` | The Monitor, a Durable Object: pings, check states, what each channel was told, the lease. It decides and does no outside I/O. |
| `src/config.ts` | Reads and checks every setting. |
| `src/alerts.ts` | The words of each alert. |
| `test/worker.test.ts` | The suite. Time is passed in to each run, so no test depends on the date. |
