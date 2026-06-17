# proof-trading-bot

Experimental trading bot for **Proof Exchange "impact markets"** — a binary
event-prediction primitive built on top of perpetual futures. Built on the
[`@proof/trading-sdk`](https://github.com/Proof-labs/trading-sdk) (vendored as a
git submodule).

> ⚠️ Experimental. Defaults to the **devnet (paper money)**. It will refuse to
> trade against anything else unless you explicitly set `PROOF_ALLOW_REAL=1`.

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

## Funding (pick one)

The smoke test reads the chain with no credentials; to actually place orders the
account needs funds. In precedence order:

1. **`PROOF_PRIVATE_KEY`** — a hex private key that's already funded. Required
   for Vercel (no writable keystore there).
2. **`PROOF_ACCESS_CODE`** (+ `PROOF_REDEEM_URL`) — paper-trading competition
   path: the contest server redeems your single-use code and returns a funded
   key, which is cached to the keystore.
3. **`PROOF_FAUCET_TOKEN`** — privileged devnet faucet (Proof-team internal).
   Funds a freshly generated/keystore key via `POST {faucet}/drip`.

Keys are stored in `KEYSTORE_PATH` (default `.keys/devnet.json`, gitignored) and
are never committed.

## Commands

| Command          | What it does                                                        |
| ---------------- | ------------------------------------------------------------------- |
| `pnpm smoke`     | One-shot devnet smoke test (connectivity, reads, place+cancel).     |
| `pnpm run`       | Long-lived strategy loop (block + interval ticks, graceful SIGINT). |
| `pnpm typecheck` | `tsc --noEmit`.                                                      |
| `pnpm test`      | Vitest (config + unit helpers).                                     |

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

**B. Vercel Cron (serverless).** [`vercel.json`](vercel.json) schedules
`/api/tick` (default every 5 min); each invocation runs one `onTick` via
[`api/tick.ts`](api/tick.ts). [`api/status.ts`](api/status.ts) reports height +
balance.

Deploy:

```bash
vercel link
vercel env add PROOF_PRIVATE_KEY     # a funded devnet key
vercel env add CRON_SECRET           # any random string; Vercel sends it as a Bearer token to /api/tick
vercel env add PROOF_NETWORK         # devnet
vercel deploy --prod
```

Notes:

- The SDK submodule is fetched over **https** so Vercel can build it; the
  `postinstall` step compiles it to `dist/`.
- Cron cadence/limits depend on your Vercel plan. Per-minute crons need a paid
  plan; for true high-frequency trading use option A.
- WebSocket block streaming only runs in the long-lived loop — the serverless
  path uses polling `onTick` only.

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
