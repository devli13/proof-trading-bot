# proof-trading-bot

Experimental trading bot for **Proof Exchange "impact markets"** — a binary
event-prediction primitive built on top of perpetual futures. Built on the
[`@proof/trading-sdk`](https://github.com/Proof-labs/trading-sdk) (vendored as a
git submodule).

> ⚠️ Experimental. Defaults to the **devnet (paper money)**. It will refuse to
> trade against anything else unless you explicitly set `PROOF_ALLOW_REAL=1`.

## Status (2026-06-18)

A **multi-strategy bot** running live on devnet — adversarially reviewed (plan + code)
and deployed.

- ✅ **Two strategies, one shared-margin account:** a **market-maker** (cancel-replace,
  inventory-skewed, post-only) and a **parity / atomic-basket arb** on the HYPE impact
  event #203, run side by side by a multi-strategy runner.
- ✅ **Hardened** against a 101-finding plan review + a code audit: order **tick/lot
  snapping**, **serialized submits** (timestamp-nonce safety), a scenario-aware
  **kill-switch** (cancel-all + halt on margin/drawdown breach), market/legs caching,
  retry/robustness, and `DRY_RUN`. `pnpm typecheck` + **35 unit tests** green.
- ✅ **Verified live** on the funded $10k wallet: real MM orders placed (CheckTx 0),
  kill-switch trips + flattens, all recorded to **Supabase** (isolated `proof_bot` schema).
