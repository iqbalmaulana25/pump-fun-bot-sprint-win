# Breakout Rider Bot

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/iqbalmaulana25/pump-fun-bot-sprint-win/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/iqbalmaulana25/pump-fun-bot-sprint-win/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A breakout paper-trading bot for the [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) bounty on make.fun. It trades 10 SOL of paper money on a replay of 6 hours of recorded pump.fun bonding-curve activity. Places go by net PnL, best first; a placement needs net PnL above 0 after every fee.

## Strategy

Ranking is net PnL, so the design goal is to catch the few real runners and let them pay for the many small losers:

- **Breakout only** — the price must print a NEW high over its 40-slot window (not just near it) on strong, broad, accelerating buy flow: net inflow ≥ 2.5 SOL, ≥ 6 buy trades from ≥ 6 distinct wallets, price up 8–80%, newer-half inflow beating the older half by 1.3×. No single wallet may dominate more than 45% of the buys. Curves younger than 200 slots are excluded (fresh launches are mostly bundled dumps); real SOL reserves must sit between 1.5 and 80 SOL.
- **Pyramid into continuation** — first buy 0.10 SOL, adds of 0.08 SOL only while the position is in profit, the price stepped up 6% from the last add, and net SOL still flows in; at most 0.3 SOL per position, 2.0 SOL total exposure.
- **Two-stage exits** — bank HALF the position at +12% and let the rest run under a trailing stop (armed at +12%, 10% give-back), so one moonshot can carry the whole run. Full stop at −6%, exit on fading flow (net < −0.8 SOL over 20 slots), on a single sell ≥ 3 SOL, or on a 1200-slot time limit unless up ≥ 25%.
- **No chasing, no overtrading** — 200-slot cooldown after an exit, at most 3 entries per curve. Fees (1.25% curve + tx fees) punish churn, so the bot waits for a real breakout.

## Files

- `main.ts` — entrypoint; the grader runs `node /bot/main.ts` (Node 22, stdlib only, no dependencies).
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` protocol shim, copied verbatim from the official kit.

## Local test

Grade locally the way the server does (process driver; docker is not installed here):

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

Dev-window result (kit's frozen dev dataset, run locally with `grade-local --driver process`, Node v24.22.1 — the server grades on Node v26.13.1 in docker, so this is indicative, not the server score): **net PnL −1.20 SOL** (return −12.0%, 90% interval −1.56…−0.83 SOL), 441 fills over 114 coins, 184 round trips, win rate 12.0%, max drawdown 12.0%, fees 0.51 SOL curve + 0.05 SOL tx. **Guardrails met** (114 coins hold a round trip ≥ 0.01 SOL, drawdown well under 50%).

Honest read: the dev window is brutal for momentum — the kit's own pilot momentum bot scores −9.49 SOL with a 95.7% drawdown (fails the guardrail) on the same data. This bot loses far less than the pilot and keeps drawdown contained; tuning rounds (smaller sizing, tighter stops, stricter entries) improved it from −1.55 SOL to −1.36 SOL, and a revision round (exits extracted to `shouldExit`, max 2 new entries per batch, 400-slot cooldown after losing exits) improved it further to −1.20 SOL. A tighter entry bar was tried in the same round and reverted after it worsened dev PnL to −1.46 SOL. The final 6h window is different data, so no dev-window number is promised — the design goal is to be positioned for the runners when they appear, with losers cut fast.
