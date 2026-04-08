import { expect, test, describe } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";

const ctx = tedge.createContext({});
const t = new Date("2026-01-01T00:00:00.000Z");

function msg(topic: string, payload: object): tedge.Message {
  return { time: t, topic, payload: JSON.stringify(payload) };
}

// --- measurements ---

describe("measurements", () => {
  test("main device", () => {
    const out = flow.onMessage(
      msg("tedge/measurements", { temperature: 22 }),
      ctx,
    );
    expect(out).toHaveLength(1);
    expect(out[0].topic).toBe("te/device/main///m/");
    expect(tedge.decodeJsonPayload(out[0].payload)).toEqual({
      temperature: 22,
    });
  });

  test("child device", () => {
    const out = flow.onMessage(
      msg("tedge/measurements/child01", { humidity: 55 }),
      ctx,
    );
    expect(out).toHaveLength(1);
    expect(out[0].topic).toBe("te/device/child01///m/");
    expect(tedge.decodeJsonPayload(out[0].payload)).toEqual({ humidity: 55 });
  });
});

// --- events ---

describe("events", () => {
  test("main device", () => {
    const out = flow.onMessage(
      msg("tedge/events/login", { text: "user logged in" }),
      ctx,
    );
    expect(out).toHaveLength(1);
    expect(out[0].topic).toBe("te/device/main///e/login");
    expect(tedge.decodeJsonPayload(out[0].payload)).toEqual({
      text: "user logged in",
    });
  });

  test("child device", () => {
    const out = flow.onMessage(
      msg("tedge/events/login/child01", { text: "user logged in" }),
      ctx,
    );
    expect(out).toHaveLength(1);
    expect(out[0].topic).toBe("te/device/child01///e/login");
    expect(tedge.decodeJsonPayload(out[0].payload)).toEqual({
      text: "user logged in",
    });
  });
});

// --- alarms ---

describe("alarms", () => {
  test("main device — severity added to payload", () => {
    const out = flow.onMessage(
      msg("tedge/alarms/critical/HighTemp", { text: "too hot" }),
      ctx,
    );
    expect(out).toHaveLength(1);
    expect(out[0].topic).toBe("te/device/main///a/HighTemp");
    expect(tedge.decodeJsonPayload(out[0].payload)).toEqual({
      severity: "critical",
      text: "too hot",
    });
  });

  test("main device — severity in topic has precedence over severity in body", () => {
    const out = flow.onMessage(
      msg("tedge/alarms/critical/HighTemp", {
        text: "too hot",
        severity: "warning",
      }),
      ctx,
    );
    expect(out).toHaveLength(1);
    expect(out[0].topic).toBe("te/device/main///a/HighTemp");
    expect(tedge.decodeJsonPayload(out[0].payload)).toEqual({
      severity: "critical",
      text: "too hot",
    });
  });

  test("child device — severity added to payload", () => {
    const out = flow.onMessage(
      msg("tedge/alarms/major/DiskFull/child01", { text: "disk full" }),
      ctx,
    );
    expect(out).toHaveLength(1);
    expect(out[0].topic).toBe("te/device/child01///a/DiskFull");
    expect(tedge.decodeJsonPayload(out[0].payload)).toEqual({
      severity: "major",
      text: "disk full",
    });
  });

  test("main device — empty payload clears the alarm", () => {
    const out = flow.onMessage(
      { time: t, topic: "tedge/alarms/critical/HighTemp", payload: "" },
      ctx,
    );
    expect(out).toHaveLength(1);
    expect(out[0].topic).toBe("te/device/main///a/HighTemp");
    expect(tedge.decodePayload(out[0].payload)).toBe("");
  });

  test("child device — empty payload clears the alarm", () => {
    const out = flow.onMessage(
      { time: t, topic: "tedge/alarms/major/DiskFull/child01", payload: "" },
      ctx,
    );
    expect(out).toHaveLength(1);
    expect(out[0].topic).toBe("te/device/child01///a/DiskFull");
    expect(tedge.decodePayload(out[0].payload)).toBe("");
  });
});

// --- unknown topic ---

describe("unknown topic", () => {
  test("returns empty array", () => {
    const out = flow.onMessage(msg("tedge/unknown/foo", {}), ctx);
    expect(out).toHaveLength(0);
  });
});

// --- custom topic_root ---

describe("custom topic_root", () => {
  const customCtx = tedge.createContext({ topic_root: "custom" });

  test("measurements use custom root", () => {
    const out = flow.onMessage(
      msg("tedge/measurements", { temp: 1 }),
      customCtx,
    );
    expect(out[0].topic).toBe("custom/device/main///m/");
  });

  test("events use custom root", () => {
    const out = flow.onMessage(msg("tedge/events/login", {}), customCtx);
    expect(out[0].topic).toBe("custom/device/main///e/login");
  });

  test("alarms use custom root", () => {
    const out = flow.onMessage(
      msg("tedge/alarms/critical/HighTemp", {}),
      customCtx,
    );
    expect(out[0].topic).toBe("custom/device/main///a/HighTemp");
  });
});
