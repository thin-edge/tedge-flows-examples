import { expect, test, describe } from "@jest/globals";
import { encodeJSON, decodeJSON } from "../../common/tedge";
import * as flow from "../src/main";

describe("map messages", () => {
  test("simple message", async () => {
    const time = new Date("2025-01-01");
    const timeSeconds = time.getTime() / 1000;
    const output = await flow.onMessage(
      {
        time,
        topic: "spBv1.0/FactoryA/DDATA/BoilerController01/TemperatureSensorA",
        payload: encodeJSON({
          timestamp: time.getTime(),
          metrics: [
            {
              name: "test1",
              type: "Float",
              value: 1.234,
            },
          ],
        }),
      },
      { config: {} },
    );
    expect(output).toHaveLength(1);
    expect(output[0].topic).toBe(
      "te/device/BoilerController01///m/TemperatureSensorA",
    );
    const payload = decodeJSON(output[0].payload);
    expect(payload).toEqual({
      time: timeSeconds,
      TemperatureSensorA: {
        test1: 1.234,
      },
    });
  });
});
