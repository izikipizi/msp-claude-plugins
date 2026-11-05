---
name: nizlo-alerts
description: >-
  Nizlo read-only alert lookup by status, severity, customer, site, device, and search text.
when_to_use: >-
  When a technician asks to list, find, summarize, or prioritize Nizlo alerts without
  acknowledging, assigning, snoozing, resolving, or otherwise mutating them.
---

# Nizlo alerts

## Workflow

1. Use `nizlo_list_alerts` with `status: "ACTIVE"` when the request means all unresolved work.
2. Add `severity`, customer, site, or device filters before increasing page size.
3. Preserve alert IDs, source timestamps, device/customer context, and assignment fields in the summary.
4. State when additional pages exist. Do not describe the first page as the full alert inventory.
5. Stop if the user asks to acknowledge, assign, snooze, resolve, or remediate an alert. This plugin is deliberately read-only and has no mutation tool.

## Example

```json
{
  "status": "ACTIVE",
  "severity": "CRITICAL",
  "customerId": "resolved-customer-id",
  "page": 1,
  "pageSize": 50
}
```

## Status values

| Value | Meaning |
|---|---|
| `ACTIVE` | Any alert not resolved |
| `OPEN` | Open state only |
| `ACKNOWLEDGED` | Acknowledged state only |
| `SNOOZED` | Snoozed state only |
| `RESOLVED` | Resolved state only |

`alerts.view` is required. A `devices.view`-only token should receive a controlled permission failure rather than broader access.
