import { expect, test, describe } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";

describe("map messages", () => {
  test.each([
    {
      description: "event with text field",
      topic: "te/device/main///e/myEvent",
      inputPayload: { text: "door opened", temperature: 22.5 },
      config: {},
      contextMapper: {},
      expectedTopic: "c8y/mqtt/out/te/v1/events",
      expectedPayload: {
        temperature: 22.5,
        text: "door opened (from mqtt-service)",
        tedgeSequence: 1,
        type: "myEvent",
        payloadType: "event",
        source: "",
      },
    },
    {
      description: "event without text uses default",
      topic: "te/device/main///e/restart",
      inputPayload: { reason: "ota" },
      config: {},
      contextMapper: {},
      expectedTopic: "c8y/mqtt/out/te/v1/events",
      expectedPayload: {
        reason: "ota",
        text: "test event (from mqtt-service)",
        tedgeSequence: 1,
        type: "restart",
        payloadType: "event",
        source: "",
      },
    },
    {
      description: "device.id from mapper context is used as source",
      topic: "te/device/main///e/myEvent",
      inputPayload: { text: "motion detected" },
      config: {},
      contextMapper: { "device.id": "my-device" },
      expectedTopic: "c8y/mqtt/out/te/v1/events",
      expectedPayload: {
        text: "motion detected (from mqtt-service)",
        tedgeSequence: 1,
        type: "myEvent",
        payloadType: "event",
        source: "my-device",
      },
    },
    {
      description: "custom output_events_topic from config",
      topic: "te/device/main///e/alarm",
      inputPayload: { text: "high temp" },
      config: { output_events_topic: "custom/events/out" },
      contextMapper: {},
      expectedTopic: "custom/events/out",
      expectedPayload: {
        text: "high temp (from mqtt-service)",
        tedgeSequence: 1,
        type: "alarm",
        payloadType: "event",
        source: "",
      },
    },
  ])(
    "$description",
    ({
      topic,
      inputPayload,
      config,
      contextMapper,
      expectedTopic,
      expectedPayload,
    }) => {
      const context = tedge.createContext(config);
      for (const [k, v] of Object.entries(contextMapper)) {
        context.mapper.set(k, v);
      }

      const output = flow.onMessage(
        {
          time: new Date("2026-01-01"),
          topic,
          payload: JSON.stringify(inputPayload),
        },
        context,
      );

      expect(output).toHaveLength(1);
      expect(output[0].topic).toBe(expectedTopic);
      const payload = tedge.decodeJsonPayload(output[0].payload);
      expect(payload).toMatchObject(expectedPayload);
    },
  );

  test("sequence counter increments with each message", () => {
    const context = tedge.createContext({});
    const msg = {
      time: new Date("2026-01-01"),
      topic: "te/device/main///e/myEvent",
      payload: JSON.stringify({ text: "ping" }),
    };

    const first = tedge.decodeJsonPayload(
      flow.onMessage(msg, context)[0].payload,
    );
    const second = tedge.decodeJsonPayload(
      flow.onMessage(msg, context)[0].payload,
    );
    const third = tedge.decodeJsonPayload(
      flow.onMessage(msg, context)[0].payload,
    );

    expect(first.tedgeSequence).toBe(1);
    expect(second.tedgeSequence).toBe(2);
    expect(third.tedgeSequence).toBe(3);
  });
});
