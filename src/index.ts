interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}${responseHints(res)}`,
    res.url,
    res.status,
  );
}

/**
 * Facts about a FAILED response that live in its headers, not its body, appended
 * so the gateway's classifier (which only ever sees this string) can tell a limit
 * from a wall from a refusal (fleet #3477). Both are standard, both are absent on
 * almost every response, and neither is invented: `Retry-After` is the server
 * saying "come back later" (the one thing that makes a 403 a throttle), and
 * Cloudflare marks a bot challenge with `cf-mitigated: challenge`.
 */
function responseHints(res: Response): string {
  const hints: string[] = [];
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) hints.push(`retry-after: ${retryAfter.slice(0, 40)}`);
  if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') hints.push('Cloudflare bot challenge (cf-mitigated: challenge)');
  return hints.length ? ` (${hints.join('; ')})` : '';
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities$shared(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities$shared(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}


/**
 * SSRF guard for fetching user- or registry-supplied URLs.
 *
 * Workers that fetch URLs an attacker can influence (submission test_endpoint,
 * scraper introspect remote_url, gateway generate_llms_txt) must run the target
 * through this first. Cloudflare Workers don't route to RFC-1918 by default, but
 * the worker is still an open-fetch primitive against internal CF services,
 * cloud metadata endpoints, and tenant-private origins reachable from egress —
 * so we enforce https-only and block private / loopback / link-local / metadata
 * hosts before the fetch.
 */

// Hostnames that must never be fetched, regardless of resolution.
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
]);

/** Parse a dotted-quad IPv4 string into its 4 octets, or null if not IPv4. */
function parseIpv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (octets.some((o) => o > 255)) return null;
  return octets as [number, number, number, number];
}

/**
 * Expand an IPv6 literal to its 8 numeric groups, or null if it isn't one.
 *
 * Needed because you cannot pattern-match IPv6 as text: `::ffff:127.0.0.1`,
 * `::ffff:7f00:1` and `0:0:0:0:0:ffff:7f00:0001` are the same address, and
 * WHATWG URL rewrites whichever you typed into the compressed hex form. The
 * guard has to compare numbers, not strings.
 */
function expandIpv6(host: string): number[] | null {
  let h = host.split('%')[0]; // drop any zone id (fe80::1%eth0)
  if (!h.includes(':')) return null;

  // A trailing dotted quad (::ffff:127.0.0.1) is legal IPv6 text. URL normally
  // normalizes it away, but accept it so callers passing a raw hostname — not
  // one that round-tripped through URL — get the same verdict.
  const lastColon = h.lastIndexOf(':');
  const tail = h.slice(lastColon + 1);
  if (tail.includes('.')) {
    const o = parseIpv4(tail);
    if (!o) return null;
    const hi = ((o[0] << 8) | o[1]).toString(16);
    const lo = ((o[2] << 8) | o[3]).toString(16);
    h = `${h.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = h.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const back = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];

  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - back.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill('0'), ...back];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

/**
 * The IPv4 address embedded in an IPv6 literal, for the three prefixes that
 * carry one, or null. Each is a way to name an IPv4 destination in IPv6 syntax,
 * so each is a way to smuggle 127.0.0.1 or 169.254.169.254 past a v4-only check.
 */
function embeddedIpv4(g: number[]): [number, number, number, number] | null {
  const low32 = (): [number, number, number, number] => [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff];
  const zeroTo5 = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
  if (zeroTo5 && g[5] === 0xffff) return low32(); // ::ffff:0:0/96  IPv4-mapped
  if (zeroTo5 && g[5] === 0) return low32();      // ::/96          IPv4-compatible (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b) return low32(); // 64:ff9b::/96 + /48  NAT64
  return null;
}

function isPrivateIpv4([a, b]: [number, number, number, number]): boolean {
  if (a === 10) return true;                         // 10.0.0.0/8
  if (a === 127) return true;                        // loopback
  if (a === 0) return true;                          // 0.0.0.0/8
  if (a === 169 && b === 254) return true;           // link-local / cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
  if (a === 192 && b === 168) return true;           // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true;                         // multicast / reserved
  return false;
}

/** True if the URL is safe to fetch (https + public host). */
function isPublicHttpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  // https only — blocks http://, file://, gopher://, ftp://, data:, etc.
  if (u.protocol !== 'https:') return false;

  let host = u.hostname.toLowerCase();
  if (!host) return false;
  // URL.hostname returns IPv6 literals bracketed (e.g. "[fc00::1]"); strip them
  // so the prefix/equality checks below see the bare address.
  const isV6 = host.startsWith('[') && host.endsWith(']');
  if (isV6) host = host.slice(1, -1);

  if (BLOCKED_HOSTNAMES.has(host)) return false;
  // Any *.localhost / *.internal / *.local
  if (host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return false;

  // IPv6 literals: block loopback (::1), unspecified (::), unique-local (fc00::/7),
  // and link-local (fe80::/10).
  if (isV6 || host.includes(':')) {
    if (host === '::1' || host === '::') return false;
    if (host.startsWith('fc') || host.startsWith('fd')) return false; // unique-local
    if (host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) return false; // link-local

    // An IPv6 literal can carry an IPv4 destination inside it (IPv4-mapped,
    // IPv4-compatible, NAT64). Decode it and apply the same v4 rules, so
    // [::ffff:169.254.169.254] is blocked exactly like 169.254.169.254.
    //
    // This previously matched on a dotted quad in the tail — which URL never
    // produces, since it serializes IPv6 in hex — so the check was dead code
    // and mapped loopback/metadata addresses passed (2026-08-01 review).
    const groups = expandIpv6(host);
    if (groups) {
      const v4 = embeddedIpv4(groups);
      if (v4 && isPrivateIpv4(v4)) return false;
    }
    return true;
  }

  const ipv4 = parseIpv4(host);
  if (ipv4) return !isPrivateIpv4(ipv4);

  return true;
}

/** Throws an Error with a stable code-ish message if the URL isn't safe to fetch. */
function assertPublicHttpUrl(raw: string): URL {
  if (!isPublicHttpUrl(raw)) {
    throw new Error(`blocked_url: refusing to fetch non-public or non-https URL`);
  }
  return new URL(raw);
}

// Path, query, fragment, userinfo, backslash, whitespace. Every one of these
// makes `https://${host}/api/...` mean something other than it reads as.
const HOSTNAME_FORBIDDEN = /[/?#@\\\s]/;

/**
 * Validate a caller-supplied HOSTNAME that a pack will interpolate into a URL
 * (`https://${host}/api/...`). Returns the normalized `hostname[:port]`.
 *
 * Use this instead of a hand-rolled strip-and-hope (fleet #214). Pinning the
 * scheme to https:// looks like protection and is not — the host segment is
 * still attacker-controlled, and two shapes walk straight past a protocol pin:
 *
 *   QUERY TRUNCATION  host = "evil.example/collect?x="
 *     `https://evil.example/collect?x=/api/v1/timelines/tag/x` — the API path
 *     the pack appended is now part of the QUERY STRING of an attacker's URL.
 *     The pack believes it called a Mastodon endpoint. It called whatever it
 *     was pointed at, and hands the body back to the caller.
 *
 *   USERINFO CONFUSION  host = "mastodon.social@evil.example"
 *     Everything before `@` is credentials, so this fetches evil.example while
 *     reading as legitimate in a log line or a code review.
 *
 * Stripping a leading `https://` and trailing slashes — the common shape in
 * these packs — defeats neither, and a `.replace(/\/.*$/, '')` that removes a
 * path still leaves `?`, `#` and `@` untouched (verified live against three
 * packs on 2026-08-10 before this landed).
 *
 * Rejects rather than sanitizes. A host with a path in it is not a typo we
 * should guess at, and silently truncating to `evil.example` would still fetch
 * a host the caller never legitimately meant.
 *
 * @param raw   the caller-supplied value; a leading scheme and trailing
 *              slashes are tolerated because callers habitually paste URLs.
 * @param label argument name, so the error tells the agent what to fix.
 */
function assertPublicHostname(raw: unknown, label = 'host'): string {
  const input = typeof raw === 'string' ? raw.trim() : '';
  if (!input) throw new Error(`blocked_host: ${label} is empty`);

  const stripped = input.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!stripped || HOSTNAME_FORBIDDEN.test(stripped)) {
    throw new Error(
      `blocked_host: ${label} "${input}" must be a bare hostname — no path, query string, fragment, "@" or whitespace.`,
    );
  }

  let u: URL;
  try {
    u = new URL(`https://${stripped}/`);
  } catch {
    throw new Error(`blocked_host: ${label} "${input}" is not a valid hostname.`);
  }

  // Reuse the vetted private/loopback/link-local/IPv6-mapped logic rather than
  // re-deriving it per pack — the packs' inlined copies each missed something
  // different (CGNAT 100.64/10 in one, IPv4-mapped IPv6 in another).
  //
  // Runs BEFORE the parse-equality check below so the caller gets the
  // informative reason. [::ffff:169.254.169.254] canonicalizes to
  // [::ffff:a9fe:a9fe], which trips equality too — "non-public host" is the
  // answer worth giving.
  if (!isPublicHttpUrl(u.toString())) {
    throw new Error(`blocked_host: refusing to fetch non-public host "${input}"`);
  }

  // Last-resort catch-all: the parser must agree with what we were handed.
  // Anything that survives the character check but still reparses into a
  // DIFFERENT host is the class of trick this function exists to stop, so treat
  // disagreement as hostile rather than trying to enumerate the tricks.
  //
  // Two legitimate transformations are exempt, or this would reject real hosts:
  //   - IDN punycoding (münchen.de → xn--mnchen-3ya.de). Every attack shape
  //     above is ASCII, so skipping non-ASCII costs the guard nothing.
  //   - IPv6 canonicalization ([2001:0db8::1] → [2001:db8::1]). The address is
  //     already fully validated above, where it matters.
  const asciiOnly = !/[^\x20-\x7E]/.test(stripped);
  const isV6Literal = stripped.startsWith('[');
  const expected = stripped.toLowerCase().replace(/:\d+$/, '');
  if (asciiOnly && !isV6Literal && u.hostname !== expected) {
    throw new Error(
      `blocked_host: ${label} "${input}" did not parse as the hostname it appears to be (got "${u.hostname}").`,
    );
  }

  return u.host;
}

/**
 * Validate a single DNS LABEL that a pack interpolates before a FIXED suffix
 * (`https://${sub}.freshdesk.com`, `https://${region}.api.riotgames.com`).
 *
 * A different problem from assertPublicHostname, and stricter: because the
 * suffix is fixed, the only escape is a character that ends the label early, so
 * a positive charset is both sufficient and simpler than parsing. Do NOT swap
 * these two — validating a label with assertPublicHostname would accept dots
 * and a port, and validating a hostname with this would reject every real one.
 *
 * These packs send credentials, so a label that escapes the suffix is a key
 * leak, not just an SSRF.
 */
function assertHostLabel(raw: unknown, label = 'subdomain'): string {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(v)) {
    throw new Error(
      `blocked_host: ${label} "${v}" must be a bare DNS label — letters, digits and hyphens only (e.g. "mycompany").`,
    );
  }
  return v.toLowerCase();
}

