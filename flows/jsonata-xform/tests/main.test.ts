import { expect, test } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";

test("Maps message to a custom topic", async () => {
  let context = tedge.createContext();
  context.config = {
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
  };

  const data = await flow.onMessage(
    {
      time: tedge.mockGetTime(),
      topic: "/plant1/line1/device1_measure1_Type",
      payload: JSON.stringify({
        value: 100,
      }),
    },
    context,
  );

  const payload = tedge.decodeJsonPayload(data[0].payload);
  expect(data[0].topic).toBe("te/device/plant1///m/measure1_Type");
  expect(Object.keys(payload)).toHaveLength(3);
  expect(payload).toHaveProperty("output", 100);
  expect(payload).toHaveProperty("type", "measure1_Type");
  expect(payload).toHaveProperty("time");
});

test("Maps message to a measurement using targetAPI", async () => {
  let context = tedge.createContext();
  context.config = {
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
  };
  const data = await flow.onMessage(
    {
      time: tedge.mockGetTime(),
      topic: "/plant1/line1/device1_measure1_Type",
      payload: JSON.stringify({
        value: 100,
      }),
    },
    context,
  );

  const payload = tedge.decodeJsonPayload(data[0].payload);
  expect(data[0].topic).toBe("te/device/plant1///m/measure1_Type");
  expect(Object.keys(payload)).toHaveLength(3);
  expect(payload).toHaveProperty("output", 100);
  expect(payload).toHaveProperty("type", "measure1_Type");
  expect(payload).toHaveProperty("time");
});

test("Maps message to an event using targetAPI", async () => {
  let context = tedge.createContext();
  context.config = {
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
  };
  const data = await flow.onMessage(
    {
      time: tedge.mockGetTime(),
      topic: "/plant1/line1/device1_measure1_Type",
      payload: JSON.stringify({
        value: 100,
      }),
    },
    context,
  );

  const payload = tedge.decodeJsonPayload(data[0].payload);
  expect(data[0].topic).toBe("te/device/plant1///e/measure1_Type");
  expect(Object.keys(payload)).toHaveLength(3);
  expect(payload).toHaveProperty("output", 100);
  expect(payload).toHaveProperty("type", "measure1_Type");
  expect(payload).toHaveProperty("time");
});

test("Maps message to an alarm using targetAPI", async () => {
  let context = tedge.createContext();
  context.config = {
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
  };

  const data = await flow.onMessage(
    {
      time: tedge.mockGetTime(),
      topic: "/plant1/line1/device1_measure1_Type",
      payload: JSON.stringify({
        value: 100,
        text: "foo",
      }),
    },
    context,
  );

  const payload = tedge.decodeJsonPayload(data[0].payload);
  expect(data[0].topic).toBe("te/device/plant1///a/measure1_Type");
  expect(Object.keys(payload)).toHaveLength(4);
  expect(payload).toHaveProperty("type", "measure1_Type");
  expect(payload).toHaveProperty("severity", "major");
  expect(payload).toHaveProperty("time");
  expect(payload).toHaveProperty("text", "foo");
});

test("Maps message to an twin fragment using targetAPI", async () => {
  let context = tedge.createContext();
  context.config = {
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
  };

  const data = await flow.onMessage(
    {
      time: tedge.mockGetTime(),
      topic: "/plant1/line1/prop1",
      payload: JSON.stringify({
        os: "Debian",
        version: "12",
      }),
    },
    context,
  );

  const payload = tedge.decodeJsonPayload(data[0].payload);
  expect(data[0].topic).toBe("te/device/plant1///twin/prop1");
  expect(Object.keys(payload)).toHaveLength(4);
  expect(payload).toHaveProperty("os", "Debian");
  expect(payload).toHaveProperty("version", "12");
  expect(payload).toHaveProperty("type", "prop1");
  expect(payload).toHaveProperty("updatedAt");
});
