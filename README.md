# dsh-budget-guard

English | [中文](README.zh.md)

**Cap what one DeepSeek Harness session can spend — before the invoice does.**

[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-blue)](https://github.com/topics/dsh-plugin) [![license: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

`dsh-budget-guard` is a drop-in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin that watches each session's cumulative billed tokens — and, from a price table you supply, its cost — and warns or circuit-breaks when a budget is crossed.

## The problem

`dsh` bounds a run by **rounds** and by **context occupancy**. Nothing bounds it by **spend**.

Those are different quantities, and the gap is where surprises live. A step's cost is not flat: prompt tokens ride the whole history, a mid-session tool or system-prompt change turns a cache read into a cache write, a retry storm re-bills entire attempts, and one tool loop can add thirty steps to a single turn. So the cumulative cost curve is spiky rather than linear — one turn can spend more than the previous hour — and the loop keeps going, because its only stopping conditions are "the model stopped asking" and "the round limit was hit".

That is the failure this guard closes: not a slow leak, but the point where an agent goes away and comes back with a ten-figure token bill.

## What this plugin does

At every step boundary it reads the session's spend and takes the mildest applicable action:

| Spend | `action: stop` (default) | `action: warn` |
| --- | --- | --- |
| below `warnRatio` | continue | continue |
| ≥ `warnRatio` of a cap | one "wrap up" notice to the model | one "wrap up" notice |
| ≥ the cap | one "the agent stops after this step" notice, then the **next** step boundary is rejected | one louder over-cap notice, then keep running |

- **The model sees the notice**, as a labeled `form: 'notice'` context message — so it can finish the job inside the budget rather than being cut off mid-sentence.
- **The operator sees it too**, in the transcript and in the log (`INFO` on a notice, `WARN` on a rejection).
- **One notice per crossing**, never every step.

### Why the counter is a session projection

A budget guard that resets when you restart the process is not a budget guard — `dsh` sessions are long-lived and are resumed and forked constantly.

So the running spend is not plugin state. It is a registered **session projection** (`budgetGuardSpend`), the harness's own mechanism for deriving durable per-session values from the event log: it replays on restore, so a resumed session continues from what it already spent, and a fork inherits its prefix's total. Per-model buckets are what let a currency ceiling be honest — each model's tokens are priced at that model's rate, while the token ceiling sums them.

## Install

From a published package:

```sh
dsh plugin add dsh-budget-guard
```

From this repository:

```sh
dsh plugin --profile <name> add github:5quan/dsh-budget-guard
```

Or load it for a single run without installing, against a source checkout of the harness:

```sh
pnpm dsh web --patch ../dsh-budget-guard/cordis.patch.yml
```

## Configuration

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `tokenBudget` | integer | `0` | Session cumulative billed-token cap. `0` leaves tokens uncapped. |
| `costBudgetUsd` | number | `0` | Session cumulative cost cap in USD. Needs a `rates` entry for every model you want priced. |
| `warnRatio` | number `0–1` | `0.8` | Fraction of either cap that raises the "wrap up" notice. |
| `action` | `stop` \| `warn` | `stop` | At the cap: end the run after one converging step, or only notify. |
| `rates` | map | `{}` | USD per one million tokens, keyed by `provider/model`. |

At least one of `tokenBudget` and `costBudgetUsd` must be above zero; a configuration that caps nothing fails loudly at load instead of silently doing nothing.

```yaml
- id: budget-guard
  name: dsh-budget-guard
  config:
    tokenBudget: 2000000
    warnRatio: 0.75
    action: stop
    rates:
      deepseek/deepseek-chat:
        input: 0.27
        output: 1.1
        cacheRead: 0.07
        cacheWrite: 0.27
```

**No prices are baked in, on purpose.** Provider price sheets change monthly and any table shipped here would go stale silently. `tokenBudget` needs no configuration to work; `costBudgetUsd` activates only for models you list.

## How it stays safe

- **No core changes.** Two documented extension points: one registered projection and one `agent/pre-step` waterfall listener. Nothing else is touched.
- **A cut that explains itself.** Rejection happens at a step boundary and is preceded by one notice, so the run ends with the model's summary rather than a truncation.
- **Unknown price is not free.** A model with no `rates` entry contributes tokens but no cost, and the cost ceiling is skipped entirely while nothing used is priced — it never treats an unpriced session as a zero-cost one.
- **Read-only accounting.** Only settled provider usage is folded in; nothing here estimates or invents a number to gate on.

## Known limitations

- An adapter that reports no usage contributes nothing, so such a session under-counts against both ceilings.
- A billed attempt that never settled into a final message has no `provider/model` route, so it folds under `unattributed`: it counts against `tokenBudget` and prices no cost.
- `costBudgetUsd` is only as accurate as your `rates`. Treat currency as an estimate and `tokenBudget` as the exact control.
- Which notice was already sent is in-process, so a restart can re-send the "wrap up" notice. Spend itself never resets.
- Budgets are per session, not per account or per day, and a fork inherits its parent's spend by design.
- A cap reached *during* a streaming step cannot be unspent: that step finishes and the guard cuts at the next boundary.

## Development

```sh
npm install --legacy-peer-deps   # or pnpm install
npm test                         # 49 tests: arithmetic + fold + events + policy + wiring
npx tsc --noEmit -p tsconfig.json
npm run build                    # tsdown -> lib/
```

Layout:

```
src/budget.ts   billed-token / USD arithmetic and ok-warn-over classification
src/spend.ts    the durable per-model fold (replacement slot, retry reopening)
src/events.ts   session event → fold input (which events bill, route extraction)
src/guard.ts    escalation policy: pass / notice / reject, once per crossing
src/index.ts    thin cordis wiring: projection registration + pre-step listener
cordis.patch.yml  the bundle layer that inserts the plugin row
```

`budget.ts`, `spend.ts`, `events.ts` and `guard.ts` import nothing from the harness, so most of `npm test` validates the accounting, the fold, the normalization and the policy anywhere — no composition, no API key. `tests/plugin.test.ts` drives the real `apply()` against a stand-in context: it asserts the projection unit folds a genuine `assistant/message` event into per-model spend and round-trips through its declared schemas, that a warn-ratio step gets its notice prepended to the downstream messages, and that an over-cap `stop` run is announced first and vetoed at the next boundary without ever calling `next()`.

Verified against `@deepseek-ai/cordis` 4.0.4, `@deepseek-ai/dsh-agent` / `dsh-llm` / `dsh-session` / `dsh-session-projection` 0.1.7-rc.1, `@deepseek-ai/schemastery` 3.18.4 and `zod` 4.4.3. Note the npm dist-tags: **`latest` is still the stale `0.0.1-rc.1`**, whose projection seam had a different contract; the current line is published under **`next`**. Install explicitly (`npm i @deepseek-ai/dsh-session-projection@next`) or the peer types you compile against predate `stateSchema` / `stateVersion`.

What is not covered here is the end-to-end case: boot a real `dsh` profile with this `cordis.patch.yml`, run a session past the cap, and confirm the step boundary cuts it.

## License

[MIT](LICENSE)
