# @pipeworx/ats-boards

Public job-board postings across fifteen applicant-tracking systems
(Greenhouse, Lever, Ashby, SmartRecruiters, Recruitee, BambooHR, Workday,
Workable, Teamtailor, Personio, Jobvite, Breezy, Pinpoint, Rippling, iCIMS) —
detect which ATS a company publishes its careers page on, then read any
company's open roles without a key. This is NOT the `greenhouse`/`ashby`
packs, which read the caller's OWN private hiring data with their own API
key; this pack reads the same public board any browser can see, for any
company.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1863+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

Dover was evaluated and dropped: its public board is a client-rendered SPA
behind a Cloudflare Turnstile challenge, and the underlying jobs API
(`app.dover.com/api/v1/jobs`) answers HTTP 401 "Authentication credentials
were not provided" for every query-param combination tried — there is no
discoverable keyless endpoint.

## Tools

- `ats_detect(domain | careers_url)` — find which ATS a company uses and its
  board token, by scraping the careers page for an ATS link and, failing that,
  slug-probing the domain name against each board API. Persists the discovery
  so a repeat lookup for the same domain is instant.
- `ats_jobs(ats, board_token, filters?)` — normalized job postings for a board
  you already have `ats` + `board_token` for. Distinguishes an unknown board
  (`found:false, reason:"board_not_found"`) from a real board with zero
  current postings (`found:true, jobs:[]`) for every ATS except
  SmartRecruiters, which cannot tell them apart (see below) — that case is
  marked `ambiguous:true` instead of guessing.
- `ats_company_jobs(domain, filters?)` — `ats_detect` + `ats_jobs` in one call.
- `ats_new_postings(ats, board_token, since?)` — diffs current postings
  against the last snapshot taken for that board. The first call for a board
  has no prior snapshot, so it returns every current posting as new
  (`snapshot_bootstrap:true`) instead of a misleadingly empty diff.

## Auth

Keyless. Every endpoint below is the same public board data a browser sees on
a company's own careers page — no account, token or registration on any of
the fifteen supported ATS vendors.

The one exception is Workable: its public widget is currently blocked by
Cloudflare from this platform's edge (see "Data sources" below) — not an auth
wall, a transport failure. `ats_jobs`/`ats_company_jobs` throw a loud error
naming the HTTP 429 and Cloudflare's block when asked for `ats:"workable"`,
rather than returning an empty result.

## Data sources

- `https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true` — Greenhouse's public board API.
- `https://api.lever.co/v0/postings/{board_token}?mode=json` (`https://api.eu.lever.co/...` for `filters.region:"eu"`) — Lever's public postings API.
- `https://api.ashbyhq.com/posting-api/job-board/{board_token}?includeCompensation=true` — Ashby's public job-board API (officially documented, includes comp bands where the employer publishes them).
- `https://api.smartrecruiters.com/v1/companies/{board_token}/postings` — SmartRecruiters' public postings API.
- `https://{board_token}.recruitee.com/api/offers/` — Recruitee's public offers API.
- `https://{board_token}.bamboohr.com/careers/list` — BambooHR's public careers-widget endpoint.
- `https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` (POST) — Workday's public CXS jobs search. `board_token` encodes all three path parts as `"{tenant}.wd{N}/{site}"`, e.g. `"workday.wd5/Workday"` (read the tenant/wd-number/site straight off the company's own `myworkdayjobs.com` careers URL).
- `https://apply.workable.com/api/v1/widget/accounts/{board_token}` — Workable's public widget API. **Currently unreachable from this platform's edge**, confirmed live via a throwaway `wrangler dev --remote` Worker on Pipeworx's production Cloudflare account: every one of 5+ attempts (two endpoint shapes — the v1 widget and the v3 `/api/v3/accounts/{account}/jobs`, with and without an `Accept` header, against several real account names, several minutes apart) returned HTTP 429 with `Content-Type: text/plain` and body `error code: 1015` — Cloudflare's OWN bot-mitigation, not a Workable application response. That reads as apply.workable.com's Cloudflare WAF specifically rate-limiting Cloudflare-Worker-to-Cloudflare traffic. The adapter is implemented per Workable's documented widget shape and is ready the moment this changes; until then every live call throws loud, naming the 429, rather than returning an empty board.
- `https://{board_token}.teamtailor.com/jobs.json` — Teamtailor's keyless JSON Feed (jsonfeed.org v1.1).
- `https://{board_token}.jobs.personio.com/xml?language=en`, falling back to `.jobs.personio.de` on a 404 — Personio's public XML feed. A company lives on exactly one of the two TLDs with no redirect between them.
- `https://jobs.jobvite.com/{board_token}` — Jobvite's server-rendered HTML board (no JSON API; the vendor's own feed is per-customer and off by default). Parsed by regex from the `jv-job-list-*` table markup.
- `https://{board_token}.breezy.hr/json` — Breezy's keyless JSON array.
- `https://{board_token}.pinpointhq.com/postings.json` — Pinpoint's keyless, officially documented postings JSON.
- `https://ats.rippling.com/{board_token}/jobs` — Rippling has no separate JSON API (every guessed `/api/...` path 404s); the job list is parsed out of the page's `<script id="__NEXT_DATA__">` hydration data.
- `https://{board_token}.icims.com/jobs/search?ss=1&in_iframe=1` — iCIMS's documented Talent-Cloud API is partner-gated, but the public career-search page itself is plain server-rendered HTML with no login; parsed by regex. `board_token` is the FULL subdomain label (e.g. `"careers-acme"`) — iCIMS customers don't share one fixed prefix.

