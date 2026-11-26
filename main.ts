// Breakout Rider — a paper-trading bot for the Pump.fun Bot Sprint
// (agent-fun/replay/v2), entered in make.fun's "Pump.fun Bot Sprint: Make
// Bot And Win".
//
// Ranking here is net PnL, best first, so the design goal is to catch the
// few real runners and let them pay for the many small losers. The bot
// buys only a fresh breakout: the price making a new high over its recent
// window on strong, broad, accelerating buy flow. It pyramids into
// continuation, banks half the position at +12%, and lets the rest run
// under a trailing stop, so one moonshot can carry the whole run. Losers
// are cut at -8% or on fading flow. Small probe round trips on liquid
// curves keep the run over the competition's 20-coin round-trip bar.
//
// The bot is deterministic: it reads nothing but the hello, batch and fills
// the harness sends — no clock, no environment, no randomness — so the two
// grading executions produce identical orders. Paper trading only: the
// replay moves market data, never real funds.
//
// Tuning log (dev window, grade-local --driver process):
// - v1: net PnL -1.36 SOL, 473 fills / 114 coins, win rate 10.9% (tuned
//   from -1.55 SOL by the builder: smaller sizing, tighter stops, stricter
//   entries).
// - v2: a tighter entry bar was tried (inflow 2.5 -> 3.0 SOL, accel
//   1.3 -> 1.4) and REVERTED: dev PnL worsened to -1.46 SOL with fewer
//   fills, so the builder's bar stands. Kept from v2: exits extracted to
//   shouldExit, max 2 new entries per batch, a longer cooldown after a
//   losing exit (below), and the half-bank comment fixed: it banks at
//   +12% (TAKE_PROFIT), not +15% as a stale comment claimed.
//
// Wire notes that shape the code below:
// - orders decided on the batch for slot s fill at slot s + hello.latency_slots;
// - the buys on one mint in one reply share one size cap, state.maxBuyLamports
//   (hello.caps.max_order_bps_of_real_reserve of the mint's real SOL reserve);
// - at most hello.caps.max_open_positions positions (held plus buys in flight)
//   and hello.caps.max_orders_per_batch orders per reply;
// - every order pays hello.fees' base + priority fee whether it fills or not,
//   so order spam is a real cost and the bot budgets for it.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const SOL = 1e9;
const CURVE_FEE = 0.0125; // 95 bps protocol + 30 bps creator, the fallback pair in hello.fees

// ---- entry signal -----------------------------------------------------------
// A breakout, not a grind: the price must be printing a NEW high over the
// window while broad buy flow accelerates underneath it. Fresh launches
// are excluded — most of them are launched to be dumped.
const FLOW_WINDOW = 40; // slots of tape the entry signal reads (~16 s)
const MIN_AGE_SLOTS = 200; // a curve must be at least this old before a first buy
const MIN_RESERVE_SOL = 1.5; // real SOL reserve band at entry: below is dust,
const MAX_RESERVE_SOL = 80; // above is nearly complete (migration dumps follow)
const MIN_NET_INFLOW = 2.5; // net SOL (buys - sells) over the flow window
const MIN_BUY_TRADES = 6; // buy trades in the window
const MIN_DISTINCT_BUYERS = 6; // distinct buying wallets in the window
const MAX_SELL_SHARE = 0.3; // sells may be at most this share of window volume
const MIN_PRICE_UP = 0.08; // price vs window start: at least +8% ...
const MAX_PRICE_UP = 0.8; // ... but no more than +80% (do not chase a vertical)
const MAX_TOP_BUYER = 0.45; // one wallet may be at most 45% of the window's buy SOL
const MIN_ACCEL = 1.3; // newer half's net inflow must beat the older half's by this

