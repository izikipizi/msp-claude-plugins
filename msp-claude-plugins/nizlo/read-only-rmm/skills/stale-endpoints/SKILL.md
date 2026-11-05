---
name: nizlo-stale-endpoints
description: >-
  Nizlo multi-page stale and never-seen endpoint review grouped by immutable customer ID.
when_to_use: >-
  When an MSP asks which Nizlo endpoints stopped checking in, have never checked in,
  are stale for a given number of days, or may represent monitoring-coverage gaps.
---

# Nizlo stale-endpoint review

## Workflow

1. Call `nizlo_stale_endpoints` with the requested age. The default is seven days.
2. Review each customer group separately; same-named customers are distinguished by immutable ID.
3. Separate `never_seen` endpoints from endpoints with an exact old `lastSeenAt` timestamp.
4. Report the cutoff, inventory count, stale count, customer grouping, and `completeness` value.
5. Treat every successful report as `unverified_no_snapshot`. The scan reconciles page metadata and endpoint IDs, but the API does not expose one snapshot token spanning all pages.

## Example

```json
{
  "days": 7,
  "pageSize": 200
}
```

## Failure behavior

The tool returns no partial report after a repeated endpoint ID, changed total, malformed page metadata, rate-limit exhaustion, oversized response, or 120-second deadline. An `INCOMPLETE_SCAN` result means retry later or use a narrower operating process; it is not evidence that no endpoints are stale.

## Operational interpretation

A stale endpoint is a coverage exception, not automatically a device failure. Confirm retirement, reimage, travel, power state, network reachability, agent health, and customer/site lifecycle before escalating. Keep unresolved endpoints owned until the inventory and business disposition agree.
