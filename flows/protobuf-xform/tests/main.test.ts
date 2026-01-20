import { expect, test } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";

import { fromBinary } from "@bufbuild/protobuf";
import { base64Decode } from "@bufbuild/protobuf/wire";
import { SensorMessageSchema } from "../src/gen/sensor_pb";

test("Converts payload to a environment sensor protobuf message", () => {
  const output = flow.onMessage(
    {
      time: tedge.mockGetTime(),
      topic: "something/environment",
      payload: JSON.stringify({
        temperature: 12.3,
        humidity: 40,
        sensorId: "foo",
      }),
    },
    tedge.createContext({
      topic: "custom/output",
    }),
  );

  expect(output[0].topic).toBe("custom/output");
  const decodedMessage = fromBinary(
    SensorMessageSchema,
    output[0].payload as Uint8Array<ArrayBufferLike>,
  );
  if (decodedMessage.sensor.case == "environment") {
    expect(decodedMessage.sensor.value?.temperature).toBe(12.3);
    expect(decodedMessage.sensor.value?.humidity).toBe(40);
    expect(decodedMessage.sensor.value?.sensorId).toBe("foo");
  }
});

test("Converts payload to a location sensor protobuf message", () => {
  const output = flow.onMessage(
    {
      time: tedge.mockGetTime(),
      topic: "something/location",
      payload: JSON.stringify({
        latitude: 12.345,
        longitude: -9.8765,
      }),
    },
    tedge.createContext({
      topic: "custom/output",
    }),
  );

  expect(output[0].topic).toBe("custom/output");
  const decodedMessage = fromBinary(
    SensorMessageSchema,
    output[0].payload as Uint8Array<ArrayBufferLike>,
  );
  if (decodedMessage.sensor.case == "location") {
    expect(decodedMessage.sensor.value?.location?.latitude).toBe(12.345);
    expect(decodedMessage.sensor.value?.location?.longitude).toBe(-9.8765);
  }
});

test("It skips messages with unknown types", () => {
  const output = flow.onMessage(
    {
      time: tedge.mockGetTime(),
      topic: "something/new_sensor_data",
      payload: JSON.stringify({
        latitude: 12.345,
        longitude: -9.8765,
      }),
    },
    tedge.createContext({
      topic: "custom/output",
    }),
  );
  expect(output).toHaveLength(0);
});

test("Output topic supports template variables", () => {
  const output = flow.onMessage(
    {
      time: tedge.mockGetTime(),
      topic: "something/environment",
      payload: JSON.stringify({
        temperature: 12.3,
        humidity: 40,
        sensorId: "foo",
      }),
    },
    tedge.createContext({
      topic: "custom/{{type}}/proto",
    }),
  );

  expect(output[0].topic).toBe("custom/environment/proto");
});
