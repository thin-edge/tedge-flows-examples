import { expect, test, describe } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";

describe("map collectd messages", () => {
  test("simple message", () => {
    const output = flow.onMessage(
      {
        time: new Date("2026-01-01"),
        topic: "collectd/localhost/temperature/temp1",
        payload: "1776866602.745439166:23.7",
      },
      tedge.createContext({}),
    );
    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe("te/device/main///m/collectd");
    const payload = tedge.decodeJsonPayload(output[0].payload);
    expect(payload).toEqual({
      time: 1776866602.745439166,
      temperature: { temp1: 23.7 },
    });
    expect(output[0].time == 1776866602745.0);
  });

  test("combined values", () => {
    const output = flow.onMessage(
      {
        time: new Date("2026-01-01"),
        topic: "collectd/localhost/temperature/temp",
        payload: "1776866602.745439166:23.7:24.0:25.8",
      },
      tedge.createContext({}),
    );
    expect(output).toHaveLength(3);

    expect(output[0].topic).toBe("te/device/main///m/collectd");
    expect(output[0].time == 1776866602745.0);
    expect(tedge.decodeJsonPayload(output[0].payload)).toEqual({
      time: 1776866602.745439166,
      temperature: { temp_val0: 23.7 },
    });

    expect(output[1].topic).toBe("te/device/main///m/collectd");
    expect(output[1].time == 1776866602745.0);
    expect(tedge.decodeJsonPayload(output[1].payload)).toEqual({
      time: 1776866602.745439166,
      temperature: { temp_val1: 24.0 },
    });

    expect(output[2].topic).toBe("te/device/main///m/collectd");
    expect(output[2].time == 1776866602745.0);
    expect(tedge.decodeJsonPayload(output[2].payload)).toEqual({
      time: 1776866602.745439166,
      temperature: { temp_val2: 25.8 },
    });
  });
});
