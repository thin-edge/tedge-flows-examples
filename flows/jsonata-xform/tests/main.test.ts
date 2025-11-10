import { expect, test } from "@jest/globals";
import * as flow from "../src/main";
import { decodeJSON, encodeJSON } from "../../common/tedge";

test("Maps message to a custom topic", async () => {
  const data = await flow.onMessage(
    {
      time: new Date(),
      topic: "/plant1/line1/device1_measure1_Type",
      payload: encodeJSON({
        value: 100,
      }),
    },
    {
      config: <flow.Config>{
        targetTopic:
          "'te/device/' & _TOPIC_LEVEL_[1] & '///m/' & $replace(_TOPIC_LEVEL_[-1], /^[^_]+_/, '')",
        substitutions: [
          {
            pathSource: "value",
            pathTarget: "output",
          },
          {
            pathSource: "'measure1_Type'",
            pathTarget: "type",
          },
          {
            pathSource: "$now()",
            pathTarget: "time",
          },
        ],
      },
    },
  );

  const payload = decodeJSON(data.payload);
  expect(data.topic).toBe("te/device/plant1///m/measure1_Type");
  expect(Object.keys(payload)).toHaveLength(3);
  expect(payload).toHaveProperty("output", 100);
  expect(payload).toHaveProperty("type", "measure1_Type");
  expect(payload).toHaveProperty("time");
});

test("Maps message to a measurement using targetAPI", async () => {
  const data = await flow.onMessage(
    {
      time: new Date(),
      topic: "/plant1/line1/device1_measure1_Type",
      payload: encodeJSON({
        value: 100,
      }),
    },
    {
      config: <flow.Config>{
        targetAPI: "MEASUREMENT",
        substitutions: [
          {
            pathSource: "_TOPIC_LEVEL_[1]",
            pathTarget: "_IDENTITY_.externalId",
          },
          {
            pathSource: "value",
            pathTarget: "output",
          },
          {
            pathSource: "$replace(_TOPIC_LEVEL_[-1], /^[^_]+_/, '')",
            pathTarget: "type",
          },
          {
            pathSource: "$now()",
            pathTarget: "time",
          },
        ],
      },
    },
  );

  const payload = decodeJSON(data.payload);
  expect(data.topic).toBe("te/device/plant1///m/measure1_Type");
  expect(Object.keys(payload)).toHaveLength(3);
  expect(payload).toHaveProperty("output", 100);
  expect(payload).toHaveProperty("type", "measure1_Type");
  expect(payload).toHaveProperty("time");
});

test("Maps message to an event using targetAPI", async () => {
  const data = await flow.onMessage(
    {
      time: new Date(),
      topic: "/plant1/line1/device1_measure1_Type",
      payload: encodeJSON({
        value: 100,
      }),
    },
    {
      config: <flow.Config>{
        targetAPI: "EVENT",
        substitutions: [
          {
            pathSource: "_TOPIC_LEVEL_[1]",
            pathTarget: "_IDENTITY_.externalId",
          },
          {
            pathSource: "value",
            pathTarget: "output",
          },
          {
            pathSource: "$replace(_TOPIC_LEVEL_[-1], /^[^_]+_/, '')",
            pathTarget: "type",
          },
          {
            pathSource: "$now()",
            pathTarget: "time",
          },
        ],
      },
    },
  );

  const payload = decodeJSON(data.payload);
  expect(data.topic).toBe("te/device/plant1///e/measure1_Type");
  expect(Object.keys(payload)).toHaveLength(3);
  expect(payload).toHaveProperty("output", 100);
  expect(payload).toHaveProperty("type", "measure1_Type");
  expect(payload).toHaveProperty("time");
});

test("Maps message to an alarm using targetAPI", async () => {
  const data = await flow.onMessage(
    {
      time: new Date(),
      topic: "/plant1/line1/device1_measure1_Type",
      payload: encodeJSON({
        value: 100,
        text: "foo",
      }),
    },
    {
      config: <flow.Config>{
        targetAPI: "ALARM",
        substitutions: [
          {
            // remove path
            pathSource: "value",
            pathTarget: "",
          },
          {
            pathSource: "_TOPIC_LEVEL_[1]",
            pathTarget: "_IDENTITY_.externalId",
          },
          {
            pathSource: "'major'",
            pathTarget: "severity",
          },
          {
            pathSource: "$replace(_TOPIC_LEVEL_[-1], /^[^_]+_/, '')",
            pathTarget: "type",
          },
          {
            pathSource: "$now()",
            pathTarget: "time",
          },
        ],
      },
    },
  );

  const payload = decodeJSON(data.payload);
  expect(data.topic).toBe("te/device/plant1///a/measure1_Type");
  expect(Object.keys(payload)).toHaveLength(4);
  expect(payload).toHaveProperty("type", "measure1_Type");
  expect(payload).toHaveProperty("severity", "major");
  expect(payload).toHaveProperty("time");
  expect(payload).toHaveProperty("text", "foo");
});

test("Maps message to an twin fragment using targetAPI", async () => {
  const data = await flow.onMessage(
    {
      time: new Date(),
      topic: "/plant1/line1/prop1",
      payload: encodeJSON({
        os: "Debian",
        version: "12",
      }),
    },
    {
      config: <flow.Config>{
        targetAPI: "INVENTORY",
        substitutions: [
          {
            pathSource: "_TOPIC_LEVEL_[1]",
            pathTarget: "_IDENTITY_.externalId",
          },
          {
            pathSource: "_TOPIC_LEVEL_[-1]",
            pathTarget: "type",
          },
          {
            pathSource: "$now()",
            pathTarget: "updatedAt",
          },
        ],
      },
    },
  );

  const payload = decodeJSON(data.payload);
  expect(data.topic).toBe("te/device/plant1///twin/prop1");
  expect(Object.keys(payload)).toHaveLength(4);
  expect(payload).toHaveProperty("os", "Debian");
  expect(payload).toHaveProperty("version", "12");
  expect(payload).toHaveProperty("type", "prop1");
  expect(payload).toHaveProperty("updatedAt");
});
