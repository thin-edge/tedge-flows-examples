import { expect, test } from "@jest/globals";
import * as flow from "../src/main";

import { fromBinary } from "@bufbuild/protobuf";
import { SensorMessageSchema } from "../src/gen/sensor_pb";
import { encodeJSON } from "../../common/tedge";

test("Converts payload to a environment sensor protobuf message", async () => {
  const output = await flow.onMessage(
    {
      time: new Date(),
      topic: "something/environment",
      payload: encodeJSON({
        temperature: 12.3,
        humidity: 40,
        sensorId: "foo",
      }),
    },
    {
      topic: "custom/output",
    },
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

test("Converts payload to a location sensor protobuf message", async () => {
  const output = await flow.onMessage(
    {
      time: new Date(),
      topic: "something/location",
      payload: encodeJSON({
        latitude: 12.345,
        longitude: -9.8765,
      }),
    },
    {
      topic: "custom/output",
    },
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

test("It skips messages with unknown types", async () => {
  const output = await flow.onMessage(
    {
      time: new Date(),
      topic: "something/new_sensor_data",
      payload: encodeJSON({
        latitude: 12.345,
        longitude: -9.8765,
      }),
    },
    {
      topic: "custom/output",
    },
  );
  expect(output).toHaveLength(0);
});

test("Output topic supports template variables", async () => {
  const output = await flow.onMessage(
    {
      time: new Date(),
      topic: "something/environment",
      payload: encodeJSON({
        temperature: 12.3,
        humidity: 40,
        sensorId: "foo",
      }),
    },
    {
      topic: "custom/{{type}}/proto",
    },
  );

  expect(output[0].topic).toBe("custom/environment/proto");
});
