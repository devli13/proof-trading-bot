# proof-trading-bot

Experimental trading bot for **Proof Exchange "impact markets"** — a binary
event-prediction primitive built on top of perpetual futures. Built on the
[`@proof/trading-sdk`](https://github.com/Proof-labs/trading-sdk) (vendored as a
git submodule).

> ⚠️ Experimental. Defaults to the **devnet (paper money)**. It will refuse to
> trade against anything else unless you explicitly set `PROOF_ALLOW_REAL=1`.

## Status (2026-06-18)

A **multi-bot platform** for Proof impact markets: many bots, each a dedicated
strategy on its **own funded wallet**, run in parallel by a persistent **worker**,
with a Supabase-backed **registry** + **dashboard**.

- ✅ **N bots in parallel** — one `BotEngine` per wallet (own kill-switch + submit
  queue), sharing one **market-data fetch** and one tracker. Scale by inserting a
  registry row (`pnpm bots add`) — no env change, no redeploy.
- ✅ **Encrypted registry** — the roster lives in `proof_bot.bots`; private keys are
  **AES-256-GCM encrypted at rest** (`BOTS_ENC_KEY`). No dashboard/API ever reads the
  key column. Only `DATABASE_URL` + `BOTS_ENC_KEY` to manage.
- ✅ **Strategies** — `market-maker` + `parity-arb` today, split onto separate wallets;
  more (`momentum`, `mean-reversion`, `funding-harvest`, `max-profit`, `volume-driver`)
  pluggable. **Multi-market** built in (a bot's `markets` list; the engine fans its
  strategy over each), exercised with HYPE event #203.
- ✅ **Hardened** — tick/lot snapping, **serialized submits** (timestamp-nonce safety),
  a scenario-aware **kill-switch**, market/legs caching, `DRY_RUN`. `pnpm typecheck` +
  **44 unit tests** green; adversarially audited.
- ✅ **Dashboard** (`/dashboard`) — per-bot **profit / volume / strategy-logic**,
  filter by **bot / strategy / tag / market**, equity chart with hover tooltips.
- ✅ **Deploy** — the worker runs on **Render** (`render.yaml`); **Vercel is
  dashboard-only** (cron disabled). All data in **Supabase** (`proof_bot` schema).