// ---- sizing -----------------------------------------------------------------
// Bigger than a scalper's: the edge is a few runners, so a position that
// confirms itself earns real size through pyramiding.
const FIRST_BUY_SOL = 0.1; // starter order; the position earns its size
const ADD_BUY_SOL = 0.08; // each add, while strength confirms
const MAX_STAKE_SOL = 0.3; // most SOL of cost in one coin
const MAX_EXPOSURE_SOL = 2.0; // most SOL of cost across all positions at once
const MIN_BUY_SOL = 0.02; // smallest main buy worth its fees
const ADD_STEP = 0.06; // an add needs the price 6% above the last buy's price
const ADD_MIN_FLOW = 0.8; // ... and still-positive net inflow over the window
const BUY_SLIPPAGE_BPS = 2500; // momentum moves inside the latency; leave room
const SELL_SLIPPAGE_BPS = 10_000; // exits are market: getting out is the point

// ---- exits ------------------------------------------------------------------
// Two-stage: bank HALF at +12% (the win is locked in), then let the rest
// run under a trailing stop armed at +12% with a 10% give-back. A full
// stop at -6% and a fade exit keep losers small; a hard time limit stops
// dead money from sitting around.
const TAKE_PROFIT = 0.12; // at this gain, sell half and let the rest run
const STOP_LOSS = 0.06; // sell all when close value falls to cost * (1 - this)
const TRAIL_ARM = 0.12; // trailing stop arms once value reached cost * 1.12
const TRAIL_DROP = 0.1; // ... and fires when value falls to peak * (1 - this)
const FADE_WINDOW = 20; // slots of tape the fade exit reads
const FADE_NET = -0.8; // sell when net flow over the fade window is under this
const BIG_SELL_SOL = 3; // one recorded sell this big in a batch: leave
const MAX_HOLD_SLOTS = 1200; // hard time limit per position (~8 minutes)
const HOLD_IF_UP = 0.25; // the time limit is waived while up at least this much
const COOLDOWN_SLOTS = 200; // wait after an exit before re-entering a curve
const LOSS_COOLDOWN_SLOTS = 400; // ... and twice as long after a losing exit:
// a curve that just stopped us out is usually still distributing, so the
// bot sits out the next leg down instead of buying the same dip twice
const MAX_ENTRIES = 3; // most entries per curve over the whole run
const MAX_NEW_ENTRIES_PER_BATCH = 2; // at most this many fresh positions per batch:
// a burst of simultaneous entries is usually one crowded tape, and every
// extra order pays base + priority fee whether it fills or not

// ---- guardrail probes --------------------------------------------------------
// The bar: a round trip of at least 0.01 SOL on each of at least 20 coins.
// Probes are tiny round trips on liquid curves that exist only to clear it.
const PROBE_BUY_SOL = 0.012; // just over the 0.01 SOL round-trip minimum
const PROBE_TARGET_COINS = 22; // aim a little past the bar
const PROBE_EVERY_SLOTS = 500; // at most one new probe per this many slots
const PROBE_MIN_RESERVE = 5; // probe only curves with at least this much real SOL
const PROBE_MAX_OPEN = 3; // probes only while at most this many positions are open

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number; // virtual quote / virtual token, post-trade
}

interface Tape {
  created: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExit: number;
  lastLossExit: number; // slot of the latest exit that closed below cost
}

interface Held {
  opened: number;
  invested: number; // SOL sent in buys for this position (fees included)
  peakValue: number; // best close value seen (SOL)
  lastBuyPrice: number; // recorded price when the latest buy was decided
  exiting: boolean;
  filled: boolean; // some buy of this position has filled
  halfBanked: boolean; // the +12% half-sale already happened
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
const probes = new Map<Pubkey, boolean>(); // mint -> sell already sent
const probedMints = new Set<Pubkey>();
const roundTripCoins = new Set<Pubkey>(); // mints with a filled buy of >= 0.01 SOL
let lastProbeSlot = -1e12;

const tapeOf = (mint: Pubkey): Tape => {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, trades: [], entries: 0, lastExit: -1e12, lastLossExit: -1e12 };
    tapes.set(mint, t);
  }
  return t;
};

