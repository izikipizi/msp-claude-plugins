#!/usr/bin/env node

import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const SERVER_NAME = "nizlo-read-only-rmm";
const SERVER_VERSION = "0.1.0";
const DEFAULT_BASE_URL = "https://app.nizlo.com/api/v1/";
const MAX_ERROR_CHARS = 512;
const MAX_RESPONSE_BYTES = 2_000_000;
const REQUEST_TIMEOUT_MS = 30_000;
const SCAN_DEADLINE_MS = 120_000;
const MAX_RETRIES = 3;
const MAX_SCAN_PAGES = 10_000;

const ROUTES = Object.freeze({
  dashboard: "dashboard/summary",
  customers: "customers",
  sites: "sites",
  devices: "devices",
  alerts: "alerts",
});

const TOOL_NAMES = Object.freeze([
  "nizlo_dashboard_summary",
  "nizlo_list_customers",
  "nizlo_list_sites",
  "nizlo_list_devices",
  "nizlo_list_alerts",
  "nizlo_stale_endpoints",
]);

class ControlledError extends Error {
  constructor(message, code = "NIZLO_ERROR") {
    super(message);
    this.name = "ControlledError";
    this.code = code;
  }
}

function redact(value, token = process.env.NIZLO_API_TOKEN ?? "") {
  let text = String(value ?? "");
  if (token) text = text.split(token).join("[REDACTED]");
  text = text
    .replace(/authorization\s*:\s*bearer\s+[^\s,;]+/gi, "Authorization: Bearer [REDACTED]")
    .replace(/bearer\s+nizlo_pat_[A-Za-z0-9_-]+/gi, "Bearer [REDACTED]")
    .replace(/nizlo_pat_[A-Za-z0-9_-]+/g, "[REDACTED]");
  return text.slice(0, MAX_ERROR_CHARS);
}

function controlled(error, fallback = "Nizlo request failed") {
  if (error instanceof ControlledError) return error;
  if (error?.name === "AbortError" || error?.name === "TimeoutError") {
    return new ControlledError("Nizlo request timed out", "TIMEOUT");
  }
  return new ControlledError(redact(error?.message || fallback));
}

function getToken(env = process.env) {
  const token = env.NIZLO_API_TOKEN?.trim();
  if (!token) {
    throw new ControlledError(
      "NIZLO_API_TOKEN is required. Create a least-privilege personal access token and expose it only to the local MCP process.",
      "TOKEN_REQUIRED",
    );
  }
  return token;
}

function getBaseUrl(env = process.env) {
  let url;
  try {
    url = new URL(env.NIZLO_BASE_URL?.trim() || DEFAULT_BASE_URL);
  } catch {
    throw new ControlledError("NIZLO_BASE_URL must be an absolute HTTPS URL", "INVALID_BASE_URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new ControlledError(
      "NIZLO_BASE_URL must be an absolute HTTPS URL without credentials, query, or fragment",
      "INVALID_BASE_URL",
    );
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function assertObject(value, label = "arguments") {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ControlledError(`${label} must be an object`, "INVALID_ARGUMENTS");
  }
  return value;
}

function rejectUnknownKeys(value, allowed) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new ControlledError(`Unsupported argument: ${unknown.sort().join(", ")}`, "INVALID_ARGUMENTS");
  }
}

function optionalString(value, name, maxLength = 200) {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new ControlledError(`${name} must be a string`, "INVALID_ARGUMENTS");
  }
  const result = value.trim();
  if (!result || result.length > maxLength) {
    throw new ControlledError(`${name} must contain 1-${maxLength} characters`, "INVALID_ARGUMENTS");
  }
  return result;
}

function optionalEnum(value, name, values) {
  const result = optionalString(value, name, 32);
  if (result == null) return undefined;
  if (!values.includes(result)) {
    throw new ControlledError(`${name} must be one of: ${values.join(", ")}`, "INVALID_ARGUMENTS");
  }
  return result;
}

function integer(value, name, defaultValue, minimum, maximum) {
  const result = value == null ? defaultValue : value;
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new ControlledError(`${name} must be an integer from ${minimum} to ${maximum}`, "INVALID_ARGUMENTS");
  }
  return result;
}

function queryString(values) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value != null) query.set(key, String(value));
  }
  return query;
}

function parseRetryAfter(value) {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, date - Date.now());
}

function safeErrorMessage(payload, response) {
  const apiMessage =
    payload && typeof payload === "object" && typeof payload.message === "string"
      ? payload.message
      : null;
  return redact(apiMessage || `${response.status} ${response.statusText}`);
}

