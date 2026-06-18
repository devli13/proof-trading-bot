# Proof Trading SDK — Feedback & Issue Report

Issues found while building an experimental trading bot on `@proof/trading-sdk`
(repo: `github.com/Proof-labs/trading-sdk`) against the public devnet and the
beta paper-trading challenge. Shared for the Proof team.

**Date:** 2026-06-17
**SDK:** `@proof/trading-sdk@0.1.0` (vendored from `main`)
**Environment:** public devnet — gateway `https://api.dev.proof.trade`, chain
`exchange-devnet-1`; beta challenge redeem at `https://beta.proof.trade`.
**Our setup:** Node 24 / TypeScript / pnpm; SDK consumed from source (built to
`dist/` via `tsc`).

Severity scale: **Critical** (blocks core flow) · **High** · **Medium** · **Low**
(ergonomics/docs) · **Info**.

---

## #1 — Redeemed paper-trading wallet is "not found" on the documented gateway · **Critical**

**What we were trying to do:** Fund a wallet for the beta paper-trading challenge
and read its balance, following `PAPER-TRADING.md`.

**Steps to reproduce**
1. Redeem a single-use challenge access code (host from the challenge announcement,
   path from `PAPER-TRADING.md`):
   ```bash
   curl -X POST https://beta.proof.trade/access-code/redeem \
     -H 'Content-Type: application/json' \
     -d '{"code":"<ACCESS-CODE>"}'
   # -> HTTP 200  {"privateKeyHex":"<hex>","address":"0x5eed014f...286f7"}
   ```
2. Per `PAPER-TRADING.md` "Step 4 — Trade with the SDK", connect with the default
   gateway and `chainId: "exchange-devnet-1"`, load the returned key, and query the
   account:
   ```ts
   const client = new ExchangeClient({ chainId: "exchange-devnet-1" }); // api.dev.proof.trade
   client.setPrivateKey(hexToBytes("<privateKeyHex>"));
   await client.queryBalance();   // and queryEquity / queryAccount
   ```

**Expected:** The returned address is pre-funded (the redeem doc says the server
"funds the derived address through the faucet"), so `queryBalance()` /
`queryAccount()` return the starting balance.

**Actual:** `queryBalance()`, `queryEquity()`, and `queryAccount()` all throw
`API error: not found` for the redeemed address — re-checked repeatedly over 6+
minutes after a successful (HTTP 200) redeem.

**Ruled out:** Address derivation is correct — deriving the address locally from
the returned `privateKeyHex` (`pubkeyToOwner(getPublicKey(priv))`) yields exactly
the `address` the redeem endpoint returned (`0x5eed014f...286f7`). So we are
querying the right address; it simply has no account record on
`api.dev.proof.trade` / `exchange-devnet-1`.