/**
 * Fetch a URL with SSRF protection that ALSO covers redirects.
 *
 * A plain `fetch(url)` uses `redirect: 'follow'`, which silently defeats an
 * `isPublicHttpUrl()` pre-check: a public URL can return a 3xx to a private /
 * loopback / metadata host and the runtime follows it without re-validation
 * (and a hostname can resolve to a private address regardless). safeFetch
 * validates the initial URL AND every redirect hop — it fetches with
 * `redirect: 'manual'`, re-runs isPublicHttpUrl on each `Location`, and
 * refuses to follow a hop to a non-public / non-https target.
 *
 * Throws `blocked_url: …` if the initial URL or any hop is unsafe, or if the
 * redirect budget is exceeded. Callers already wrap probes in try/catch, so a
 * blocked redirect flows through their normal failure path (submission stays
 * pending, monitor records a down check, introspection error, etc.).
 *
 * Method + body from `init` are preserved across hops (every hop is validated,
 * so re-issuing the request to a vetted public host is safe); any caller-set
 * `redirect` is overridden to 'manual'.
 *
 * Credential headers are DROPPED on a cross-origin hop. Built-in fetch does
 * this for you; a manual redirect loop has to do it by hand, and skipping it
 * turns "public host redirects us somewhere" into "public host harvests our
 * Authorization header" — the initial host chooses the Location, so it chooses
 * where the credential goes.
 */
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'x-api-key', 'proxy-authorization'];

/** Strip credential headers from `init`, used when a redirect crosses origins. */
function stripCredentials(init: RequestInit | undefined): RequestInit | undefined {
  if (!init?.headers) return init;
  const h = new Headers(init.headers as HeadersInit);
  let removed = false;
  for (const name of CREDENTIAL_HEADERS) {
    if (h.has(name)) {
      h.delete(name);
      removed = true;
    }
  }
  return removed ? { ...init, headers: h } : init;
}

async function safeFetch(
  raw: string,
  init?: RequestInit,
  opts?: { maxRedirects?: number } & SafeFetchExtendedOptions,
): Promise<Response> {
  // Opt-in hardening (fleet #2729/#2847). Only a caller that passes one of the
  // extended options takes the extended path; every existing caller passes at
  // most `maxRedirects` and runs the original loop below, unchanged.
  if (opts && usesExtendedOptions(opts)) return safeFetchExtended(raw, init, opts);
  const maxRedirects = opts?.maxRedirects ?? 3;
  const origin = assertPublicHttpUrl(raw).origin;
  let target = assertPublicHttpUrl(raw).toString();
  let reqInit = init;
  for (let hop = 0; ; hop++) {
    const res = await fetch(target, { ...reqInit, redirect: 'manual' });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return res;
    if (hop >= maxRedirects) throw new Error(`blocked_url: too many redirects (>${maxRedirects})`);
    let next: string;
    try {
      // Resolve relative Location against the current target before validating.
      next = new URL(location, target).toString();
    } catch {
      throw new Error('blocked_url: invalid redirect location');
    }
    if (!isPublicHttpUrl(next)) throw new Error('blocked_url: redirect to non-public URL');
    if (new URL(next).origin !== origin) reqInit = stripCredentials(reqInit);
    target = next;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OPT-IN HARDENING for fetching an arbitrary caller-named URL (fleet #2729,
// docs/verbatim-fetch-design.md §3; built in #2847).
//
// Everything below is reached ONLY when a caller passes one of these options to
// safeFetch. The https-only, any-port, lexical-only behaviour above is a
// standing invariant for every existing caller and is not changed: a call with
// no options, or with `maxRedirects` alone, never enters this code.
//
// What it adds, each enforced on the initial URL AND on every redirect hop:
//   allowHttp       accept http:// as well as https:// (https→http hops too;
//                   the caller sees them through onHop and says so)
//   allowedPorts    refuse any explicit port not in the list
//   refuseUserinfo  refuse `user:pass@host` — we never send credentials
//   resolvePublic   resolve the host over DNS-over-HTTPS (A + AAAA) and refuse
//                   if ANY answer is non-public: `10.0.0.1.nip.io` passes every
//                   lexical check above and still points at private space
//   denyHost        caller-supplied denylist (our own hosts, abuse complaints)
//   onHop           observe every response in the chain (status + Location)
//
// Refusals throw BlockedUrlError, whose message still starts `blocked_url:` so
// any existing catch that keys on that prefix keeps working, and which carries
// the RULE that fired so the caller can name it.
// ─────────────────────────────────────────────────────────────────────────────

type BlockedUrlRule =
  | 'invalid_url'
  | 'scheme'
  | 'userinfo'
  | 'port'
  | 'private_address'
  | 'dns_private'
  | 'denylisted_host'
  | 'too_many_redirects'
  | 'invalid_redirect';

class BlockedUrlError extends Error {
  readonly rule: BlockedUrlRule;
  /** The URL (initial or redirect target) that tripped the rule. */
  readonly url: string;
  /** 0 = the URL the caller passed; n = the n-th redirect target. */
  readonly hop: number;
  constructor(rule: BlockedUrlRule, detail: string, url: string, hop: number) {
    super(`blocked_url: ${rule}: ${detail}`);
    this.name = 'BlockedUrlError';
    this.rule = rule;
    this.url = url;
    this.hop = hop;
  }
}

/** The host could not be resolved at all (NXDOMAIN, no A/AAAA, or the DoH lookup itself failed). Fails closed. */
class DnsLookupError extends Error {
  readonly kind: 'nxdomain' | 'no_address' | 'lookup_failed';
  readonly host: string;
  constructor(kind: DnsLookupError['kind'], host: string, detail: string) {
    super(`dns_lookup_failed: ${kind}: ${host}: ${detail}`);
    this.name = 'DnsLookupError';
    this.kind = kind;
    this.host = host;
  }
}

interface PublicResolutionOptions {
  /** DoH JSON endpoint. Default https://cloudflare-dns.com/dns-query */
  endpoint?: string;
  /** Per-lookup bound. Default 3000 ms. */
  timeoutMs?: number;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

interface SafeFetchExtendedOptions {
  allowHttp?: boolean;
  allowedPorts?: number[];
  refuseUserinfo?: boolean;
  resolvePublic?: boolean | PublicResolutionOptions;
  /** Return a reason string to refuse a host, or null to allow it. Receives the lowercased hostname. */
  denyHost?: (hostname: string) => string | null;
  onHop?: (hop: { url: string; status: number; location: string | null }) => void;
}

function usesExtendedOptions(o: SafeFetchExtendedOptions): boolean {
  return (
    o.allowHttp !== undefined ||
    o.allowedPorts !== undefined ||
    o.refuseUserinfo !== undefined ||
    o.resolvePublic !== undefined ||
    o.denyHost !== undefined ||
    o.onHop !== undefined
  );
}

function bareHost(u: URL): string {
  const h = u.hostname.toLowerCase();
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

function isIpLiteral(host: string): boolean {
  return parseIpv4(host) !== null || host.includes(':');
}

/** True when an address from a DNS answer is public, by the same rules as a URL literal. */
function isPublicAddress(addr: string): boolean {
  const a = addr.trim().toLowerCase();
  if (!a) return false;
  return isPublicHttpUrl(a.includes(':') ? `https://[${a}]/` : `https://${a}/`);
}

/**
 * Lexical checks for one URL in the chain, by the opted-in rules. Returns the
 * parsed URL or throws BlockedUrlError naming the rule.
 */
function checkUrlByRules(raw: string, opts: SafeFetchExtendedOptions, hop = 0): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BlockedUrlError('invalid_url', 'not a parseable absolute URL', raw, hop);
  }
  const httpOk = opts.allowHttp === true && u.protocol === 'http:';
  if (u.protocol !== 'https:' && !httpOk) {
    throw new BlockedUrlError('scheme', `${u.protocol.replace(/:$/, '')} is not allowed (${opts.allowHttp ? 'http or https' : 'https'} only)`, raw, hop);
  }
  if (opts.refuseUserinfo && (u.username || u.password)) {
    throw new BlockedUrlError('userinfo', 'URLs carrying user:password@ credentials are refused', raw, hop);
  }
  if (opts.allowedPorts) {
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    if (!opts.allowedPorts.includes(port)) {
      throw new BlockedUrlError('port', `port ${port} is not allowed (allowed: ${opts.allowedPorts.join(', ')})`, raw, hop);
    }
  }
  // Host rules: reuse the vetted lexical guard on an https URL carrying only the host.
  if (!isPublicHttpUrl(`https://${u.hostname}/`)) {
    throw new BlockedUrlError('private_address', `${u.hostname} is a private, loopback, link-local, metadata or reserved address`, raw, hop);
  }
  if (opts.denyHost) {
    const reason = opts.denyHost(bareHost(u));
    if (reason) throw new BlockedUrlError('denylisted_host', reason, raw, hop);
  }
  return u;
}

type DohAnswer = { type?: number; data?: string; TTL?: number };
const dnsVerdictCache = new Map<string, { addresses: string[]; expires: number }>();

async function dohQuery(host: string, type: 'A' | 'AAAA', o: PublicResolutionOptions): Promise<{ status: number; answers: DohAnswer[] }> {
  const endpoint = o.endpoint ?? 'https://cloudflare-dns.com/dns-query';
  const f = o.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${endpoint}?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { Accept: 'application/dns-json' },
      signal: AbortSignal.timeout(o.timeoutMs ?? 3000),
    });
  } catch (e) {
    throw new DnsLookupError('lookup_failed', host, `DoH ${type} request failed: ${(e as Error).message}`);
  }
  if (!res.ok) throw new DnsLookupError('lookup_failed', host, `DoH ${type} returned HTTP ${res.status}`);
  let j: { Status?: number; Answer?: DohAnswer[] };
  try {
    j = (await res.json()) as typeof j;
  } catch {
    throw new DnsLookupError('lookup_failed', host, `DoH ${type} body is not JSON`);
  }
  return { status: j.Status ?? -1, answers: Array.isArray(j.Answer) ? j.Answer : [] };
}

/**
 * Resolve `host` over DNS-over-HTTPS (A and AAAA) and throw BlockedUrlError
 * (`dns_private`) if ANY address is non-public. Throws DnsLookupError when the
 * name does not resolve or the lookup fails — fail closed: an unverifiable
 * host is not fetched.
 *
 * Residual risk, accepted in the design: the runtime resolves the name again
 * when it connects, so a TOCTOU window remains. The backstop is that Workers
 * egress is not a route into our infrastructure and no credential is attached.
 *
 * Public verdicts are cached per isolate for the record TTL (60 s minimum).
 */
async function assertPublicResolution(host: string, o: PublicResolutionOptions = {}, hop = 0, url = host): Promise<string[]> {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIpLiteral(h)) {
    if (!isPublicAddress(h)) throw new BlockedUrlError('dns_private', `${h} is not a public address`, url, hop);
    return [h];
  }
  const hit = dnsVerdictCache.get(h);
  if (hit && hit.expires > Date.now()) return hit.addresses;

  const [a, aaaa] = await Promise.all([dohQuery(h, 'A', o), dohQuery(h, 'AAAA', o)]);
  if (a.status === 3 && aaaa.status === 3) throw new DnsLookupError('nxdomain', h, 'the name does not exist');
  if (a.status !== 0 && aaaa.status !== 0) {
    throw new DnsLookupError('lookup_failed', h, `DoH status A=${a.status} AAAA=${aaaa.status}`);
  }
  const addrs = [...a.answers, ...aaaa.answers].filter((r) => (r.type === 1 || r.type === 28) && typeof r.data === 'string');
  if (addrs.length === 0) throw new DnsLookupError('no_address', h, 'no A or AAAA records');
  const bad = addrs.find((r) => !isPublicAddress(String(r.data)));
  if (bad) {
    throw new BlockedUrlError('dns_private', `${h} resolves to ${bad.data}, which is not a public address`, url, hop);
  }
  const ttl = Math.max(60, Math.min(...addrs.map((r) => (typeof r.TTL === 'number' ? r.TTL : 60))));
  const addresses = addrs.map((r) => String(r.data));
  dnsVerdictCache.set(h, { addresses, expires: Date.now() + ttl * 1000 });
  return addresses;
}