async function requestJson(route, query = new URLSearchParams(), options = {}) {
  if (!Object.values(ROUTES).includes(route)) {
    throw new ControlledError("The requested API route is not allowlisted", "ROUTE_NOT_ALLOWED");
  }
  const token = options.token ?? getToken(options.env);
  const baseUrl = options.baseUrl ?? getBaseUrl(options.env);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const random = options.random ?? Math.random;
  const deadline = options.deadline ?? now() + SCAN_DEADLINE_MS;
  const target = new URL(route, baseUrl);
  target.search = query.toString();
  if (target.origin !== baseUrl.origin || !target.pathname.startsWith(baseUrl.pathname)) {
    throw new ControlledError("The requested API route escaped the configured base URL", "ROUTE_NOT_ALLOWED");
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new ControlledError("Nizlo scan deadline exceeded", "INCOMPLETE_SCAN");
    const timeout = Math.min(REQUEST_TIMEOUT_MS, remaining);
    let response;
    try {
      response = await fetchImpl(target, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "User-Agent": `${SERVER_NAME}/${SERVER_VERSION}`,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw controlled(error);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      let destination;
      try {
        destination = location ? new URL(location, target) : null;
      } catch {
        destination = null;
      }
      const detail = destination && destination.origin !== target.origin
        ? "cross-origin redirect"
        : "redirect";
      throw new ControlledError(`Nizlo API returned an unexpected ${detail}`, "REDIRECT_REJECTED");
    }

    if (response.status === 429) {
      if (attempt === MAX_RETRIES) {
        throw new ControlledError("Nizlo rate-limit retry ceiling reached", "INCOMPLETE_SCAN");
      }
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      if (retryAfter != null && retryAfter > 30_000) {
        throw new ControlledError("Nizlo Retry-After exceeds the 30-second safety bound", "INCOMPLETE_SCAN");
      }
      const waitMs = retryAfter ?? Math.min(8_000, 500 * 2 ** attempt) + Math.floor(random() * 250);
      if (now() + waitMs >= deadline) {
        throw new ControlledError("Nizlo rate-limit wait would exceed the scan deadline", "INCOMPLETE_SCAN");
      }
      await sleep(waitMs);
      continue;
    }

    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new ControlledError("Nizlo response exceeded the local size limit", "RESPONSE_TOO_LARGE");
    }

    let bytes;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw controlled(error, "Unable to read the Nizlo response");
    }
    if (bytes.byteLength > MAX_RESPONSE_BYTES) {
      throw new ControlledError("Nizlo response exceeded the local size limit", "RESPONSE_TOO_LARGE");
    }

    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ControlledError("Nizlo API returned invalid UTF-8", "INVALID_RESPONSE");
    }

    let payload;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new ControlledError("Nizlo API returned a non-JSON response", "INVALID_RESPONSE");
    }
    if (!response.ok) {
      throw new ControlledError(`Nizlo API error: ${safeErrorMessage(payload, response)}`, `HTTP_${response.status}`);
    }
    return payload;
  }
  throw new ControlledError("Nizlo request failed", "NIZLO_ERROR");
}

function listArguments(args, allowedExtra = new Set()) {
  const value = assertObject(args);
  rejectUnknownKeys(value, new Set(["page", "pageSize", "search", ...allowedExtra]));
  return {
    page: integer(value.page, "page", 1, 1, 1_000_000),
    pageSize: integer(value.pageSize, "pageSize", 50, 1, 200),
    search: optionalString(value.search, "search"),
    raw: value,
  };
}

function validatePage(payload, requestedPage, requestedSize, expectedTotal = null) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ControlledError("Nizlo page response was not an object", "INCOMPLETE_SCAN");
  }
  const { items, total, page, pageSize } = payload;
  if (!Array.isArray(items) || !Number.isInteger(total) || total < 0) {
    throw new ControlledError("Nizlo page response has invalid items or total", "INCOMPLETE_SCAN");
  }
  if (page !== requestedPage || pageSize !== requestedSize || items.length > requestedSize) {
    throw new ControlledError("Nizlo page metadata did not match the request", "INCOMPLETE_SCAN");
  }
  if (expectedTotal != null && total !== expectedTotal) {
    throw new ControlledError("Nizlo inventory changed during the paginated scan", "INCOMPLETE_SCAN");
  }
  if (requestedPage * requestedSize < total && items.length === 0) {
    throw new ControlledError("Nizlo returned an empty page before the inventory boundary", "INCOMPLETE_SCAN");
  }
  return { items, total };
}

