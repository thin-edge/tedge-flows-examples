import { expect, test, describe, beforeEach, jest } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";

const t0 = new Date("2026-09-24T18:00:00.000Z");
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

const baseConfig: flow.Config = {
  deployment_key: "demo",
  device_id: "device01",
  interval: "24h",
  startup_delay: "5m",
  retry_min: "5m",
  max_attempts: "3",
  assigned_timeout: "1h",
};

const topics = flow.topics(flow.getSettings(baseConfig));
const PATH =
  "/c8y/service/deployment-device-proxy/deployments/demo/targetstates/active/evaluate";

function at(ms: number): Date {
  return new Date(t0.getTime() + ms);
}

function msg(
  topic: string,
  payload: object | string,
  time = t0,
): tedge.Message {
  return {
    time,
    topic,
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
  };
}

function result(
  id: string,
  response: object | undefined,
  error?: string,
): string {
  return JSON.stringify(
    error === undefined
      ? { id, path: PATH, ok: true, response: JSON.stringify(response) }
      : { id, path: PATH, ok: false, error },
  );
}

function find(out: tedge.Message[], topic: string): tedge.Message | undefined {
  return out.find((m) => m.topic === topic);
}

function requestOf(out: tedge.Message[]): flow.RequestSpec {
  const m = find(out, topics.request);
  expect(m).toBeDefined();
  expect(m!.mqtt).toEqual({ retain: true, qos: 1 });
  return flow.parseRequest(tedge.decodePayload(m!.payload))!;
}

beforeEach(() => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});

describe("settings", () => {
  test("defaults", () => {
    const s = flow.getSettings({ deployment_key: "demo" });
    expect(s.targetState).toBe("active");
    expect(s.interval).toBe(24 * HOUR);
    expect(s.maxAttempts).toBe(3);
    expect(s.mode).toBe("client");
    expect(s.allowPreview).toBe(false);
    expect(s.waitForContext).toBe(false);
  });

  test("unset params are treated as defaults", () => {
    const s = flow.getSettings({
      deployment_key: "demo",
      target_state: "null",
      priority: "",
      context_file: "",
      interval: "",
    });
    expect(s.targetState).toBe("active");
    expect(s.interval).toBe(24 * HOUR);
    expect(s.waitForContext).toBe(false);
  });

  test.each([
    ["30s", 30 * SEC],
    ["5m", 5 * MIN],
    ["24h", 24 * HOUR],
    ["1d", 24 * HOUR],
    ["90", 90 * SEC],
    [120, 120 * SEC],
    ["500ms", 500],
    ["bogus", 42],
  ])("parse duration %s", (value, expected) => {
    expect(flow.parseDuration(value, 42)).toBe(expected);
  });

  test.each([
    ["demo", true],
    ["eu_west-1", true],
    ["eu/west.1", false],
    ["", false],
    ["a".repeat(129), false],
  ])("key %s valid=%s", (key, valid) => {
    expect(flow.isValidKey(key)).toBe(valid);
  });
});

describe("request building", () => {
  test("default path", () => {
    const s = flow.getSettings(baseConfig);
    expect(flow.buildPath(s, "dry")).toBe(PATH);
    expect(flow.buildPath(s, "create")).toBe(`${PATH}?createOperation=true`);
  });

  test("custom target state is url encoded", () => {
    const s = flow.getSettings({ ...baseConfig, target_state: "13.6 beta" });
    expect(flow.buildPath(s, "dry")).toMatch(
      /\/targetstates\/13.6%20beta\/evaluate$/,
    );
  });

  test("server mode adds the conditional query", () => {
    const s = flow.getSettings({
      ...baseConfig,
      operation_request: "server",
      server_query: "?onlyIfChanged=true",
    });
    expect(flow.buildPath(s, "server")).toBe(
      `${PATH}?createOperation=true&onlyIfChanged=true`,
    );
  });

  test("context params and file are merged", () => {
    expect(
      JSON.parse(
        flow.buildBody(
          { arch: "arm64", type: "basic" },
          '{"type":"deluxe"}',
          "",
        ),
      ),
    ).toEqual({ arch: "arm64", type: "deluxe" });
  });

  test("context given as JSON string", () => {
    expect(flow.buildBody('{"arch":"arm64"}', undefined, undefined)).toBe(
      '{"arch":"arm64"}',
    );
  });

  test("priority is added as an integer", () => {
    expect(JSON.parse(flow.buildBody({}, undefined, "100"))).toEqual({
      priority: 100,
    });
    expect(JSON.parse(flow.buildBody({}, undefined, 7))).toEqual({
      priority: 7,
    });
  });

  test.each([[""], ["null"], [undefined], ["abc"], ["-1"]])(
    "priority %s is not sent",
    (priority) => {
      expect(flow.buildBody({}, undefined, priority)).toBe("{}");
    },
  );

  test("priority in the context is ignored", () => {
    expect(flow.buildBody({ priority: "1" }, '{"priority":2}', "")).toBe("{}");
  });

  test("non string values are dropped", () => {
    expect(flow.buildBody({ arch: "arm64" }, '{"cores":4}', "")).toBe(
      '{"arch":"arm64"}',
    );
  });

  test("invalid context file is ignored", () => {
    expect(flow.buildBody({ arch: "arm64" }, "{not json", "")).toBe(
      '{"arch":"arm64"}',
    );
    expect(flow.buildBody({}, "[1,2]", "")).toBe("{}");
  });

  test("request line round trip, the body can contain spaces", () => {
    const spec: flow.RequestSpec = {
      due: 1790000000,
      expires: 0,
      id: "abc-1",
      path: PATH,
      body: '{"model":"Raspberry Pi 5"}',
    };
    const line = flow.formatRequest(spec);
    expect(line).toBe(`1790000000 0 abc-1 ${PATH} {"model":"Raspberry Pi 5"}`);
    expect(flow.parseRequest(line)).toEqual(spec);
  });

  test("invalid request line", () => {
    expect(flow.parseRequest("")).toBeUndefined();
    expect(flow.parseRequest("soon abc")).toBeUndefined();
  });
});

describe("scheduling", () => {
  const s = flow.getSettings(baseConfig);

  test("slot is deterministic and in the future", () => {
    const now = t0.getTime();
    const a = flow.nextSlot(now, s);
    expect(a).toBe(flow.nextSlot(now, s));
    expect(a).toBeGreaterThan(now);
    expect(a - now).toBeLessThanOrEqual(s.interval);
    // the next slot is exactly one interval later
    expect(flow.nextSlot(a, s)).toBe(a + s.interval);
  });

  test("slot is the same time of the interval, regardless of when it is computed", () => {
    const a = flow.nextSlot(t0.getTime(), s);
    const b = flow.nextSlot(t0.getTime() + 3 * HOUR, s);
    expect((b - a) % s.interval).toBe(0);
  });

  test("devices are spread", () => {
    const slots = new Set(
      Array.from({ length: 20 }, (_, i) =>
        flow.nextSlot(
          t0.getTime(),
          flow.getSettings({ ...baseConfig, device_id: `device${i}` }),
        ),
      ),
    );
    expect(slots.size).toBeGreaterThan(15);
  });

  test("startup due is within the startup delay", () => {
    const now = t0.getTime();
    const due = flow.startupDue(now, s);
    expect(due).toBeGreaterThanOrEqual(now);
    expect(due).toBeLessThan(now + 5 * MIN);
  });

  test("backoff doubles up to the interval", () => {
    expect(flow.backoffDelay(1, s)).toBe(5 * MIN);
    expect(flow.backoffDelay(2, s)).toBe(10 * MIN);
    expect(flow.backoffDelay(3, s)).toBe(20 * MIN);
    expect(flow.backoffDelay(20, s)).toBe(24 * HOUR);
  });
});

