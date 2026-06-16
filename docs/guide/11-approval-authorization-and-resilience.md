# Approval, authorization, and resilience

## Goal

Add human-in-the-loop workflows, gate tool access by policy or role, and make
runs more robust under operational stress.

## Prerequisites

- You have read the earlier guides
- You are building a production or semi-production integration

## Step 1: Add human-in-the-loop approval

`@infinityi/engine-lib/approval` exports:

- `askHumanTool`
- `deferredHumanInputGateway`
- `trustApprovalPolicy`
- `compareTrust`
- `TRUST_METADATA_KEY`

Use this module when an agent must pause for human review before performing a
sensitive action.

`askHumanTool` lets the model explicitly request human input. The deferred input
gateway pattern supports asynchronous host-side handling when the answer cannot
be provided inline.

## Step 2: Add trust-aware approval policies

Use `trustApprovalPolicy(...)` when different actions require different trust
levels or previous grants should influence future approval decisions.

This is useful for hosts that need a policy layer between raw tool requests and
actual execution.

## Step 3: Gate tools by role or context

`roleToolAuthorizer` from the root package and the `authorization` surface can
be used to determine whether a given tool call is allowed in the current
application context.

Use authorization when some tools should only be available to certain users,
roles, tenants, or environments.

## Step 4: Enforce run budgets

`@infinityi/engine-lib/resilience` exports `evaluateBudget(...)` and the related
budget types.

Use this layer when the host needs to stop or flag runs based on usage, token,
or other bounded resource consumption.

## Step 5: Add retries and circuit breakers

The resilience module also exports:

- `withProviderRetry`
- `circuitBreaker`

Use these around provider access when upstream model APIs may be flaky or when
you need controlled retry semantics and failure isolation.

## Step 6: Add rate limiting

Available limiters include:

- `fixedWindowRateLimiter`
- `slidingWindowRateLimiter`
- `tokenBucketRateLimiter`
- `isTokenRateLimiter`

Use rate limiting when the host must protect upstream providers, contain costs,
or prevent tenant abuse.

## Result

You should now know how to:

- pause for human review
- authorize tools by role or context
- enforce budgets
- retry safely
- trip circuit breakers
- apply rate limiting

## Next steps

- Use [API map](./12-api-map.md) as a final cross-reference