/** Test seam: forget cached DNS verdicts. */
function clearPublicResolutionCache(): void {
  dnsVerdictCache.clear();
}

async function vetHop(raw: string, opts: SafeFetchExtendedOptions, hop: number): Promise<URL> {
  const u = checkUrlByRules(raw, opts, hop);
  if (opts.resolvePublic) {
    const ro = typeof opts.resolvePublic === 'object' ? opts.resolvePublic : {};
    await assertPublicResolution(bareHost(u), ro, hop, raw);
  }
  return u;
}

async function safeFetchExtended(
  raw: string,
  init: RequestInit | undefined,
  opts: { maxRedirects?: number } & SafeFetchExtendedOptions,
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 3;
  let target = await vetHop(raw, opts, 0);
  const origin = target.origin;
  let reqInit = init;
  for (let hop = 0; ; hop++) {
    const res = await fetch(target.toString(), { ...reqInit, redirect: 'manual' });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    opts.onHop?.({ url: target.toString(), status: res.status, location });
    if (!location) return res;
    // Release the redirect body; we never read it.
    try { await res.body?.cancel(); } catch { /* already consumed or not cancellable */ }
    if (hop >= maxRedirects) {
      throw new BlockedUrlError('too_many_redirects', `more than ${maxRedirects} redirects`, target.toString(), hop + 1);
    }
    let next: string;
    try {
      next = new URL(location, target).toString();
    } catch {
      throw new BlockedUrlError('invalid_redirect', `unparseable Location ${location.slice(0, 120)}`, target.toString(), hop + 1);
    }
    target = await vetHop(next, opts, hop + 1);
    if (target.origin !== origin) reqInit = stripCredentials(reqInit);
  }
}
/**
 * ATS Boards MCP — public job-board postings across eight applicant-tracking
 * systems (keyless).
 *
 * This is NOT the `greenhouse`/`ashby` packs. Those wrap each vendor's PRIVATE
 * Harvest/API key endpoints so a caller can read their OWN hiring data. This
 * pack reads the PUBLIC job-board endpoint every ATS exposes with no key at
 * all — the same data a browser sees on a company's careers page — for any
 * company, not just the caller's own.
 *
 * Coverage and the exact public endpoint each one wraps:
 *   greenhouse       GET  boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
 *   lever            GET  api.lever.co/v0/postings/{token}?mode=json        (region:"eu" -> api.eu.lever.co)
 *   ashby            GET  api.ashbyhq.com/posting-api/job-board/{token}?includeCompensation=true
 *   smartrecruiters  GET  api.smartrecruiters.com/v1/companies/{token}/postings
 *   recruitee        GET  {token}.recruitee.com/api/offers/
 *   bamboohr         GET  {token}.bamboohr.com/careers/list
 *   workday          POST {tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
 *                         board_token format: "{tenant}.wd{N}/{site}", e.g. "workday.wd5/Workday"
 *   workable         GET  apply.workable.com/api/v1/widget/accounts/{token}  — SEE WORKABLE NOTE BELOW.
 *
 * ── THE SILENT-ZERO TRAPS, measured live via a throwaway `wrangler dev
 *    --remote` edge probe (2026-10-08, this task) — not assumed from docs ──
 *
 * These are the reason this pack normalizes into `{found, reason, jobs}`
 * rather than passing upstream shapes through: each ATS answers "no such
 * board" differently, and three of the eight don't even distinguish it from
 * "real board, zero jobs right now."
 *
 *   GREENHOUSE  unknown board -> HTTP 404 JSON {"status":404,"error":"Job
 *     not found"}. Confirmed real board w/ jobs: boards-api.greenhouse.io
 *     /v1/boards/airbnb/jobs?content=true -> 200, 2.28 MB, jobs[].
 *
 *   LEVER  unknown company -> HTTP 404 JSON {"ok":false,"error":"Document
 *     not found"}. A REAL company with zero current postings -> HTTP 200
 *     `[]` (2 bytes) — confirmed live against api.lever.co/v0/postings/lever
 *     (Lever's own board, genuinely empty right now). A real board WITH
 *     jobs -> HTTP 200 with a populated array (confirmed against
 *     .../postings/spotify, 740 KB). So 404 vs 200 is the ENTIRE signal;
 *     never treat a non-200 as "zero jobs."
 *
 *   ASHBY  unknown board -> HTTP 404, Content-Type text/plain, body
 *     literally "Not Found" (9 bytes — NOT JSON, parsing it as JSON throws).
 *     A real board with zero jobs -> HTTP 200 JSON
 *     {"jobs":[],"apiVersion":"1"} (28 bytes) — confirmed against
 *     api.ashbyhq.com/posting-api/job-board/vercel, /deel and /mercury, all
 *     three live and empty at probe time. A real board with jobs ->
 *     .../job-board/ramp, 2.9 MB.
 *
 *   SMARTRECRUITERS  does NOT distinguish unknown from empty — both return
 *     HTTP 200 JSON {"offset":0,"limit":100,"totalFound":0,"content":[]}
 *     (confirmed: a nonsense company id and a plausible-but-wrong guess
 *     ("visa") both got byte-identical responses). There is no field in this
 *     response that tells you which one you got. `smartrecruiters_jobs` on
 *     totalFound:0 therefore returns `found:true, ambiguous:true` rather than
 *     claiming either "no such company" or "confirmed zero postings" — only
 *     `ats_detect`, which verifies the token through a DIFFERENT channel
 *     first (the careers-page scrape), can resolve the ambiguity. Confirmed
 *     real w/ jobs: companies/mcdonaldscorporation/postings (4),
 *     companies/boschgroup/postings (4,886).
 *
 *   RECRUITEE  unknown subdomain -> HTTP 404 JSON {"error":"Not Found"}.
 *     Confirmed real w/ jobs: livesport.recruitee.com/api/offers/
 *     (16 KB, {"offers":[...]}). Did not find a currently-empty real board
 *     inside this task's time budget; the shape for one would be HTTP 200
 *     {"offers":[]}, by analogy with every sibling ATS that uses this
 *     "200 success envelope, empty array" convention — NOT independently
 *     confirmed live, flagged as such below.
 *
 *   BAMBOOHR  unknown subdomain -> HTTP 200 (!) but Content-Type text/html,
 *     serving BambooHR's OWN marketing homepage
 *     (<title>BambooHR: The Complete HR Software...</title>, 44,786 bytes,
 *     byte-identical across different nonsense subdomains — it's a wildcard
 *     catch-all, not a per-subdomain 404). This is a THIRD distinct trap
 *     shape: same status code, different content-type and body. A real
 *     subdomain -> HTTP 200 JSON {"meta":{"totalCount":N},"result":[...]}.
 *     Confirmed real w/ jobs: instructure.bamboohr.com/careers/list
 *     (totalCount:4). Confirmed real w/ ZERO jobs:
 *     helpscout.bamboohr.com/careers/list and
 *     pantheon.bamboohr.com/careers/list (both totalCount:0,
 *     {"meta":{"totalCount":0},"result":[]}) — this endpoint was marked
 *     [unverified] in the research the demand evidence cites; it is now
 *     CONFIRMED live, including the catch-all trap.
 *
 *   WORKDAY  unknown tenant/site -> HTTP 404 JSON
 *     {"errorCode":"S21",...,"message":"not found:
 *     Job_Posting_Site_ID=<site>"}. A `limit` over 20 -> HTTP 400 JSON
 *     {"errorCode":"HTTP_400",...} — Workday REJECTS it outright rather than
 *     silently emptying the page, so this pack clamps `limit` to 20 itself
 *     and reports when it had to. An `offset` past 10,000 did NOT error in
 *     this probe — workday.wd5.myworkdayjobs.com/wday/cxs/workday/Workday
 *     /jobs with offset:10040 returned HTTP 200 with the SAME `total` and the
 *     SAME first job as offset:0, i.e. pagination silently stalls rather than
 *     erroring or going empty past the cap. This pack reports `capped:true`
 *     whenever a caller's offset exceeds 10,000, naming the behavior rather
 *     than returning what looks like a fresh page. Confirmed real tenant w/
 *     jobs: tenant "workday", wd5, site "Workday" -> total:389.
 *
 *   WORKABLE  every documented public endpoint (the v1 widget
 *     apply.workable.com/api/v1/widget/accounts/{account}, the v3 widget
 *     apply.workable.com/api/v3/accounts/{account}/jobs, with and without an
 *     Accept header, against several real account names) returned HTTP 429,
 *     Content-Type text/plain, body "error code: 1015" — Cloudflare's OWN
 *     bot-block, not an application-level response, reproduced identically
 *     across 5+ attempts over several minutes from a throwaway
 *     `wrangler dev --remote` Worker on Pipeworx's production Cloudflare
 *     account. This reads as Workable's Cloudflare WAF specifically rate-
 *     limiting Worker-to-Worker (Cloudflare-to-Cloudflare) traffic to
 *     apply.workable.com — a structural block, not a transient blip or a
 *     wrong URL (an alternate {account}.workable.com/spi/v1/jobs path was
 *     NOT blocked, returning a clean 404 instead, but is not the real jobs
 *     endpoint — every account probed there, real and fake alike, got the
 *     same 404). This pack still implements the v1 widget parser (shape per
 *     Workable's own published docs — name, jobs:[{title, shortcode, code,
 *     department, url, ...}]) so it is ready the moment this changes, but
 *     EVERY live call from this platform's edge will currently throw a loud
 *     error naming the 429 and the Cloudflare block, never a silent empty
 *     list. Do not spend more probing time rediscovering this; it is
 *     consistent and documented.
 *
 * ── Second wave (fleet #3086, 2026-10-14) — Teamtailor, Personio, Jobvite,
 *    Breezy, Pinpoint, Rippling, iCIMS added; Dover dropped ──────────────────
 * Measured live via curl from a laptop AND a throwaway Worker (see
 * `_edge_probe_worker` note below). Endpoints:
 *
 *   TEAMTAILOR  GET {token}.teamtailor.com/jobs.json — a keyless JSON Feed
 *     (jsonfeed.org v1.1). Unknown subdomain -> HTTP 404, Content-Type
 *     application/json, body EMPTY (0 bytes, not even `{}`) — status is the
 *     only signal, never parse-then-check. Confirmed real w/ jobs:
 *     career.teamtailor.com (Teamtailor itself) and arsenalfc.teamtailor.com.
 *     Each item carries a schema.org `_jobposting.jobLocation[0].address`;
 *     no department/remote field in this feed.
 *
 *   PERSONIO  GET {token}.jobs.personio.com/xml?language=en, falling back to
 *     .jobs.personio.de on a 404 — a company is hosted on exactly one of the
 *     two TLDs and there is no redirect between them, confirmed live
 *     (1nce -> .com; kertos -> .de; hometogo.com 404'd, never probed .de).
 *     Unknown subdomain (either TLD) -> HTTP 404 text/html. Real feed is XML
 *     (`<workzag-jobs><position>...`), parsed by regex (Workers have no
 *     DOMParser) with basic entity decoding. No per-job URL field; this pack
 *     builds one as `{token}.jobs.personio.{tld}/job/{id}?language=en`,
 *     matching the pattern on every indexed Personio job link.
 *
 *   JOBVITE  GET jobs.jobvite.com/{token} — server-rendered HTML table
 *     (`<td class="jv-job-list-name"><a href="/{token}/job/{code}">`), no
 *     JSON API (the vendor's own feed is per-customer and off by default).
 *     Unknown token -> HTTP 200 but 4 silent redirects to
 *     www.jobvite.com/support/job-seeker-support/?invalid=1 — a DIFFERENT
 *     host, confirmed live (`num_redirects:4`). `fetch()`'s default
 *     `redirect:'follow'` makes this invisible unless you check
 *     `res.redirected`; this pack treats any redirect as board_not_found.
 *     Confirmed real w/ jobs: jobs.jobvite.com/bagleybagelbites (65 rows).
 *
 *   BREEZY  GET {token}.breezy.hr/json — keyless JSON array (not wrapped).
 *     Unknown subdomain -> HTTP 404, Content-Type text/html, title "Career
 *     portal not found | Breezy HR". Confirmed real w/ jobs: breezy.breezy.hr
 *     and duolingo.breezy.hr.
 *
 *   PINPOINT  GET {token}.pinpointhq.com/postings.json — keyless JSON
 *     `{data:[...]}`, per Pinpoint's own published docs. Unknown subdomain ->
 *     HTTP 404, Content-Type text/html (Pinpoint's own 404 page, not JSON).
 *     Confirmed real w/ jobs: workwithus.pinpointhq.com. A real board with
 *     zero current postings would be HTTP 200 `{data:[]}` by the same
 *     200-success-envelope convention every sibling ATS here uses — NOT
 *     independently confirmed live (every real board probed had postings),
 *     flagged as such like Recruitee's empty-board case above.
 *
 *   RIPPLING  GET ats.rippling.com/{token}/jobs — a Next.js page with NO
 *     separate JSON API; every guessed `/api/...` path 404'd. The job data is
 *     server-rendered into a `<script id="__NEXT_DATA__" type="application/
 *     json">` tag as hydrated react-query state — this pack parses that
 *     script tag and reads the query whose `queryKey` is
 *     `["board", token, "job-posts"]`. Unknown token -> HTTP 404,
 *     Content-Type text/html, Next.js's own 404 page (no `__NEXT_DATA__`
 *     job-posts query to find). Confirmed real w/ jobs:
 *     ats.rippling.com/skillable-careers/jobs and .../rearc/jobs.
 *
 *   ICIMS  GET {token}.icims.com/jobs/search?ss=1&in_iframe=1 — iCIMS's
 *     documented Talent-Cloud API is gated behind a partner application, but
 *     the public career-SEARCH page itself is plain server-rendered HTML
 *     with no login (`<li class="iCIMS_JobCardItem">` blocks: title via
 *     `<h3>`, location via the "Job Locations" field, department via the
 *     "Category" dt/dd pair) — parsed by regex, same category as this pack's
 *     existing HTML scraping for ats_detect. `token` is the FULL subdomain
 *     label a company's careers portal uses (e.g. "careers-intrepidsolutions"
 *     — iCIMS customers don't share one fixed prefix). Unknown subdomain ->
 *     HTTP 404, title "gone: {subdomain}.icims.com : dc409". Confirmed real
 *     w/ jobs: careers-intrepidsolutions.icims.com (14 postings).
 *
 *   DOVER — DROPPED. app.dover.com/jobs/{slug} is a client-rendered SPA
 *     behind a Cloudflare Turnstile challenge (the page ships
 *     `challenges.cloudflare.com/turnstile/v0/api.js`); its underlying jobs
 *     API, app.dover.com/api/v1/jobs, answers HTTP 401 `{"detail":
 *     "Authentication credentials were not provided."}` for every query-
 *     param combination tried (bare, `?company=`, `?careers_page_slug=`) —
 *     there is no discoverable keyless public endpoint, only a walled one.
 *
 * ── Persistence (fleet #2754: never module scope) ──────────────────────────
 * The gateway injects its one shared KV namespace as `_cacheKv`
 * (`injectCacheKv: true` on this pack's pack-manifest.json row — same
 * mechanism as prozorro/spain-tenders/oregon-code). Two independent uses,
 * both missing/degrading cleanly to a live fetch when the binding is absent
 * (standalone build, or a KV error — caching is never why a call fails):
 *   1. JOB-LIST CACHE-ASIDE, keyed per board, TTL ~3h — this IS "poll each
 *      board no more than every few hours" from the task: every caller
 *      within the TTL window gets the same cached answer instead of each
 *      re-hitting the upstream.
 *   2. DISCOVERY INDEX, `ats_detect` writes `domain -> {ats, board_token}`
 *      once resolved, TTL 30 days — "the index grows with use."
 *   3. NEW-POSTINGS SNAPSHOT for `ats_new_postings`, the set of job keys seen
 *      on the last call for a given board, no TTL (diffing needs it to
 *      persist; it is small and self-correcting on every call).
 */