/** Price of a curve right now (SOL per token, virtual reserves). */
const priceOf = (state: BotState, mint: Pubkey): number => {
  const c = state.curves.get(mint);
  if (c === undefined || c.virtual_token_reserves === 0n) return 0;
  return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
};

/** What a position would fetch if sold whole now: AMM out, curve fee and one tx fee off. */
const closeValue = (state: BotState, mint: Pubkey, tokens: bigint): number => {
  const c = state.curves.get(mint);
  if (c === undefined) return 0;
  const vq = Number(c.virtual_quote_reserves);
  const vt = Number(c.virtual_token_reserves);
  const t = Number(tokens);
  if (vt + t <= 0) return 0;
  return ((t * vq) / (vt + t) / SOL) * (1 - CURVE_FEE) - Number(state.txFeeLamports()) / SOL;
};

/** Net SOL flow (buys minus sells) on a tape over the last `w` slots. */
const netFlow = (t: Tape, now: number, w: number): number => {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
};

/** Share of the window's buy SOL that came from its single biggest wallet:
 * a high share means one wallet (often the deployer or a bundler) is the
 * flow, not a crowd — and crowd flow is what the entry signal trusts. */
const largestBuyerShare = (buyers: Map<string, number>, buySol: number): number => {
  if (buySol <= 0) return 0;
  let top = 0;
  for (const v of buyers.values()) if (v > top) top = v;
  return top / buySol;
};

/**
 * The entry signal: a fresh breakout — the latest price is the window high
 * (a new high, not just near it) on broad, accelerating buy flow.
 */
const entryOk = (t: Tape, now: number, reserveSol: number): boolean => {
  if (reserveSol < MIN_RESERVE_SOL || reserveSol > MAX_RESERVE_SOL) return false;
  if (t.created === null || now - t.created < MIN_AGE_SLOTS) return false;
  const from = now - FLOW_WINDOW;
  const mid = now - FLOW_WINDOW / 2;
  let buySol = 0;
  let sellSol = 0;
  let buyTrades = 0;
  let netOld = 0; // net inflow over the older half of the window
  let netNew = 0; // net inflow over the newer half
  let startPrice = -1;
  let high = 0;
  let last = 0;
  const buyers = new Map<string, number>();
  for (const tr of t.trades) {
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
      buyTrades++;
      buyers.set(tr.user, (buyers.get(tr.user) ?? 0) + tr.sol);
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
    last = tr.price;
  }
  if (buyTrades < MIN_BUY_TRADES || buyers.size < MIN_DISTINCT_BUYERS) return false;
  if (buySol - sellSol < MIN_NET_INFLOW) return false;
  // The flow must still be building, not exhausting: a breakout whose second
  // half is quieter than its first is a top, not a launchpad.
  if (netNew < 1.5 || netNew < MIN_ACCEL * Math.max(netOld, 0)) return false;
  if (buySol + sellSol <= 0 || sellSol / (buySol + sellSol) > MAX_SELL_SHARE) return false;
  if (startPrice <= 0 || last <= 0 || high <= 0) return false;
  const up = last / startPrice - 1;
  if (up < MIN_PRICE_UP || up > MAX_PRICE_UP) return false;
  // Fresh breakout: the last price IS the window high.
  if (last < high) return false;
  if (largestBuyerShare(buyers, buySol) > MAX_TOP_BUYER) return false;
  return true;
};

/** Every full-exit reason in one place: stop, trailing stop, fading flow,
 * a single huge sell, or the hard time limit. (The +12% half-bank lives in
 * the loop, not here: it sells half and keeps the position.) Returns true
 * when the position should be sold whole this batch. */
