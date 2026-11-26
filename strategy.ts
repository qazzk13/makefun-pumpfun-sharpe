// Pump.fun Sharpe Sprint — steady dip-buying paper bot.
//
// The ranking is hourly Sharpe, not raw PnL: steady small gains with low
// hour-to-hour variance beat one lucky moonshot. So this bot trades small,
// takes profits fast, cuts losses fast, and stays busy across the whole
// window instead of concentrating on a few coins.
//
// What it does, in one line: it buys pullbacks on liquid curves and sells
// part of the way back up. Chasing momentum was tried first on the dev
// window and just bled: by the time the flow looks exciting, the move is
// usually being sold into. A dip is different — sellers hit the curve, the
// price falls 12-28% off its recent high, and fresh buyers step back in.
// That is the entry: a pullback with returning flow, on a curve holding
// enough real SOL to be tradable.
//
// How it reads a curve: every curve keeps a short rolling tape of its
// recorded trades. A buy needs the price down dipDdMin..dipDdMax from its
// dipWindow high, net SOL flowing back in over the newer half of the window
// (at least dipNetNew, and more than the older half), enough trades from
// enough distinct buyers, buys a healthy share of the traded SOL, and real
// SOL within bounds. One shot per coin: no re-entries, no chasing the same
// dip twice.
//
// Sizing: one buy of initialSol (0.2 SOL, cut down by the 1%-of-real-reserve
// cap on thinner curves). A buy that was sized down by the cap may be
// topped up to stakeSol while the bounce confirms, never more. Exits are
// mechanical and whole-position: stop loss, a recoverShare exit (sell once
// the price has climbed back part of the way to the recent high), a trailing
// stop once armed, or a time limit. A curve that completes is closed by the
// replay at its final reserves.
//
// Guardrail pacing: the run must end with round trips of >= 0.01 SOL on
// >= 20 distinct mints (and we aim for >= 200 fills). When the bot's own
// fills or coins lag a pace set in block time, it opens tiny probe round
// trips (buy probeSol, sell it all as soon as the buy lands) on liquid
// curves until it is back on pace.
//
// Deterministic by construction: no clock, no randomness, no network;
// iteration only over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry regime: 'momentum' chases a rising tape; 'dip' buys a pullback with flow returning. */
  entryMode: 'momentum' | 'dip';
  /** Entry lookback in slots. */
  window: number;
  /** Net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Price now over price at the window start, minus 1 (lower bound). */
  minPriceUp: number;
  /** Same rise, upper bound: skip curves that already ran too far. */
  maxPriceUp: number;
  /** Newer-half net inflow must be at least this multiple of the older half's. */
  accel: number;
  /** Price now at least this share of the window's high. */
  nearHigh: number;
  /** Largest single wallet's share of the window's buy SOL (upper bound). */
  maxBuyerShare: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** SOL in one position in total (first buy + one add). */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys in bps; sells always go out at 10000. */
  buySlipBps: number;
  /** Exit: value below cost * (1 - stopLoss). */
  stopLoss: number;
  /** Exit: value above cost * (1 + takeProfit). 0 = off. */
  takeProfit: number;
  /** Exit: price recovered this share of the gap between entry price and the recent high at entry. 0 = off. */
  recoverShare: number;
  /** Exit: trailing stop, value below peak * (1 - trail). */
  trail: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Fade lookback in slots. */
  fadeWindow: number;
  /** Exit when net SOL over the fade window falls below -fadeNetSol. */
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. 0 = off. */
  bigSellSol: number;
  /** Exit after this many slots held (unless up >= holdIfUp). */
  maxHold: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** First buy of a position (SOL). */
  initialSol: number;
  /** The one pyramid add (SOL). */
  addSol: number;
  /** Add only once price is this much above the last buy's decision price. */
  addStep: number;
  /** Add only while the position's close value is at least cost * (1 + addIfUp). */
  addIfUp: number;
  /** Add only while net SOL over the entry window is at least this. */
  addNetSol: number;
  /** Most momentum positions open at once (the rest of the cap is for probes). */
  maxMain: number;
  /** Guardrail pacing targets. */
  targetCoins: number;
  targetFills: number;
  /** Block-time seconds over which the pace ramps from 0 to 1. */
  paceSecs: number;
  /** Probe buy size (SOL). */
  probeSol: number;
  /** Most probe round trips in flight at once. */
  maxProbes: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Dip regime: lookback in slots for the recent high the pullback is measured from. */
  dipWindow: number;
  /** Enter when price is at least this far below the recent high (fraction)... */
  dipDdMin: number;
  /** ...and not further than this (a collapse, not a dip). */
  dipDdMax: number;
  /** Net SOL over the newer half of the dip window must be at least this. */
  dipNetNew: number;
  /** Trades in the dip window. */
  dipMinTrades: number;
  /** Distinct buying wallets in the dip window. */
  dipMinBuyers: number;
  /** Buys' share of traded SOL in the dip window, lower and upper bound. */
  dipMinBuyShare: number;
  dipMaxBuyShare: number;
}