const UA = 'pipeworx-ats-boards/1.0 (+https://pipeworx.io)';

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, 'ATS board');
}

// -- KV cache-aside (fleet #2754/#2836 pattern) ------------------------------

interface KvLike {
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

function kvFromArgs(args: Record<string, unknown>): KvLike | undefined {
  const kv = args._cacheKv;
  return kv && typeof (kv as KvLike).get === 'function' && typeof (kv as KvLike).put === 'function'
    ? (kv as KvLike)
    : undefined;
}

async function kvGetJson<T>(kv: KvLike | undefined, key: string): Promise<T | null> {
  if (!kv) return null;
  try {
    const v = await kv.get(key, 'json');
    return (v as T) ?? null;
  } catch {
    return null; // a cache read failure degrades to "no cache", never a thrown error
  }
}

async function kvPutJson(kv: KvLike | undefined, key: string, value: unknown, ttlSec?: number): Promise<void> {
  if (!kv) return;
  try {
    await kv.put(key, JSON.stringify(value), ttlSec ? { expirationTtl: ttlSec } : undefined);
  } catch {
    // caching is an optimization; a write failure must never fail the call
  }
}

const JOBS_CACHE_TTL_SEC = 3 * 60 * 60; // ~3h — "poll each board no more than every few hours"
const DISCOVERY_TTL_SEC = 30 * 24 * 60 * 60; // 30 days
const KV_PREFIX = 'ats-boards:v1';

function jobsCacheKey(ats: string, token: string, extra?: string): string {
  return `${KV_PREFIX}:jobs:${ats}:${token.toLowerCase()}${extra ? `:${extra}` : ''}`;
}
function discoveryKey(domain: string): string {
  return `${KV_PREFIX}:domain:${domain.toLowerCase()}`;
}
function snapshotKey(ats: string, token: string): string {
  return `${KV_PREFIX}:snapshot:${ats}:${token.toLowerCase()}`;
}

// -- Normalized shapes --------------------------------------------------------

export interface NormalizedJob {
  title: string;
  location: string | null;
  dept: string | null;
  remote: boolean | null;
  comp: string | null;
  posted_at: string | null;
  url: string | null;
}

export interface AtsJobsFound {
  found: true;
  ats: string;
  board_token: string;
  total: number | null;
  jobs: NormalizedJob[];
  data_as_of: string;
  ambiguous?: boolean;
  note?: string;
  capped?: boolean;
  cap_detail?: string;
  served_from?: 'fresh-cache' | 'upstream';
  cache_age_sec?: number;
}

export interface AtsJobsNotFound {
  found: false;
  ats: string;
  board_token: string;
  reason: 'board_not_found' | 'invalid_board_token' | 'upstream_blocked';
  evidence: string;
  data_as_of: string;
}

export type AtsJobsResult = AtsJobsFound | AtsJobsNotFound;

// Exported so callers that reuse this pack's logic directly (rather than
// re-fetching boards themselves — see workers/scraper/src/subscriptions.ts'
// evaluateJobPost, fleet #2858) can validate/enumerate the same board types
// without duplicating this list.
export const VALID_ATS = [
  'greenhouse',
  'lever',
  'ashby',
  'smartrecruiters',
  'recruitee',
  'bamboohr',
  'workday',
  'workable',
  'teamtailor',
  'personio',
  'jobvite',
  'breezy',
  'pinpoint',
  'rippling',
  'icims',
] as const;
export type Ats = (typeof VALID_ATS)[number];

function requireAts(v: unknown): Ats {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!(VALID_ATS as readonly string[]).includes(s)) {
    throw new Error(`invalid_ats: "${v}" — must be one of ${VALID_ATS.join(', ')}`);
  }
  return s as Ats;
}

function nowIso(): string {
  return new Date().toISOString();
}

// -- Per-ATS fetchers (each returns a normalized AtsJobsResult, never throws
//    for a board-shaped "not found" — only for a genuine transport/parse
//    failure, which DOES throw, loud, naming the upstream status) ----------

async function fetchGreenhouse(token: string): Promise<AtsJobsResult> {
  const res = await pwFetch(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`, {
    headers: { Accept: 'application/json' },
  });
  if (res.status === 404) {
    return { found: false, ats: 'greenhouse', board_token: token, reason: 'board_not_found', evidence: 'HTTP 404 — Greenhouse: "Job not found"', data_as_of: nowIso() };
  }
  if (!res.ok) {
    throw new Error(`Greenhouse board "${token}" returned HTTP ${res.status}: ${summarizeErrorBody(await res.text())}`);
  }
  const data = (await res.json()) as { jobs?: unknown[] };
  const jobs: NormalizedJob[] = (data.jobs ?? []).map((raw) => {
    const j = raw as Record<string, unknown>;
    const location = j.location as Record<string, unknown> | undefined;
    const departments = j.departments as Array<Record<string, unknown>> | undefined;
    return {
      title: String(j.title ?? ''),
      location: (location?.name as string) ?? null,
      dept: (departments?.[0]?.name as string) ?? null,
      remote: null,
      comp: null,
      posted_at: (j.updated_at as string) ?? null,
      url: (j.absolute_url as string) ?? null,
    };
  });
  return { found: true, ats: 'greenhouse', board_token: token, total: jobs.length, jobs, data_as_of: nowIso() };
}

async function fetchLever(token: string, region: 'us' | 'eu'): Promise<AtsJobsResult> {
  const base = region === 'eu' ? 'https://api.eu.lever.co' : 'https://api.lever.co';
  const res = await pwFetch(`${base}/v0/postings/${encodeURIComponent(token)}?mode=json`, { headers: { Accept: 'application/json' } });
  if (res.status === 404) {
    return { found: false, ats: 'lever', board_token: token, reason: 'board_not_found', evidence: 'HTTP 404 — Lever: {"ok":false,"error":"Document not found"}', data_as_of: nowIso() };
  }
  if (!res.ok) {
    throw new Error(`Lever board "${token}" returned HTTP ${res.status}: ${summarizeErrorBody(await res.text())}`);
  }
  const data = (await res.json()) as unknown[];
  const jobs: NormalizedJob[] = (Array.isArray(data) ? data : []).map((raw) => {
    const j = raw as Record<string, unknown>;
    const categories = j.categories as Record<string, unknown> | undefined;
    return {
      title: String(j.text ?? ''),
      location: (categories?.location as string) ?? null,
      dept: (categories?.team as string) ?? null,
      remote: (categories?.workplaceType as string)?.toLowerCase() === 'remote' || null,
      comp: null,
      posted_at: typeof j.createdAt === 'number' ? new Date(j.createdAt).toISOString() : null,
      url: (j.hostedUrl as string) ?? null,
    };
  });
  // jobs.length === 0 here is a REAL confirmed-empty board (we only reach this
  // line on HTTP 200) — never reclassify it as not-found.
  return { found: true, ats: 'lever', board_token: token, total: jobs.length, jobs, data_as_of: nowIso() };
}

async function fetchAshby(token: string): Promise<AtsJobsResult> {
  const res = await pwFetch(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`, {
    headers: { Accept: 'application/json' },
  });
  if (res.status === 404) {
    return { found: false, ats: 'ashby', board_token: token, reason: 'board_not_found', evidence: `HTTP 404 — Ashby: plain-text "${summarizeErrorBody(await res.text())}" (not JSON)`, data_as_of: nowIso() };
  }
  if (!res.ok) {
    throw new Error(`Ashby board "${token}" returned HTTP ${res.status}: ${summarizeErrorBody(await res.text())}`);
  }
  const data = (await res.json()) as { jobs?: unknown[] };
  const jobs: NormalizedJob[] = (data.jobs ?? []).map((raw) => {
    const j = raw as Record<string, unknown>;
    const comp = j.compensation as Record<string, unknown> | undefined;
    const compSummary = comp && typeof comp.compensationTierSummary === 'string' ? (comp.compensationTierSummary as string) : null;
    return {
      title: String(j.title ?? ''),
      location: (j.location as string) ?? null,
      dept: (j.department as string) ?? null,
      remote: typeof j.isRemote === 'boolean' ? (j.isRemote as boolean) : null,
      comp: compSummary,
      posted_at: (j.publishedAt as string) ?? null,
      url: (j.jobUrl as string) ?? (j.applyUrl as string) ?? null,
    };
  });
  // {"jobs":[],"apiVersion":"1"} on HTTP 200 is a REAL confirmed-empty board.
  return { found: true, ats: 'ashby', board_token: token, total: jobs.length, jobs, data_as_of: nowIso() };
}