describe("evaluation parsing", () => {
  test("available", () => {
    const e = flow.parseEvaluation(
      result("1", {
        available: true,
        deploymentKey: "demo",
        version: "13.6",
        priority: 100,
        payload: {},
      }),
    );
    expect(e).toEqual({
      id: "1",
      ok: true,
      available: true,
      version: "13.6",
      priority: 100,
      reason: undefined,
      operationCreated: undefined,
    });
  });

  test("not available", () => {
    const e = flow.parseEvaluation(
      result("1", {
        available: false,
        reason: "threshold.exceeded",
        priority: 42,
      }),
    );
    expect(e).toMatchObject({
      ok: true,
      available: false,
      reason: "threshold.exceeded",
      priority: 42,
    });
  });

  test("http error status is extracted", () => {
    const e = flow.parseEvaluation(
      result(
        "1",
        undefined,
        "Error: failed to POST http://127.0.0.1:8001/c8y/... Caused by:     HTTP client error: 404 Not Found     {}",
      ),
    );
    expect(e).toMatchObject({ ok: false, status: 404 });
    expect(flow.isRetryable(e!)).toBe(false);
  });

  test.each([
    ["HTTP server error: 502 Bad Gateway", true],
    ["HTTP client error: 401 Unauthorized", true],
    ["HTTP client error: 400 Bad Request", false],
    ["Connection refused", true],
  ])("%s retryable=%s", (error, retryable) => {
    const e = flow.parseEvaluation(result("1", undefined, error))!;
    expect(flow.isRetryable(e)).toBe(retryable);
  });

  test("invalid response json", () => {
    const e = flow.parseEvaluation(
      JSON.stringify({ id: "1", ok: true, response: "<html>" }),
    );
    expect(e).toMatchObject({ ok: false });
  });

  test("not a poll result", () => {
    expect(flow.parseEvaluation("garbage")).toBeUndefined();
    expect(flow.parseEvaluation("{}")).toBeUndefined();
  });
});

describe("decide", () => {
  const s = flow.getSettings(baseConfig);
  const now = t0.getTime();
  const available = (version = "13.6"): flow.Evaluation => ({
    id: "1",
    ok: true,
    available: true,
    version,
    priority: 100,
  });
  const recently = at(-10 * MIN).toISOString();
  const longAgo = at(-2 * HOUR).toISOString();

  test.each<[string, flow.Evaluation, flow.Twins, flow.PollState, string]>([
    [
      "not available",
      { id: "1", ok: true, available: false, reason: "threshold.exceeded" },
      {},
      {},
      "schedule",
    ],
    ["new version", available(), {}, {}, "create"],
    [
      "new version after an older one",
      available("13.7"),
      {
        membership: { version: "13.6" },
        state: { version: "13.6", state: "SUCCESS" },
      },
      { version: "13.6", attempts: 1 },
      "create",
    ],
    [
      "already applied",
      available(),
      {
        membership: { version: "13.6" },
        state: { version: "13.6", state: "SUCCESS" },
      },
      {},
      "schedule",
    ],
    ...["ASSIGNED", "PENDING", "CONFIRMED", "IN_PROGRESS"].map(
      (state) =>
        [
          `in flight (${state})`,
          available(),
          { state: { version: "13.6", state, updatedAt: recently } },
          { version: "13.6", attempts: 1 },
          "schedule",
        ] as [string, flow.Evaluation, flow.Twins, flow.PollState, string],
    ),
    [
      "other version in flight",
      available("13.7"),
      { state: { version: "13.6", state: "IN_PROGRESS", updatedAt: recently } },
      {},
      "schedule",
    ],
    [
      "stale assignment",
      available(),
      { state: { version: "13.6", state: "ASSIGNED", updatedAt: longAgo } },
      { version: "13.6", attempts: 1 },
      "create",
    ],
    [
      "stale assignment, cap reached",
      available(),
      { state: { version: "13.6", state: "ASSIGNED", updatedAt: longAgo } },
      { version: "13.6", attempts: 3 },
      "give-up",
    ],
    [
      "retry after failure",
      available(),
      { state: { version: "13.6", state: "FAILURE" } },
      { version: "13.6", attempts: 1 },
      "create",
    ],
    [
      "failure cap reached",
      available(),
      { state: { version: "13.6", state: "FAILURE" } },
      { version: "13.6", attempts: 3 },
      "give-up",
    ],
    [
      "new version resets attempts",
      available("13.7"),
      { state: { version: "13.6", state: "FAILURE" } },
      { version: "13.6", attempts: 3 },
      "create",
    ],
    [
      "retryable error",
      { id: "1", ok: false, error: "HTTP server error: 502", status: 502 },
      {},
      {},
      "backoff",
    ],
    [
      "unknown deployment",
      { id: "1", ok: false, error: "HTTP client error: 404", status: 404 },
      {},
      {},
      "schedule",
    ],
  ])("dry run: %s", (_, evaluation, twins, poll, action) => {
    expect(flow.decide(evaluation, "dry", twins, poll, s, now).action).toBe(
      action,
    );
  });

  test("create response records the assignment", () => {
    expect(flow.decide(available("13.7"), "create", {}, {}, s, now)).toEqual({
      action: "assigned",
      version: "13.7",
    });
  });

  test("rollout paused between the calls", () => {
    const d = flow.decide(
      { id: "1", ok: true, available: false, reason: "deployment.paused" },
      "create",
      {},
      {},
      s,
      now,
    );
    expect(d.action).toBe("schedule");
  });

  test("preview target state never creates an operation", () => {
    const preview = flow.getSettings({ ...baseConfig, target_state: "latest" });
    expect(flow.decide(available(), "dry", {}, {}, preview, now).action).toBe(
      "schedule",
    );
    const allowed = flow.getSettings({
      ...baseConfig,
      target_state: "latest",
      allow_preview: "true",
    });
    expect(flow.decide(available(), "dry", {}, {}, allowed, now).action).toBe(
      "create",
    );
    const upper = flow.getSettings({ ...baseConfig, target_state: "ACTIVE" });
    expect(flow.decide(available(), "dry", {}, {}, upper, now).action).toBe(
      "create",
    );
  });

  test("server mode only records the assignment if an operation was created", () => {
    const server = flow.getSettings({
      ...baseConfig,
      operation_request: "server",
    });
    expect(
      flow.decide(
        { ...available(), operationCreated: true },
        "server",
        {},
        {},
        server,
        now,
      ).action,
    ).toBe("assigned");
    expect(flow.decide(available(), "server", {}, {}, server, now).action).toBe(
      "schedule",
    );
  });
});

describe("membership", () => {
  test("first poll", () => {
    expect(flow.membershipUpdate(undefined, 42, "demo")).toEqual({
      deploymentKey: "demo",
      priority: 42,
    });
  });

  test("keeps the applied version", () => {
    expect(
      flow.membershipUpdate(
        {
          deploymentKey: "demo",
          priority: 42,
          version: "13.5",
          assignedAt: "2026-09-01T00:00:00Z",
        },
        50,
        "demo",
      ),
    ).toEqual({
      deploymentKey: "demo",
      priority: 50,
      version: "13.5",
      assignedAt: "2026-09-01T00:00:00Z",
    });
  });

  test("unchanged priority", () => {
    expect(
      flow.membershipUpdate(
        { deploymentKey: "demo", priority: 42 },
        42,
        "demo",
      ),
    ).toBeUndefined();
  });
});

