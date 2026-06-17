# proof-trading-bot

Experimental trading bot for **Proof Exchange "impact markets"** — a binary
event-prediction primitive built on top of perpetual futures. Built on the
[`@proof/trading-sdk`](https://github.com/Proof-labs/trading-sdk) (vendored as a
git submodule).

> ⚠️ Experimental. Defaults to the **devnet (paper money)**. It will refuse to
> trade against anything else unless you explicitly set `PROOF_ALLOW_REAL=1`.

## Status (2026-06-17)

- ✅ **Engine + devnet reads working** — connects to `api.dev.proof.trade`, lists
  the 1,310 markets, reads orderbooks/health. `pnpm typecheck` + `pnpm test` green.
- ✅ **Wallet + funding plumbing** — `wallet`/`fund` CLI commands; supports a
  bring-your-own key, the beta-challenge access-code redeem, and the faucet token.
- 🟡 **Funding blocked by a backend/SDK issue** — a wallet redeemed for the beta
  challenge (`beta.proof.trade`) is **`not found`** on the documented gateway
  (`api.dev.proof.trade` / `exchange-devnet-1`), so it can't trade yet. Details +
  repro in [`PROOF_SDK_FEEDBACK.md`](./PROOF_SDK_FEEDBACK.md) (issue #1). Likely a
  different gateway/chain for the beta challenge — pending confirmation from Proof.
- 🟡 **Vercel deploy** — live at `asymmetra/proof-trading-bot`; cron + functions
  wired. Fixing an ESM bundling issue in the serverless functions (see the Vercel
  section). Root `/` is a status page; the bot runs at `/api/tick` (cron) and
  `/api/status`.

Found a bunch of SDK/devnet rough edges along the way — written up for the Proof
team in **[`PROOF_SDK_FEEDBACK.md`](./PROOF_SDK_FEEDBACK.md)**.

## What are impact markets?

Creating one impact market spawns a family of **5 order books**: the underlying
perp plus four conditional/basket legs (`CPY`/`CPN` = conditional-proof yes/no,
`EBY`/`EBN` = exact-basket yes/no). Traders take YES/NO positions on a binary
event; at a deadline it resolves **YES / NO / VOID** via an oracle
price-vs-strike comparison or a relayer attestation, and positions settle. All
prices are integer **cents** and balances are **microUSDC** — everything is
`bigint`, never a float.

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

> ⚠️ **Known blocker:** a wallet redeemed for the beta challenge currently reads
> back as `not found` on `api.dev.proof.trade`. See
> [`PROOF_SDK_FEEDBACK.md`](./PROOF_SDK_FEEDBACK.md) #1 — likely a different
> gateway/chain for the challenge. Once the correct gateway is known, set
> `PROOF_NETWORK=custom` + `PROOF_GATEWAY_URL` + `PROOF_CHAIN_ID` + `PROOF_ALLOW_REAL=1`
> (or we add a `beta` preset in `src/config.ts`).

## Commands

| Command           | What it does                                                        |
| ----------------- | ------------------------------------------------------------------- |
| `pnpm wallet`     | Show the current devnet wallet (generates one if none).             |
| `pnpm wallet:new` | Generate a fresh keypair into the keystore.                         |
| `pnpm fund`       | Drip the devnet faucet into the wallet and verify balance.          |
| `pnpm smoke`      | One-shot devnet smoke test (connectivity, reads, place+cancel).     |
| `pnpm run`        | Long-lived strategy loop (block + interval ticks, graceful SIGINT). |
| `pnpm typecheck`  | `tsc --noEmit`.                                                      |
| `pnpm test`       | Vitest (config + unit helpers).                                     |

## Writing a strategy

Strategies implement the [`Strategy`](src/strategy/types.ts) interface
(`init` / `onTick` / `onBlock` / `shutdown`). The runner injects a
`StrategyContext` with read helpers and **risk-guarded** writes (`placeLimit`,
`cancelAll`) that enforce `MAX_ORDER_QTY` and `MAX_OPEN_ORDERS`. Copy
[`src/strategy/noop.ts`](src/strategy/noop.ts) as a template and register it in
[`src/index.ts`](src/index.ts).

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
| `/`            | Static status page ([`public/index.html`](public/index.html)).      |
| `/api/status`  | Chain height + (if `PROOF_PRIVATE_KEY` set) account balance.         |
| `/api/tick`    | One strategy tick. Cron-only — guarded by `CRON_SECRET`.            |

Env vars (already set in Production): `PROOF_PRIVATE_KEY` (funded key — there's no
writable keystore on Vercel), `CRON_SECRET` (Vercel sends it as `Authorization:
Bearer …` to `/api/tick`), `PROOF_NETWORK`. Set more with
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
  config.ts        env + network presets, devnet-safety gate
  wallet.ts        Ed25519 key: BYO / access-code redeem / keystore / generated
  client.ts        ExchangeClient factory + order helpers
  faucet.ts        privileged devnet faucet drip
  units.ts         cents / microUSDC formatting & parsing (bigint)
  logger.ts        pino logger
  runner.ts        buildContext + executeTick (cron) + runBot (loop) + risk guard
  smoke.ts         end-to-end devnet smoke flow
  strategy/        Strategy interface + NoopStrategy template
api/               Vercel functions: tick (cron), status (read-only)
vendor/trading-sdk git submodule — @proof/trading-sdk
```
