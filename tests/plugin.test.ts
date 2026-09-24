import { describe, expect, it } from 'vitest'
import { apply, Config, inject, name } from '../src/index.ts'
import type { SpendState } from '../src/spend.ts'
import { initialSpendState } from '../src/spend.ts'

/** One captured `agent/pre-step` listener plus the projection unit it registered. */
interface Harness {
  preStep: (event: { agent: { session: { id: string } } }, next: () => Promise<Decision>) => Promise<Decision>
  projection: {
    key: string
    stateVersion: number
    init: (header: unknown, inheritedEventCount: number) => SpendState
    apply: (state: SpendState, event: unknown) => SpendState
    stateSchema: { parse(value: unknown): SpendState }
    wire: { view(state: SpendState): unknown; viewSchema: { parse(value: unknown): unknown } }
  }
  warnings: string[]
  infos: string[]
}

type Enter = { kind: 'enter'; messages: unknown[] }
type Decision = Enter | { kind: 'reject' }

/** Install the plugin against a stand-in context that records what it wires up. */
function install(config: Record<string, unknown>, spend: Record<string, unknown>): Harness {
  const logs: { level: string; message: string }[] = []
  let captured: Harness['preStep'] | undefined
  let projection: Harness['projection'] | undefined
  const ctx = {
    logger: {
      warn: (message: string) => logs.push({ level: 'warn', message }),
      info: (message: string) => logs.push({ level: 'info', message }),
    },
    on: (event: string, listener: Harness['preStep']) => {
      if (event === 'agent/pre-step') captured = listener
    },
    sessionProjections: {
      register: (def: Harness['projection']) => {
        projection = def
      },
      snapshot: () => ({ asOfSeq: -1, values: { budgetGuardSpend: spend } }),
    },
  }
  apply(ctx as never, Config(config) as never)
  const messagesAt = (level: string): string[] =>
    logs.filter(entry => entry.level === level).map(entry => entry.message)
  return {
    preStep: captured!,
    projection: projection!,
    get warnings() {
      return messagesAt('warn')
    },
    get infos() {
      return messagesAt('info')
    },
  }
}

const enter = (): Promise<Enter> => Promise.resolve({ kind: 'enter', messages: [] })
const session = { id: 's1' }
const spent = (input: number): Record<string, unknown> => ({ 'deepseek/deepseek-chat': { input, output: 0, cacheRead: 0, cacheWrite: 0 } })

describe('plugin contract', () => {
  it('exports the named function-plugin shape Cordis loads', () => {
    expect(name).toBe('budget-guard')
    expect(inject).toEqual(['sessionProjections'])
    expect(typeof apply).toBe('function')
  })

  it('fills defaults through the schema rather than in code', () => {
    expect(Config({})).toEqual({
      tokenBudget: 0,
      costBudgetUsd: 0,
      warnRatio: 0.8,
      action: 'stop',
      rates: {},
    })
  })

  it('refuses to install when every ceiling is disabled', () => {
    expect(() => apply({} as never, Config({}) as never)).toThrow(/every ceiling is disabled/)
  })

  it('rejects an action outside the declared union', () => {
    expect(() => Config({ tokenBudget: 100, action: 'pause' } as never)).toThrow()
  })
})

describe('agent/pre-step wiring', () => {
  it('passes a step through while under the cap', async () => {
    const harness = install({ tokenBudget: 1000 }, spent(100))
    const decision = await harness.preStep({ agent: { session } }, enter)
    expect(decision).toEqual({ kind: 'enter', messages: [] })
    expect(harness.warnings).toEqual([])
    expect(harness.infos).toEqual([])
  })

  it('injects a wrap-up notice at the warn ratio, keeping downstream messages', async () => {
    const harness = install({ tokenBudget: 1000, warnRatio: 0.8 }, spent(800))
    const downstream: Enter = { kind: 'enter', messages: [{ marker: 'from-downstream' } as never] }
    const decision = await harness.preStep(
      { agent: { session } },
      () => Promise.resolve(downstream),
    )
    expect(decision.kind).toBe('enter')
    const messages = (decision as Enter).messages as { source?: { kind?: string; form?: string } }[]
    expect(messages).toHaveLength(2)
    expect(messages[0]!.source).toMatchObject({ kind: 'budget-guard', form: 'notice' })
    expect(messages[1]).toBe(downstream.messages[0])
    expect(harness.infos.join()).toContain('budget-guard: session s1')
  })

  it('announces the stop first, then vetoes the waterfall without calling next', async () => {
    const harness = install({ tokenBudget: 1000, warnRatio: 0.8, action: 'stop' }, spent(1500))
    let nextCalls = 0
    const next = (): Promise<Enter> => {
      nextCalls += 1
      return Promise.resolve({ kind: 'enter', messages: [] })
    }
    const armed = await harness.preStep({ agent: { session } }, next)
    expect(armed.kind).toBe('enter')
    expect(nextCalls).toBe(1)
    const blocked = await harness.preStep({ agent: { session } }, next)
    expect(blocked).toEqual({ kind: 'reject' })
    expect(nextCalls).toBe(1)
    expect(harness.warnings.join()).toContain('blocked at a step boundary')
  })

  it('leaves an over-cap run going when the action is warn', async () => {
    const harness = install({ tokenBudget: 1000, action: 'warn' }, spent(9999))
    const first = await harness.preStep({ agent: { session } }, enter)
    const second = await harness.preStep({ agent: { session } }, enter)
    expect(first.kind).toBe('enter')
    expect(second).toEqual({ kind: 'enter', messages: [] })
  })

  it('keeps a downstream rejection instead of decorating it', async () => {
    const harness = install({ tokenBudget: 1000, warnRatio: 0.8 }, spent(800))
    const decision = await harness.preStep({ agent: { session } }, () => Promise.resolve({ kind: 'reject' }))
    expect(decision).toEqual({ kind: 'reject' })
  })
})

describe('registered projection unit', () => {
  it('folds a real assistant/message event into per-model spend', () => {
    const harness = install({ tokenBudget: 1000 }, {})
    const state = harness.projection.apply(harness.projection.init({}, 0), {
      type: 'assistant/message',
      data: {
        turn: 0,
        step: 0,
        usage: { inputTokens: 120, outputTokens: 30 },
        message: { source: { provider: 'deepseek', model: 'deepseek-chat' } },
      },
    })
    expect(state.byModel['deepseek/deepseek-chat']).toEqual({
      input: 120,
      output: 30,
      cacheRead: 0,
      cacheWrite: 0,
    })
    expect(harness.projection.wire.view(state)).toBe(state.byModel)
  })

  it('round-trips its state and view through the declared schemas', () => {
    const harness = install({ tokenBudget: 1000 }, {})
    const initial = harness.projection.init({}, 0)
    expect(() => harness.projection.stateSchema.parse(initial)).not.toThrow()
    expect(() => harness.projection.wire.viewSchema.parse(harness.projection.wire.view(initial))).not.toThrow()
    expect(harness.projection.key).toBe('budgetGuardSpend')
    expect(harness.projection.stateVersion).toBe(1)
  })

  it('starts every session from an empty spend state', () => {
    const harness = install({ tokenBudget: 1000 }, {})
    expect(harness.projection.init({}, 0)).toEqual(initialSpendState())
  })
})