**Root cause (confirmed):** It is **not** a gateway mismatch. The beta web app's
own JS bundle (`beta.proof.trade`) references only `https://api.dev.proof.trade`
and chain `exchange-devnet-1` — the **same** gateway/chain the SDK defaults to.
The account is genuinely funded there (the web app shows `$10,000.00`), and
**writes succeed** against it (see #1b). The problem is specifically the SDK's
**account-read REST endpoint**:

- SDK `queryAccount()` → `GET /v1/account/<hex>` (client.ts:772) → `HTTP 404
  {"status":"error","error":"not found"}` for the funded address, **with and
  without** the `0x` prefix.
- `queryOpenOrders()` likewise → `API error: not found`.
- Meanwhile the web app reads the same account fine via **`/info`** (request
  types seen in the bundle include `clearinghouseState`, `account`) and
  **`/portfolio`** — NOT via `/v1/account/<hex>`.

So `/v1/account/<hex>` (the endpoint the whole `queryAccount`/`queryBalance`/
`queryEquity` surface is built on) appears **deprecated, not populated for
web-funded accounts, or replaced by `/info`** — while the SDK still points at it.

**Workaround we found (works — likely the fix):** `POST {gateway}/info` with body
`{"type":"clearinghouseState","user":"0x<addr>"}` returns the funded account —
HTTP 200, body `{"data":"<base64 msgpack>"}`. Decoding the base64→msgpack yields
the **same array layout `queryAccount` already decodes**:
`[balance, positions, equity, totalMm, totalIm, marginRatioBps, bindingScenario,
feesAccrued, volume30d, <extra[9]>]`. Our $10,000 account decodes to
`balance=10000000000`, `equity=10000000000` (micro-USDC) ✓. Gotchas:
- `user` must be **0x-prefixed** (the SDK's `ownerToHex` is un-prefixed).
- `{"type":"account",…}` returns `400 {"error":"invalid info request"}` — the type
  is `clearinghouseState`, field is `user` (not `address`).
- index `[9]` is an extra field not in the SDK's parser (equals `balance` for a
  fresh account — possibly free/withdrawable collateral?). Please document it.

So the cleanest SDK fix is to point `queryAccount` (and the open-orders read) at
`POST /info` — the path the web app already uses — instead of
`GET /v1/account/<hex>`. We've done exactly this in our bot as a workaround and it
restores full balance/equity/position reads.

**What we need:** Either fix `/v1/account/<hex>` to return web-funded accounts, or
update the SDK to read account/orders via `/info` (and document its request/response
shape + the `[9]` field + whether an `openOrders` info type exists).

**Impact:** **Critical** for read flows — a bot can't read its balance, positions,
or open orders via the SDK, even though the account is funded and **can place
orders** (#1b). We worked around it by not gating order submission on the
(failing) balance read.

---

## #1b — `submitTxCommit` confirm-poll times out; `submitTx` (CheckTx) works · **High**

**What:** Order submission **broadcasts successfully** (returns a tx hash, and
`submitTx` returns **CheckTx code 0** = admitted), but `submitTxCommit()` then
**times out polling `/tx` after 9s** (`code:-1, log:"submitTxCommit: timed out
polling /tx after 9s"`) — so it can never confirm DeliverTx/inclusion via the
documented commit path. Reproduced on multiple markets (HYPE m7, BTC m1).

**Reproduce:** With a funded key, `await client.submitTxCommit({type:"PlaceOrder",…})`
→ returns `code:-1` timeout despite a valid tx hash. The same action via
`client.submitTx(…)` returns `code:0` immediately.

**Workaround:** Use `submitTx` (fire-and-forget CheckTx) and verify out-of-band.
But then there's **no SDK way to confirm execution** (the `/tx` poll and
`queryOpenOrders` both fail), so a bot is flying blind on whether its order rested.

**What we need:** A working inclusion/confirmation read (fix `/tx` polling, or a
documented `/info`-based order/fill query), so bots can confirm orders.

---

## #2 — Account queries throw instead of returning `null` for new/unfunded accounts · **Low** (ergonomics)

**What:** `ExchangeClient.queryAccount()` is typed `Promise<AccountInfo | null>`,
implying `null` for a missing account. In practice, querying a freshly generated
(never-funded) address **throws** `API error: not found` rather than returning
`null`. `queryBalance()` / `queryEquity()` behave the same.

**Reproduce:** `await new ExchangeClient({chainId:"exchange-devnet-1"}).setPrivateKey(genKey); await client.queryAccount()` on a brand-new address → throws `API error: not found`.

**Expected:** Return `null` (per the type) for "account does not exist yet", and
reserve thrown errors for genuine failures.

**Workaround we used:** wrap in try/catch and treat `/not found/i` as `null`.

**Impact:** Minor; every caller must wrap account reads to distinguish "no account
yet" from real errors. Aligning behavior with the `| null` type would remove the
footgun.

---

## #3 — `PAPER-TRADING.md` redeem host is a placeholder · **Low** (docs)

**What:** `PAPER-TRADING.md` documents the redeem endpoint as
`POST https://<contest-site>/access-code/redeem` with `<contest-site>` left as a
placeholder. The real host (`beta.proof.trade`) only came via the out-of-band
challenge announcement. Combined with #1, it's unclear which gateway/chain a
redeemed wallet lives on.

**Suggestion:** Document the actual challenge URL and the exact
`ExchangeClient` config (gateway + `chainId`) participants should use after
redeeming.

---

## #4 — Faucet `/health` returns 404 · **Info**

`GET https://faucet.dev.proof.trade/` → 200, but `GET .../health` → 404. Minor
inconsistency (the gateway exposes `/health`). `POST /drip` correctly returns
`401 {"error":"missing or invalid bearer token"}` without a token — expected.

---

## #5 — No public/self-serve devnet funding for non-participants · **Info**

For internal-dev style testing (outside the challenge), the only funding path is
the privileged faucet token (`PROOF_FAUCET_TOKEN`), which isn't obtainable without
contacting the team. An open, rate-limited devnet drip (or a documented way to get
a dev token) would make SDK evaluation easier. Not a bug — a DX note.

---

## #6 — Price unit/scale is ambiguous (docs say "cents", devnet book implies micro-USDC) · **Medium**

**What:** `README`/`AGENTS.md`/`CLAUDE.md` and the `OrderbookLevel.price` / `PlaceOrder.price`
docstrings state prices are **integer cents (2 dp)** — e.g. `6675000 = $66,750`.
But `MarketConfig.tickSize` is documented as **"Tick size in micro-USDC"** (1e6),
and the live devnet book doesn't match the "cents" reading:

```
queryOrderbook(1)  // BTC-PERP, devnet
bestBid = 64611500000   bestAsk = 64623686545
```
Interpreted as cents (1e2) → bestBid ≈ $646,115,000 (impossible for BTC).
Interpreted as micro-USDC (1e6) → bestBid = $64,611.50, ask = $64,623.69,
spread ≈ $12 (~1.9 bps) — a sane BTC quote.

**Confirmed against the web app:** `queryOrderbook(7)` (HYPE) returns bestBid
`72020000`; the beta web app displays HYPE at **$72.02** at the same moment.
`72020000 / 1e6 = 72.02` ✓. So prices are unambiguously **1e6-scaled
(micro-USDC), not 1e2 ("cents")**. The two unit systems ("cents" in prose,
"micro-USDC" in `tickSize`) coexist in the SDK and conflict.

**Please clarify:** What is the canonical price scale? Is it uniform across
markets, or per-market via `tickSize` / `szDecimals`? The "integer cents (2 dp)"
examples in the docs look wrong (or at least not universal).

**Impact:** Medium. Anyone hardcoding "cents" (e.g. the `50_000_00n` bid in
`examples/connect-and-trade.ts`) will mis-price by 1e4. We avoided this by deriving
order prices from the live book, but the docs would mislead a new integrator.

---

## Clarifications needed (open questions)

These weren't clear from the README / `AGENTS.md` / `PAPER-TRADING.md`:

1. **Beta challenge endpoint** — which gateway URL + `chainId` do redeemed
   challenge wallets live on? (See #1 — this is the current blocker.)
2. **Impact-market discovery** — `ImpactMarketInfo` and `CreateImpactMarket` exist,
   and an impact market spawns 5 books (underlying + CPY/CPN/EBY/EBN). But how does
   a *trader* enumerate impact markets and map them to their 5 market IDs, question
   text, deadline, and status (Trading/PreResolution/Resolved)? Is there a
   `queryImpactMarkets()` / an info endpoint, or must we infer from `queryMarkets()`?
3. **Trading the conditional/binary legs** — is it the same `PlaceOrder` with the
   child market id, and are there constraints (e.g. price bounds 0–1 for binaries,
   or are they priced like perps)? A worked example for a YES/NO trade would help.
4. **Settlement from a trader's POV** — how do we observe an event resolving and the
   PnL hitting the account? Is `queryHistoryResolutions()` the canonical source, and
   is there an event on the WS stream?
5. **Price/size gates per market** — relationship between `tickSize`, `lotSize`,
   `szDecimals`, and the integer price/qty we submit. Which fields must orders snap to?
6. **Rate limits** — the challenge rules mention rate limits "to protect the
   infrastructure." What are the concrete limits (per IP / per key / per endpoint)
   so a bot can self-throttle rather than get `429`'d?
7. **Nonce window** — `seq` is a ms timestamp validated against a sliding window.
   What's the window size / allowed clock skew? (Helps bots that batch or run on
   slightly-skewed serverless clocks.)

## Nice-to-haves

- **A real-time market data stream.** `subscribeBlocks()` exposes raw NewBlock/Tx
  events; the example hints at `wss://<host>/ws`, but there's no documented
  higher-level feed for orderbook deltas / trades / fills / funding. A typed
  subscription (`onOrderbook`, `onFill`, `onResolution`) would remove a lot of
  per-bot plumbing.
- **`queryAccount` returning `null` for unknown accounts** (see #2) — small, but it
  matches the type and removes a footgun.
- **Publish the SDK to npm** (it's `@proof/trading-sdk@0.1.0` but 404s on the
  registry). We vendored it as a git submodule and build `dist/` ourselves; an npm
  publish (or at least a built `dist/` on a release tag) would simplify consumption,
  especially for serverless bundlers.
- **A `testnet`/`beta` preset** in `ExchangeClientOptions` (or a documented list of
  gateway+chainId pairs) so integrators don't hardcode URLs.
- **An `examples/` snippet for an end-to-end impact-market (YES/NO) trade**, not just
  a perp limit order — that's the headline primitive and the most novel part.
- **Clarify faucet vs. challenge funding** in one place (who gets a token, who
  redeems a code, and which gateway each funds).

## Things that worked well

- `queryMarkets()`, `queryOrderbook()`, `queryHealth()` all worked first try
  against devnet (health height ~27.46M; 1,310 markets incl. BTC/SOL/WTI/NVDA/HYPE
  perps and impact-market legs).
- Key handling (`generateKeypair`, `getPublicKey`, `pubkeyToOwner`, `ownerToHex`,
  `hexToBytes`) is clean and the derivation matches the server.
- The access-code redeem endpoint itself responded correctly (HTTP 200 + key).
- **The write path works:** signing + `submitTx` for `PlaceOrder` and
  `CancelAllOrders` returns **CheckTx code 0** against the funded account on every
  attempt — the codec/signing/v3-envelope path is solid. (Only the read/confirm
  side, #1 and #1b, is broken.)
- `bigint`-everywhere units and the typed action set are easy to build against.