async function staleEndpoints(args, options = {}) {
  const value = assertObject(args);
  rejectUnknownKeys(value, new Set(["days", "pageSize"]));
  const days = integer(value.days, "days", 7, 1, 3650);
  const pageSize = integer(value.pageSize, "pageSize", 200, 1, 200);
  const now = options.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + SCAN_DEADLINE_MS;
  const cutoff = new Date(startedAt - days * 86_400_000);
  const seen = new Set();
  const stale = [];
  let total = null;
  let page = 1;

  while (page <= MAX_SCAN_PAGES) {
    const payload = await requestJson(
      ROUTES.devices,
      queryString({ page, pageSize }),
      { ...options, deadline },
    );
    const checked = validatePage(payload, page, pageSize, total);
    if (total == null) total = checked.total;
    for (const device of checked.items) {
      if (!device || typeof device !== "object" || typeof device.id !== "string" || !device.id) {
        throw new ControlledError("Nizlo device page contained an invalid endpoint", "INCOMPLETE_SCAN");
      }
      if (seen.has(device.id)) {
        throw new ControlledError("Nizlo inventory repeated an endpoint during the scan", "INCOMPLETE_SCAN");
      }
      seen.add(device.id);
      const lastSeenAt = device.lastSeenAt ?? null;
      let staleState = "never_seen";
      if (lastSeenAt != null) {
        const observed = new Date(lastSeenAt);
        if (!Number.isFinite(observed.getTime())) {
          throw new ControlledError("Nizlo endpoint contained an invalid lastSeenAt timestamp", "INCOMPLETE_SCAN");
        }
        if (observed > cutoff) continue;
        staleState = "stale";
      }
      stale.push({
        id: device.id,
        name: device.displayName || device.hostname || device.id,
        hostname: device.hostname ?? null,
        operatingSystem: device.inventory?.osName ?? device.osName ?? device.agentPlatform ?? null,
        lastSeenAt,
        state: staleState,
        customerId: device.customerId ?? device.customer?.id ?? null,
        customerName: device.customer?.name ?? "Unknown customer",
        siteId: device.siteId ?? device.site?.id ?? null,
        siteName: device.site?.name ?? null,
      });
    }
    if (page * pageSize >= checked.total) break;
    page += 1;
  }

  if (page > MAX_SCAN_PAGES || seen.size !== total) {
    throw new ControlledError("Nizlo inventory could not be reconciled at the pagination boundary", "INCOMPLETE_SCAN");
  }

  const grouped = new Map();
  for (const endpoint of stale) {
    const key = endpoint.customerId ?? "unknown";
    if (!grouped.has(key)) {
      grouped.set(key, {
        customerId: endpoint.customerId,
        customerName: endpoint.customerName,
        endpoints: [],
      });
    }
    grouped.get(key).endpoints.push(endpoint);
  }
  const customers = [...grouped.values()]
    .map((group) => ({
      ...group,
      endpoints: group.endpoints.sort((left, right) =>
        String(left.name).localeCompare(String(right.name)),
      ),
    }))
    .sort((left, right) =>
      left.customerName.localeCompare(right.customerName) ||
      String(left.customerId).localeCompare(String(right.customerId)),
    );

  return {
    generatedAt: new Date(startedAt).toISOString(),
    cutoff: cutoff.toISOString(),
    days,
    inventoryEndpoints: total,
    staleEndpoints: stale.length,
    completeness: "unverified_no_snapshot",
    completenessNote:
      "Pagination metadata and endpoint IDs reconciled, but the Nizlo API does not expose a snapshot token spanning every page.",
    customers,
  };
}

