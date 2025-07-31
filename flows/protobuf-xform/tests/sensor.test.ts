import { expect, test } from "@jest/globals";

import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import {
  SensorMessageSchema,
  EnvironmentSensorSchema,
  LocationSensorSchema,
} from "../src/gen/sensor_pb";

test("Encode and decode environment sensor data", async () => {
  const input = create(SensorMessageSchema, {
    sensor: {
      case: "environment",
      value: create(EnvironmentSensorSchema, {
        temperature: 12.3,
      }),
    },
  });

  const encodedMessage = toBinary(SensorMessageSchema, input);
  const decodedMessage = fromBinary(SensorMessageSchema, encodedMessage);
  expect(decodedMessage.sensor.case).toBe("environment");
  if (decodedMessage.sensor.case == "environment") {
    expect(decodedMessage.sensor.value?.temperature).toBe(12.3);
    expect(decodedMessage.sensor.value?.humidity).toBe(0);
  }
});

test("Encode and decode location sensor data", async () => {
  const input = create(SensorMessageSchema, {
    sensor: {
      case: "location",
      value: create(LocationSensorSchema, {
        location: {
          latitude: -1.12,
          longitude: 3.456,
        },
      }),
    },
  });

  const encodedMessage = toBinary(SensorMessageSchema, input);
  const decodedMessage = fromBinary(SensorMessageSchema, encodedMessage);
  expect(decodedMessage.sensor.case).toBe("location");
  if (decodedMessage.sensor.case == "location") {
    expect(decodedMessage.sensor.value?.location?.latitude).toBe(-1.12);
    expect(decodedMessage.sensor.value?.location?.longitude).toBe(3.456);
  }
});
