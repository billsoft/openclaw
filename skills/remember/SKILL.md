---
name: remember
description: 'Save something to persistent memory so it survives across sessions and compactions. Use when user says "remember this", "save this", "note that", or any explicit request to retain information long-term. Writes to the agent memory directory using the 4-type taxonomy (user/feedback/project/reference).'
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

## Memory directory

Write files to the agent memory directory. OpenClaw injects `MEMORY.md` (an index of saved files)
into the system prompt at startup. The memory directory is typically at:

```
~/.openclaw/agents/<agentId>/memory/
```

Read `MEMORY.md` first to see what files already exist, then update an existing file or create a
new one — never create a duplicate.

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

**Turn 1** — Read all files you might need to update:
```
Read MEMORY.md  (to see what exists)
Read <existing-file>.md  (if updating)
```

**Turn 2** — Write/Edit in parallel:
```
Write <new-file>.md  (new memory)
Edit <existing-file>.md  (update existing)
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