async function fetchSmartRecruiters(token: string): Promise<AtsJobsResult> {
  const res = await pwFetch(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings`, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`SmartRecruiters company "${token}" returned HTTP ${res.status}: ${summarizeErrorBody(await res.text())}`);
  }
  const data = (await res.json()) as { totalFound?: number; content?: unknown[] };
  const total = data.totalFound ?? 0;
  const jobs: NormalizedJob[] = (data.content ?? []).map((raw) => {
    const j = raw as Record<string, unknown>;
    const location = j.location as Record<string, unknown> | undefined;
    return {
      title: String(j.name ?? ''),
      location: (location?.city as string) ?? (location?.country as string) ?? null,
      dept: null,
      remote: (location?.remote as boolean) ?? null,
      comp: null,
      posted_at: (j.releasedDate as string) ?? (j.createdOn as string) ?? null,
      url: (j.ref as string) ?? null,
    };
  });
  if (total === 0) {
    // CONFIRMED LIVE: SmartRecruiters returns this exact shape for BOTH an
    // unknown company id AND a real company with zero current postings —
    // there is no field here that tells them apart. Say so; never guess.
    return {
      found: true,
      ats: 'smartrecruiters',
      board_token: token,
      total: 0,
      jobs: [],
      ambiguous: true,
      note: 'SmartRecruiters returns this identical {"totalFound":0,"content":[]} shape whether "token" is a real company id with no current postings or simply does not exist — the API does not distinguish them. Verify the company id independently (e.g. via ats_detect scraping the careers page) before treating this as a confirmed empty board.',
      data_as_of: nowIso(),
    };
  }
  return { found: true, ats: 'smartrecruiters', board_token: token, total, jobs, data_as_of: nowIso() };
}

async function fetchRecruitee(token: string): Promise<AtsJobsResult> {
  const sub = assertHostLabel(token, 'board_token');
  const res = await pwFetch(`https://${sub}.recruitee.com/api/offers/`, { headers: { Accept: 'application/json' } });
  if (res.status === 404) {
    return { found: false, ats: 'recruitee', board_token: token, reason: 'board_not_found', evidence: 'HTTP 404 — Recruitee: {"error":"Not Found"}', data_as_of: nowIso() };
  }
  if (!res.ok) {
    throw new Error(`Recruitee board "${token}" returned HTTP ${res.status}: ${summarizeErrorBody(await res.text())}`);
  }
  const data = (await res.json()) as { offers?: unknown[] };
  const jobs: NormalizedJob[] = (data.offers ?? []).map((raw) => {
    const j = raw as Record<string, unknown>;
    return {
      title: String(j.title ?? ''),
      location: (j.city as string) ?? (j.country as string) ?? null,
      dept: (j.department as string) ?? null,
      remote: (j.remote as boolean) ?? null,
      comp: null,
      posted_at: (j.created_at as string) ?? null,
      url: (j.careers_url as string) ?? null,
    };
  });
  return { found: true, ats: 'recruitee', board_token: token, total: jobs.length, jobs, data_as_of: nowIso() };
}

async function fetchBambooHR(token: string): Promise<AtsJobsResult> {
  const sub = assertHostLabel(token, 'board_token');
  const res = await pwFetch(`https://${sub}.bamboohr.com/careers/list`, { headers: { Accept: 'application/json' } });
  const contentType = res.headers.get('content-type') ?? '';
  if (!res.ok) {
    throw new Error(`BambooHR board "${token}" returned HTTP ${res.status}: ${summarizeErrorBody(await res.text())}`);
  }
  if (!contentType.includes('json')) {
    // CONFIRMED LIVE: an unregistered/unknown subdomain still answers HTTP 200,
    // but with BambooHR's own marketing homepage (text/html), not a 404 and
    // not JSON. That IS the "no such board" signal for this ATS.
    return {
      found: false,
      ats: 'bamboohr',
      board_token: token,
      reason: 'board_not_found',
      evidence: `HTTP 200 but Content-Type "${contentType}" — BambooHR serves its own marketing homepage for a subdomain with no customer account (not JSON, no per-company data).`,
      data_as_of: nowIso(),
    };
  }
  const data = (await res.json()) as { meta?: { totalCount?: number }; result?: unknown[] };
  const jobs: NormalizedJob[] = (data.result ?? []).map((raw) => {
    const j = raw as Record<string, unknown>;
    const location = j.location as Record<string, unknown> | undefined;
    return {
      title: String(j.jobOpeningName ?? ''),
      location: [location?.city, location?.state].filter(Boolean).join(', ') || (j.locationLabel as string) || null,
      dept: (j.departmentLabel as string) ?? null,
      remote: null,
      comp: null,
      posted_at: null,
      url: (j.jobOpeningShareUrl as string) ?? (j.applyUrl as string) ?? null,
    };
  });
  // {"meta":{"totalCount":0},"result":[]} on a real subdomain is a REAL
  // confirmed-empty board.
  return { found: true, ats: 'bamboohr', board_token: token, total: data.meta?.totalCount ?? jobs.length, jobs, data_as_of: nowIso() };
}

const WORKDAY_MAX_LIMIT = 20;
const WORKDAY_OFFSET_CAP = 10000;

function parseWorkdayToken(token: string): { tenant: string; wdN: string; site: string } {
  const m = /^([a-z0-9-]+)\.wd(\d{1,2})\/(.+)$/i.exec(token.trim());
  if (!m) {
    throw new Error(`invalid_board_token: Workday board_token must be "<tenant>.wd<N>/<site>", e.g. "workday.wd5/Workday" (the host + site slug from the company's own careers URL).`);
  }
  return { tenant: m[1].toLowerCase(), wdN: m[2], site: m[3] };
}

async function fetchWorkday(
  token: string,
  filters: { title_query?: string; limit?: number; offset?: number } = {},
): Promise<AtsJobsResult> {
  const { tenant, wdN, site } = parseWorkdayToken(token);
  const requestedLimit = filters.limit;
  const limit = Math.min(requestedLimit ?? WORKDAY_MAX_LIMIT, WORKDAY_MAX_LIMIT);
  const requestedOffset = filters.offset ?? 0;
  const offsetCapped = requestedOffset > WORKDAY_OFFSET_CAP;
  const offset = offsetCapped ? WORKDAY_OFFSET_CAP : requestedOffset;
  const limitCapped = !!requestedLimit && requestedLimit > WORKDAY_MAX_LIMIT;

  const res = await pwFetch(`https://${tenant}.wd${wdN}.myworkdayjobs.com/wday/cxs/${tenant}/${encodeURIComponent(site)}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ appliedFacets: {}, limit, offset, searchText: filters.title_query ?? '' }),
  });
  if (res.status === 404) {
    return { found: false, ats: 'workday', board_token: token, reason: 'board_not_found', evidence: `HTTP 404 — Workday: ${summarizeErrorBody(await res.text())}`, data_as_of: nowIso() };
  }
  if (!res.ok) {
    throw new Error(`Workday "${token}" returned HTTP ${res.status}: ${summarizeErrorBody(await res.text())}`);
  }
  const data = (await res.json()) as { total?: number; jobPostings?: unknown[] };
  const jobs: NormalizedJob[] = (data.jobPostings ?? []).map((raw) => {
    const j = raw as Record<string, unknown>;
    const externalPath = j.externalPath as string | undefined;
    return {
      title: String(j.title ?? ''),
      location: (j.locationsText as string) ?? null,
      dept: null,
      remote: typeof j.remoteType === 'string' ? j.remoteType.toLowerCase() !== 'onsite' : null,
      comp: null,
      posted_at: (j.postedOn as string) ?? null,
      url: externalPath ? `https://${tenant}.wd${wdN}.myworkdayjobs.com${externalPath}` : null,
    };
  });
  const capped = offsetCapped || limitCapped;
  const capDetail = capped
    ? [
        limitCapped ? `requested limit ${requestedLimit} clamped to Workday's max of ${WORKDAY_MAX_LIMIT} (a higher limit gets HTTP 400 from Workday, not a partial page)` : null,
        offsetCapped ? `requested offset ${requestedOffset} clamped to Workday's pagination cap of ${WORKDAY_OFFSET_CAP} — past this cap Workday silently re-serves an earlier page rather than erroring or going empty` : null,
      ]
        .filter(Boolean)
        .join('; ')
    : undefined;
  return {
    found: true,
    ats: 'workday',
    board_token: token,
    total: data.total ?? jobs.length,
    jobs,
    data_as_of: nowIso(),
    ...(capped ? { capped: true, cap_detail: capDetail } : {}),
  };
}

