/**
 * Session token / cost budget guard.
 *
 * DeepSeek Harness bounds a run by rounds and by context occupancy, but nothing
 * caps what a session has already *billed*. A single runaway turn — a retry
 * storm, a tool loop over large results, an over-eager sub-agent fan-out — can
 * spend more than every previous turn combined, and the loop keeps going. This
 * plugin puts a ceiling on it: it tracks each session's billed tokens (and,
 * from a user-supplied price table, its cost), tells the model to wrap up at
 * `warnRatio` of the cap, then at the cap either keeps running with a louder
 * notice or stops the run.
 *
 * The accounting is a session projection rather than plugin state
 * (`./spend.ts`), so a restarted or forked session inherits what it already
 * spent. The policy lives in `./guard.ts` and the arithmetic in `./budget.ts`,
 * neither of which imports the harness, so both are unit-testable without a
 * running composition; this module is the thin cordis wiring.
 *
 * @module dsh-budget-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zv } from 'zod'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection/types'
import type { ModelRate, Spend } from './budget.ts'
import { decide, freshEscalation } from './guard.ts'
import type { Escalation, GuardAction, GuardPolicy } from './guard.ts'
import { applySpendEvent, initialSpendState } from './spend.ts'
import type { SpendState } from './spend.ts'
import { toSpendEvent } from './events.ts'
import type { SessionEventLike } from './events.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'budget-guard': { kind: 'budget-guard' } & ContextFormed
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    budgetGuardSpend: SpendState
  }
  interface SessionProjectionMap {
    budgetGuardSpend: Record<string, Spend>
  }
}

export const name = 'budget-guard'
export const inject = ['sessionProjections']

/** The `{kind:'budget-guard'}` producer source stamped on every notice injected. */
const NOTICE_SOURCE: MessageSource = { kind: 'budget-guard' }

/** Plugin configuration. A ceiling of `0` means that dimension is uncapped. */
export interface Config {
  /** Session cumulative billed-token cap. */
  tokenBudget?: number
  /** Session cumulative cost cap in USD; needs matching {@link Config.rates} entries. */
  costBudgetUsd?: number
  /** Fraction of either cap that raises the "wrap up" notice, in `(0, 1)`. */
  warnRatio?: number
  /** At the cap: `warn` keeps running, `stop` ends the run after one converging step. */
  action?: GuardAction
  /** USD per one million tokens keyed by `provider/model`; unlisted models price at zero. */
  rates?: Record<string, ModelRate>
}

export const Config: z<Config> = z.object({
  tokenBudget: z.natural().default(0),
  costBudgetUsd: z.number().min(0).default(0),
  warnRatio: z.percent().default(0.8),
  action: z.union(['warn', 'stop']).default('stop'),
  rates: z.dict(z.object({
    input: z.number().min(0),
    output: z.number().min(0),
    cacheRead: z.number().min(0),
    cacheWrite: z.number().min(0),
  })).default({}),
})

const spendSchema = zv.object({
  input: zv.number().int().nonnegative(),
  output: zv.number().int().nonnegative(),
  cacheRead: zv.number().int().nonnegative(),
  cacheWrite: zv.number().int().nonnegative(),
}).strict()

/**
 * The durable spend unit, keyed by `provider/model` so a cost ceiling prices
 * each model's tokens at that model's rate while the token ceiling sums the
 * whole record. `stateVersion` bumps whenever the serialized shape changes, so
 * persisted checkpoints from an older unit are discarded rather than
 * forward-applied into garbage.
 */
const budgetGuardSpendProjection = {
  key: 'budgetGuardSpend',
  stateVersion: 1,
  stateSchema: zv.object({
    byModel: zv.record(zv.string(), spendSchema),
    last: zv.object({
      turn: zv.number().int().nonnegative(),
      step: zv.number().int().nonnegative(),
      model: zv.string(),
      buckets: spendSchema,
    }).nullable(),
  }).strict(),
  init: (): SpendState => initialSpendState(),
  // The fold reads a structural slice of the event (`./events.ts`), which is
  // where the one unchecked conversion in this plugin happens.
  apply: (state: SpendState, event: SessionEvent): SpendState => {
    const spendEvent = toSpendEvent(event as unknown as SessionEventLike)
    return spendEvent === undefined ? state : applySpendEvent(state, spendEvent)
  },
  wire: {
    viewSchema: zv.record(zv.string(), spendSchema),
    view: (state: SpendState): Record<string, Spend> => state.byModel,
  },
} satisfies ProjectionDefinition<'budgetGuardSpend', SpendState>

/**
 * Install the spend projection and the step-boundary budget check.
 * @param ctx - the plugin context.
 * @param config - the resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const tokenBudget = config.tokenBudget as number
  const costBudgetUsd = config.costBudgetUsd as number
  if (tokenBudget <= 0 && costBudgetUsd <= 0) {
    throw new Error('budget-guard: every ceiling is disabled — set `tokenBudget` or `costBudgetUsd` above zero')
  }
  const policy: GuardPolicy = {
    budget: { tokenBudget, costBudgetUsd },
    warnRatio: config.warnRatio as number,
    action: config.action as GuardAction,
    rates: config.rates as Record<string, ModelRate>,
  }
  ctx.sessionProjections.register(budgetGuardSpendProjection)

  const escalations = new WeakMap<Session, Escalation>()

  ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
    const { session } = agent
    const escalation = escalations.get(session) ?? freshEscalation()
    escalations.set(session, escalation)
    const spend = ctx.sessionProjections.snapshot(session, ['budgetGuardSpend']).values.budgetGuardSpend ?? {}
    const decision = decide(spend, escalation, policy)

    // A rejection vetoes the rest of the waterfall on purpose: spending the
    // next model call is exactly what the guard exists to prevent.
    if (decision.kind === 'reject') {
      ctx.logger.warn(`budget-guard: session ${session.id} blocked at a step boundary — ${decision.summary}`)
      return { kind: 'reject' }
    }
    const downstream = await next()
    if (decision.kind === 'pass' || downstream.kind === 'reject') return downstream
    ctx.logger.info(`budget-guard: session ${session.id} — ${decision.summary}`)
    const notice = createUserMessage({
      content: [{ type: 'text', text: decision.text }],
      source: { ...NOTICE_SOURCE, form: 'notice', summary: decision.summary },
    })
    return { ...downstream, messages: [notice, ...downstream.messages] }
  })
}
