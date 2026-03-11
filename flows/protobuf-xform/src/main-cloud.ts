import { fromBinary } from "@bufbuild/protobuf";
import { SensorMessageSchema } from "./gen/sensor_pb";

interface DeviceMessage {
  time: Date;
  topic: string;
  payload: Uint8Array<ArrayBufferLike>;
  clientID?: string;
}

interface CumulocityMessage {
  cumulocityType: "measurement" | "event" | "alarm" | "managedObject";
  externalSource?: Array<{ externalId: string; type: string }>;
  payload: any;
}

export function onMessage(
  message: DeviceMessage,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
): CumulocityMessage[] {
  let sensorMessage;
  try {
    sensorMessage = fromBinary(SensorMessageSchema, message.payload);
  } catch (e) {
    console.log(`ERROR: Failed to decode sensor protobuf payload: ${e}`);
    return [];
  }

  const time = message.time;
  const { sensor } = sensorMessage;

  if (sensor.case === "environment") {
    const env = sensor.value;
    const externalId = env.sensorId || env.sensorSerial || message.clientID;

    const payload: any = {
      time,
      type: "c8y_EnvironmentSensor",
      c8y_Temperature: {
        T: { value: env.temperature, unit: "°C" },
      },
      c8y_Humidity: {
        H: { value: env.humidity, unit: "%" },
      },
    };

    return [
      {
        cumulocityType: "measurement",
        ...(externalId
          ? { externalSource: [{ externalId, type: "c8y_Serial" }] }
          : {}),
        payload,
      },
    ];
  }

  if (sensor.case === "location") {
    const loc = sensor.value.location;
    if (!loc) return [];

    const payload: any = {
      time,
      type: "c8y_LocationUpdate",
      text: "Location Update",
      c8y_Position: {
        lat: loc.latitude,
        lng: loc.longitude,
        alt: loc.altitude,
      },
    };

    return [
      {
        cumulocityType: "event",
        ...(message.clientID
          ? {
              externalSource: [
                { externalId: message.clientID, type: "c8y_Serial" },
              ],
            }
          : {}),
        payload: payload,
      },
    ];
  }

  console.log(`WARN: Unknown sensor type: ${sensor.case}`);
  return [];
}