async function fetchWorkable(token: string): Promise<AtsJobsResult> {
  const sub = assertHostLabel(token, 'board_token');
  const res = await pwFetch(`https://apply.workable.com/api/v1/widget/accounts/${sub}`, { headers: { Accept: 'application/json' } });
  if (res.status === 429) {
    const summary = summarizeErrorBody(await res.text());
    // CONFIRMED LIVE (this task, 5+ attempts, several real accounts, several
    // minutes apart): apply.workable.com answers Cloudflare's OWN bot-block
    // (error code 1015) to every request from this platform's edge. This is a
    // transport failure, not an empty board — throw loud, naming the upstream
    // status, exactly per the standing rule.
    throw new Error(
      `Workable upstream blocked this request: HTTP 429, "${summary}" (Cloudflare's own bot-mitigation on apply.workable.com, not a Workable application response). This is a known, reproducible limitation of fetching Workable's public widget from this platform's edge, not evidence the board "${token}" is empty or missing.`,
    );
  }
  if (res.status === 404) {
    return { found: false, ats: 'workable', board_token: token, reason: 'board_not_found', evidence: `HTTP 404 from Workable's widget endpoint.`, data_as_of: nowIso() };
  }
  if (!res.ok) {
    throw new Error(`Workable board "${token}" returned HTTP ${res.status}: ${summarizeErrorBody(await res.text())}`);
  }
  const data = (await res.json()) as { jobs?: unknown[] };
  const jobs: NormalizedJob[] = (data.jobs ?? []).map((raw) => {
    const j = raw as Record<string, unknown>;
    return {
      title: String(j.title ?? ''),
      location: (j.location as string) ?? null,
      dept: (j.department as string) ?? null,
      remote: null,
      comp: null,
      posted_at: (j.published_on as string) ?? null,
      url: (j.url as string) ?? null,
    };
  });
  return { found: true, ats: 'workable', board_token: token, total: jobs.length, jobs, data_as_of: nowIso() };
}

// -- Minimal entity decoder for regex-parsed HTML/XML (Workers have no DOMParser) --
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .trim();
}

async function fetchTeamtailor(token: string): Promise<AtsJobsResult> {
  const sub = assertHostLabel(token, 'board_token');
  const res = await pwFetch(`https://${sub}.teamtailor.com/jobs.json`, { headers: { Accept: 'application/json' } });
  if (res.status === 404) {
    return { found: false, ats: 'teamtailor', board_token: token, reason: 'board_not_found', evidence: 'HTTP 404, empty body — Teamtailor serves no jobs.json for an unknown subdomain.', data_as_of: nowIso() };
  }
  if (!res.ok) {
    throw new Error(`Teamtailor board "${token}" returned HTTP ${res.status}: ${summarizeErrorBody(await res.text())}`);
  }
  const data = (await res.json()) as { items?: unknown[] };
  const jobs: NormalizedJob[] = (data.items ?? []).map((raw) => {
    const j = raw as Record<string, unknown>;
    const jp = j._jobposting as Record<string, unknown> | undefined;
    const locs = jp?.jobLocation as Array<Record<string, unknown>> | undefined;
    const addr = locs?.[0]?.address as Record<string, unknown> | undefined;
    const locationParts = [addr?.addressLocality, addr?.addressRegion].filter((v) => typeof v === 'string' && v);
    return {
      title: String(j.title ?? ''),
      location: locationParts.length ? locationParts.join(', ') : null,
      dept: null,
      remote: null,
      comp: null,
      posted_at: (j.date_published as string) ?? null,
      url: (j.url as string) ?? null,
    };
  });
  return { found: true, ats: 'teamtailor', board_token: token, total: jobs.length, jobs, data_as_of: nowIso() };
}

function parsePersonioXml(xml: string, token: string, tld: 'com' | 'de'): NormalizedJob[] {
  const positions = xml.match(/<position>[\s\S]*?<\/position>/g) ?? [];
  return positions.map((block) => {
    const field = (name: string): string | null => {
      const m = new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`).exec(block);
      return m ? decodeEntities(m[1]) : null;
    };
    const id = field('id');
    const office = field('office');
    const additional = Array.from(block.matchAll(/<additionalOffices>([\s\S]*?)<\/additionalOffices>/g)).flatMap((m) =>
      Array.from(m[1].matchAll(/<office>([\s\S]*?)<\/office>/g)).map((o) => decodeEntities(o[1])),
    );
    const location = [office, ...additional].filter(Boolean).join(', ') || null;
    return {
      title: field('name') ?? '',
      location,
      dept: field('department'),
      remote: location ? /remote/i.test(location) : null,
      comp: null,
      posted_at: field('createdAt'),
      url: id ? `https://${token}.jobs.personio.${tld}/job/${id}?language=en` : null,
    };
  });
}

async function fetchPersonio(token: string): Promise<AtsJobsResult> {
  const sub = assertHostLabel(token, 'board_token');
  for (const tld of ['com', 'de'] as const) {
    const res = await pwFetch(`https://${sub}.jobs.personio.${tld}/xml?language=en`, { headers: { Accept: 'text/xml' } });
    if (res.status === 404) continue; // try the other TLD — a company lives on exactly one
    if (!res.ok) {
      throw new Error(`Personio board "${token}" (.${tld}) returned HTTP ${res.status}: ${summarizeErrorBody(await res.text())}`);
    }
    const xml = await res.text();
    const jobs = parsePersonioXml(xml, sub, tld);
    return { found: true, ats: 'personio', board_token: token, total: jobs.length, jobs, data_as_of: nowIso() };
  }
  return { found: false, ats: 'personio', board_token: token, reason: 'board_not_found', evidence: 'HTTP 404 on both jobs.personio.com and jobs.personio.de — Personio hosts a company on exactly one TLD with no redirect between them, and neither had this subdomain.', data_as_of: nowIso() };
}

async function fetchJobvite(token: string): Promise<AtsJobsResult> {
  const slug = assertHostLabel(token, 'board_token');
  const res = await pwFetch(`https://jobs.jobvite.com/${slug}`, { headers: { Accept: 'text/html' } });
  if (res.redirected) {
    // CONFIRMED LIVE: an unknown slug 4-hop redirects to
    // www.jobvite.com/support/job-seeker-support/?invalid=1 — a different
    // host — rather than answering 404 on jobs.jobvite.com itself.
    return { found: false, ats: 'jobvite', board_token: token, reason: 'board_not_found', evidence: `Request redirected to ${res.url} instead of serving the board — Jobvite's "invalid slug" signal.`, data_as_of: nowIso() };
  }
  if (!res.ok) {
    throw new Error(`Jobvite board "${token}" returned HTTP ${res.status}: ${summarizeErrorBody(await res.text())}`);
  }
  const html = await res.text();
  const rows = Array.from(
    html.matchAll(/<tr>\s*<td class="jv-job-list-name">\s*<a href="([^"]+)"[^>]*>([^<]*)<\/a>\s*<\/td>\s*<td class="jv-job-list-location">([\s\S]*?)<\/td>\s*<\/tr>/g),
  );
  const jobs: NormalizedJob[] = rows.map((m) => ({
    title: decodeEntities(m[2]),
    location: decodeEntities(m[3].replace(/\s+/g, ' ')) || null,
    dept: null,
    remote: null,
    comp: null,
    posted_at: null,
    url: m[1].startsWith('http') ? m[1] : `https://jobs.jobvite.com${m[1]}`,
  }));
  return { found: true, ats: 'jobvite', board_token: token, total: jobs.length, jobs, data_as_of: nowIso() };
}

async function fetchBreezy(token: string): Promise<AtsJobsResult> {
  const sub = assertHostLabel(token, 'board_token');
  const res = await pwFetch(`https://${sub}.breezy.hr/json`, { headers: { Accept: 'application/json' } });
  if (res.status === 404) {
    return { found: false, ats: 'breezy', board_token: token, reason: 'board_not_found', evidence: 'HTTP 404, Content-Type text/html — Breezy: "Career portal not found".', data_as_of: nowIso() };
  }
  if (!res.ok) {
    throw new Error(`Breezy board "${token}" returned HTTP ${res.status}: ${summarizeErrorBody(await res.text())}`);
  }
  const data = (await res.json()) as unknown[];
  const jobs: NormalizedJob[] = (Array.isArray(data) ? data : []).map((raw) => {
    const j = raw as Record<string, unknown>;
    const location = j.location as Record<string, unknown> | undefined;
    const salary = typeof j.salary === 'string' ? j.salary.trim() : '';
    return {
      title: String(j.name ?? ''),
      location: (location?.name as string) ?? null,
      dept: (j.department as string) ?? null,
      remote: typeof location?.is_remote === 'boolean' ? (location.is_remote as boolean) : null,
      comp: salary || null,
      posted_at: (j.published_date as string) ?? null,
      url: (j.url as string) ?? null,
    };
  });
  return { found: true, ats: 'breezy', board_token: token, total: jobs.length, jobs, data_as_of: nowIso() };
}

async function fetchPinpoint(token: string): Promise<AtsJobsResult> {
  const sub = assertHostLabel(token, 'board_token');
  const res = await pwFetch(`https://${sub}.pinpointhq.com/postings.json`, { headers: { Accept: 'application/json' } });
  if (res.status === 404) {
    return { found: false, ats: 'pinpoint', board_token: token, reason: 'board_not_found', evidence: 'HTTP 404, Content-Type text/html — Pinpoint\'s own 404 page, not a JSON response.', data_as_of: nowIso() };
  }
  if (!res.ok) {
    throw new Error(`Pinpoint board "${token}" returned HTTP ${res.status}: ${summarizeErrorBody(await res.text())}`);
  }
  const data = (await res.json()) as { data?: unknown[] };
  const jobs: NormalizedJob[] = (data.data ?? []).map((raw) => {
    const j = raw as Record<string, unknown>;
    const location = j.location as Record<string, unknown> | undefined;
    const job = j.job as Record<string, unknown> | undefined;
    const dept = job?.department as Record<string, unknown> | undefined;
    const workplaceType = typeof j.workplace_type === 'string' ? j.workplace_type.toLowerCase() : undefined;
    const min = j.compensation_minimum as number | undefined;
    const max = j.compensation_maximum as number | undefined;
    const currency = j.compensation_currency as string | undefined;
    const comp = j.compensation_visible && (min || max) ? `${currency ?? ''} ${min ?? ''}${max ? `-${max}` : ''}`.trim() : null;
    return {
      title: String(j.title ?? ''),
      location: (location?.city as string) ?? (location?.name as string) ?? null,
      dept: (dept?.name as string) ?? null,
      remote: workplaceType ? workplaceType === 'remote' : null,
      comp,
      posted_at: null, // not confirmed live — Pinpoint's postings.json carries no date field in any probed response
      url: (j.url as string) ?? null,
    };
  });
  // Not independently confirmed live for a real board with ZERO current
  // postings (every probed board had jobs); documented by analogy with every
  // sibling ATS's 200-success-envelope convention, same as Recruitee above.
  return { found: true, ats: 'pinpoint', board_token: token, total: jobs.length, jobs, data_as_of: nowIso() };
}

interface RippleQuery {
  queryKey?: unknown[];
  state?: { data?: { items?: unknown[] } };
}

function parseRipplingNextData(html: string): unknown[] | null {
  const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!m) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const queries = (parsed as { props?: { pageProps?: { dehydratedState?: { queries?: RippleQuery[] } } } })?.props?.pageProps?.dehydratedState?.queries ?? [];
  const jobPosts = queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'board' && q.queryKey[2] === 'job-posts');
  return jobPosts?.state?.data?.items ?? null;
}

