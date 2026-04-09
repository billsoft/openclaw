---
name: simplify
description: 'Review code for over-engineering and unnecessary complexity. Use when user says "simplify this", "is this too complex?", "refactor for clarity", or wants a complexity audit. Identifies speculative abstractions, premature generalization, dead code, and unnecessary indirection — then proposes minimal, focused rewrites.'
metadata:
  {
    "openclaw":
      {
        "emoji": "✂️",
        "always": false,
      },
  }
---

# Simplify

Review code for complexity and propose targeted simplifications. The goal is not style
consistency — it is reducing cognitive load and lines of code without changing behavior.

## When to use

- "simplify this"
- "is this too complex / over-engineered?"
- "refactor for readability"
- "this feels bloated"
- "make this cleaner"

## Complexity smell checklist

Scan the target code for these patterns (check each one):

| Smell | Examples |
|---|---|
| **Speculative abstraction** | Interface with one implementation; factory for one type |
| **Premature generalization** | Generic function used in exactly one place |
| **Wrapper for nothing** | Function that just calls another function with no transformation |
| **Over-split files** | 5 files for 50 lines of logic |
| **Unnecessary async** | `async` function that never awaits anything |
| **Dead code** | Exported symbol never imported; unreachable branch |
| **Redundant state** | State that could be derived from other state |
| **Config for one value** | Config object with one key that never varies |
| **Comment compensating for bad naming** | `// increment counter` above `x++` |
| **Error handling for impossible cases** | Validating internal data that can never be invalid |

## Output format

For each smell found:

```
[smell type] <file>:<line>
Problem: <what makes it complex>
Fix: <specific, minimal change>
```

Then a consolidated diff or rewrite for the top 1–3 highest-value simplifications.

## Constraints (read before suggesting)

- **Do not add features** — simplification only, no new behavior
- **Do not add error handling** for cases that cannot occur
- **Do not create helpers** for one-time use
- **Do not rename** unless the name is genuinely confusing
- **Do not reformat** unless formatting causes confusion
- **Stop at 3 suggestions** — long lists dilute signal; prioritize by impact
- **Measure twice** — if removing code, confirm no other callers first (`grep`)

## Example output

```
[speculative abstraction] src/cache/factory.ts:12
Problem: CacheFactory creates only MemoryCache; the abstraction adds a layer with no benefit.
Fix: Delete factory, inline `new MemoryCache()` at the two call sites.

[unnecessary async] src/utils/parse.ts:8
Problem: parseFrontmatter is declared async but contains no await.
Fix: Remove async keyword; callers can drop their awaits.
```

## After review

Ask the user which (if any) simplifications to apply before touching any files.
Never auto-apply simplifications without confirmation.
