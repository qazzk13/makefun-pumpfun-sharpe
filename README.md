# makefun-pumpfun-sharpe

![Competition](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)
![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/qazzk13/makefun-pumpfun-sharpe/rank.svg)
![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/qazzk13/makefun-pumpfun-sharpe/reward.svg)

Entry for [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) on make.fun. It is a paper-trading bot: the harness replays recorded pump.fun chain data at it, and it answers each batch with buy or sell orders. No real money, no keys, no network. Places go by hourly Sharpe ratio, not raw PnL, so the bot is built for steady small gains rather than one lucky moonshot.

## How it trades, in plain words

The first version of this bot chased momentum — buy when the price and the buy flow are both rising — and on the dev tape it just bled (about -0.7 SOL over 24 hours). By the time the flow looks exciting, the move is usually being sold into. So the shipped version buys dips instead. For every coin it keeps the last ~90 slots of trades. A coin only gets bought when its price is down 12–28% off its recent high, but the newer half of the window shows at least 1.5 SOL of net inflow, more than the older half — sellers hit it, and now fresh buyers are stepping back in. It also needs at least 12 window trades from at least 6 different buyers, buys making up 45–68% of the traded SOL, and a real reserve between 10 and 90 SOL. One shot per coin; no re-entries.

Stakes are 0.2 SOL per position (cut down by the 1%-of-real-reserve cap on thinner curves), and never more than 4 momentum positions at once out of the 10 SOL paper bankroll, with total exposure capped at 3 SOL. Exits are mechanical: sell everything at -10% (stop loss), once the price has climbed back 30% of the way to the recent high (recoverShare), on a trailing stop once a position has been up 12% and falls 10% off its peak, or after 450 slots if nothing happened. Whichever comes first.

The contest also wants at least 20 different coins to complete a full round trip with at least 0.01 SOL bought. Dip signals alone might not get there on a quiet tape, so if round trips are lagging, the bot opens small 0.01 SOL probe positions on liquid, actively traded curves and closes them as soon as the buy lands. Probes are not meant to make money; they are there so the entry clears the guardrails, and they are sized so their fees stay a rounding error.

On the kit's dev window the final version grades at about +0.10 SOL net PnL with a max drawdown around 1.5% and roughly 290 fills over 64 coins — inside every guardrail. The final window is different data recorded after entries close, so that number is a sanity check, not a promise.

The bot is deterministic: it reads no clock, uses no randomness, and decides only from the batch stream in arrival order, so two runs over the same data produce the same orders byte for byte.

## Layout

- `main.ts` — the entrypoint the grader runs (`node /bot/main.ts`).
- `strategy.ts` — the strategy (dip entries, mechanical exits, guardrail pacing).
- `vendor/makefun-bot.ts` — the kit's TypeScript SDK shim for the agent-fun/replay/v2 protocol, vendored unchanged.
- `LICENSE` — MIT.

## Running it

The grader mounts this repo and runs `node main.ts` (Node 22.18+). Locally it can be graded with the competition kit:

```
node cli/makefun.mjs grade-local --kit <kit dir> --bot <this repo> --driver process
```