describe("flow", () => {
  function started(config: flow.Config = baseConfig): flow.FlowContext {
    const context = tedge.createContext(config) as flow.FlowContext;
    flow.onStartup(t0, context);
    return context;
  }

  test("invalid key publishes nothing", () => {
    const context = started({ ...baseConfig, deployment_key: "eu/west.1" });
    expect(flow.onInterval(at(1 * MIN), context)).toEqual([]);
  });

  test("first install schedules a dry run within the startup delay", () => {
    const context = started();
    // wait for the retained messages first
    expect(flow.onInterval(at(1 * SEC), context)).toEqual([]);

    const out = flow.onInterval(at(10 * SEC), context);
    const spec = requestOf(out);
    expect(spec.path).toBe(PATH);
    expect(spec.body).toBe("{}");
    expect(spec.expires).toBe(0);
    expect(spec.due * 1000).toBeGreaterThanOrEqual(
      at(10 * SEC).getTime() - 1000,
    );
    expect(spec.due * 1000).toBeLessThan(at(10 * SEC + 5 * MIN).getTime());

    // nothing more to do
    expect(flow.onInterval(at(20 * SEC), context)).toEqual([]);
  });

  test("existing retained request is kept after a restart", () => {
    const context = started();
    const line = `${Math.floor(at(2 * HOUR).getTime() / 1000)} 0 old-1 ${PATH} {}`;
    expect(flow.onMessage(msg(topics.request, line), context)).toEqual([]);
    expect(flow.onInterval(at(10 * SEC), context)).toEqual([]);
  });

  test("waits for the context file", () => {
    const context = started({
      ...baseConfig,
      context: { arch: "arm64" },
      context_file: "/etc/tedge/device-context.json",
    });
    expect(flow.onInterval(at(10 * SEC), context)).toEqual([]);

    const out = flow.onMessage(
      msg(topics.context, '{"type":"deluxe"}', at(12 * SEC)),
      context,
    );
    expect(JSON.parse(requestOf(out).body)).toEqual({
      arch: "arm64",
      type: "deluxe",
    });
  });

  test("gives up waiting for the context file", () => {
    const context = started({
      ...baseConfig,
      context_file: "/etc/tedge/missing.json",
    });
    expect(flow.onInterval(at(10 * SEC), context)).toEqual([]);
    expect(requestOf(flow.onInterval(at(31 * SEC), context)).body).toBe("{}");
  });

  test("pending request is updated when the context changes", () => {
    const context = started();
    const due = Math.floor(at(2 * HOUR).getTime() / 1000);
    flow.onMessage(msg(topics.request, `${due} 0 old-1 ${PATH} {}`), context);

    const out = flow.onMessage(
      msg(topics.context, '{"arch":"arm64"}', at(10 * SEC)),
      context,
    );
    const spec = requestOf(out);
    expect(spec.body).toBe('{"arch":"arm64"}');
    expect(spec.due).toBe(due);
    expect(spec.id).not.toBe("old-1");
  });

  test("a due request is not changed, as poll.sh might be executing it", () => {
    const context = started();
    const due = Math.floor(at(5 * SEC).getTime() / 1000);
    flow.onMessage(
      msg(topics.request, `${due} 0 due-1 ${PATH}?createOperation=true {}`),
      context,
    );
    expect(
      flow.onMessage(
        msg(topics.context, '{"arch":"arm64"}', at(10 * SEC)),
        context,
      ),
    ).toEqual([]);
  });

  test("unanswered request is replaced by a new dry run", () => {
    const context = started();
    const due = Math.floor(at(-1 * HOUR).getTime() / 1000);
    flow.onMessage(
      msg(topics.request, `${due} 0 lost-1 ${PATH}?createOperation=true {}`),
      context,
    );
    // after a restart, poll.sh first gets a chance to execute the overdue request
    expect(flow.onInterval(at(10 * SEC), context)).toEqual([]);

    const spec = requestOf(flow.onInterval(at(6 * MIN), context));
    expect(spec.path).toBe(PATH);
    expect(spec.id).not.toBe("lost-1");
  });

  test("full cycle: dry run, create, assigned, success, in sync", () => {
    const context = started({ ...baseConfig, priority: "100" });
    flow.onMessage(
      msg(topics.membership, {
        deploymentKey: "demo",
        priority: 100,
        version: "13.5",
      }),
      context,
    );

    // initial request
    const dry = requestOf(flow.onInterval(at(10 * SEC), context));
    expect(dry.body).toBe('{"priority":100}');

    // dry run: a new version is available
    let out = flow.onMessage(
      msg(
        topics.response,
        result(dry.id, {
          available: true,
          deploymentKey: "demo",
          version: "13.6",
          priority: 100,
          payload: {},
        }),
        at(5 * MIN),
      ),
      context,
    );
    const create = requestOf(out);
    expect(create.path).toBe(`${PATH}?createOperation=true`);
    expect(create.due * 1000).toBeLessThanOrEqual(at(5 * MIN).getTime());
    expect(create.expires * 1000).toBeGreaterThan(at(5 * MIN).getTime());
    // no twin changes yet, the priority did not change
    expect(find(out, topics.deploymentState)).toBeUndefined();
    expect(find(out, topics.membership)).toBeUndefined();

    // operation requested
    out = flow.onMessage(
      msg(
        topics.response,
        result(create.id, {
          available: true,
          deploymentKey: "demo",
          version: "13.6",
          priority: 100,
          payload: {},
        }),
        at(6 * MIN),
      ),
      context,
    );
    const assigned = find(out, topics.deploymentState)!;
    expect(assigned.mqtt).toEqual({ retain: true, qos: 1 });
    expect(tedge.decodeJsonPayload(assigned.payload)).toEqual({
      deploymentKey: "demo",
      version: "13.6",
      state: "ASSIGNED",
      updatedAt: at(6 * MIN).toISOString(),
    });
    expect(
      tedge.decodeJsonPayload(find(out, topics.state)!.payload),
    ).toMatchObject({ version: "13.6", attempts: 1, lastRequestId: create.id });
    let next = requestOf(out);
    expect(next.path).toBe(PATH);
    expect(next.due * 1000).toBeGreaterThan(at(6 * MIN).getTime());

    // the operation arrives and is applied (published by c8y-deploy-status)
    flow.onMessage(
      msg(topics.deploymentState, {
        deploymentKey: "demo",
        version: "13.6",
        state: "SUCCESS",
      }),
      context,
    );
    flow.onMessage(
      msg(topics.membership, {
        deploymentKey: "demo",
        priority: 100,
        version: "13.6",
      }),
      context,
    );

    // next poll: in sync
    out = flow.onMessage(
      msg(
        topics.response,
        result(next.id, {
          available: true,
          deploymentKey: "demo",
          version: "13.6",
          priority: 100,
          payload: {},
        }),
        at(25 * HOUR),
      ),
      context,
    );
    expect(find(out, topics.deploymentState)).toBeUndefined();
    next = requestOf(out);
    expect(next.path).toBe(PATH);
    expect(next.due * 1000).toBeGreaterThan(at(25 * HOUR).getTime());
  });

  test("in flight deployment is not requested again", () => {
    const context = started();
    flow.onMessage(
      msg(topics.deploymentState, {
        deploymentKey: "demo",
        version: "13.6",
        state: "IN_PROGRESS",
        updatedAt: t0.toISOString(),
      }),
      context,
    );
    const dry = requestOf(flow.onInterval(at(10 * SEC), context));
    const out = flow.onMessage(
      msg(
        topics.response,
        result(dry.id, { available: true, version: "13.6", priority: 1 }),
        at(5 * MIN),
      ),
      context,
    );
    expect(requestOf(out).path).toBe(PATH);
  });

  test("retry after failure increments the attempts", () => {
    const context = started();
    flow.onMessage(
      msg(topics.state, { version: "13.6", attempts: 1 }),
      context,
    );
    flow.onMessage(
      msg(topics.deploymentState, { version: "13.6", state: "FAILURE" }),
      context,
    );
    const dry = requestOf(flow.onInterval(at(10 * SEC), context));
    const create = requestOf(
      flow.onMessage(
        msg(
          topics.response,
          result(dry.id, { available: true, version: "13.6" }),
          at(1 * MIN),
        ),
        context,
      ),
    );
    const out = flow.onMessage(
      msg(
        topics.response,
        result(create.id, { available: true, version: "13.6" }),
        at(2 * MIN),
      ),
      context,
    );
    expect(
      tedge.decodeJsonPayload(find(out, topics.state)!.payload),
    ).toMatchObject({
      version: "13.6",
      attempts: 2,
    });
  });

  describe("reset", () => {
    const resetTopic = "tedge-flows/c8y-deploy-poll/demo/reset";

    // Give up on 13.6 after 3 attempts, return the next (regular) request
    function gaveUp(context: flow.FlowContext): flow.RequestSpec {
      flow.onMessage(
        msg(topics.state, { version: "13.6", attempts: 3, failures: 1 }),
        context,
      );
      flow.onMessage(
        msg(topics.deploymentState, { version: "13.6", state: "FAILURE" }),
        context,
      );
      const dry = requestOf(flow.onInterval(at(10 * SEC), context));
      const next = requestOf(
        flow.onMessage(
          msg(
            topics.response,
            result(dry.id, { available: true, version: "13.6" }),
            at(1 * MIN),
          ),
          context,
        ),
      );
      expect(next.path).toBe(PATH);
      expect(next.due * 1000).toBeGreaterThan(at(1 * HOUR).getTime());
      return next;
    }

    test("requests the version again after giving up", () => {
      const context = started();
      gaveUp(context);

      const out = flow.onMessage(msg(resetTopic, "{}", at(2 * MIN)), context);
      // a retained reset is cleared
      expect(find(out, resetTopic)).toEqual({
        time: at(2 * MIN),
        topic: resetTopic,
        payload: "",
        mqtt: { retain: true, qos: 1 },
      });
      expect(
        tedge.decodeJsonPayload(find(out, topics.state)!.payload),
      ).toMatchObject({ version: "13.6", attempts: 0, failures: 0 });

      // a dry run is scheduled now
      const dry = requestOf(out);
      expect(dry.path).toBe(PATH);
      expect(dry.due).toBe(Math.floor(at(2 * MIN).getTime() / 1000));

      const create = requestOf(
        flow.onMessage(
          msg(
            topics.response,
            result(dry.id, { available: true, version: "13.6" }),
            at(3 * MIN),
          ),
          context,
        ),
      );
      expect(create.path).toBe(`${PATH}?createOperation=true`);
      const assigned = flow.onMessage(
        msg(
          topics.response,
          result(create.id, { available: true, version: "13.6" }),
          at(4 * MIN),
        ),
        context,
      );
      expect(
        tedge.decodeJsonPayload(find(assigned, topics.state)!.payload),
      ).toMatchObject({ version: "13.6", attempts: 1 });
    });

    test("an empty payload is ignored", () => {
      const context = started();
      gaveUp(context);
      expect(flow.onMessage(msg(resetTopic, "", at(2 * MIN)), context)).toEqual(
        [],
      );
    });

    test("a due request is not replaced", () => {
      const context = started();
      flow.onMessage(
        msg(topics.state, { version: "13.6", attempts: 3 }),
        context,
      );
      const due = Math.floor(at(5 * SEC).getTime() / 1000);
      flow.onMessage(msg(topics.request, `${due} 0 due-1 ${PATH} {}`), context);

      const out = flow.onMessage(msg(resetTopic, "{}", at(10 * SEC)), context);
      expect(find(out, topics.request)).toBeUndefined();
      expect(
        tedge.decodeJsonPayload(find(out, topics.state)!.payload),
      ).toMatchObject({ attempts: 0 });
    });
  });

  test("first poll publishes the membership", () => {
    const context = started();
    const dry = requestOf(flow.onInterval(at(10 * SEC), context));
    const out = flow.onMessage(
      msg(
        topics.response,
        result(dry.id, {
          available: false,
          reason: "threshold.exceeded",
          priority: 42,
        }),
        at(1 * MIN),
      ),
      context,
    );
    expect(
      tedge.decodeJsonPayload(find(out, topics.membership)!.payload),
    ).toEqual({
      deploymentKey: "demo",
      priority: 42,
    });
    expect(find(out, topics.deploymentState)).toBeUndefined();
  });

  test("failed create request falls back to a dry run with backoff", () => {
    const context = started();
    const dry = requestOf(flow.onInterval(at(10 * SEC), context));
    const create = requestOf(
      flow.onMessage(
        msg(
          topics.response,
          result(dry.id, { available: true, version: "13.6" }),
          at(1 * MIN),
        ),
        context,
      ),
    );
    const out = flow.onMessage(
      msg(
        topics.response,
        result(create.id, undefined, "HTTP server error: 502 Bad Gateway"),
        at(2 * MIN),
      ),
      context,
    );
    const next = requestOf(out);
    expect(next.path).toBe(PATH);
    expect(next.due * 1000).toBe(at(7 * MIN).getTime());
    expect(find(out, topics.deploymentState)).toBeUndefined();
    expect(find(out, topics.membership)).toBeUndefined();
  });

  test("results of old requests are ignored", () => {
    const context = started();
    requestOf(flow.onInterval(at(10 * SEC), context));
    expect(
      flow.onMessage(
        msg(
          topics.response,
          result("other", { available: true, version: "1" }),
        ),
        context,
      ),
    ).toEqual([]);
  });

  test("server mode sends a single request", () => {
    const context = started({
      ...baseConfig,
      operation_request: "server",
      server_query: "onlyIfChanged=true",
    });
    const spec = requestOf(flow.onInterval(at(10 * SEC), context));
    expect(spec.path).toBe(`${PATH}?createOperation=true&onlyIfChanged=true`);
    expect(spec.expires).toBe(0);

    const out = flow.onMessage(
      msg(
        topics.response,
        result(spec.id, {
          available: true,
          version: "13.6",
          operationCreated: true,
        }),
        at(1 * MIN),
      ),
      context,
    );
    expect(
      tedge.decodeJsonPayload(find(out, topics.deploymentState)!.payload),
    ).toMatchObject({
      version: "13.6",
      state: "ASSIGNED",
    });
    expect(requestOf(out).path).toBe(spec.path);
  });
});

