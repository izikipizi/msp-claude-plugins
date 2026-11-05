import assert from "node:assert/strict";
import test from "node:test";

import {
  ControlledError,
  TOOL_NAMES,
  callTool,
  getBaseUrl,
  handleMessage,
  requestJson,
  staleEndpoints,
} from "./index.mjs";

const TOKEN = "nizlo_pat_TESTPREFIX1_test_secret_that_must_never_be_returned";
const BASE = new URL("https://sandbox.example.test/api/v1/");

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function options(fetchImpl, extra = {}) {
  return { token: TOKEN, baseUrl: BASE, fetchImpl, ...extra };
}

test("publishes exactly the six approved read-only tools", async () => {
  assert.deepEqual(TOOL_NAMES, [
    "nizlo_dashboard_summary",
    "nizlo_list_customers",
    "nizlo_list_sites",
    "nizlo_list_devices",
    "nizlo_list_alerts",
    "nizlo_stale_endpoints",
  ]);
  const response = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(response.result.tools.map((tool) => tool.name), TOOL_NAMES);
  for (const tool of response.result.tools) {
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
});

test("rejects insecure or credential-bearing base URLs", () => {
  for (const value of [
    "http://app.nizlo.com/api/v1/",
    "https://user:secret@app.nizlo.com/api/v1/",
    "https://app.nizlo.com/api/v1/?token=x",
  ]) {
    assert.throws(() => getBaseUrl({ NIZLO_BASE_URL: value }), ControlledError);
  }
});

test("list device calls use GET, allowed query keys, and bearer auth", async () => {
  let observed;
  const fetchImpl = async (url, init) => {
    observed = { url: new URL(url), init };
    return jsonResponse({ items: [], total: 0, page: 2, pageSize: 25 });
  };
  const result = await callTool(
    "nizlo_list_devices",
    {
      page: 2,
      pageSize: 25,
      search: "HOST-01",
      customerId: "customer-1",
      status: "offline",
      platform: "windows",
    },
    options(fetchImpl),
  );
  assert.equal(result.total, 0);
  assert.equal(observed.init.method, "GET");
  assert.equal(observed.init.redirect, "manual");
  assert.equal(observed.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(observed.url.pathname, "/api/v1/devices");
  assert.deepEqual([...observed.url.searchParams.keys()].sort(), [
    "customerId",
    "page",
    "pageSize",
    "platform",
    "search",
    "status",
  ]);
});

test("each simple tool maps to its one approved GET route", async () => {
  const cases = [
    ["nizlo_dashboard_summary", {}, "/api/v1/dashboard/summary", []],
    ["nizlo_list_customers", { page: 3, pageSize: 10, search: "Acme" }, "/api/v1/customers", ["page", "pageSize", "search"]],
    ["nizlo_list_sites", { customerId: "customer-1" }, "/api/v1/sites", ["customerId", "page", "pageSize"]],
    ["nizlo_list_alerts", { status: "ACTIVE", severity: "CRITICAL" }, "/api/v1/alerts", ["page", "pageSize", "severity", "status"]],
  ];

  for (const [name, args, pathname, queryKeys] of cases) {
    let observed;
    const result = await callTool(name, args, options(async (url, init) => {
      observed = { url: new URL(url), init };
      return jsonResponse({ route: pathname });
    }));
    assert.equal(result.route, pathname);
    assert.equal(observed.init.method, "GET");
    assert.equal(observed.init.redirect, "manual");
    assert.equal(observed.url.pathname, pathname);
    assert.deepEqual([...observed.url.searchParams.keys()].sort(), queryKeys);
  }
});

test("rejects unknown arguments before sending a request", async () => {
  let calls = 0;
  await assert.rejects(
    () => callTool("nizlo_list_customers", { page: 1, tenantId: "other" }, options(async () => {
      calls += 1;
      return jsonResponse({});
    })),
    /Unsupported argument/,
  );
  assert.equal(calls, 0);
});

test("rejects redirects without replaying the authorization header", async () => {
  let calls = 0;
  await assert.rejects(
    () => requestJson("customers", new URLSearchParams(), options(async () => {
      calls += 1;
      return new Response("", { status: 302, headers: { location: "https://evil.example/steal" } });
    })),
    (error) => error.code === "REDIRECT_REJECTED",
  );
  assert.equal(calls, 1);
});

test("redacts bearer credentials from API errors", async () => {
  await assert.rejects(
    () => requestJson("customers", new URLSearchParams(), options(async () =>
      jsonResponse(
        { message: `Authorization: Bearer ${TOKEN}` },
        { status: 401, statusText: "Unauthorized" },
      ),
    )),
    (error) => {
      assert.equal(error.code, "HTTP_401");
      assert.ok(!error.message.includes(TOKEN));
      assert.ok(!error.message.includes("nizlo_pat_"));
      return true;
    },
  );
});

test("surfaces a controlled permission failure for a narrow token", async () => {
  await assert.rejects(
    () => callTool("nizlo_list_alerts", {}, options(async () =>
      jsonResponse(
        { message: "Missing required permission: alerts.view" },
        { status: 403, statusText: "Forbidden" },
      ),
    )),
    (error) =>
      error.code === "HTTP_403" &&
      /alerts\.view/.test(error.message) &&
      !error.message.includes(TOKEN),
  );
});

test("rejects invalid UTF-8 before parsing JSON", async () => {
  await assert.rejects(
    () => requestJson("customers", new URLSearchParams(), options(async () =>
      new Response(Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )),
    (error) => error.code === "INVALID_RESPONSE" && /UTF-8/.test(error.message),
  );
});

test("rejects oversized responses before reading the body", async () => {
  let bodyRead = false;
  const response = {
    status: 200,
    ok: true,
    headers: new Headers({ "content-length": "2000001" }),
    arrayBuffer: async () => {
      bodyRead = true;
      return new ArrayBuffer(0);
    },
  };
  await assert.rejects(
    () => requestJson("customers", new URLSearchParams(), options(async () => response)),
    (error) => error.code === "RESPONSE_TOO_LARGE",
  );
  assert.equal(bodyRead, false);
});

test("normalizes request timeouts without exposing credentials", async () => {
  await assert.rejects(
    () => requestJson("customers", new URLSearchParams(), options(async () => {
      throw new DOMException(`Bearer ${TOKEN}`, "AbortError");
    })),
    (error) => error.code === "TIMEOUT" && !error.message.includes(TOKEN),
  );
});

test("honors a bounded Retry-After then retries serially", async () => {
  let calls = 0;
  const waits = [];
  const result = await requestJson(
    "customers",
    new URLSearchParams(),
    options(
      async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({ message: "slow down" }), {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "1" },
          });
        }
        return jsonResponse({ items: [], total: 0, page: 1, pageSize: 50 });
      },
      { now: () => 1_000, sleep: async (ms) => waits.push(ms), deadline: 120_000 },
    ),
  );
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1_000]);
  assert.equal(result.total, 0);
});

