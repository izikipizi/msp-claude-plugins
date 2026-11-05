---
name: nizlo-fleet-operations
description: >-
  Nizlo tenant-scoped fleet summary, customer, site, and endpoint lookup workflows.
when_to_use: >-
  When a technician asks for Nizlo fleet health, customer or site context, endpoint
  inventory, offline devices, hostname lookup, operating-system scope, or first-pass triage.
---

# Nizlo fleet operations

## Workflow

1. Call `nizlo_dashboard_summary` for fleet counts and current attention queues when the request is broad.
2. Resolve customer or site context with `nizlo_list_customers` or `nizlo_list_sites` before applying an ID filter.
3. Call `nizlo_list_devices` with the narrowest useful filters. Prefer `search` for a hostname or display name and use customer/site IDs to preserve boundaries.
4. Report exact source fields and timestamps. Do not infer that an endpoint is healthy merely because it appears in inventory.
5. Keep pagination visible when the returned `total` exceeds the current page boundary.

## Filter examples

Find an offline Windows endpoint by hostname fragment:

```json
{
  "search": "FILESERVER",
  "status": "offline",
  "platform": "windows",
  "page": 1,
  "pageSize": 50
}
```

List sites for one resolved customer:

```json
{
  "customerId": "resolved-customer-id",
  "pageSize": 100
}
```

## Gotchas

- Nizlo derives the workspace from the token; do not ask for or invent a tenant ID.
- `status` is an observed connectivity filter (`online`, `offline`, or `unknown`), not a business-service health verdict.
- Same-named customers remain separate. Carry immutable IDs when joining customer, site, and endpoint results.
- List tools return one bounded page. Continue only when the user needs more than that page.