describe("events", () => {
  const eventTopic = "te/device/main///e/c8y_DeploymentPoll";

  function started(events: string, config: flow.Config = {}): flow.FlowContext {
    const context = tedge.createContext({
      ...baseConfig,
      ...config,
      events,
    }) as flow.FlowContext;
    flow.onStartup(t0, context);
    return context;
  }

  // Answer the current request with the given response, return the output
  function answer(
    context: flow.FlowContext,
    id: string,
    response: object | undefined,
    time: Date,
    error?: string,
  ): tedge.Message[] {
    return flow.onMessage(
      msg(topics.response, result(id, response, error), time),
      context,
    );
  }

  function eventOf(out: tedge.Message[]): any {
    const m = find(out, eventTopic);
    if (!m) {
      return undefined;
    }
    expect(m.mqtt?.retain).toBeFalsy();
    return tedge.decodeJsonPayload(m.payload);
  }

  const notAvailable = {
    available: false,
    reason: "threshold.exceeded",
    priority: 42,
  };

  test("off publishes no events", () => {
    const context = started("off");
    const dry = requestOf(flow.onInterval(at(10 * SEC), context));
    expect(
      eventOf(answer(context, dry.id, notAvailable, at(1 * MIN))),
    ).toBeUndefined();
  });

  test("not available event", () => {
    const context = started("changes");
    const dry = requestOf(flow.onInterval(at(10 * SEC), context));
    const out = answer(context, dry.id, notAvailable, at(1 * MIN));
    const next = requestOf(out);
    expect(eventOf(out)).toEqual({
      text: "No update available for deployment demo: the rollout has not reached this device yet",
      time: at(1 * MIN).toISOString(),
      deploymentKey: "demo",
      targetState: "active",
      outcome: "not_available",
      reason: "threshold.exceeded",
      priority: 42,
      nextPollAt: new Date(next.due * 1000).toISOString(),
    });
  });

  test("changes only publishes an event when the outcome changes", () => {
    const context = started("changes");
    let req = requestOf(flow.onInterval(at(10 * SEC), context));

    // first: not available
    let out = answer(context, req.id, notAvailable, at(1 * MIN));
    expect(eventOf(out).outcome).toBe("not_available");
    req = requestOf(out);

    // same outcome again: no event
    out = answer(context, req.id, notAvailable, at(25 * HOUR));
    expect(eventOf(out)).toBeUndefined();
    req = requestOf(out);

    // different reason: event
    out = answer(
      context,
      req.id,
      { available: false, reason: "deployment.paused" },
      at(49 * HOUR),
    );
    expect(eventOf(out)).toMatchObject({
      outcome: "not_available",
      reason: "deployment.paused",
      text: "No update available for deployment demo: the deployment is paused",
    });
    req = requestOf(out);

    // new version: only the operation request is reported
    out = answer(
      context,
      req.id,
      { available: true, version: "13.6" },
      at(73 * HOUR),
    );
    expect(eventOf(out)).toBeUndefined();
    req = requestOf(out);
    out = answer(
      context,
      req.id,
      { available: true, version: "13.6" },
      at(73 * HOUR + MIN),
    );
    expect(eventOf(out)).toMatchObject({
      outcome: "operation_requested",
      version: "13.6",
      attempts: 1,
      text: "Requested the operation to install version 13.6 of deployment demo (attempt 1 of 3)",
    });
  });

  test("the last event survives a restart", () => {
    const context = started("changes");
    const dry = requestOf(flow.onInterval(at(10 * SEC), context));
    const out = answer(context, dry.id, notAvailable, at(1 * MIN));
    const state = find(out, topics.state)!;
    const next = requestOf(out);

    // restart: the retained messages are received again
    const restarted = started("changes");
    flow.onMessage(
      msg(topics.state, tedge.decodePayload(state.payload)),
      restarted,
    );
    flow.onMessage(msg(topics.request, flow.formatRequest(next)), restarted);
    expect(
      eventOf(answer(restarted, next.id, notAvailable, at(25 * HOUR))),
    ).toBeUndefined();
  });

  test("all publishes an event for every evaluation", () => {
    const context = started("all");
    let req = requestOf(flow.onInterval(at(10 * SEC), context));
    let out = answer(context, req.id, notAvailable, at(1 * MIN));
    expect(eventOf(out).outcome).toBe("not_available");
    req = requestOf(out);
    out = answer(context, req.id, notAvailable, at(25 * HOUR));
    expect(eventOf(out).outcome).toBe("not_available");
    req = requestOf(out);
    out = answer(
      context,
      req.id,
      { available: true, version: "13.6" },
      at(49 * HOUR),
    );
    expect(eventOf(out)).toMatchObject({
      outcome: "new_version",
      version: "13.6",
    });
  });

  test("retry of a failed version is reported with the attempt", () => {
    const context = started("changes");
    flow.onMessage(
      msg(topics.state, {
        version: "13.6",
        attempts: 1,
        lastEvent: "operation_requested|13.6|||1",
      }),
      context,
    );
    flow.onMessage(
      msg(topics.deploymentState, { version: "13.6", state: "FAILURE" }),
      context,
    );
    const dry = requestOf(flow.onInterval(at(10 * SEC), context));
    const create = requestOf(
      answer(
        context,
        dry.id,
        { available: true, version: "13.6" },
        at(1 * MIN),
      ),
    );
    const out = answer(
      context,
      create.id,
      { available: true, version: "13.6" },
      at(2 * MIN),
    );
    expect(eventOf(out)).toMatchObject({
      outcome: "operation_requested",
      attempts: 2,
    });
  });

  test("gave up", () => {
    const context = started("changes");
    flow.onMessage(
      msg(topics.state, { version: "13.6", attempts: 3 }),
      context,
    );
    flow.onMessage(
      msg(topics.deploymentState, { version: "13.6", state: "FAILURE" }),
      context,
    );
    const dry = requestOf(flow.onInterval(at(10 * SEC), context));
    const out = answer(
      context,
      dry.id,
      { available: true, version: "13.6" },
      at(1 * MIN),
    );
    expect(eventOf(out)).toMatchObject({
      outcome: "gave_up",
      version: "13.6",
      attempts: 3,
      text: "Version 13.6 of deployment demo failed 3 times. It is not requested again until a new version is available",
    });
  });

  test("reset", () => {
    const context = started("changes");
    flow.onMessage(
      msg(topics.state, { version: "13.6", attempts: 3 }),
      context,
    );
    const dry = requestOf(flow.onInterval(at(10 * SEC), context));
    answer(context, dry.id, { available: true, version: "13.6" }, at(1 * MIN));
    const out = flow.onMessage(
      msg("tedge-flows/c8y-deploy-poll/demo/reset", "{}", at(2 * MIN)),
      context,
    );
    expect(eventOf(out)).toMatchObject({
      outcome: "reset",
      version: "13.6",
      nextPollAt: at(2 * MIN).toISOString(),
      text: "The attempts of deployment demo were reset (version 13.6). Checking again",
    });
  });

  test("in sync and in progress", () => {
    const context = started("all");
    flow.onMessage(
      msg(topics.membership, { deploymentKey: "demo", version: "13.6" }),
      context,
    );
    let req = requestOf(flow.onInterval(at(10 * SEC), context));
    let out = answer(
      context,
      req.id,
      { available: true, version: "13.6" },
      at(1 * MIN),
    );
    expect(eventOf(out)).toMatchObject({
      outcome: "in_sync",
      text: "The device is up to date with version 13.6 of deployment demo",
    });

    flow.onMessage(
      msg(topics.deploymentState, {
        version: "13.7",
        state: "IN_PROGRESS",
        updatedAt: at(1 * HOUR).toISOString(),
      }),
      context,
    );
    req = requestOf(out);
    out = answer(
      context,
      req.id,
      { available: true, version: "13.7" },
      at(2 * HOUR),
    );
    expect(eventOf(out)).toMatchObject({
      outcome: "in_progress",
      version: "13.7",
      state: "IN_PROGRESS",
      text: "Version 13.7 of deployment demo is already being installed (IN_PROGRESS)",
    });
  });

  test("failures are reported once per streak", () => {
    const context = started("changes");
    let req = requestOf(flow.onInterval(at(10 * SEC), context));
    let out = answer(
      context,
      req.id,
      undefined,
      at(1 * MIN),
      "Caused by: HTTP server error: 502 Bad Gateway",
    );
    expect(eventOf(out)).toMatchObject({
      outcome: "request_failed",
      status: 502,
      text: "Could not check deployment demo (HTTP 502), retrying in 5m",
    });
    req = requestOf(out);
    out = answer(
      context,
      req.id,
      undefined,
      at(7 * MIN),
      "Caused by: HTTP server error: 502 Bad Gateway",
    );
    expect(eventOf(out)).toBeUndefined();
    req = requestOf(out);
    out = answer(context, req.id, notAvailable, at(20 * MIN));
    expect(eventOf(out).outcome).toBe("not_available");
  });

  test("client error", () => {
    const context = started("changes");
    const req = requestOf(flow.onInterval(at(10 * SEC), context));
    const out = answer(
      context,
      req.id,
      undefined,
      at(1 * MIN),
      "Caused by: HTTP client error: 404 Not Found",
    );
    expect(eventOf(out)).toMatchObject({
      outcome: "request_error",
      status: 404,
      text: "Could not check deployment demo (HTTP 404): the deployment or target state does not exist",
    });
  });

  test("preview", () => {
    const context = started("changes", { target_state: "latest" });
    const req = requestOf(flow.onInterval(at(10 * SEC), context));
    const out = answer(
      context,
      req.id,
      { available: true, version: "13.6" },
      at(1 * MIN),
    );
    expect(eventOf(out)).toMatchObject({
      outcome: "preview",
      targetState: "latest",
    });
  });

  test("lost result", () => {
    const context = started("changes");
    const due = Math.floor(at(-1 * HOUR).getTime() / 1000);
    flow.onMessage(msg(topics.request, `${due} 0 lost-1 ${PATH} {}`), context);
    const out = flow.onInterval(at(6 * MIN), context);
    expect(eventOf(out)).toMatchObject({ outcome: "request_lost" });
    expect(
      tedge.decodeJsonPayload(find(out, topics.state)!.payload).lastEvent,
    ).toMatch(/^request_lost/);
    expect(requestOf(out).path).toBe(PATH);
  });

  test.each([
    ["threshold.exceeded", "the rollout has not reached this device yet"],
    [
      "selectionCriteria.noMatch",
      "the device does not match the selection criteria of the deployment",
    ],
    ["deployment.stopped", "the deployment is stopped"],
    ["something.new", "something.new"],
    [undefined, "unknown reason"],
  ])("reason %s", (reason, text) => {
    expect(flow.describeReason(reason)).toBe(text);
  });

  test.each([
    [30 * SEC, "30s"],
    [5 * MIN, "5m"],
    [2 * HOUR, "2h"],
    [90 * MIN, "90m"],
  ])("duration %s", (ms, text) => {
    expect(flow.formatDuration(ms)).toBe(text);
  });

  test.each([["changes"], ["all"], ["off"], ["bogus"], [""]])(
    "event mode %s",
    (mode) => {
      const expected = mode === "changes" || mode === "all" ? mode : "off";
      expect(flow.getSettings({ ...baseConfig, events: mode }).events).toBe(
        expected,
      );
    },
  );
});

