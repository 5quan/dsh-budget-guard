import { describe, expect, it } from 'vitest'
import { decide, freshEscalation } from '../src/guard.ts'
import type { GuardPolicy } from '../src/guard.ts'
import type { Spend } from '../src/budget.ts'

const spend = (input: number, output = 0): Spend => ({ input, output, cacheRead: 0, cacheWrite: 0 })

const tokenPolicy = (tokenBudget: number, action: GuardPolicy['action'] = 'stop'): GuardPolicy => ({
  budget: { tokenBudget, costBudgetUsd: 0 },
  warnRatio: 0.8,
  action,
  rates: {},
})

describe('decide', () => {
  it('passes while the session is below the warn ratio', () => {
    expect(decide({ 'a/one': spend(100) }, freshEscalation(), tokenPolicy(1000))).toEqual({ kind: 'pass' })
  })

  it('warns once as the session approaches the cap', () => {
    const escalation = freshEscalation()
    const first = decide({ 'a/one': spend(800) }, escalation, tokenPolicy(1000))
    expect(first.kind).toBe('notice')
    expect((first as { text: string }).text).toContain('800 tokens')
    expect((first as { text: string }).text).toContain('approaching')
    expect(decide({ 'a/one': spend(850) }, escalation, tokenPolicy(1000))).toEqual({ kind: 'pass' })
  })

  it('arms a stop on the first over-cap step and rejects on the next', () => {
    const escalation = freshEscalation()
    const policy = tokenPolicy(1000)
    const armed = decide({ 'a/one': spend(1000) }, escalation, policy)
    expect(armed.kind).toBe('notice')
    expect((armed as { text: string }).text).toContain('stops after this step')
    expect(decide({ 'a/one': spend(1200) }, escalation, policy)).toEqual({
      kind: 'reject',
      summary: 'blocked: 1200 tokens exceeds the session budget',
    })
    expect(decide({ 'a/one': spend(1500) }, escalation, policy).kind).toBe('reject')
  })

  it('keeps running under the warn action once past the cap', () => {
    const escalation = freshEscalation()
    const policy = tokenPolicy(1000, 'warn')
    expect(decide({ 'a/one': spend(1100) }, escalation, policy).kind).toBe('notice')
    expect(decide({ 'a/one': spend(9000) }, escalation, policy)).toEqual({ kind: 'pass' })
  })

  it('escalates a session that skipped the warn tier', () => {
    const escalation = freshEscalation()
    expect(decide({ 'a/one': spend(999) }, escalation, tokenPolicy(1000)).kind).toBe('notice')
    expect(decide({ 'a/one': spend(1000) }, escalation, tokenPolicy(1000)).kind).toBe('notice')
  })

  it('sums tokens across models for the token ceiling', () => {
    const escalation = freshEscalation()
    expect(decide({ 'a/one': spend(500), 'b/two': spend(400) }, escalation, tokenPolicy(1000)).kind).toBe('notice')
  })

  it('ignores the cost ceiling while no used model is priced', () => {
    const escalation = freshEscalation()
    const policy: GuardPolicy = {
      budget: { tokenBudget: 0, costBudgetUsd: 0.01 },
      warnRatio: 0.8,
      action: 'stop',
      rates: { 'other/model': { input: 10, output: 10 } },
    }
    expect(decide({ 'a/one': spend(10_000_000) }, escalation, policy)).toEqual({ kind: 'pass' })
  })

  it('trips the cost ceiling at the configured rate and names it in the notice', () => {
    const escalation = freshEscalation()
    const policy: GuardPolicy = {
      budget: { tokenBudget: 0, costBudgetUsd: 1 },
      warnRatio: 0.8,
      action: 'stop',
      rates: { 'a/one': { input: 1, output: 2 } },
    }
    const decision = decide({ 'a/one': spend(600_000, 200_000) }, escalation, policy)
    expect(decision.kind).toBe('notice')
    expect((decision as { text: string }).text).toContain('cost budget')
    expect((decision as { text: string }).text).toContain('USD')
  })
})