async function fetchRippling(token: string): Promise<AtsJobsResult> {
  const slug = assertHostLabel(token, 'board_token');
  const res = await pwFetch(`https://ats.rippling.com/${slug}/jobs`, { headers: { Accept: 'text/html' } });
  if (res.status === 404) {
    return { found: false, ats: 'rippling', board_token: token, reason: 'board_not_found', evidence: 'HTTP 404 — Rippling\'s own Next.js 404 page, no __NEXT_DATA__ job-posts query present.', data_as_of: nowIso() };
  }
  if (!res.ok) {
    throw new Error(`Rippling board "${token}" returned HTTP ${res.status}: ${summarizeErrorBody(await res.text())}`);
  }
  const html = await res.text();
  const items = parseRipplingNextData(html);
  if (items === null) {
    throw new Error(`Rippling board "${token}" returned HTTP 200 but no parseable __NEXT_DATA__ job-posts query was found — the page shape may have changed.`);
  }
  const jobs: NormalizedJob[] = items.map((raw) => {
    const j = raw as Record<string, unknown>;
    const dept = j.department as Record<string, unknown> | undefined;
    const locs = j.locations as Array<Record<string, unknown>> | undefined;
    const loc0 = locs?.[0];
    return {
      title: String(j.name ?? ''),
      location: (loc0?.name as string) ?? null,
      dept: (dept?.name as string) ?? null,
      remote: typeof loc0?.workplaceType === 'string' ? (loc0.workplaceType as string).toUpperCase() === 'REMOTE' : null,
      comp: null,
      posted_at: null,
      url: (j.url as string) ?? null,
    };
  });
  return { found: true, ats: 'rippling', board_token: token, total: jobs.length, jobs, data_as_of: nowIso() };
}

function parseIcimsCards(html: string): NormalizedJob[] {
  const cards = html.split('<li class="iCIMS_JobCardItem">').slice(1);
  return cards.map((card) => {
    const titleMatch = /<h3[^>]*>\s*([^<]+?)\s*<\/h3>/.exec(card);
    const urlMatch = /<a href="([^"]+)" class="iCIMS_Anchor"/.exec(card);
    const locMatch = /Job Locations<\/span>\s*<span[^>]*>\s*([^<]*?)\s*<\/span>/.exec(card);
    const deptMatch = /<dt class="iCIMS_JobHeaderField">Category<\/dt>\s*<dd class="iCIMS_JobHeaderData"><span[^>]*>\s*([^<]*?)\s*<\/span>/.exec(card);
    const rawUrl = urlMatch ? urlMatch[1] : null;
    return {
      title: titleMatch ? decodeEntities(titleMatch[1]) : '',
      location: locMatch && locMatch[1] ? decodeEntities(locMatch[1]) : null,
      dept: deptMatch && deptMatch[1] ? decodeEntities(deptMatch[1]) : null,
      remote: null,
      comp: null,
      posted_at: null,
      url: rawUrl ? rawUrl.replace(/\?in_iframe=1$/, '') : null,
    };
  });
}

async function fetchIcims(token: string): Promise<AtsJobsResult> {
  const sub = assertHostLabel(token, 'board_token');
  const res = await pwFetch(`https://${sub}.icims.com/jobs/search?ss=1&in_iframe=1`, { headers: { Accept: 'text/html' } });
  if (res.status === 404) {
    return { found: false, ats: 'icims', board_token: token, reason: 'board_not_found', evidence: `HTTP 404 — iCIMS: "gone: ${sub}.icims.com : dc409".`, data_as_of: nowIso() };
  }
  if (!res.ok) {
    throw new Error(`iCIMS board "${token}" returned HTTP ${res.status}: ${summarizeErrorBody(await res.text())}`);
  }
  const html = await res.text();
  const jobs = parseIcimsCards(html);
  // Not independently confirmed live for a real portal with ZERO current
  // postings — every probed portal had jobs. Documented by analogy, same
  // disclaimer as Pinpoint/Recruitee above.
  return { found: true, ats: 'icims', board_token: token, total: jobs.length, jobs, data_as_of: nowIso() };
}

async function fetchRaw(ats: Ats, token: string, filters: Record<string, unknown> = {}): Promise<AtsJobsResult> {
  switch (ats) {
    case 'greenhouse':
      return fetchGreenhouse(token);
    case 'lever':
      return fetchLever(token, filters.region === 'eu' ? 'eu' : 'us');
    case 'ashby':
      return fetchAshby(token);
    case 'smartrecruiters':
      return fetchSmartRecruiters(token);
    case 'recruitee':
      return fetchRecruitee(token);
    case 'bamboohr':
      return fetchBambooHR(token);
    case 'workday':
      return fetchWorkday(token, filters as { title_query?: string; limit?: number; offset?: number });
    case 'workable':
      return fetchWorkable(token);
    case 'teamtailor':
      return fetchTeamtailor(token);
    case 'personio':
      return fetchPersonio(token);
    case 'jobvite':
      return fetchJobvite(token);
    case 'breezy':
      return fetchBreezy(token);
    case 'pinpoint':
      return fetchPinpoint(token);
    case 'rippling':
      return fetchRippling(token);
    case 'icims':
      return fetchIcims(token);
  }
}

// Whole-board cache-aside. Keyed per (ats, token) for every ATS except
// workday, whose upstream query (limit/offset/searchText) changes the
// response, so workday's cache key folds those in too.
async function fetchCached(ats: Ats, token: string, filters: Record<string, unknown>, kv: KvLike | undefined): Promise<AtsJobsResult> {
  const extra = ats === 'workday' ? `${filters.limit ?? ''}:${filters.offset ?? ''}:${filters.title_query ?? ''}` : ats === 'lever' ? String(filters.region ?? 'us') : undefined;
  const key = jobsCacheKey(ats, token, extra);
  const cached = await kvGetJson<AtsJobsFound & { cached_at: string }>(kv, key);
  if (cached && cached.found) {
    const ageSec = Math.max(0, Math.round((Date.now() - new Date(cached.cached_at).getTime()) / 1000));
    if (ageSec < JOBS_CACHE_TTL_SEC) {
      const { cached_at, ...rest } = cached;
      return { ...rest, served_from: 'fresh-cache', cache_age_sec: ageSec };
    }
  }
  const fresh = await fetchRaw(ats, token, filters);
  if (fresh.found && kv) {
    await kvPutJson(kv, key, { ...fresh, served_from: 'upstream', cached_at: nowIso() }, JOBS_CACHE_TTL_SEC);
  }
  return fresh.found ? { ...fresh, served_from: 'upstream' } : fresh;
}

// -- Normalized job -> stable key, for ats_new_postings diffing -------------
// Exported: evaluateJobPost (workers/scraper/src/subscriptions.ts) keeps its
// own per-subscription seen-keys cursor rather than touching this pack's
// per-board ats_new_postings KV snapshot (which is shared across every
// caller of ats_new_postings and would collide across subscriptions to the
// same board) — it needs the IDENTICAL key function so a job that already
// fired is recognized as the same job on the next poll.

export function jobKey(j: NormalizedJob): string {
  return j.url || `${j.title}::${j.location ?? ''}::${j.posted_at ?? ''}`;
}

// -- ats_detect: careers-page scrape, then slug probing ----------------------

type DetectCandidate = { ats: Ats; board_token: string; evidence: string };

function scanHtmlForAts(html: string): DetectCandidate[] {
  const out: DetectCandidate[] = [];
  const patterns: Array<{ ats: Ats; re: RegExp }> = [
    { ats: 'greenhouse', re: /boards\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9][a-z0-9_-]{0,63})/i },
    { ats: 'lever', re: /jobs(?:\.eu)?\.lever\.co\/([a-z0-9][a-z0-9_-]{0,63})/i },
    { ats: 'ashby', re: /jobs\.ashbyhq\.com\/([a-z0-9][a-z0-9_-]{0,63})/i },
    { ats: 'smartrecruiters', re: /(?:jobs|careers)\.smartrecruiters\.com\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})/i },
    { ats: 'recruitee', re: /([a-z0-9][a-z0-9-]{0,61})\.recruitee\.com/i },
    { ats: 'bamboohr', re: /([a-z0-9][a-z0-9-]{0,61})\.bamboohr\.com/i },
    { ats: 'workable', re: /apply\.workable\.com\/(?:api\/v\d\/widget\/accounts\/|j\/)?([a-z0-9][a-z0-9_-]{0,63})/i },
    { ats: 'workday', re: /([a-z0-9-]+)\.(wd\d{1,2})\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_.-]+)/i },
    { ats: 'teamtailor', re: /([a-z0-9][a-z0-9-]{0,61})\.teamtailor\.com/i },
    { ats: 'personio', re: /([a-z0-9][a-z0-9-]{0,61})\.jobs\.personio\.(?:com|de)/i },
    { ats: 'jobvite', re: /jobs\.jobvite\.com\/([a-z0-9][a-z0-9_-]{0,63})/i },
    { ats: 'breezy', re: /([a-z0-9][a-z0-9-]{0,61})\.breezy\.hr/i },
    { ats: 'pinpoint', re: /([a-z0-9][a-z0-9-]{0,61})\.pinpointhq\.com/i },
    { ats: 'rippling', re: /ats\.rippling\.com\/([a-z0-9][a-z0-9_-]{0,63})/i },
    { ats: 'icims', re: /([a-z0-9][a-z0-9-]{0,61})\.icims\.com/i },
  ];
  for (const { ats, re } of patterns) {
    const m = re.exec(html);
    if (!m) continue;
    if (ats === 'workday') {
      out.push({ ats, board_token: `${m[1]}.${m[2]}/${m[3]}`, evidence: `found a myworkdayjobs.com link on the page: ${m[0]}` });
    } else {
      out.push({ ats, board_token: m[1], evidence: `found a ${ats} careers link on the page: ${m[0]}` });
    }
  }
  return out;
}

async function verifyCandidate(c: DetectCandidate): Promise<boolean> {
  try {
    const r = await fetchRaw(c.ats, c.board_token);
    if (!r.found) return false;
    // SmartRecruiters' zero-found is ambiguous on its own — a scrape hit
    // confirming the token is independent evidence, so accept it even then;
    // but for slug PROBING (no scrape evidence) we refuse ambiguous hits
    // (see probeSlug below) because an ambiguous 0 there could just as well
    // be a wrong guess.
    return true;
  } catch {
    // Workable throws loud on the Cloudflare block; a thrown verification
    // still means "we found a workable link", so treat it as verified —
    // the detection evidence came from the scrape, not from this check.
    return c.ats === 'workable';
  }
}

async function probeSlug(ats: Ats, token: string): Promise<boolean> {
  try {
    const r = await fetchRaw(ats, token);
    if (!r.found) return false;
    if (r.ambiguous) return false; // never accept an ambiguous SmartRecruiters zero as a blind-probe hit
    return true;
  } catch {
    return false;
  }
}

