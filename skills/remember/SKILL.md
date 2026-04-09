---
name: remember
description: 'Save something to persistent memory so it survives across sessions and compactions. Chooses between global memory (cross-agent user facts) and per-agent memory (project/feedback/reference). Use when user says "remember this", "save this", "note that", or any explicit request to retain information long-term.'
metadata:
  {
    "openclaw":
      {
        "emoji": "🧠",
        "always": false,
      },
  }
---

# Remember

Save information to persistent memory. Memories survive context compaction and are surfaced
automatically in future conversations when relevant.

## When to use

Use this skill immediately when the user says:

- "remember this / that"
- "save this for later"
- "note that..."
- "don't forget..."
- "keep in mind..."
- any explicit instruction to retain something long-term

## Memory tiers

OpenClaw has two memory tiers. Choose based on the memory type:

| Tier | Path | When to use |
|---|---|---|
| **Global** | `~/.openclaw/global-memory/memory/` | `user` type facts: personal identity, preferences, habits that apply across ALL agents |
| **Per-agent** | `~/.openclaw/agents/<agentId>/memory/` | `feedback`, `project`, `reference`; or user facts specific to this agent/workspace |

**Default rule**: prefer global for `user` type, per-agent for everything else.

### Which MEMORY.md to update

After writing a memory file, update the matching index:
- Global tier → `~/.openclaw/global-memory/MEMORY.md`
- Per-agent tier → `{agentWorkspaceDir}/MEMORY.md`

Read the target MEMORY.md first to see what files already exist.

## How to save a memory

Each memory goes in its own `.md` file with this frontmatter:

```markdown
---
name: Short descriptive title
description: One-line description used to decide relevance in future conversations
type: user | feedback | project | reference
---

Memory content here.
```

### Memory types

| Type | When to use |
|---|---|
| **user** | User's role, expertise, goals, recurring preferences |
| **feedback** | Guidance on your approach — what to avoid or keep doing. Include **Why:** and **How to apply:** |
| **project** | Ongoing work, decisions, bugs, deadlines. Include **Why:** and **How to apply:** |
| **reference** | Pointers to external resources (Linear boards, dashboards, docs URLs) |

### What NOT to save

- Code patterns derivable from reading the repo
- Git history or recent changes (use `git log`)
- Debugging recipes (fix is in the code; commit message has context)
- Anything already documented in CLAUDE.md / AGENTS.md
- Transient state like "currently working on X" → use session memory instead

## Efficient two-turn strategy

**Turn 1** — Read all files you might need, in parallel:
```
Read ~/.openclaw/global-memory/MEMORY.md     (if saving user-type memory)
Read {agentWorkspaceDir}/MEMORY.md           (if saving other types)
Read <existing-file>.md                      (if updating an existing file)
```

**Turn 2** — Write/Edit in parallel:
```
Write <new-file>.md      (create new memory in the correct tier directory)
Edit MEMORY.md           (add pointer to the new file in the correct index)
```

Never investigate the codebase during a memory-save turn — only act on what the user just told you.

## Examples

### User says "remember I prefer tabs not spaces"

```markdown
---
name: Code style preference
description: User prefers tabs for indentation, not spaces
type: user
---

Prefer tabs for indentation in all code. Never use spaces as indentation.
```

### User says "remember: always squash commits before merging"

```markdown
---
name: Git workflow preference
description: Always squash commits before merging to main
type: feedback
---

Squash all commits into a single commit before merging branches to main.

**Why:** User prefers clean linear history; squash-merge is their team's convention.
**How to apply:** After any `git merge` suggestion, remind the user to squash-merge or use `--squash` flag.
```

### User says "the Linear project for bugs is called INFRA"

```markdown
---
name: Linear bug project
description: Bug tracking project in Linear is called INFRA
type: reference
---

All bugs are tracked in Linear project **INFRA**. Use this project ID when linking issues.
```

### User says "remember I'm a vegetarian"

This is a personal fact that applies across all agents → **global tier**.

Write to `~/.openclaw/global-memory/memory/user_diet.md`:
```markdown
---
name: Dietary preference
description: User is vegetarian — avoid suggesting meat-based options
type: user
---

User is vegetarian. When suggesting recipes, restaurants, or food-related content, always use vegetarian options. Never suggest meat.
```

Then update `~/.openclaw/global-memory/MEMORY.md`:
```
- [Dietary preference](memory/user_diet.md) — User is vegetarian
```
