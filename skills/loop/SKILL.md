---
name: loop
description: 'Execute a task repeatedly — N times, until a condition is met, or until the user says stop. Use for: batch processing, retry loops, polling, iterating over a list of items. Builds an explicit iteration plan before starting so progress is visible.'
metadata:
  {
    "openclaw":
      {
        "emoji": "🔁",
        "always": false,
      },
  }
---

# Loop

Execute a task repeatedly with explicit iteration tracking and early-exit conditions.

## When to use

- "do this for each of these 10 repos"
- "keep trying until it passes"
- "retry this 3 times"
- "run this every minute for the next hour"
- any batch/repeated task over a list or condition

## Core pattern

Before starting any loop, state the plan:

```
Loop plan:
- Items: [list what you're iterating over]
- Action: [what you'll do each iteration]
- Stop condition: [N iterations / success / user interrupt]
- On failure: [skip and continue / abort / retry once]
```

Then execute one item at a time, reporting after each:

```
[1/5] Processing repo-a ... ✅ done (12ms)
[2/5] Processing repo-b ... ❌ failed: timeout — skipping
[3/5] Processing repo-c ... ✅ done
```

## Common loop shapes

### Fixed-count loop (N items)

```
For each item in [list]:
  1. Do action
  2. Report result
  3. Pause if user interrupt requested
After all: summarize successes/failures
```

### Until-success loop (retry)

```
Attempt 1/3: <action> → failed (reason)
Attempt 2/3: <action> → failed (reason)
Attempt 3/3: <action> → succeeded ✅
```

Max retries default: **3**. Always set an explicit cap — never infinite loops.

### Polling loop

```
Poll every <interval>:
  Check condition → not met, waiting...
  [after N checks] condition met → exit
```

For real-time polling, use background bash sessions with `process action:poll`.

## Rules

1. **State the plan first** — always enumerate what will be iterated before starting
2. **Report each iteration** — never go silent; user must know where you are
3. **Respect stop conditions** — if user says "stop", halt after the current item
4. **Cap all loops** — default max iterations: 10 unless user specifies otherwise
5. **Summarize at end** — total processed, succeeded, failed, skipped

## Example: Batch process a list of files

User: "run the linter on each file in this list: a.ts, b.ts, c.ts"

```
Loop plan:
- Items: a.ts, b.ts, c.ts (3 files)
- Action: run eslint on each file
- Stop: after all 3
- On failure: report error, continue to next

[1/3] a.ts → ✅ 0 errors
[2/3] b.ts → ⚠️ 2 warnings (unused variable line 14, 23)
[3/3] c.ts → ❌ 1 error (missing semicolon line 8)

Summary: 3 files processed — 1 clean, 1 warnings, 1 error.
```

## Example: Retry until passing

User: "keep running the tests until they pass (max 5 tries)"

```
Attempt 1/5: pnpm test → ❌ 2 failures
Attempt 2/5: pnpm test → ❌ 1 failure (flaky test)
Attempt 3/5: pnpm test → ✅ all pass

Done in 3 attempts.
```