- 🟡 **SDK read/confirm gaps remain** (account + open-orders `404` → we read via `/info`;
  CheckTx ≠ DeliverTx → can't confirm execution). All in
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
| `pnpm worker`     | **Persistent MULTI-bot worker** (registry-driven; the Render entry). |
| `pnpm bots ...`   | Manage the registry: `list` / `add <id> <strat> <key\|-> [markets] [tags] [json]` / `disable` / `enable`. |
| `pnpm tick`       | Run ONE single-bot tick (no resting-order cleanup).                 |
| `pnpm run`        | Long-lived single-bot loop; flattens (cancel-all) on SIGINT.        |
| `pnpm typecheck`  | `tsc --noEmit`.                                                      |
| `pnpm test`       | Vitest (44 tests: config, snapping, parity math, quotes, risk, crypto). |

## Tracking (Supabase)

The SDK can't read open orders or fills, so the bot keeps its own ledger
([`src/tracking/`](src/tracking)): every submitted order/basket, periodic position
snapshots, and strategy decisions. In-memory by default; set **`DATABASE_URL`** to
persist to Supabase/Postgres in a dedicated **`DB_SCHEMA`** (`proof_bot`, isolated
from other projects). Schema in [`migration.sql`](src/tracking/migration.sql)
(auto-applied on connect). For Vercel serverless, use the **transaction pooler
(`:6543`)**; for a local long-running loop the session pooler (`:5432`) is fine.

## Multi-bot worker + registry

The platform runs many bots in one persistent process. Each bot is a row in the
**`proof_bot.bots`** registry — `{ strategies[], markets, tags[], encrypted key,
params }` — and the worker runs one `BotEngine` per enabled bot (own wallet +
kill-switch + submit queue) against a **shared** market-data fetch and tracker. It
**hot-reloads** the registry every `BOTS_REFRESH_MS`, so adding/disabling a bot needs
no restart.

```bash
# generate the at-rest encryption key once, put it in .env (and Render):
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # → BOTS_ENC_KEY

pnpm bots add mm-base    market-maker -  all "market-making,single-strat" '{"MM_SPREAD_BPS":"30"}'
pnpm bots add arb-binary parity-arb   -  203 "arb,single-strat"
pnpm bots list                 # roster, never prints keys
pnpm worker                    # run them all (DRY_RUN=1 first to dry-run)
```

`-` reads the key from `BOT_KEY` (keeps it out of shell history). Keys are
**AES-256-GCM encrypted** with `BOTS_ENC_KEY` before they touch the DB. ⚠️ Give each
bot its **own** key — two bots on one wallet collide on the ms-timestamp nonce.

### Deploy (Render worker + Vercel dashboard)

The worker runs on **Render** — create a service from [`render.yaml`](render.yaml)
(a background worker: `pnpm install` → `pnpm worker`) and set two secrets in the
dashboard: `DATABASE_URL` and `BOTS_ENC_KEY`. Everything else is in the blueprint.
Scaling bots is a `pnpm bots add` — no redeploy.

**Vercel is dashboard-only** (the cron is removed). Push to `main` auto-deploys the
static dashboard + read-only API. Surfaces:

| Route          | What                                                                 |
| -------------- | ------------------------------------------------------------------- |
| `/`            | Status home ([`public/index.html`](public/index.html)).             |
| `/dashboard`   | Fleet view: per-bot PnL/volume/strategy-logic, filters, hover charts. |
| `/api/status`  | Chain height + (if `PROOF_PRIVATE_KEY` set) account balance.         |
| `/api/stats`   | Multi-bot stats JSON (per-bot breakdown; never the keys).            |
| `/api/tick`    | One single-bot tick, fail-closed by `CRON_SECRET` (manual/testing).  |

- **ESM gotcha:** Vercel runs `api/` as un-bundled ESM, so **all relative imports use
  explicit `.js` extensions** or they fail with `ERR_MODULE_NOT_FOUND`.
- The SDK submodule is fetched over **https** (Render + Vercel can clone it);
  `postinstall` compiles it to `dist/`.
- For the worker, devDependencies (`tsx`) must be installed — don't set
  `NODE_ENV=production` on Render.

## Writing a strategy

Implement the [`Strategy`](src/strategy/types.ts) interface (`onTick`, optional
`init`/`shutdown`). The engine runs it once per assigned market each tick and injects
a `StrategyContext` whose writes (`place`, `cancelMarket`, `basket`) are **snapped to
tick/lot, qty-capped, serialized (nonce-safe), tracked (per bot), and `DRY_RUN`-aware**
— strategies can't bypass them, and the persistent worker lets them keep state across
ticks. Copy [`market-maker.ts`](src/strategy/market-maker.ts) or
[`parity-arb.ts`](src/strategy/parity-arb.ts) and register it in
[`buildStrategies`](src/strategy/index.ts).

## Layout

```
src/
  config.ts        env + network presets, devnet-safety gate, all strategy/risk/worker knobs
  wallet.ts        Ed25519 key: BYO / from-hex / access-code / keystore / generated
  client.ts        ExchangeClient factory + order/basket/account helpers (/info reader)
  impact.ts        impact-market data (/info impactMarket) + parity math
  market-data.ts   SHARED multi-event legs + market metadata (one fetch for all bots)
  orders.ts        tick/lot snapping + clientOrderId
  risk.ts          scenario-aware kill-switch
  runner.ts        BotEngine (one per bot): submits, kill-switch, multi-market fan-out
  worker.ts        persistent MULTI-bot runner (registry-driven, hot-reload)
  bots.ts          registry: load/add/list/disable (encrypted keys)
  bots-cli.ts      `pnpm bots` admin CLI
  bot-crypto.ts    AES-256-GCM at-rest key encryption (BOTS_ENC_KEY)
  strategy/        Strategy interface, market-maker, parity-arb, buildStrategies
  tracking/        Tracker: in-memory + Supabase/Postgres (proof_bot: ledger + bots registry)
  smoke.ts         end-to-end devnet smoke flow
  units.ts logger.ts faucet.ts commands.ts
api/               Vercel functions: status + stats (read-only dashboard data)
render.yaml        Render blueprint for the worker
vendor/trading-sdk git submodule — @proof/trading-sdk
```