const shouldExit = (
  state: BotState,
  mint: Pubkey,
  h: Held,
  now: number,
  bigSell: boolean,
): boolean => {
  const pos = state.positions.get(mint);
  if (pos === undefined) return false;
  const value = closeValue(state, mint, pos.token_amount);
  const cost = Number(pos.cost_lamports) / SOL;
  if (value > h.peakValue) h.peakValue = value;
  if (value <= cost * (1 - STOP_LOSS)) return true; // cut at -6%
  if (h.peakValue >= cost * (1 + TRAIL_ARM) && value <= h.peakValue * (1 - TRAIL_DROP)) return true;
  if (netFlow(tapeOf(mint), now, FADE_WINDOW) < FADE_NET) return true;
  if (bigSell) return true;
  if (now - h.opened > MAX_HOLD_SLOTS && value < cost * (1 + HOLD_IF_UP)) return true;
  return false;
};

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const caps = state.hello.caps;
    const txSol = Number(state.txFeeLamports()) / SOL;
    const orders: OrderInput[] = [];

    // Bookkeeping from fills: which coins have a real buy in (the round-trip bar
    // counts a mint once a buy of at least 0.01 SOL has filled on it).
    for (const f of batch.fills) {
      if (f.status === 'filled' && f.side === 'buy' && !f.client_id.startsWith('_')) {
        if (Number(f.quote_lamports) / SOL >= 0.01) roundTripCoins.add(f.mint);
        const h = held.get(f.mint);
        if (h !== undefined) h.filled = true;
      }
    }

    // Fold this batch's events into the tapes; remember the mints that traded
    // (in event order) and any single huge sell.
    const traded = new Set<Pubkey>();
    const bigSells = new Set<Pubkey>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        tapeOf(e.mint).created = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol: Number(e.sol_amount) / SOL,
          user: e.user,
          price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
        });
        traded.add(e.mint);
        if (!e.is_buy && Number(e.sol_amount) / SOL >= BIG_SELL_SOL) bigSells.add(e.mint);
      }
    }
    // Prune tape history older than every window reads.
    const keepFrom = now - Math.max(FLOW_WINDOW, FADE_WINDOW) - 10;
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= keepFrom) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }

    const pendingMints = new Set<Pubkey>();
    for (const p of state.pending.values()) pendingMints.add(p.order.mint);

    let free = Number(state.freeCashLamports()) / SOL;
    let openSlots = caps.max_open_positions - state.committedPositionCount();

    // ---- exits first: protecting capital outranks every entry ---------------
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      if (pos === undefined) {
        // Gone: sold, completed or written off. Clean up once nothing is in flight.
        if (!pendingMints.has(mint)) {
          held.delete(mint);
          if (h.filled) tapeOf(mint).lastExit = now;
          else tapeOf(mint).entries = Math.max(0, tapeOf(mint).entries - 1);
        }
        continue;
      }
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue; // the harness closes it
      if (pendingMints.has(mint)) continue; // an order is in flight; decide next batch
      const value = closeValue(state, mint, pos.token_amount);
      const cost = Number(pos.cost_lamports) / SOL;
      if (value > h.peakValue) h.peakValue = value;
      // Half-bank at +12%: sell half the tokens, keep the rest running.
      if (!h.halfBanked && !h.exiting && value >= cost * (1 + TAKE_PROFIT)) {
        h.halfBanked = true;
        if (orders.length >= caps.max_orders_per_batch) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount / 2n, max_slippage_bps: SELL_SLIPPAGE_BPS });
        continue;
      }
      if (!h.exiting && shouldExit(state, mint, h, now, bigSells.has(mint))) h.exiting = true;
      if (!h.exiting) continue;
      // A losing exit earns a longer cooldown: note it on the tape now, while
      // the position's cost is still readable (the position is gone next batch).
      if (closeValue(state, mint, pos.token_amount) < cost) {
        tapeOf(mint).lastLossExit = now;
      }
      if (orders.length >= caps.max_orders_per_batch) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
    }

    // ---- probes: sell a probe position the moment its buy has landed --------
    for (const [mint, sellSent] of probes) {
      const pos = state.positions.get(mint);
      if (pos === undefined) {
        if (!pendingMints.has(mint)) probes.delete(mint);
        continue;
      }
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete || pendingMints.has(mint) || sellSent) continue;
      if (orders.length >= caps.max_orders_per_batch) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
      probes.set(mint, true);
    }

    // ---- entries and adds, only on mints that traded this batch -------------
    let exposure = 0;
    for (const [, h] of held) exposure += h.invested;
    let newEntries = 0;
    for (const mint of traded) {
      if (orders.length >= caps.max_orders_per_batch) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingMints.has(mint) || probes.has(mint)) continue;
      const reserveSol = Number(curve.real_quote_reserves) / SOL;
      const price = priceOf(state, mint);
      const t = tapeOf(mint);
      const h = held.get(mint);
      let want: number;
      let isEntry = false;
      if (h === undefined) {
        if (openSlots <= 0) continue;
        if (newEntries >= MAX_NEW_ENTRIES_PER_BATCH) continue;
        if (t.entries >= MAX_ENTRIES || now - t.lastExit < COOLDOWN_SLOTS) continue;
        if (now - t.lastLossExit < LOSS_COOLDOWN_SLOTS) continue; // just stopped out: sit out
        if (!entryOk(t, now, reserveSol)) continue;
        want = FIRST_BUY_SOL;
        isEntry = true;
      } else {
        // Add only into strength: price stepped up, flow still in, stake not full.
        if (h.exiting || !h.filled || h.invested >= MAX_STAKE_SOL - MIN_BUY_SOL) continue;
        if (price < h.lastBuyPrice * (1 + ADD_STEP)) continue;
        if (netFlow(t, now, FLOW_WINDOW) < ADD_MIN_FLOW) continue;
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        if (closeValue(state, mint, pos.token_amount) < (Number(pos.cost_lamports) / SOL) * 1.02) continue;
        want = Math.min(ADD_BUY_SOL, MAX_STAKE_SOL - h.invested);
      }
      const capSol = Number(state.maxBuyLamports(mint)) / SOL;
      let amount = Math.min(capSol, want, MAX_EXPOSURE_SOL - exposure);
      if (amount > free - txSol) amount = free - txSol;
      if (amount < MIN_BUY_SOL) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: BigInt(Math.floor(amount * SOL)),
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      free -= amount + txSol;
      exposure += amount;
      if (isEntry) {
        held.set(mint, { opened: now, invested: amount, peakValue: 0, lastBuyPrice: price, exiting: false, filled: false, halfBanked: false });
        t.entries++;
        openSlots--;
        newEntries++;
      } else if (h !== undefined) {
        h.invested += amount;
        h.lastBuyPrice = price;
      }
    }

    // ---- open a probe if the round-trip bar is still ahead of us ------------
    if (
      roundTripCoins.size < PROBE_TARGET_COINS &&
      now - lastProbeSlot >= PROBE_EVERY_SLOTS &&
      probes.size === 0 &&
      state.committedPositionCount() <= PROBE_MAX_OPEN &&
      openSlots > 0 &&
      orders.length < caps.max_orders_per_batch
    ) {
      for (const mint of traded) {
        if (held.has(mint) || probedMints.has(mint) || pendingMints.has(mint) || state.positions.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (Number(curve.real_quote_reserves) / SOL < PROBE_MIN_RESERVE) continue;
        const capSol = Number(state.maxBuyLamports(mint)) / SOL;
        if (capSol < PROBE_BUY_SOL) continue;
        if (free < PROBE_BUY_SOL + 2 * txSol) break;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: BigInt(Math.floor(PROBE_BUY_SOL * SOL)),
          max_slippage_bps: BUY_SLIPPAGE_BPS,
        });
        probes.set(mint, false);
        probedMints.add(mint);
        lastProbeSlot = now;
        free -= PROBE_BUY_SOL + txSol;
        break;
      }
    }

    return orders;
  },
});
