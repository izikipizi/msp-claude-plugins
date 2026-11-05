# Nizlo read-only RMM plugin

Inspect Nizlo fleet posture, customers, sites, endpoints, and alerts from Claude Code. The bundled local MCP server exposes exactly six read-only tools and never sends a non-GET API request.

## Installation

```text
/plugin marketplace add WYRE-AI/msp-claude-plugins
/plugin install nizlo
```

Node.js 20 or newer must be available locally. The MCP server has no package-install step and no runtime dependency outside Node.

## Configuration

Create a personal access token in Nizlo with the smallest useful scope:

- `devices.view` for the dashboard, customer, site, endpoint, and stale-endpoint tools;
- `alerts.view` only when the alert tool is needed.

Store the one-time value in the local `NIZLO_API_TOKEN` environment variable. Do not paste it into chat, pass it as a command argument, or commit it to a file. `NIZLO_BASE_URL` is optional and defaults to `https://app.nizlo.com/api/v1/`; use an HTTPS override only for an authorized sandbox.

## Available tools

| Tool | Scope |
|---|---|
| `nizlo_dashboard_summary` | Tenant-scoped fleet counts, attention queues, recent alerts, and activity |
| `nizlo_list_customers` | Active customer pages with optional search |
| `nizlo_list_sites` | Active site pages with optional customer and search filters |
| `nizlo_list_devices` | Active endpoints with customer, site, status, platform, and text filters |
| `nizlo_list_alerts` | Alerts with status, severity, customer, site, device, and text filters |
| `nizlo_stale_endpoints` | Serial seven-day-by-default inventory scan grouped by immutable customer ID |

Every list call is bounded to 1-200 records per page. The stale-endpoint tool pages serially, fails closed on contradictory metadata or repeated endpoint IDs, and labels a successful report `unverified_no_snapshot` because the API does not currently expose a snapshot token spanning the full scan.

## Example prompts

```text
Show offline Windows endpoints matching FILESERVER.
List active critical alerts for this workspace.
Which endpoints have not checked in for seven days? Group them by customer.
Give me the fleet summary before I start triage.
```

## Safety boundary

The server allowlists only these routes:

- `GET /dashboard/summary`
- `GET /customers`
- `GET /sites`
- `GET /devices`
- `GET /alerts`

It has no tool for remote access, scripts, patching, jobs, alert mutation, enrollment, webhooks, or token administration. It rejects insecure base URLs, redirects, unknown tool arguments, overlong retry waits, malformed pagination, invalid UTF-8, non-JSON responses, and oversized responses. API data flows directly from Nizlo to the local MCP process and is not stored by the plugin. Tool results can still enter the configured model provider's context, so operators must review that provider's data-processing and retention terms.

## Troubleshooting

- `TOKEN_REQUIRED` — set `NIZLO_API_TOKEN` in the environment used to start Claude Code.
- `HTTP_401` — create a new token or verify that the technician account remains active.
- `HTTP_403` on alerts — add `alerts.view`, or avoid the alert tool and keep only `devices.view`.
- `INCOMPLETE_SCAN` — inventory changed, pagination metadata conflicted, a rate-limit bound was exceeded, or the 120-second scan deadline expired. Retry later; the server does not return a partial stale-endpoint report.
- `INVALID_BASE_URL` — use an absolute HTTPS API base without embedded credentials, query, or fragment.

Run the dependency-free tests with:

```bash
node --test server/index.test.mjs
```

## Disclosure

The initial plugin implementation is maintained by Nizlo and follows the community-approved [read-only design specification](../../../files/nizlo-plugin-prd.md). Inclusion in the marketplace is not a WYRE endorsement, certification, or claim of independent MSP verification.

## Links

- [Nizlo RMM API overview](https://nizlo.com/rmm-api)
- [Nizlo security architecture](https://nizlo.com/security)
- [Marketplace repository](https://github.com/WYRE-AI/msp-claude-plugins)