async function atsDetect(args: Record<string, unknown>, kv: KvLike | undefined): Promise<Record<string, unknown>> {
  const rawDomain = typeof args.domain === 'string' && args.domain.trim() ? args.domain.trim() : undefined;
  const rawCareersUrl = typeof args.careers_url === 'string' && args.careers_url.trim() ? args.careers_url.trim() : undefined;
  if (!rawDomain && !rawCareersUrl) throw new Error('missing_input: pass "domain" (e.g. "acme.com") or "careers_url".');

  const domain = rawDomain ? assertPublicHostname(rawDomain, 'domain').replace(/^www\./, '') : undefined;
  const careersUrl = rawCareersUrl ? assertPublicHttpUrl(rawCareersUrl).toString() : undefined;
  const cacheDomain = domain ?? new URL(careersUrl as string).hostname.replace(/^www\./, '');

  const cached = await kvGetJson<Record<string, unknown>>(kv, discoveryKey(cacheDomain));
  if (cached) return { ...cached, source: 'cache' };

  const pagesToTry = careersUrl ? [careersUrl] : domain ? [`https://${domain}/careers`, `https://${domain}/`] : [];
  let html = '';
  for (const url of pagesToTry) {
    try {
      const res = await safeFetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(10000) }, { resolvePublic: true });
      if (res.ok) {
        html = await res.text();
        if (html) break;
      }
    } catch {
      // unreachable page — fall through to the next candidate / slug probing
    }
  }

  const candidates = html ? scanHtmlForAts(html) : [];
  for (const c of candidates) {
    if (await verifyCandidate(c)) {
      const result = { found: true, ats: c.ats, board_token: c.board_token, evidence: c.evidence, confidence: 'scraped_and_verified', discovered_at: nowIso() };
      await kvPutJson(kv, discoveryKey(cacheDomain), result, DISCOVERY_TTL_SEC);
      return { ...result, source: 'scrape' };
    }
  }

  if (domain) {
    const slug = domain.split('.')[0];
    const probeOrder: Ats[] = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'recruitee', 'bamboohr', 'teamtailor', 'personio', 'breezy', 'pinpoint'];
    for (const ats of probeOrder) {
      if (await probeSlug(ats, slug)) {
        const result = {
          found: true,
          ats,
          board_token: slug,
          evidence: `no ATS link found on the careers/home page; slug-probed "${slug}" against ${ats}'s public board API and got a real response`,
          confidence: 'probed',
          discovered_at: nowIso(),
        };
        await kvPutJson(kv, discoveryKey(cacheDomain), result, DISCOVERY_TTL_SEC);
        return { ...result, source: 'probe', checked: probeOrder };
      }
    }
    return {
      found: false,
      reason: 'no_ats_detected',
      checked_scrape: candidates.map((c) => `${c.ats}:${c.board_token}`),
      checked_probe: probeOrder.map((a) => `${a}:${slug}`),
      note: 'Scraped the careers page and the homepage for ATS links, then slug-probed Greenhouse/Lever/Ashby/SmartRecruiters/Recruitee/BambooHR/Teamtailor/Personio/Breezy/Pinpoint using the domain label as the board token. None matched. Workday needs a tenant + wd-number + site slug that cannot be guessed from a domain alone, so it is not blind-probed. Jobvite, Rippling and iCIMS use slugs/subdomain prefixes that often do not match the bare domain label either, so they are not blind-probed — pass board_token directly if you already know it. Workable is not blind-probed either — its public widget is currently blocked by Cloudflare from this platform\'s edge (see ats_jobs with ats:"workable" for the measured 429).',
      data_as_of: nowIso(),
    };
  }

  return { found: false, reason: 'no_ats_detected', note: 'careers_url was given without a domain, so there was no slug to probe once the page scrape found nothing.', data_as_of: nowIso() };
}

// -- Tool definitions ---------------------------------------------------------

const tools: McpToolExport['tools'] = [
  {
    name: 'ats_detect',
    description:
      'Detect which applicant-tracking system (ATS) a company publishes its public job board on, and its board token. Reads the company\'s careers page (or a given careers_url) for a Greenhouse/Lever/Ashby/SmartRecruiters/Recruitee/BambooHR/Workday/Workable/Teamtailor/Personio/Jobvite/Breezy/Pinpoint/Rippling/iCIMS link; falls back to slug-probing the domain name against each board API that supports it. Does not read any private/Harvest-key ATS data — only what a public job board already exposes. Discoveries persist so repeat lookups for the same domain are instant.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        domain: { type: 'string', description: 'Company domain, e.g. "airbnb.com" (no scheme, no path).' },
        careers_url: { type: 'string', description: 'A specific careers-page URL to scan instead of guessing one from domain, e.g. "https://www.airbnb.com/careers".' },
      },
    },
  },
  {
    name: 'ats_jobs',
    description:
      'Fetch normalized job postings from a PUBLIC ATS board you already have the ats + board_token for (use ats_detect or ats_company_jobs if you only have a domain). Returns {found:false, reason:"board_not_found"} for an unknown board — never an empty jobs[] for that case. Lever/Ashby/BambooHR/Recruitee/Teamtailor/Breezy DO distinguish a real zero-job board (found:true, jobs:[]) from an unknown one; SmartRecruiters cannot (ambiguous:true); Pinpoint and iCIMS have not had a confirmed-empty real board observed live, so a 0-job result from those two is NOT independently confirmed to mean "real board, no jobs" versus a mis-detected token. Workday board_token is "<tenant>.wd<N>/<site>" (e.g. "workday.wd5/Workday"); its response states capped:true if your limit/offset hit Workday\'s own pagination limits (limit<=20, offset<=10000). Workable is currently blocked by Cloudflare from this platform\'s edge and will throw a loud error naming the 429, not an empty result. Dover is NOT supported: its public board is a Cloudflare-Turnstile-gated SPA with no keyless jobs endpoint.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ats: { type: 'string', enum: [...VALID_ATS], description: 'Which ATS to query.' },
        board_token: {
          type: 'string',
          description:
            'The board identifier: Greenhouse/Lever/Ashby/SmartRecruiters/Teamtailor/Personio/Breezy/Pinpoint company slug or subdomain label; Recruitee/BambooHR subdomain label; Jobvite slug (path segment after jobs.jobvite.com/); Rippling slug (path segment after ats.rippling.com/); iCIMS full subdomain label before .icims.com (e.g. "careers-acme" — prefixes vary by customer); Workable account slug; Workday "<tenant>.wd<N>/<site>".',
        },
        filters: {
          type: 'object',
          description: 'Optional post-fetch filters and Workday pagination controls.',
          properties: {
            title_query: { type: 'string', description: 'Case-insensitive substring match on job title. For Workday this is also sent upstream as the search text.' },
            location_query: { type: 'string', description: 'Case-insensitive substring match on location.' },
            remote_only: { type: 'boolean', description: 'Keep only jobs flagged remote (where the ATS reports it).' },
            region: { type: 'string', enum: ['us', 'eu'], description: 'Lever only: "eu" queries api.eu.lever.co instead of api.lever.co.' },
            limit: { type: 'number', description: 'Workday only: page size, clamped to 20 (Workday itself rejects anything higher with HTTP 400).' },
            offset: { type: 'number', description: 'Workday only: pagination offset, clamped to 10000 (Workday\'s own cap).' },
          },
        },
      },
      required: ['ats', 'board_token'],
    },
  },
  {
    name: 'ats_company_jobs',
    description: 'Detect a company\'s public ATS board from its domain, then fetch its postings in one call — ats_detect + ats_jobs combined. Returns the same {found:false, reason:"no_ats_detected"} shape as ats_detect when no board can be found.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        domain: { type: 'string', description: 'Company domain, e.g. "airbnb.com".' },
        filters: {
          type: 'object',
          description: 'Same optional filters as ats_jobs.',
          properties: {
            title_query: { type: 'string' },
            location_query: { type: 'string' },
            remote_only: { type: 'boolean' },
          },
        },
      },
      required: ['domain'],
    },
  },
  {
    name: 'ats_new_postings',
    description:
      'Diff a board\'s current postings against the last time this tool was called for the same ats+board_token (snapshot kept in KV, dated). The FIRST call for a board has no prior snapshot, so it returns every current job as new (snapshot_bootstrap:true) rather than a misleading empty diff. Pass "since" (ISO date) to also require posted_at >= since where the ATS reports a date.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ats: { type: 'string', enum: [...VALID_ATS], description: 'Which ATS the board is on.' },
        board_token: { type: 'string', description: 'Same board_token shape as ats_jobs.' },
        since: { type: 'string', description: 'Optional ISO-8601 date/time; only postings with posted_at on or after this (where the ATS reports a date) count as new.' },
      },
      required: ['ats', 'board_token'],
    },
  },
];

// -- callTool -----------------------------------------------------------------

function applyFilters(jobs: NormalizedJob[], filters: Record<string, unknown> = {}): NormalizedJob[] {
  let out = jobs;
  if (typeof filters.title_query === 'string' && filters.title_query.trim()) {
    const q = filters.title_query.trim().toLowerCase();
    out = out.filter((j) => j.title.toLowerCase().includes(q));
  }
  if (typeof filters.location_query === 'string' && filters.location_query.trim()) {
    const q = filters.location_query.trim().toLowerCase();
    out = out.filter((j) => (j.location ?? '').toLowerCase().includes(q));
  }
  if (filters.remote_only === true) {
    out = out.filter((j) => j.remote === true);
  }
  return out;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const kv = kvFromArgs(args);

  switch (name) {
    case 'ats_detect': {
      return atsDetect(args, kv);
    }

    case 'ats_jobs': {
      const ats = requireAts(args.ats);
      const tokenRaw = args.board_token;
      if (typeof tokenRaw !== 'string' || !tokenRaw.trim()) throw new Error('Required argument "board_token" is missing or empty.');
      const token = tokenRaw.trim();
      const filters = (args.filters as Record<string, unknown>) ?? {};
      const result = await fetchCached(ats, token, filters, kv);
      if (!result.found) return result;
      const filtered = applyFilters(result.jobs, filters);
      return { ...result, jobs: filtered, total: result.ambiguous ? result.total : filtered.length, total_unfiltered: result.jobs.length };
    }

    case 'ats_company_jobs': {
      const domainRaw = args.domain;
      if (typeof domainRaw !== 'string' || !domainRaw.trim()) throw new Error('Required argument "domain" is missing or empty.');
      const detected = await atsDetect({ domain: domainRaw }, kv);
      if (!detected.found) return detected;
      const ats = detected.ats as Ats;
      const token = detected.board_token as string;
      const filters = (args.filters as Record<string, unknown>) ?? {};
      const result = await fetchCached(ats, token, filters, kv);
      if (!result.found) return { ...result, detected_from: domainRaw };
      const filtered = applyFilters(result.jobs, filters);
      return { ...result, jobs: filtered, total: result.ambiguous ? result.total : filtered.length, total_unfiltered: result.jobs.length, detection: { source: detected.source, confidence: detected.confidence, evidence: detected.evidence } };
    }

    case 'ats_new_postings': {
      const ats = requireAts(args.ats);
      const tokenRaw = args.board_token;
      if (typeof tokenRaw !== 'string' || !tokenRaw.trim()) throw new Error('Required argument "board_token" is missing or empty.');
      const token = tokenRaw.trim();
      const since = typeof args.since === 'string' && args.since.trim() ? args.since.trim() : undefined;

      const current = await fetchCached(ats, token, {}, kv);
      if (!current.found) return current;

      const snapKey = snapshotKey(ats, token);
      const prior = await kvGetJson<{ job_keys: string[]; captured_at: string }>(kv, snapKey);
      const priorKeys = new Set(prior?.job_keys ?? []);
      const bootstrap = !prior;

      const newJobs = current.jobs.filter((j) => {
        const key = jobKey(j);
        const isNew = bootstrap || !priorKeys.has(key);
        const passesSince = !since || !j.posted_at || j.posted_at >= since;
        return isNew && passesSince;
      });

      await kvPutJson(kv, snapKey, { job_keys: current.jobs.map(jobKey), captured_at: nowIso() });

      return {
        found: true,
        ats,
        board_token: token,
        since: since ?? null,
        new_postings: newJobs,
        new_count: newJobs.length,
        total_current: current.total,
        snapshot_bootstrap: bootstrap,
        data_as_of: nowIso(),
        ...(current.ambiguous ? { ambiguous: true, note: current.note } : {}),
        ...(current.capped ? { capped: true, cap_detail: current.cap_detail } : {}),
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
