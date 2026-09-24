/**
 * Budget policy: what the guard does at a step boundary given a session's
 * durable spend.
 *
 * The spend itself is not this module's business (see `./spend.ts` — it is a
 * session projection, so it survives restarts and forks). What is local is the
 * escalation memory: which level has already been announced, and whether a stop
 * has been armed. That state resets with the process on purpose — re-announcing
 * after a restart is a courtesy, while re-counting spend would be a hole.
 *
 * @module dsh-budget-guard/guard
 */

import type { Budget, BudgetLevel, RateTable, Spend } from './budget.ts'
import { evaluate, summarize } from './budget.ts'

/** How the guard reacts when a session reaches its cap. */
export type GuardAction = 'warn' | 'stop'

/** Static configuration the decision engine needs. */
export interface GuardPolicy {
  /** Token and/or cost ceilings; a dimension with no ceiling never trips. */
  budget: Budget
  /** Fraction of each ceiling that raises the heads-up notice. */
  warnRatio: number
  /** At the cap, only notify (`warn`) or also stop the agent (`stop`). */
  action: GuardAction
  /** Price table for the cost ceiling, keyed by `provider/model`. */
  rates: RateTable
}

/** In-process escalation memory for one session. */
export interface Escalation {
  /** Highest level already announced, so a notice fires once per crossing. */
  announced: BudgetLevel
  /** For `stop`: the cap notice was injected; the next step rejects. */
  stopArmed: boolean
}

/** Fresh escalation memory. */
export function freshEscalation(): Escalation {
  return { announced: 'ok', stopArmed: false }
}

/** One decision the plugin entry carries out against the running agent. */
export type GuardDecision =
  /** Do nothing; forward the step unchanged. */
  | { kind: 'pass' }
  /** Inject a model-visible + user-visible notice, then keep going. */
  | { kind: 'notice'; text: string; summary: string }
  /** Reject the step: the turn ends and no further model call is spent. */
  | { kind: 'reject'; summary: string }

function metricOf(tripped: 'tokens' | 'cost' | undefined, tokens: number, cost: number): string {
  return tripped === 'cost' ? `${cost.toFixed(4)} USD` : `${tokens} tokens`
}

/**
 * Decide what the guard does at the next step boundary for one session.
 *
 * The policy escalates once per crossing:
 * - Below `warnRatio`: pass.
 * - First reaching `warn`: emit the heads-up notice once.
 * - Reaching the cap with `action: 'warn'`: emit an over-cap notice once.
 * - Reaching the cap with `action: 'stop'`: emit a final "wrapping up" notice
 *   once and arm; the following call rejects, so the model gets one step to
 *   converge and the user sees a summary rather than a silence.
 *
 * @param spends - the session's durable per-model spend.
 * @param escalation - the session's mutable escalation memory.
 * @param policy - ceilings, warn ratio, action, and price table.
 * @returns the decision to carry out.
 */
export function decide(
  spends: Readonly<Record<string, Spend>>,
  escalation: Escalation,
  policy: GuardPolicy,
): GuardDecision {
  const usage = summarize(spends, policy.rates)
  const status = evaluate(usage, policy.budget, policy.warnRatio)
  if (status.level === 'ok') return { kind: 'pass' }

  const pct = Math.round(status.fraction * 100)
  const metric = metricOf(status.tripped, usage.tokens, usage.cost)

  if (status.level === 'over') {
    if (policy.action === 'warn') {
      if (escalation.announced === 'over') return { kind: 'pass' }
      escalation.announced = 'over'
      return {
        kind: 'notice',
        summary: `over budget: ${metric} (${pct}%)`,
        text: `[budget-guard] This session exceeded its ${status.tripped} budget (${metric}, ${pct}% of the`
          + ' cap). Continuing to run; raise the configured limit or start a fresh session to reset the counter.',
      }
    }
    if (!escalation.stopArmed) {
      escalation.stopArmed = true
      escalation.announced = 'over'
      return {
        kind: 'notice',
        summary: `budget reached: ${metric} (${pct}%), stopping`,
        text: `[budget-guard] This session reached its ${status.tripped} budget (${metric}, ${pct}% of the`
          + ' cap). The agent stops after this step, so summarize or hand off anything essential now.',
      }
    }
    return { kind: 'reject', summary: `blocked: ${metric} exceeds the session budget` }
  }

  if (escalation.announced === 'ok') {
    escalation.announced = 'warn'
    return {
      kind: 'notice',
      summary: `approaching budget: ${metric} (${pct}%)`,
      text: `[budget-guard] This session is approaching its ${status.tripped} budget (${metric}, ${pct}% of`
        + ' the cap). Wrap up soon or the guard will stop the run.',
    }
  }
  return { kind: 'pass' }
}