describe("busy device", () => {
  const cmdTopic = (op: string, id: string) =>
    `te/device/main///cmd/${op}/${id}`;
  const eventTopic = "te/device/main///e/c8y_DeploymentPoll";

  function started(config: flow.Config = {}): flow.FlowContext {
    const context = tedge.createContext({
      ...baseConfig,
      events: "all",
      ...config,
    }) as flow.FlowContext;
    flow.onStartup(t0, context);
    return context;
  }

  function answer(
    context: flow.FlowContext,
    id: string,
    response: object,
    time: Date,
  ): tedge.Message[] {
    return flow.onMessage(
      msg(topics.response, result(id, response), time),
      context,
    );
  }

  function eventOf(out: tedge.Message[]): any {
    const m = find(out, eventTopic);
    return m ? tedge.decodeJsonPayload(m.payload) : undefined;
  }

  describe("command tracking", () => {
    const s = flow.getSettings(baseConfig);

    test("active, status change and final status", () => {
      const twins: flow.Twins = {};
      const topic = cmdTopic("device_profile", "c8y-mapper-218");
      const payload = (status: string) =>
        JSON.stringify({
          status,
          deployment: { key: "demo", version: "13.6" },
        });

      expect(flow.trackCommand(twins, topic, payload("init"), s, t0)).toBe(
        true,
      );
      expect(flow.activeCommands(twins)).toEqual([
        {
          operation: "device_profile",
          cmdId: "c8y-mapper-218",
          status: "init",
          changedAt: t0.toISOString(),
          deploymentKey: "demo",
          version: "13.6",
        },
      ]);
      // same status: unchanged, keeps the time of the last change
      expect(
        flow.trackCommand(twins, topic, payload("init"), s, at(1 * HOUR)),
      ).toBe(false);
      expect(flow.activeCommands(twins)[0].changedAt).toBe(t0.toISOString());
      // status change
      expect(
        flow.trackCommand(twins, topic, payload("executing"), s, at(2 * HOUR)),
      ).toBe(true);
      expect(flow.activeCommands(twins)[0].changedAt).toBe(
        at(2 * HOUR).toISOString(),
      );
      // finished
      expect(
        flow.trackCommand(twins, topic, payload("successful"), s, at(3 * HOUR)),
      ).toBe(true);
      expect(flow.activeCommands(twins)).toEqual([]);
    });

    test("cleared command is removed", () => {
      const twins: flow.Twins = {};
      const topic = cmdTopic("software_update", "abc");
      flow.trackCommand(twins, topic, '{"status":"executing"}', s, t0);
      expect(flow.trackCommand(twins, topic, "", s, t0)).toBe(true);
      expect(flow.activeCommands(twins)).toEqual([]);
    });

    test.each([
      [
        "other operation",
        cmdTopic("log_upload", "1"),
        '{"status":"executing"}',
      ],
      [
        "child device",
        "te/device/child01///cmd/device_profile/1",
        '{"status":"executing"}',
      ],
      ["final status", cmdTopic("device_profile", "1"), '{"status":"failed"}'],
      ["invalid payload", cmdTopic("device_profile", "1"), "{not json"],
    ])("%s is ignored", (_, topic, payload) => {
      const twins: flow.Twins = {};
      expect(flow.trackCommand(twins, topic, payload, s, t0)).toBe(false);
      expect(flow.activeCommands(twins)).toEqual([]);
    });

    test("busy operations can be configured", () => {
      const custom = flow.getSettings({
        ...baseConfig,
        busy_operations: ["restart"],
      });
      expect(custom.busyOperations).toEqual(["restart"]);
      expect(
        flow.getSettings({ ...baseConfig, busy_operations: "a, b" })
          .busyOperations,
      ).toEqual(["a", "b"]);
      expect(flow.getSettings(baseConfig).busyOperations).toEqual(
        flow.DEFAULT_BUSY_OPERATIONS,
      );
      const twins: flow.Twins = {};
      expect(
        flow.trackCommand(
          twins,
          cmdTopic("restart", "1"),
          '{"status":"executing"}',
          custom,
          t0,
        ),
      ).toBe(true);
    });
  });

  describe("decide", () => {
    const s = flow.getSettings(baseConfig);
    const now = t0.getTime();
    const available: flow.Evaluation = {
      id: "1",
      ok: true,
      available: true,
      version: "13.7",
    };
    const command = (
      c: Partial<flow.ActiveCommand>,
    ): Record<string, flow.ActiveCommand> => ({
      topic: {
        operation: "device_profile",
        cmdId: "c8y-mapper-1",
        status: "executing",
        changedAt: at(-1 * HOUR).toISOString(),
        ...c,
      },
    });

    test("installation taking hours is not requested again", () => {
      const d = flow.decide(
        available,
        "dry",
        {
          state: {
            version: "13.7",
            state: "IN_PROGRESS",
            updatedAt: at(-10 * HOUR).toISOString(),
          },
        },
        { version: "13.7", attempts: 1 },
        s,
        now,
      );
      expect(d).toMatchObject({ action: "schedule", outcome: "in_progress" });
    });

    test("own command running, deployment state unknown", () => {
      const d = flow.decide(
        available,
        "dry",
        {
          // c8y-deploy-status not installed: the assignment looks stale
          state: {
            version: "13.7",
            state: "ASSIGNED",
            updatedAt: at(-2 * HOUR).toISOString(),
          },
          commands: command({ deploymentKey: "demo", version: "13.7" }),
        },
        { version: "13.7", attempts: 1 },
        s,
        now,
      );
      expect(d).toMatchObject({
        action: "schedule",
        outcome: "in_progress",
        version: "13.7",
        state: "executing",
      });
    });

    test("other operation running", () => {
      const d = flow.decide(
        available,
        "dry",
        {
          commands: command({
            operation: "firmware_update",
            cmdId: "c8y-mapper-9",
          }),
        },
        {},
        s,
        now,
      );
      expect(d).toMatchObject({
        action: "schedule",
        outcome: "device_busy",
        operation: "firmware_update c8y-mapper-9",
      });
    });

    test("other deployment running", () => {
      const d = flow.decide(
        available,
        "dry",
        { commands: command({ deploymentKey: "other", version: "1.0" }) },
        {},
        s,
        now,
      );
      expect(d).toMatchObject({ outcome: "device_busy" });
    });

    test("stuck is reported but nothing is requested", () => {
      const timeout = flow.getSettings({
        ...baseConfig,
        in_progress_timeout: "24h",
      });
      const twins: flow.Twins = {
        state: {
          version: "13.7",
          state: "IN_PROGRESS",
          updatedAt: at(-25 * HOUR).toISOString(),
        },
      };
      expect(
        flow.decide(available, "dry", twins, {}, timeout, now),
      ).toMatchObject({
        action: "schedule",
        outcome: "stuck",
        version: "13.7",
      });
      // disabled by default
      expect(flow.decide(available, "dry", twins, {}, s, now)).toMatchObject({
        outcome: "in_progress",
      });
      // not yet
      expect(
        flow.decide(
          available,
          "dry",
          twins,
          {},
          flow.getSettings({ ...baseConfig, in_progress_timeout: "48h" }),
          now,
        ),
      ).toMatchObject({ outcome: "in_progress" });
    });

    test("stuck other operation", () => {
      const timeout = flow.getSettings({
        ...baseConfig,
        in_progress_timeout: "1h",
      });
      const d = flow.decide(
        available,
        "dry",
        { commands: command({ changedAt: at(-2 * HOUR).toISOString() }) },
        {},
        timeout,
        now,
      );
      expect(d).toMatchObject({
        outcome: "stuck",
        operation: "device_profile c8y-mapper-1",
      });
    });
  });

  describe("flow", () => {
    test("no operation is requested while another operation is running", () => {
      const context = started();
      flow.onMessage(
        msg(cmdTopic("firmware_update", "c8y-mapper-5"), {
          status: "executing",
        }),
        context,
      );
      const dry = requestOf(flow.onInterval(at(10 * SEC), context));
      const out = answer(
        context,
        dry.id,
        { available: true, version: "13.6" },
        at(1 * MIN),
      );
      expect(requestOf(out).path).toBe(PATH);
      expect(eventOf(out)).toMatchObject({
        outcome: "device_busy",
        operation: "firmware_update c8y-mapper-5",
        state: "executing",
        text: "Another operation is in progress on the device (firmware_update c8y-mapper-5: executing). No operation is requested for deployment demo until it is finished",
      });
    });

    test("the deployment is requested once the operation finished", () => {
      const context = started();
      const topic = cmdTopic("device_profile", "c8y-mapper-5");
      flow.onMessage(msg(topic, { status: "executing" }), context);
      let req = requestOf(flow.onInterval(at(10 * SEC), context));
      let out = answer(
        context,
        req.id,
        { available: true, version: "13.6" },
        at(1 * MIN),
      );
      req = requestOf(out);
      expect(req.path).toBe(PATH);

      flow.onMessage(msg(topic, { status: "successful" }), context);
      flow.onMessage(msg(topic, ""), context);
      out = answer(
        context,
        req.id,
        { available: true, version: "13.6" },
        at(2 * HOUR),
      );
      expect(requestOf(out).path).toBe(`${PATH}?createOperation=true`);
    });

    test("stuck event", () => {
      const context = started({ in_progress_timeout: "24h" });
      flow.onMessage(
        msg(topics.deploymentState, {
          deploymentKey: "demo",
          version: "13.6",
          state: "IN_PROGRESS",
          updatedAt: at(-30 * HOUR).toISOString(),
        }),
        context,
      );
      const dry = requestOf(flow.onInterval(at(10 * SEC), context));
      const out = answer(
        context,
        dry.id,
        { available: true, version: "13.6" },
        at(1 * MIN),
      );
      expect(requestOf(out).path).toBe(PATH);
      expect(eventOf(out)).toMatchObject({
        outcome: "stuck",
        version: "13.6",
        state: "IN_PROGRESS",
        text: `Version 13.6 of deployment demo has not progressed for more than 24h (IN_PROGRESS since ${at(-30 * HOUR).toISOString()}). Please check the device`,
      });
    });

    test("server mode only checks while the device is busy", () => {
      const context = started({ operation_request: "server" });
      const topic = cmdTopic("software_update", "1");
      const serverPath = `${PATH}?createOperation=true`;

      let req = requestOf(flow.onInterval(at(10 * SEC), context));
      expect(req.path).toBe(serverPath);

      // busy: the pending request becomes a plain check, with the same due time
      let out = flow.onMessage(
        msg(topic, { status: "executing" }, at(20 * SEC)),
        context,
      );
      const check = requestOf(out);
      expect(check.path).toBe(PATH);
      expect(check.due).toBe(req.due);

      // no longer busy: back to requesting the operation
      out = flow.onMessage(msg(topic, "", at(30 * SEC)), context);
      req = requestOf(out);
      expect(req.path).toBe(serverPath);

      // a check executed while busy, answered once the device is free
      out = flow.onMessage(
        msg(topic, { status: "executing" }, at(40 * SEC)),
        context,
      );
      const busyCheck = requestOf(out);
      expect(busyCheck.path).toBe(PATH);
      const afterDue = new Date(busyCheck.due * 1000 + 30 * SEC);
      // the request is due (poll.sh may be executing it), so it is not changed anymore
      expect(flow.onMessage(msg(topic, "", afterDue), context)).toEqual([]);
      out = answer(
        context,
        busyCheck.id,
        { available: true, version: "13.6" },
        new Date(afterDue.getTime() + 10 * SEC),
      );
      const next = requestOf(out);
      expect(next.path).toBe(serverPath);
      expect(next.expires).toBeGreaterThan(0);
    });
  });
});