const TOOLS = [
  {
    name: "nizlo_dashboard_summary",
    description: "Read the tenant-scoped Nizlo fleet summary, attention queues, recent alerts, and recent activity.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "nizlo_list_customers",
    description: "List active customers in the authenticated Nizlo workspace.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "integer", minimum: 1, default: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        search: { type: "string", minLength: 1, maxLength: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "nizlo_list_sites",
    description: "List active sites, optionally scoped to one customer, in the authenticated Nizlo workspace.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "integer", minimum: 1, default: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        search: { type: "string", minLength: 1, maxLength: 200 },
        customerId: { type: "string", minLength: 1, maxLength: 64 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "nizlo_list_devices",
    description: "List active endpoints with optional customer, site, lifecycle-status, platform, and hostname search filters.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "integer", minimum: 1, default: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        search: { type: "string", minLength: 1, maxLength: 200 },
        customerId: { type: "string", minLength: 1, maxLength: 64 },
        siteId: { type: "string", minLength: 1, maxLength: 64 },
        status: { type: "string", enum: ["online", "offline", "unknown"] },
        platform: { type: "string", enum: ["windows", "macos", "linux"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "nizlo_list_alerts",
    description: "List Nizlo alerts with optional status, severity, customer, site, device, and text filters.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "integer", minimum: 1, default: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        search: { type: "string", minLength: 1, maxLength: 200 },
        status: { type: "string", enum: ["ACTIVE", "OPEN", "ACKNOWLEDGED", "SNOOZED", "RESOLVED"] },
        severity: { type: "string", enum: ["INFO", "WARNING", "CRITICAL"] },
        customerId: { type: "string", minLength: 1, maxLength: 64 },
        siteId: { type: "string", minLength: 1, maxLength: 64 },
        deviceId: { type: "string", minLength: 1, maxLength: 64 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "nizlo_stale_endpoints",
    description: "Scan active endpoints serially and report never-seen or stale endpoints grouped by immutable customer ID.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "integer", minimum: 1, maximum: 3650, default: 7 },
        pageSize: { type: "integer", minimum: 1, maximum: 200, default: 200 },
      },
      additionalProperties: false,
    },
  },
];

async function callTool(name, args, options = {}) {
  if (!TOOL_NAMES.includes(name)) {
    throw new ControlledError(`Unknown tool: ${name}`, "UNKNOWN_TOOL");
  }
  if (name === "nizlo_dashboard_summary") {
    const value = assertObject(args);
    rejectUnknownKeys(value, new Set());
    return requestJson(ROUTES.dashboard, new URLSearchParams(), options);
  }
  if (name === "nizlo_stale_endpoints") return staleEndpoints(args, options);

  if (name === "nizlo_list_customers") {
    const parsed = listArguments(args);
    return requestJson(
      ROUTES.customers,
      queryString({ page: parsed.page, pageSize: parsed.pageSize, search: parsed.search }),
      options,
    );
  }
  if (name === "nizlo_list_sites") {
    const parsed = listArguments(args, new Set(["customerId"]));
    return requestJson(
      ROUTES.sites,
      queryString({
        page: parsed.page,
        pageSize: parsed.pageSize,
        search: parsed.search,
        customerId: optionalString(parsed.raw.customerId, "customerId", 64),
      }),
      options,
    );
  }
  if (name === "nizlo_list_devices") {
    const parsed = listArguments(args, new Set(["customerId", "siteId", "status", "platform"]));
    return requestJson(
      ROUTES.devices,
      queryString({
        page: parsed.page,
        pageSize: parsed.pageSize,
        search: parsed.search,
        customerId: optionalString(parsed.raw.customerId, "customerId", 64),
        siteId: optionalString(parsed.raw.siteId, "siteId", 64),
        status: optionalEnum(parsed.raw.status, "status", ["online", "offline", "unknown"]),
        platform: optionalEnum(parsed.raw.platform, "platform", ["windows", "macos", "linux"]),
      }),
      options,
    );
  }
  const parsed = listArguments(args, new Set(["status", "severity", "customerId", "siteId", "deviceId"]));
  return requestJson(
    ROUTES.alerts,
    queryString({
      page: parsed.page,
      pageSize: parsed.pageSize,
      search: parsed.search,
      status: optionalEnum(parsed.raw.status, "status", ["ACTIVE", "OPEN", "ACKNOWLEDGED", "SNOOZED", "RESOLVED"]),
      severity: optionalEnum(parsed.raw.severity, "severity", ["INFO", "WARNING", "CRITICAL"]),
      customerId: optionalString(parsed.raw.customerId, "customerId", 64),
      siteId: optionalString(parsed.raw.siteId, "siteId", 64),
      deviceId: optionalString(parsed.raw.deviceId, "deviceId", 64),
    }),
    options,
  );
}

function writeMessage(message, output = process.stdout) {
  output.write(`${JSON.stringify(message)}\n`);
}

async function handleMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  if (message.method === "notifications/initialized") return null;
  const id = message.id;
  if (id == null) return null;
  if (message.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: message.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    };
  }
  if (message.method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (message.method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }
  if (message.method === "tools/call") {
    try {
      const result = await callTool(message.params?.name, message.params?.arguments);
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
      };
    } catch (error) {
      const safe = controlled(error);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: `${safe.code}: ${redact(safe.message)}` }],
        },
      };
    }
  }
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "Method not found" },
  };
}

async function main() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    try {
      const response = await handleMessage(message);
      if (response) writeMessage(response);
    } catch {
      writeMessage({ jsonrpc: "2.0", id: message.id ?? null, error: { code: -32603, message: "Internal error" } });
    }
  }
}

export {
  ControlledError,
  TOOL_NAMES,
  TOOLS,
  callTool,
  getBaseUrl,
  handleMessage,
  parseRetryAfter,
  requestJson,
  staleEndpoints,
  validatePage,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("Nizlo MCP server failed to start\n");
    process.exitCode = 1;
  });
}