- ✅ **Deployed** at `asymmetra/proof-trading-bot` — Vercel cron runs the arb every 5 min.
- 🟡 **SDK read/confirm gaps remain** (account + open-orders `404` → we read via `/info`;
  CheckTx ≠ DeliverTx → can't confirm execution). All reported in
  **[`PROOF_SDK_FEEDBACK.md`](./PROOF_SDK_FEEDBACK.md)** (#1–#11).

## What are impact markets?

Creating one impact market spawns a family of **5 order books**: the underlying
perp plus four conditional/basket legs (`CPY`/`CPN` = conditional-proof yes/no,
`EBY`/`EBN` = exact-basket yes/no, i.e. binary prediction legs). Traders take
YES/NO positions on a binary event; at a deadline it resolves **YES / NO / VOID**
via an oracle price-vs-strike comparison or a relayer attestation, and positions
settle. Everything is `bigint`, never a float. Prices are **micro-USDC** (`$1 =
1_000_000`); binary legs trade in `0..1_000_000`. Per-market `tickSize`/`lotSize`/
`szDecimals` matter (binary legs: `tick=1, lot=100`; `szDecimals=2` ⇒ `qty=100` =
1 contract) — orders are snapped or the engine rejects them. (The SDK docs' "integer
cents" is wrong — see [`PROOF_SDK_FEEDBACK.md`](./PROOF_SDK_FEEDBACK.md) #6/#9.)

## Strategies

Both run side by side under one funded account (cross-margin; **Proof has no
subaccounts** — agent wallets are the per-strategy-key option, documented as future).
A scenario-aware **kill-switch** cancels all + halts on a margin/drawdown breach.

- **`market-maker`** — quotes a post-only bid+ask on one leg (default the event's base
  perp), `mid ± MM_SPREAD_BPS/2`, inventory-skewed, with the side that grows `|position|`
  suppressed past `MM_MAX_POSITION`. Cancel-replace each tick (robust to the missing
  open-orders read); fills inferred from `/info` positions.
- **`parity-arb`** — watches binary parity `EBY + EBN` vs `$1`; on a dislocation past
  fees + a **VOID safety margin**, captures it with a 2-leg **`AtomicBasketOrder`** (FOK,
  no resting orders). Net inventory per leg is bounded by **`ARB_MAX_POSITION`** — past
  the cap it only takes *inventory-reducing* baskets, so the position can't drift. An
  opt-in (`ARB_CONDITIONAL_ENABLED`) 3-leg conditional basket expresses an explicitly
  **directional** view (`base` vs `p·CPY+(1−p)·CPN`) — *not* an arb, since conditional
  legs settle to the underlying price in-branch.

Risk knobs (`.env.example`): `MM_*`, `ARB_*`, `MIN_MARGIN_RATIO_BPS`, `MAX_DRAWDOWN_BPS`,
`RESOLUTION_GUARD_MS`. Start with `DRY_RUN=1` to log intended orders without submitting.

## Quick start (devnet)

```bash
git clone --recurse-submodules <this-repo>
cd proof-trading-bot
pnpm install            # also builds the vendored SDK (postinstall)
cp .env.example .env    # fill in a funding source (see below)
pnpm smoke              # connect → read markets/account/book → place+cancel a test order
```

If you cloned without submodules: `git submodule update --init --recursive && pnpm build:sdk`.

## Wallet & funding

Create a devnet wallet and inspect it:

```bash
pnpm wallet         # show the current keypair (generates one if none exists)
pnpm wallet:new     # generate a fresh keypair into the gitignored keystore
```

The smoke test reads the chain with no credentials; to place orders the account
needs funds. Three paths, in precedence order:

1. **`PROOF_PRIVATE_KEY`** — a hex private key that's already funded. Required for
   Vercel (no writable keystore there).
2. **`PROOF_ACCESS_CODE`** (+ `PROOF_REDEEM_URL`) — **beta-challenge path** (what we
   use). Redeem a single-use code; the server returns a **new pre-funded wallet**
   `{privateKeyHex, address}`, which is cached to the keystore. The redeem host for
   the current challenge is `https://beta.proof.trade/access-code/redeem`. ⚠️ Note:
   redeem returns its *own* funded address — it does not fund a wallet you already
   generated.
3. **`PROOF_FAUCET_TOKEN`** — privileged devnet faucet (Proof-team internal). Funds
   a generated/keystore key via `POST {faucet}/drip`, then `pnpm fund` verifies the
   balance.

Keys live in `KEYSTORE_PATH` (default `.keys/devnet.json`, gitignored) — never
committed.

> ⚠️ **Known issue:** the beta challenge runs on the SDK's default gateway
> (`api.dev.proof.trade` / `exchange-devnet-1`), and the funded wallet **can place
> orders** — but the SDK's account-read endpoints (`GET /v1/account/<hex>`,
> open-orders) return `404 not found`, so the bot can't read balance/positions via
> the SDK. The web app reads via `/info` instead. See
> [`PROOF_SDK_FEEDBACK.md`](./PROOF_SDK_FEEDBACK.md) #1/#1b (reported to Proof).

## Commands

| Command           | What it does                                                        |
| ----------------- | ------------------------------------------------------------------- |
| `pnpm wallet`     | Show the current devnet wallet (generates one if none).             |
| `pnpm wallet:new` | Generate a fresh keypair into the keystore.                         |
| `pnpm fund`       | Drip the devnet faucet into the wallet and verify balance.          |
| `pnpm smoke`      | One-shot devnet smoke test (connectivity, reads, place+cancel).     |
| `pnpm tick`       | Run ONE multi-strategy tick (no resting-order cleanup) — used by cron. |
| `pnpm run`        | Long-lived multi-strategy loop; flattens (cancel-all) on SIGINT.    |
| `pnpm typecheck`  | `tsc --noEmit`.                                                      |
| `pnpm test`       | Vitest (35 tests: config, snapping, parity math, quotes, risk).     |

## Tracking (Supabase)

The SDK can't read open orders or fills, so the bot keeps its own ledger
([`src/tracking/`](src/tracking)): every submitted order/basket, periodic position
snapshots, and strategy decisions. In-memory by default; set **`DATABASE_URL`** to
persist to Supabase/Postgres in a dedicated **`DB_SCHEMA`** (`proof_bot`, isolated
from other projects). Schema in [`migration.sql`](src/tracking/migration.sql)
(auto-applied on connect). For Vercel serverless, use the **transaction pooler
(`:6543`)**; for a local long-running loop the session pooler (`:5432`) is fine.

## Writing a strategy

Implement the [`Strategy`](src/strategy/types.ts) interface (`onTick`, optional
`init`/`shutdown`). The runner injects a `StrategyContext` whose writes (`place`,
`cancelMarket`, `basket`) are **snapped to tick/lot, qty-capped, serialized
(nonce-safe), tracked, and `DRY_RUN`-aware** — strategies can't bypass them. Copy
[`market-maker.ts`](src/strategy/market-maker.ts) or
[`parity-arb.ts`](src/strategy/parity-arb.ts) and register it in
[`buildStrategies`](src/strategy/index.ts).

## Run it while you sleep — two options

**A. Long-lived loop (any VM / container).** `pnpm run` keeps a process alive,
subscribes to blocks, and ticks every `TICK_INTERVAL_MS`. Best for higher
frequency.

**B. Vercel Cron (serverless).** Deployed at **`asymmetra/proof-trading-bot`** (Git
integration — pushing to `main` auto-deploys). [`vercel.json`](vercel.json) schedules
`/api/tick` every 5 min; each invocation runs one `onTick` via
[`api/tick.ts`](api/tick.ts). Surfaces:

| Route          | What                                                                 |
| -------------- | ------------------------------------------------------------------- |
| `/`            | Status home ([`public/index.html`](public/index.html)).             |
| `/dashboard`   | PnL, equity chart, open positions, recent trades, decisions.        |
| `/api/status`  | Chain height + (if `PROOF_PRIVATE_KEY` set) account balance.         |
| `/api/stats`   | Trading-ledger stats JSON (powers the dashboard).                   |
| `/api/tick`    | One strategy tick. Cron-only — fail-closed by `CRON_SECRET`.        |

On the 5-min cron we run **`STRATEGIES=parity-arb`** (FOK, cadence-safe); the
market-maker wants a faster loop than 5 min, so run it via `pnpm run` on a VM.

Env vars (set in Production): `PROOF_PRIVATE_KEY` (funded key — no writable keystore
on Vercel), `CRON_SECRET` (Vercel sends it as `Authorization: Bearer …`; the route is
**fail-closed** — unset ⇒ 503), `PROOF_NETWORK`, `PROOF_IMPACT_EVENT`, `STRATEGIES`,
`DATABASE_URL` (transaction pooler), `DB_SCHEMA`. Set more with
`vercel env add <NAME> production`.

Notes:

- **ESM gotcha:** Vercel's Node runtime runs the functions as ESM and does *not*
  bundle them, so **all relative imports use explicit `.js` extensions** (e.g.
  `../src/config.js`). Without them the function fails at runtime with
  `ERR_MODULE_NOT_FOUND`.
- The SDK submodule is fetched over **https** so Vercel can fetch it; `postinstall`
  compiles it to `dist/`.
- Cron cadence/limits depend on your Vercel plan. Per-minute crons need a paid plan;
  for true high-frequency trading use option A.
- WebSocket block streaming only runs in the long-lived loop — the serverless path
  polls `onTick` only.

## Layout

```
src/
  config.ts        env + network presets, devnet-safety gate, all strategy/risk knobs
  wallet.ts        Ed25519 key: BYO / access-code redeem / keystore / generated
  client.ts        ExchangeClient factory + order/basket/account helpers (/info reader)
  impact.ts        impact-market data (/info impactMarket) + parity math
  orders.ts        tick/lot snapping + clientOrderId
  risk.ts          scenario-aware kill-switch
  runner.ts        BotEngine: multi-strategy, serialized submits, kill-switch, caching
  strategy/        Strategy interface, market-maker, parity-arb, buildStrategies
  tracking/        Tracker: in-memory + Supabase/Postgres adapter (proof_bot schema)
  smoke.ts         end-to-end devnet smoke flow
  units.ts logger.ts faucet.ts commands.ts
api/               Vercel functions: tick (cron), status (read-only)
vendor/trading-sdk git submodule — @proof/trading-sdk
```