test("rejects Retry-After values above the safety bound", async () => {
  await assert.rejects(
    () => requestJson("customers", new URLSearchParams(), options(async () =>
      new Response("{}", { status: 429, headers: { "retry-after": "31" } }),
    )),
    (error) => error.code === "INCOMPLETE_SCAN",
  );
});

test("stale scan groups same-named customers by immutable ID", async () => {
  const pages = [
    {
      items: [
        {
          id: "device-1",
          hostname: "A-OLD",
          displayName: "A old",
          lastSeenAt: "2026-10-01T00:00:00.000Z",
          customerId: "customer-a",
          customer: { name: "Shared name" },
          siteId: "site-a",
          site: { name: "Main" },
          inventory: { osName: "Windows 11" },
        },
        {
          id: "device-2",
          hostname: "A-NEW",
          lastSeenAt: "2026-11-04T12:00:00.000Z",
          customerId: "customer-a",
          customer: { name: "Shared name" },
        },
      ],
      total: 3,
      page: 1,
      pageSize: 2,
    },
    {
      items: [
        {
          id: "device-3",
          hostname: "B-NEVER",
          lastSeenAt: null,
          customerId: "customer-b",
          customer: { name: "Shared name" },
          inventory: { osName: "Windows Server 2025" },
        },
      ],
      total: 3,
      page: 2,
      pageSize: 2,
    },
  ];
  let calls = 0;
  const report = await staleEndpoints(
    { days: 7, pageSize: 2 },
    options(async () => jsonResponse(pages[calls++]), {
      now: () => Date.parse("2026-11-05T12:00:00.000Z"),
    }),
  );
  assert.equal(calls, 2);
  assert.equal(report.inventoryEndpoints, 3);
  assert.equal(report.staleEndpoints, 2);
  assert.equal(report.completeness, "unverified_no_snapshot");
  assert.deepEqual(report.customers.map((group) => group.customerId), ["customer-a", "customer-b"]);
  assert.equal(report.customers[0].endpoints[0].operatingSystem, "Windows 11");
  assert.equal(report.customers[1].endpoints[0].state, "never_seen");
});

test("stale scan fails closed on duplicate IDs", async () => {
  const pages = [
    { items: [{ id: "same", lastSeenAt: null }], total: 2, page: 1, pageSize: 1 },
    { items: [{ id: "same", lastSeenAt: null }], total: 2, page: 2, pageSize: 1 },
  ];
  let calls = 0;
  await assert.rejects(
    () => staleEndpoints(
      { pageSize: 1 },
      options(async () => jsonResponse(pages[calls++]), { now: () => Date.parse("2026-11-05T12:00:00Z") }),
    ),
    (error) => error.code === "INCOMPLETE_SCAN" && /repeated an endpoint/.test(error.message),
  );
});

test("stale scan fails closed when totals drift", async () => {
  const pages = [
    { items: [{ id: "one", lastSeenAt: null }], total: 2, page: 1, pageSize: 1 },
    { items: [{ id: "two", lastSeenAt: null }], total: 3, page: 2, pageSize: 1 },
  ];
  let calls = 0;
  await assert.rejects(
    () => staleEndpoints(
      { pageSize: 1 },
      options(async () => jsonResponse(pages[calls++]), { now: () => Date.parse("2026-11-05T12:00:00Z") }),
    ),
    (error) => error.code === "INCOMPLETE_SCAN" && /changed during/.test(error.message),
  );
});

test("JSON-RPC tool errors are bounded and do not expose tokens", async () => {
  const previous = process.env.NIZLO_API_TOKEN;
  process.env.NIZLO_API_TOKEN = TOKEN;
  process.env.NIZLO_BASE_URL = "http://insecure.example/api/v1/";
  try {
    const response = await handleMessage({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "nizlo_dashboard_summary", arguments: {} },
    });
    assert.equal(response.result.isError, true);
    assert.ok(response.result.content[0].text.length < 600);
    assert.ok(!response.result.content[0].text.includes(TOKEN));
  } finally {
    if (previous == null) delete process.env.NIZLO_API_TOKEN;
    else process.env.NIZLO_API_TOKEN = previous;
    delete process.env.NIZLO_BASE_URL;
  }
});
