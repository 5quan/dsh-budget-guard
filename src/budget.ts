/**
 * Pure, dependency-free budget arithmetic for the token / cost guard.
 *
 * The guard accumulates the tokens each completed model call billed, compares
 * the running total against a session token budget and an optional currency
 * budget, and classifies the result into `ok` / `warn` / `over`. Currency is
 * computed only from a caller-supplied price table: the harness records token
 * counts, not model prices, and provider prices change often, so baking a rate
 * table here would go stale — the user supplies the rates that match their
 * billing.
 *
 * @module dsh-budget-guard/budget
 */

/** Token buckets a completed model call reports as billed. */
export interface Usage {
  /** Uncached prompt tokens. */
  inputTokens?: number
  /** Generated tokens, including any reasoning subset. */
  outputTokens?: number
  /** Cached prompt tokens read (billed separately from uncached input). */
  cacheReadTokens?: number
  /** Cached prompt tokens written. */
  cacheWriteTokens?: number
}

/** Running per-session spend, summed across every billed call. */
export interface Spend {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** Fresh zeroed spend. */
export function emptySpend(): Spend {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

/**
 * Total billed tokens carried by a spend, across all four buckets.
 * @param spend - accumulated tokens.
 * @returns billed tokens.
 */
export function billedTokens(spend: Spend): number {
  return spend.input + spend.output + spend.cacheRead + spend.cacheWrite
}

/** USD price per one million tokens, by bucket. */
export interface ModelRate {
  input: number
  output: number
  /** Defaults to `input` when omitted. */
  cacheRead?: number
  /** Defaults to `input` when omitted. */
  cacheWrite?: number
}

/** Price table keyed by `provider/model`. Empty means cost budgeting is off. */
export type RateTable = Record<string, ModelRate>

/**
 * Cost of one spend at a model's rate.
 * @param spend - accumulated tokens.
 * @param rate - USD per million tokens for the model that produced the spend.
 * @returns the cost in USD.
 */
export function costUsd(spend: Spend, rate: ModelRate): number {
  const perMillion = (tokens: number, price: number): number => (tokens / 1_000_000) * price
  return perMillion(spend.input, rate.input)
    + perMillion(spend.cacheRead, rate.cacheRead ?? rate.input)
    + perMillion(spend.cacheWrite, rate.cacheWrite ?? rate.input)
    + perMillion(spend.output, rate.output)
}

/** Aggregated usage across every model a session used, in the two budget units. */
export interface BudgetUsage {
  /** Total billed tokens across all models. */
  tokens: number
  /** Total cost in USD, summed over the models that have a rate; 0 when no rate is known. */
  cost: number
  /** True when at least one used model had a configured rate. */
  costKnown: boolean
}

/**
 * Aggregate a per-model spend record into token and cost totals.
 * @param spends - billed spend keyed by `provider/model`.
 * @param rates - price table; a model absent from it contributes tokens but no cost.
 * @returns the token and cost totals plus whether any cost was computable.
 */
export function summarize(spends: Readonly<Record<string, Spend>>, rates: RateTable): BudgetUsage {
  let tokens = 0
  let cost = 0
  let costKnown = false
  for (const model of Object.keys(spends)) {
    // `Object.keys` of a `Record` yields only present own keys.
    const spend = spends[model] as Spend
    tokens += billedTokens(spend)
    const rate = rates[model]
    if (rate !== undefined) {
      cost += costUsd(spend, rate)
      costKnown = true
    }
  }
  return { tokens, cost, costKnown }
}

/** Budget ceilings; a dimension with no ceiling never trips. */
export interface Budget {
  /** Session cumulative billed-token cap, or undefined for no token cap. */
  tokenBudget?: number
  /** Session cumulative USD cap, or undefined for no cost cap. */
  costBudgetUsd?: number
}

/** The most severe level reached across the configured dimensions. */
export type BudgetLevel = 'ok' | 'warn' | 'over'

/** Classification of one usage against one budget. */
export interface BudgetStatus {
  /** Most severe level any dimension reached. */
  level: BudgetLevel
  /** Largest fraction of any configured ceiling reached; 0 when none set. */
  fraction: number
  /** Which dimension is worst, for the notice text; undefined when ok. */
  tripped?: 'tokens' | 'cost'
}

/**
 * Classify aggregated usage against a token and/or cost budget at a warn ratio.
 *
 * A dimension trips to `warn` when its usage reaches `warnRatio` of the ceiling
 * and to `over` at the ceiling. `warnRatio` is clamped to `(0, 1)` so the warn
 * tier always sits strictly below the cap. The cost dimension is skipped when
 * no ceiling is set or no used model had a rate (cost is unknown, not free).
 *
 * @param usage - aggregated token and cost totals.
 * @param budget - configured ceilings.
 * @param warnRatio - fraction of each ceiling that triggers `warn` (default 0.8).
 * @returns the level, worst fraction, and worst dimension.
 */
export function evaluate(
  usage: BudgetUsage,
  budget: Budget,
  warnRatio = 0.8,
): BudgetStatus {
  const ratio = warnRatio > 0 && warnRatio < 1 ? warnRatio : 0.8
  let level: BudgetLevel = 'ok'
  let fraction = 0
  let tripped: BudgetStatus['tripped']

  const consider = (dimension: 'tokens' | 'cost', used: number, cap: number | undefined): void => {
    if (cap === undefined || cap <= 0) return
    const reached = used / cap
    const reachedLevel: BudgetLevel = reached >= 1 ? 'over' : reached >= ratio ? 'warn' : 'ok'
    if (reached > fraction) { fraction = reached; tripped = dimension }
    if (reachedLevel === 'over') level = 'over'
    else if (reachedLevel === 'warn' && level !== 'over') level = 'warn'
  }

  consider('tokens', usage.tokens, budget.tokenBudget)
  if (usage.costKnown) consider('cost', usage.cost, budget.costBudgetUsd)
  return { level, fraction, ...(level === 'ok' ? {} : { tripped }) }
}
