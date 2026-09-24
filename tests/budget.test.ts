import { describe, expect, it } from 'vitest'
import { billedTokens, costUsd, emptySpend, evaluate, summarize } from '../src/budget.ts'
import type { RateTable, Spend } from '../src/budget.ts'

const spend = (input: number, output: number, cacheRead = 0, cacheWrite = 0): Spend => ({
  input, output, cacheRead, cacheWrite,
})

describe('billedTokens', () => {
  it('sums all four disjoint buckets', () => {
    expect(billedTokens(spend(100, 40, 600, 20))).toBe(760)
  })

  it('is zero for an empty spend', () => {
    expect(billedTokens(emptySpend())).toBe(0)
  })
})

describe('costUsd', () => {
  const rate = { input: 1, output: 2 }

  it('prices per million tokens by bucket', () => {
    expect(costUsd(spend(1_000_000, 500_000), rate)).toBeCloseTo(2)
  })

  it('prices cache traffic at the input rate when the rate omits it', () => {
    expect(costUsd(spend(0, 0, 1_000_000, 1_000_000), rate)).toBeCloseTo(2)
  })

  it('uses a distinct cache rate when configured', () => {
    const cacheRate = { input: 2, output: 8, cacheRead: 0.5 }
    expect(costUsd(spend(0, 0, 1_000_000), cacheRate)).toBeCloseTo(0.5)
  })
})

describe('summarize', () => {
  it('sums tokens across models but prices each at its own rate', () => {
    const spends = { 'a/one': spend(1_000_000, 0), 'b/two': spend(0, 1_000_000) }
    const rates: RateTable = { 'a/one': { input: 1, output: 1 }, 'b/two': { input: 5, output: 10 } }
    const usage = summarize(spends, rates)
    expect(usage.tokens).toBe(2_000_000)
    expect(usage.cost).toBeCloseTo(11)
    expect(usage.costKnown).toBe(true)
  })

  it('reports unknown cost when no used model has a rate', () => {
    const usage = summarize({ 'x/y': spend(10, 5) }, { 'other/model': { input: 1, output: 1 } })
    expect(usage.tokens).toBe(15)
    expect(usage.cost).toBe(0)
    expect(usage.costKnown).toBe(false)
  })
})

describe('evaluate', () => {
  it('passes below the warn ratio', () => {
    expect(evaluate({ tokens: 100, cost: 0, costKnown: false }, { tokenBudget: 1000 }, 0.8))
      .toEqual({ level: 'ok', fraction: 0.1 })
  })

  it('warns at the ratio and trips over at the cap', () => {
    const budget = { tokenBudget: 1000 }
    expect(evaluate({ tokens: 800, cost: 0, costKnown: false }, budget).level).toBe('warn')
    expect(evaluate({ tokens: 1000, cost: 0, costKnown: false }, budget).level).toBe('over')
  })

  it('reports the worst dimension when both are capped', () => {
    const status = evaluate(
      { tokens: 900, cost: 0.02, costKnown: true },
      { tokenBudget: 1000, costBudgetUsd: 1 },
    )
    expect(status).toEqual({ level: 'warn', fraction: 0.9, tripped: 'tokens' })
  })

  it('takes the more severe level even when the other dimension is larger', () => {
    const status = evaluate(
      { tokens: 500, cost: 2, costKnown: true },
      { tokenBudget: 1000, costBudgetUsd: 1 },
    )
    expect(status.level).toBe('over')
    expect(status.tripped).toBe('cost')
    expect(status.fraction).toBe(2)
  })

  it('skips the cost dimension when no used model is priced', () => {
    const status = evaluate({ tokens: 10, cost: 999, costKnown: false }, { costBudgetUsd: 1 })
    expect(status.level).toBe('ok')
  })

  it('skips a dimension with no ceiling and returns ok when neither is capped', () => {
    expect(evaluate({ tokens: 10, cost: 10, costKnown: true }, {})).toEqual({ level: 'ok', fraction: 0 })
  })

  it('clamps a warn ratio outside (0, 1) to the default', () => {
    expect(evaluate({ tokens: 700, cost: 0, costKnown: false }, { tokenBudget: 1000 }, 0).level).toBe('ok')
    expect(evaluate({ tokens: 700, cost: 0, costKnown: false }, { tokenBudget: 1000 }, 1.5).level).toBe('ok')
    expect(evaluate({ tokens: 850, cost: 0, costKnown: false }, { tokenBudget: 1000 }, -3).level).toBe('warn')
  })
})