describe("architecture detection", () => {
  test.each([
    ["x86_64", "amd64"],
    ["amd64", "amd64"],
    ["aarch64", "arm64"],
    ["arm64", "arm64"],
    ["arm64e", "arm64"],
    ["armv8", "arm64"],
    ["armv8b", "arm64"],
    ["armv8l", "armv7"],
    ["armv7l", "armv7"],
    ["armhf", "armv7"],
    ["armv6l", "armv6"],
    ["armv5tel", "armv6"],
    ["armel", "armv6"],
    ["i686", "386"],
    ["i586", "386"],
    ["i386", "386"],
    ["riscv64", "riscv64"],
    ["AARCH64", "arm64"],
    ["musl-linux-arm64", "arm64"],
    ["mips64el", "mips64el"],
    ["", undefined],
    [undefined, undefined],
  ])("normalize %s => %s", (raw, arch) => {
    expect(flow.normalizeArch(raw)).toBe(arch);
  });

  test.each([
    // 32-bit Raspberry Pi OS on a 64-bit kernel: the userland wins
    [{ machine: "aarch64", dpkg: "armhf" }, { arch: "armv7" }],
    [{ machine: "aarch64", dpkg: "arm64" }, { arch: "arm64" }],
    [{ machine: "x86_64", dpkg: "" }, { arch: "amd64" }],
    [{ machine: "arm64", dpkg: "darwin-arm64" }, { arch: "arm64" }],
    // unknown dpkg architecture: the kernel architecture is used
    [{ machine: "aarch64", dpkg: "weird" }, { arch: "arm64" }],
    [{ machine: "mips64", dpkg: "" }, { arch: "mips64" }],
    [{ machine: "", dpkg: "" }, {}],
  ])("detect %j => %j", (detected, expected) => {
    expect(flow.detectedContext(JSON.stringify(detected))).toEqual(expected);
  });

  test("invalid detection output", () => {
    expect(flow.detectedContext("garbage")).toEqual({});
  });

  test("detected values have the lowest precedence", () => {
    expect(
      JSON.parse(flow.buildBody({}, undefined, "", { arch: "arm64" })),
    ).toEqual({
      arch: "arm64",
    });
    expect(
      JSON.parse(
        flow.buildBody({ arch: "armv7" }, undefined, "", { arch: "arm64" }),
      ),
    ).toEqual({ arch: "armv7" });
    expect(
      JSON.parse(flow.buildBody({}, '{"arch":"amd64"}', "", { arch: "arm64" })),
    ).toEqual({ arch: "amd64" });
  });

  describe("flow", () => {
    const detectTopic = "tedge-flows/c8y-deploy-poll/demo/detect";

    function started(config: flow.Config = {}): flow.FlowContext {
      const context = tedge.createContext({
        ...baseConfig,
        context: { type: "deluxe" },
        detect_arch: "true",
        ...config,
      }) as flow.FlowContext;
      flow.onStartup(t0, context);
      return context;
    }

    test("waits for the detection before the first request", () => {
      const context = started();
      expect(flow.onInterval(at(10 * SEC), context)).toEqual([]);
      const out = flow.onMessage(
        msg(detectTopic, '{"machine":"aarch64","dpkg":"arm64"}', at(12 * SEC)),
        context,
      );
      expect(JSON.parse(requestOf(out).body)).toEqual({
        arch: "arm64",
        type: "deluxe",
      });
    });

    test("gives up waiting for the detection", () => {
      const context = started();
      expect(
        JSON.parse(requestOf(flow.onInterval(at(31 * SEC), context)).body),
      ).toEqual({
        type: "deluxe",
      });
    });

    test("detection disabled", () => {
      const context = started({ detect_arch: "false" });
      flow.onMessage(
        msg(detectTopic, '{"machine":"aarch64","dpkg":"arm64"}', at(1 * SEC)),
        context,
      );
      expect(
        JSON.parse(requestOf(flow.onInterval(at(10 * SEC), context)).body),
      ).toEqual({
        type: "deluxe",
      });
    });

    test("unchanged detection does not update the request", () => {
      const context = started();
      requestOf(
        flow.onMessage(
          msg(
            detectTopic,
            '{"machine":"aarch64","dpkg":"arm64"}',
            at(12 * SEC),
          ),
          context,
        ),
      );
      expect(
        flow.onMessage(
          msg(
            detectTopic,
            '{"machine":"aarch64","dpkg":"arm64"}',
            at(1 * HOUR),
          ),
          context,
        ),
      ).toEqual([]);
    });
  });
});

