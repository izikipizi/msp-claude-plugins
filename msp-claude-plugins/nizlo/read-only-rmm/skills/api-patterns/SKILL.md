---
name: nizlo-api-patterns
description: >-
  Nizlo read-only API authentication, route boundaries, pagination, rate-limit,
  response-hardening, and tenant-isolation behavior.
when_to_use: >-
  When configuring Nizlo API access, diagnosing a Nizlo MCP error, choosing token
  permissions, paging Nizlo results, or explaining the local read-only boundary.
---

# Nizlo API patterns

## Overview

The plugin runs a local stdio MCP server that sends bearer-authenticated HTTPS requests directly to the authenticated Nizlo workspace. Nizlo derives the workspace from the technician and token; no tool accepts a tenant selector.

## Authentication and permissions

1. Create a time-limited personal access token in the Nizlo console.
2. Grant `devices.view` for dashboard, customer, site, endpoint, and stale-endpoint reads.
3. Add `alerts.view` only if `nizlo_list_alerts` is needed.
4. Store the one-time token in `NIZLO_API_TOKEN` for the local MCP process.

The token remains accountable to an active technician. It is not a service account and cannot manage its own lifecycle.

## Read-only boundary

The server exposes only `GET /dashboard/summary`, `/customers`, `/sites`, `/devices`, and `/alerts`. It rejects unknown tool arguments before network access, uses `redirect: manual`, and never replays the authorization header to a redirect.

## Pagination

List tools accept `page` and `pageSize`; page numbers start at 1 and page size is limited to 1-200. The expected envelope is:

```json
{
  "items": [],
  "total": 0,
  "page": 1,
  "pageSize": 50
}
```

The stale-endpoint scan validates this metadata on every page and fails closed instead of guessing when the values conflict.

## Errors

| Code | Meaning | Resolution |
|---|---|---|
| `TOKEN_REQUIRED` | No local token was supplied | Set `NIZLO_API_TOKEN` and restart the MCP process |
| `HTTP_401` | Token is missing, expired, or invalid | Create a new time-limited token |
| `HTTP_403` | Effective permission is missing | Add the narrow permission or avoid that tool |
| `INCOMPLETE_SCAN` | Pagination, drift, rate limit, or deadline prevented a reconciled scan | Retry later; do not treat a partial inventory as complete |
| `REDIRECT_REJECTED` | API returned a redirect | Verify the HTTPS base URL; credentials are not replayed |
| `INVALID_RESPONSE` | API returned invalid UTF-8 or non-JSON data | Check API availability and configured base URL |

## Data handling

The plugin does not persist results. Endpoint names, customer/site names, alert text, IP context, and activity data can still enter the configured model provider's context. Confirm that provider's data-processing, retention, and training settings before use.