### The silent-zero shape, per ATS (each measured live, not assumed from docs)

Each ATS answers "no such board" differently, and three don't distinguish it
from "real board, zero jobs right now" at all:

| ATS | Unknown board | Real board, zero jobs |
|---|---|---|
| Greenhouse | HTTP 404 JSON `{"status":404,"error":"Job not found"}` | HTTP 200 `{"jobs":[]}` |
| Lever | HTTP 404 JSON `{"ok":false,"error":"Document not found"}` | HTTP 200 `[]` (confirmed live: `api.lever.co/v0/postings/lever`) |
| Ashby | HTTP 404, **plain text** `"Not Found"` (not JSON) | HTTP 200 JSON `{"jobs":[],"apiVersion":"1"}` (confirmed live: `vercel`, `deel`, `mercury`) |
| SmartRecruiters | **Same shape as "zero jobs" — cannot tell them apart.** Both return HTTP 200 `{"totalFound":0,"content":[]}` | Same as unknown; this pack marks `ambiguous:true` rather than guessing |
| Recruitee | HTTP 404 JSON `{"error":"Not Found"}` | Not independently confirmed live (not found within this build's time budget); expected HTTP 200 `{"offers":[]}` by analogy with every sibling ATS's 200-success-empty-array convention |
| BambooHR | HTTP 200 (not 404!), `Content-Type: text/html` — BambooHR's own marketing homepage, byte-identical across different nonsense subdomains (a wildcard catch-all, not a per-company 404) | HTTP 200 JSON `{"meta":{"totalCount":0},"result":[]}` (confirmed live: `helpscout`, `pantheon`) |
| Workday | HTTP 404 JSON `{"errorCode":"S21",...,"message":"not found: Job_Posting_Site_ID=..."}` | Not independently confirmed (every real tenant found had jobs); `limit` over 20 is HTTP 400, not an empty page; `offset` past 10,000 returns HTTP 200 with the SAME page as `offset:0` rather than erroring — this pack reports `capped:true` when either cap is hit |
| Workable | Blocked (HTTP 429, Cloudflare) before any board-shaped answer is reachable from this platform | — |
| Teamtailor | HTTP 404, `Content-Type: application/json`, body EMPTY (0 bytes) | HTTP 200 JSON Feed `{"items":[...]}` (confirmed live: `career`, `arsenalfc`) |
| Personio | HTTP 404 `text/html` on BOTH `.com` and `.de` | HTTP 200 XML `<workzag-jobs>` (confirmed live: `kertos` on `.de`, `1nce` on `.com`) |
| Jobvite | HTTP 200 but 4 silent redirects to a DIFFERENT host (`www.jobvite.com/support/...?invalid=1`) — `fetch`'s default `redirect:'follow'` hides this unless you check `res.redirected` | HTTP 200, no redirect, server-rendered job table (confirmed live: `bagleybagelbites`, 65 rows) |
| Breezy | HTTP 404, `Content-Type: text/html`, title "Career portal not found" | HTTP 200 JSON array (confirmed live: `breezy`, `duolingo`) |
| Pinpoint | HTTP 404, `Content-Type: text/html` (Pinpoint's own 404 page) | Not independently confirmed (every real board found had postings); expected HTTP 200 `{"data":[]}` by the same convention |
| Rippling | HTTP 404, Next.js's own 404 page, no `__NEXT_DATA__` job-posts query | HTTP 200 with a `job-posts` query present but `items:[]` — not independently confirmed (every real board found had postings) |
| iCIMS | HTTP 404, title `"gone: {subdomain}.icims.com : dc409"` | Not independently confirmed (every real portal found had postings) |

Treating any non-200 as "zero jobs," or SmartRecruiters' `totalFound:0` as a
confirmed empty board, is the exact silent-zero failure this pack exists to
avoid — see the header comment in `src/index.ts` for the full edge-probe
evidence (status/length/first-400-bytes) behind every row above.

### Persistence (KV, not module scope)

The gateway injects its shared KV namespace as `_cacheKv` (`injectCacheKv` in
`pack-manifest.json`), used for three things, each dated and each degrading
cleanly to a live fetch if the binding is absent:

1. A whole-board job-list cache, ~3h TTL — "poll each board no more than every
   few hours."
2. The `domain -> {ats, board_token}` discovery index `ats_detect` writes —
   "the index grows with use."
3. The job-key snapshot `ats_new_postings` diffs against.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ats-boards": {
      "url": "https://gateway.pipeworx.io/ats-boards/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ats-boards/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1863+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ats_detect \
  -H 'Content-Type: application/json' \
  -d '{"domain":"ramp.com"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ats_detect`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-ats-boards` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/ats-boards/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "ats-boards": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-ats-boards"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ats Boards data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
