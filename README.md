# dsh-budget-guard

中文 | [English](README.en.md)

**在一次 DeepSeek Harness 会话花爆预算之前，先给它设一个上限。**

[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-blue)](https://github.com/topics/dsh-plugin) [![license: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

`dsh-budget-guard` 是一个可直接挂载的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）插件：它持续统计每个会话累计计费的 token，并可按你自己提供的价格表折算成金额，一旦越过预算就告警或熔断。

## 问题

`dsh` 会用**轮次**和**上下文占用**来约束一次运行，但没有任何机制按**开销**约束它。

这是两回事，而意外恰恰藏在差值里。每一步的开销并不均匀：prompt token 会带着整段历史一起上涨，会话中途改动工具或系统提示会把缓存读变成缓存写，重试风暴会把整次尝试重新计一遍费，一个工具循环还能在单轮里加上三十个 step。于是累计开销曲线是突刺状而非线性的——某一轮的消耗可以超过之前一整个小时——而循环照旧继续，因为它只知道两个停止条件：“模型不再请求”和“轮次上限到了”。

这个守卫要堵的就是这个漏洞：不是缓慢泄漏，而是 agent 走开一会儿、回来时带着一张十位数量级的 token 账单。

## 这个插件做什么

在每个 step 边界读取会话已产生的开销，并采取当前最轻的处置：

| 开销 | `action: stop`（默认） | `action: warn` |
| --- | --- | --- |
| 低于 `warnRatio` | 继续 | 继续 |
| 达到某个上限的 `warnRatio` | 向模型注入一次「收尾」提示 | 注入一次「收尾」提示 |
| 达到上限 | 先注入一次「本 step 之后将停止」提示，**下一个** step 边界被拒绝 | 注入一次更明确的超限提示，然后继续运行 |

- **模型能看到提示**：它以带标签的 `form: 'notice'` 上下文消息注入，所以模型有机会在预算内把活干完，而不是话说一半被掐断。
- **操作者也能看到**：既在会话记录里，也在日志里（提示是 `INFO`，拒绝是 `WARN`）。
- **每次越级只提示一次**，不会每一步都唠叨。

### 为什么计数器是一个 session projection

一个进程重启就清零的预算守卫算不上预算守卫——`dsh` 的会话是长生命周期的，会被不断恢复和 fork。

所以累计开销不是插件私有状态，而是注册进去的一个 **session projection**（`budgetGuardSpend`）：这是 harness 自己用来从事件日志派生持久会话状态的机制，恢复时会重放，因此被恢复的会话从已花掉的额度继续，fork 出的子会话继承其前缀的总额。按模型分桶则让金额上限有可能诚实——每个模型的 token 按该模型的单价计费，而 token 上限把它们求和。

## 安装

从已发布的包安装：

```sh
dsh plugin add dsh-budget-guard
```

从本仓库安装：

```sh
dsh plugin --profile <name> add github:5quan/dsh-budget-guard
```

或者不安装、只针对单次运行加载（配一份 harness 源码 checkout）：

```sh
pnpm dsh web --patch ../dsh-budget-guard/cordis.patch.yml
```

## 配置

| 键 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `tokenBudget` | 整数 | `0` | 会话累计计费 token 上限。`0` 表示 token 不设上限。 |
| `costBudgetUsd` | 数值 | `0` | 会话累计开销的美元上限。想被计费到的模型都必须在 `rates` 里列出。 |
| `warnRatio` | `0–1` 数值 | `0.8` | 任一上限达到该比例时注入「收尾」提示。 |
| `action` | `stop` \| `warn` | `stop` | 到达上限时：在本 step 后结束运行，还是仅提示。 |
| `rates` | map | `{}` | 每百万 token 的美元价，键为 `provider/model`。 |

`tokenBudget` 与 `costBudgetUsd` 至少要有一个大于零；一个什么都不设限的配置会在加载时直接报错，而不是静默地什么也不做。

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

**这里刻意不内置任何价格。** 供应商价目表每月都在变，任何写死在这里的表都会悄无声息地过期。`tokenBudget` 开箱即用；`costBudgetUsd` 只对你列出的模型生效。

## 为什么它安全

- **不改内核。** 只用两个有文档的扩展点：注册一个 projection，加一个 `agent/pre-step` waterfall 监听器。别的都不碰。
- **断得清楚。** 拒绝发生在 step 边界，并且前面一定有一次提示，所以运行结束时你拿到的是模型的总结，而不是一段被截断的输出。
- **不知道价格不等于免费。** 没有 `rates` 条目的模型只贡献 token、不贡献金额；只要所用模型全都无价，金额维度就整条跳过——它绝不会把一笔未计价当成零成本。
- **只读记账。** 只折叠已结算的 provider usage；这里不估算、不编造任何用来做闸门的数字。

## 已知限制

- 不上报 usage 的 adapter 不贡献任何计数，这类会话会在两个上限上都偏低。
- 一条已计费但最终没有落成消息的 attempt 没有 `provider/model` 路由，因此折进 `unattributed`：它计入 `tokenBudget`，但不产生金额。
- `costBudgetUsd` 的准确度取决于你的 `rates`。请把金额当作估算，把 `tokenBudget` 当作精确控制。
- 「哪次提示已经发过」是进程内状态，所以重启后「收尾」提示可能再发一次。开销本身不会重置。
- 预算按会话计，不按账户或自然日计；fork 按设计继承父会话的已花额度。
- 上限是在流式 step **过程中**到达的话，那一步的 token 已经花出去了：该 step 会跑完，守卫在下一个边界切断。

## 开发

```sh
npm install --legacy-peer-deps   # 或 pnpm install
npm test                         # 49 个单测：算术 + 折叠 + 事件 + 策略 + 接线
npx tsc --noEmit -p tsconfig.json
npm run build                    # tsdown -> lib/
```

目录结构：

```
src/budget.ts   计费 token / 美元算术，以及 ok-warn-over 分级
src/spend.ts    持久化的按模型折叠（同槽位替换、重试重开槽位）
src/events.ts   会话事件 → 折叠输入（哪些事件计费、如何取路由）
src/guard.ts    升级策略：pass / notice / reject，每次越级一次
src/index.ts    轻量的 cordis 接线：注册 projection + pre-step 监听器
cordis.patch.yml  插入该插件行的 bundle 层
```

`budget.ts`、`spend.ts`、`events.ts`、`guard.ts` 不 import 任何 harness 依赖，因此大部分 `npm test` 在没有 composition、没有 API key 的地方也能验证记账、折叠、归一化与策略。`tests/plugin.test.ts` 会把真实的 `apply()` 接到一个替身 context 上：验证 projection 单元能把一条真正的 `assistant/message` 事件折叠成按模型的开销、并能沿声明的 schema 往返；到达告警比例的步骤会把提示插到下游消息前面；而超预算且 `action: stop` 的运行会先收到预告，再在下一次边界被否决且不再调用 `next()`。

已验证版本：`@deepseek-ai/cordis` 4.0.4、`@deepseek-ai/dsh-agent` / `dsh-llm` / `dsh-session` / `dsh-session-projection` 0.1.7-rc.1、`@deepseek-ai/schemastery` 3.18.4、`zod` 4.4.3。注意 npm 的 dist-tag：**`latest` 仍停留在过期的 `0.0.1-rc.1`**，那一版的 projection 接口契约完全不同；当前版本线发布在 **`next`** 下。请显式安装（`npm i @deepseek-ai/dsh-session-projection@next`），否则你编译时面对的 peer 类型还不认识 `stateSchema` / `stateVersion`。

未覆盖的是端到端场景：用本仓库的 `cordis.patch.yml` 启动真实 `dsh` profile，跑过一个预算上限，确认步骤边界会切断它。

## 许可证

[MIT](LICENSE)
