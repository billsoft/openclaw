---
name: schedule
description: 'Create, list, or cancel scheduled/recurring tasks using OpenClaw cron jobs. Use when user says "remind me", "do this every day", "schedule this", "run this at 9am", or any time-based recurring task. Wraps the cron_create / cron_list / cron_delete tools.'
metadata:
  {
    "openclaw":
      {
        "emoji": "⏰",
        "always": false,
      },
  }
---

# Schedule

Create and manage recurring tasks via OpenClaw's built-in cron system.

## When to use

- "remind me every morning at 9"
- "do X every day / week / hour"
- "schedule this to run on Mondays"
- "set up a recurring check"
- "cancel that reminder"
- "what recurring tasks do I have?"

## Available tools

| Tool | Purpose |
|---|---|
| `cron_create` | Create a new scheduled job |
| `cron_list` | List all active scheduled jobs |
| `cron_delete` | Cancel a scheduled job by ID |

## Creating a schedule

```
cron_create:
  schedule: "<cron expression or natural language>"
  prompt: "<what the agent should do when triggered>"
  label: "<human-readable name>"
```

### Cron expression quick reference

| Schedule | Expression |
|---|---|
| Every day at 9am | `0 9 * * *` |
| Every Monday at 8am | `0 8 * * 1` |
| Every hour | `0 * * * *` |
| Every 15 minutes | `*/15 * * * *` |
| First of month at noon | `0 12 1 * *` |
| Weekdays at 6pm | `0 18 * * 1-5` |

Format: `minute hour day-of-month month day-of-week`

### Prompt best practices

Write the cron prompt as if you're leaving instructions for a future version of yourself:

- Be specific about what to check and how to report
- Include the delivery target if needed (e.g., "send to Telegram")
- Keep it focused — cron runs are short context windows

**Good:**
```
Check GitHub notifications for any PRs that need review.
If any open PRs are more than 2 days old without a review, list them with links.
Send summary to Telegram.
```

**Bad:**
```
Check stuff
```

## Examples

### Daily standup reminder

User: "remind me every weekday morning at 9 to write my standup"

```
cron_create:
  schedule: "0 9 * * 1-5"
  prompt: "Remind the user to write their standup. Ask: What did you do yesterday? What are you doing today? Any blockers?"
  label: "Daily standup reminder"
```

### Weekly review

User: "every Friday at 5pm, summarize what I worked on this week"

```
cron_create:
  schedule: "0 17 * * 5"
  prompt: "Look at today's date. Summarize the week's work by checking recent session history and any notes. Ask the user if they want to add anything to their weekly log."
  label: "Weekly work review"
```

### Listing active schedules

```
cron_list
→ Shows: ID, label, schedule, next run time, last run result
```

### Cancelling a schedule

```
cron_delete: <id>
```

Get the ID from `cron_list` output.

## Confirming with the user

Before creating a cron job, always confirm:
1. The schedule (show the next 3 trigger times to verify)
2. The prompt (show what will actually run)
3. The label

Example confirmation:
```
I'll create a cron job:
- Label: Daily standup reminder
- Schedule: 0 9 * * 1-5 (weekdays at 9:00am)
- Next runs: Mon Apr 14, Tue Apr 15, Wed Apr 16
- Prompt: [prompt text]

Shall I create this?
```