export const DEFAULT_PARAMS: Params = {
  entryMode: 'dip',
  window: 30,
  minNetSol: 0.8,
  minBuys: 3,
  minBuyers: 4,
  minPriceUp: 0.04,
  maxPriceUp: 1.2,
  accel: 1,
  nearHigh: 0.93,
  maxBuyerShare: 0.8,
  minRqSol: 10,
  maxRqSol: 90,
  minAge: 500,
  stakeSol: 0.2,
  minBuySol: 0.01,
  buySlipBps: 1500,
  stopLoss: 0.1,
  takeProfit: 0,
  recoverShare: 0.3,
  trail: 0.1,
  trailArm: 0.12,
  fadeWindow: 20,
  fadeNetSol: 1000,
  bigSellSol: 0,
  maxHold: 450,
  cooldown: 300,
  maxEntries: 1,
  initialSol: 0.2,
  addSol: 0.05,
  addStep: 0.02,
  addIfUp: 0,
  addNetSol: 0.3,
  maxMain: 4,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 14400,
  probeSol: 0.01,
  maxProbes: 1,
  maxExposureSol: 3,
  dipWindow: 90,
  dipDdMin: 0.12,
  dipDdMax: 0.28,
  dipNetNew: 1.5,
  dipMinTrades: 12,
  dipMinBuyers: 6,
  dipMinBuyShare: 0.45,
  dipMaxBuyShare: 0.68,
};

const LAMPORTS = 1e9;
/** 95 bps protocol + 30 bps creator, charged on each side. */
const CURVE_FEE = 0.0125;

interface Tick {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface CurveTape {
  created: number | null;
  ticks: Tick[];
  entries: number;
  lastExit: number;
}

interface OpenPos {
  opened: number;
  peak: number;
  invested: number;
  filled: boolean;
  exiting: boolean;
  lastBuyPrice: number;
  value: number;
  /** Price and recent high when the position was opened (for recoverShare exits). */
  entryPrice: number;
  entryHigh: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, CurveTape>();
  const open = new Map<Pubkey, OpenPos>();
  /** Probe round trips in flight: false while the buy is pending, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.window, p.fadeWindow, p.dipWindow) + 5;

  const tapeOf = (mint: Pubkey): CurveTape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, ticks: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots of a tape. */
  const netFlow = (t: CurveTape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.ticks.length - 1; i >= 0; i--) {
      const tr = t.ticks[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Momentum entry signal on a tape at slot `now`, given real SOL reserves. */
  const entryOk = (t: CurveTape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    const from = now - p.window;
    const mid = now - p.window / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.ticks) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (startPrice <= 0) return false;
    const up = last / startPrice - 1;
    if (up < p.minPriceUp || up > p.maxPriceUp) return false;
    if (last < high * p.nearHigh) return false;
    if (netNew <= 0 || netNew < p.accel * netOld) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (top > p.maxBuyerShare * buySol) return false;
    return true;
  };

  /** Highest recorded price on a tape over the last `w` slots. */
  const recentHigh = (t: CurveTape, now: number, w: number): number => {
    let high = 0;
    for (let i = t.ticks.length - 1; i >= 0; i--) {
      const tr = t.ticks[i]!;
      if (tr.slot <= now - w) break;
      if (tr.price > high) high = tr.price;
    }
    return high;
  };

  /** Dip entry signal: price pulled back from its recent high, but fresh
   * buyers are stepping back in — sellers hit it, flow is returning. */
  const dipOk = (t: CurveTape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    const from = now - p.dipWindow;
    const mid = now - p.dipWindow / 2;
    let high = 0;
    let last = 0;
    let buySol = 0;
    let sellSol = 0;
    let trades = 0;
    let netOld = 0;
    let netNew = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.ticks) {
      if (tr.slot <= from) continue;
      if (tr.price > high) high = tr.price;
      last = tr.price;
      trades++;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buySol += tr.sol;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
    }
    if (trades < p.dipMinTrades || byUser.size < p.dipMinBuyers) return false;
    if (high <= 0 || last <= 0) return false;
    const dd = 1 - last / high;
    if (dd < p.dipDdMin || dd > p.dipDdMax) return false;
    if (netNew < p.dipNetNew || netNew <= netOld) return false;
    const total = buySol + sellSol;
    if (total <= 0) return false;
    const share = buySol / total;
    if (share < p.dipMinBuyShare || share > p.dipMaxBuyShare) return false;
    return true;
  };