describe("deployment result events", () => {
  const eventTopic = "te/device/main///e/c8y_DeploymentPoll";
  const cmdTopic = "te/device/main///cmd/device_profile/c8y-mapper-218";

  function started(events = "changes"): flow.FlowContext {
    const context = tedge.createContext({
      ...baseConfig,
      events,
    }) as flow.FlowContext;
    flow.onStartup(t0, context);
    return context;
  }

  function stateMsg(
    state: string,
    version: string,
    updatedAt: Date,
  ): tedge.Message {
    return msg(
      topics.deploymentState,
      {
        deploymentKey: "demo",
        version,
        state,
        updatedAt: updatedAt.toISOString(),
      },
      updatedAt,
    );
  }

  function eventOf(out: tedge.Message[]): any {
    const m = find(out, eventTopic);
    return m ? tedge.decodeJsonPayload(m.payload) : undefined;
  }

  test("successful installation", () => {
    const context = started();
    const out = flow.onMessage(
      stateMsg("SUCCESS", "13.7", at(2 * HOUR)),
      context,
    );
    expect(eventOf(out)).toEqual({
      text: "Version 13.7 of deployment demo was installed successfully",
      time: at(2 * HOUR).toISOString(),
      deploymentKey: "demo",
      targetState: "active",
      version: "13.7",
      state: "SUCCESS",
      outcome: "completed",
    });
    expect(
      tedge.decodeJsonPayload(find(out, topics.state)!.payload).reportedResult,
    ).toBe(`13.7|SUCCESS|${at(2 * HOUR).toISOString()}`);

    // the same result is only reported once
    expect(
      eventOf(
        flow.onMessage(stateMsg("SUCCESS", "13.7", at(2 * HOUR)), context),
      ),
    ).toBeUndefined();
  });

  test("in progress states are not reported as a result", () => {
    const context = started();
    for (const state of ["ASSIGNED", "PENDING", "CONFIRMED", "IN_PROGRESS"]) {
      expect(
        flow.onMessage(stateMsg(state, "13.7", at(1 * HOUR)), context),
      ).toEqual([]);
    }
  });

  test("failed installation with the reason and the next attempt", () => {
    const context = started();
    flow.onMessage(
      msg(topics.state, { version: "13.7", attempts: 1 }),
      context,
    );
    flow.onMessage(
      msg(cmdTopic, {
        status: "failed",
        reason: "firmware_update failed: Download failed",
        deployment: { key: "demo", version: "13.7" },
      }),
      context,
    );
    const out = flow.onMessage(
      stateMsg("FAILURE", "13.7", at(2 * HOUR)),
      context,
    );
    expect(eventOf(out)).toMatchObject({
      outcome: "failed",
      version: "13.7",
      state: "FAILURE",
      reason: "firmware_update failed: Download failed",
      attempts: 1,
      text: "Installation of version 13.7 of deployment demo failed: firmware_update failed: Download failed. It is requested again at the next poll (attempt 2 of 3)",
    });
  });

  test("failed installation, no further attempts", () => {
    const context = started();
    flow.onMessage(
      msg(topics.state, { version: "13.7", attempts: 3 }),
      context,
    );
    const out = flow.onMessage(
      stateMsg("FAILURE", "13.7", at(2 * HOUR)),
      context,
    );
    expect(eventOf(out).text).toBe(
      "Installation of version 13.7 of deployment demo failed. No further attempts are made (3 of 3)",
    );
  });

  test("failure reason of another version is not used", () => {
    const context = started();
    flow.onMessage(
      msg(cmdTopic, {
        status: "failed",
        reason: "old",
        deployment: { key: "demo", version: "13.6" },
      }),
      context,
    );
    const out = flow.onMessage(
      stateMsg("FAILURE", "13.7", at(2 * HOUR)),
      context,
    );
    expect(eventOf(out).reason).toBeUndefined();
  });

  test("results from before the flow started are not reported", () => {
    const context = started();
    expect(
      flow.onMessage(stateMsg("SUCCESS", "13.6", at(-2 * HOUR)), context),
    ).toEqual([]);
  });

  test("a restart does not repeat the result", () => {
    const context = started();
    const out = flow.onMessage(
      stateMsg("SUCCESS", "13.7", at(2 * HOUR)),
      context,
    );
    const state = tedge.decodePayload(find(out, topics.state)!.payload);

    // restarted shortly after: the retained messages are received again
    const restarted = tedge.createContext({
      ...baseConfig,
      events: "changes",
    }) as flow.FlowContext;
    flow.onStartup(at(2 * HOUR + 30 * SEC), restarted);
    flow.onMessage(msg(topics.state, state), restarted);
    expect(
      eventOf(
        flow.onMessage(stateMsg("SUCCESS", "13.7", at(2 * HOUR)), restarted),
      ),
    ).toBeUndefined();
  });

  test("no result events when events are off", () => {
    const context = started("off");
    expect(
      flow.onMessage(stateMsg("SUCCESS", "13.7", at(2 * HOUR)), context),
    ).toEqual([]);
  });

  test("full cycle: requested, installed, then no redundant in sync event", () => {
    const context = started();
    let req = requestOf(flow.onInterval(at(10 * SEC), context));
    req = requestOf(
      flow.onMessage(
        msg(
          topics.response,
          result(req.id, { available: true, version: "13.7" }),
          at(1 * MIN),
        ),
        context,
      ),
    );
    let out = flow.onMessage(
      msg(
        topics.response,
        result(req.id, { available: true, version: "13.7" }),
        at(2 * MIN),
      ),
      context,
    );
    expect(eventOf(out).outcome).toBe("operation_requested");
    req = requestOf(out);

    // c8y-deploy-status reports the progress and the result
    flow.onMessage(stateMsg("PENDING", "13.7", at(3 * MIN)), context);
    flow.onMessage(stateMsg("IN_PROGRESS", "13.7", at(4 * MIN)), context);
    out = flow.onMessage(stateMsg("SUCCESS", "13.7", at(3 * HOUR)), context);
    expect(eventOf(out).outcome).toBe("completed");
    flow.onMessage(
      msg(
        topics.membership,
        { deploymentKey: "demo", version: "13.7" },
        at(3 * HOUR),
      ),
      context,
    );

    // next poll: in sync, which is not reported again
    out = flow.onMessage(
      msg(
        topics.response,
        result(req.id, { available: true, version: "13.7" }),
        at(25 * HOUR),
      ),
      context,
    );
    expect(eventOf(out)).toBeUndefined();
  });
});

describe("request line parsing without slow regular expressions", () => {
  test.each([
    ["1 0 id /p", { due: 1, expires: 0, id: "id", path: "/p", body: "{}" }],
    [
      '  1\t0  id   /p   {"a": "b c"}  ',
      { due: 1, expires: 0, id: "id", path: "/p", body: '{"a": "b c"}' },
    ],
  ])("%j", (line, expected) => {
    expect(flow.parseRequest(line)).toEqual(expected);
  });

  test.each([["1 0 id"], ["x 0 id /p"], ["1 y id /p"], ["1 0"], [""]])(
    "invalid %j",
    (line) => {
      expect(flow.parseRequest(line)).toBeUndefined();
    },
  );

  test("adversarial input is processed quickly", () => {
    const started = Date.now();
    expect(
      flow.parseRequest("0 0 ! ! " + "  ".repeat(100_000) + "\n!"),
    ).toEqual({
      due: 0,
      expires: 0,
      id: "!",
      path: "!",
      body: "!",
    });
    flow.parseRequest("0 0 " + " ".repeat(100_000));
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
