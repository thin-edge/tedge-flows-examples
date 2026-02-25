import { expect, test } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as dm from "../src/dynamicmapper";

test("Converts string to a timestamp", async () => {
  const output = await dm.build(
    {
      time: tedge.mockGetTime(),
      topic: "/plant1/line1/device1_measure1_Type",
      payload: JSON.stringify({
        time: 1.1234,
        value: 100,
        value2: 99.1,
        dateTo: "2025-01-01 00:00",
      }),
    },
    {
      id: "asd",
      name: "",
      mappingTopic: "",
      targetAPI: "MEASUREMENT",
      substitutions: [
        {
          pathSource: "$replace(dateTo,' ','T')",
          pathTarget: "dateTo",
        },
        {
          pathSource: "time",
          pathTarget: "timestamp",
        },
        {
          pathSource: "value + 1",
          pathTarget: "some.nested.value",
        },
        {
          pathSource: "value",
          pathTarget: "some.other.value",
        },
        {
          pathSource: "'˚C'",
          pathTarget: "some.other.unit",
        },
      ],
    },
  );

  expect(output).toStrictEqual({
    dateTo: "2025-01-01T00:00",
    timestamp: 1.1234,
    value2: 99.1,
    some: {
      nested: {
        value: 101,
      },
      other: {
        value: 100,
        unit: "˚C",
      },
    },
  });
});