  const entryHighNow = (t: CurveTape, now: number): number =>
    p.entryMode === 'dip' ? recentHigh(t, now, p.dipWindow) : recentHigh(t, now, p.window);

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();

      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.ticks.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
          if (!e.is_buy && p.bigSellSol > 0 && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.ticks.length && t.ticks[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.ticks.splice(0, cut);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }
      const tx = Number(state.txFeeLamports()) / LAMPORTS;
      const cap = state.hello.caps.max_orders_per_batch;
      const orders: OrderInput[] = [];

      /** Close value of a held position in SOL, curve + tx fees deducted. */
      const closeValue = (mint: Pubkey): number | null => {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined || curve === undefined) return null;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        return ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      };

      // ---- Exits first: whole-position sells. ----
      for (const [mint, h] of open) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            open.delete(mint);
            if (h.filled) tapeOf(mint).lastExit = now;
            else tapeOf(mint).entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = closeValue(mint);
        if (value === null) continue;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peak) h.peak = value;
        h.value = value;
        const t = tapeOf(mint);
        // Current price, for the recoverShare exit (dip regime).
        const curveNow = state.curves.get(mint);
        const priceNow = curveNow ? Number(curveNow.virtual_quote_reserves) / Number(curveNow.virtual_token_reserves) : 0;
        let exit = h.exiting;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && p.takeProfit > 0 && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && p.recoverShare > 0 && h.entryHigh > h.entryPrice && priceNow >= h.entryPrice + p.recoverShare * (h.entryHigh - h.entryPrice)) exit = true;
        if (!exit && h.peak >= cost * (1 + p.trailArm) && value < h.peak * (1 - p.trail)) exit = true;
        if (!exit && netFlow(t, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
      }

      // ---- Probe round trips: sell the whole probe as soon as its buy lands. ----
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
        if (!selling) probes.set(mint, true);
      }

      // ---- Entries and the single pyramid add. ----
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - open.size;
      let exposure = 0;
      for (const [mint, h] of open) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = open.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          const signal = p.entryMode === 'dip' ? dipOk(t, now, rqSol) : entryOk(t, now, rqSol);
          if (!signal) continue;
          want = Math.min(p.initialSol, p.stakeSol);
        } else {
          if (h.exiting || !h.filled || h.invested >= p.stakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastBuyPrice * (1 + p.addStep)) continue;
          if (h.value < (Number(pos.cost_lamports) / LAMPORTS) * (1 + p.addIfUp)) continue;
          if (netFlow(t, now, p.window) < p.addNetSol) continue;
          if (rqSol > p.maxRqSol) continue;
          want = Math.min(p.addSol, p.stakeSol - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
          max_slippage_bps: p.buySlipBps,
        });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          open.set(mint, {
            opened: now,
            peak: 0,
            invested: amount,
            filled: false,
            exiting: false,
            lastBuyPrice: price,
            value: 0,
            entryPrice: price,
            entryHigh: entryHighNow(t, now),
          });
          t.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.lastBuyPrice = price;
        }
      }

      // ---- Guardrail pacing: open a probe when fills or coins lag the pace. ----
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (open.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({
              side: 'buy',
              mint,
              quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)),
              max_slippage_bps: p.buySlipBps,
            });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
