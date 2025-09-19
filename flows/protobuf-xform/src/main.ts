/*
  Serialize json messages into protobuf
*/
// import * as proto from 'protobufjs';
import { Message } from "../../common/tedge";
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import { base64Decode, base64Encode } from "@bufbuild/protobuf/wire";
import {
  SensorMessageSchema,
  EnvironmentSensorSchema,
  LocationSensorSchema,
} from "./gen/sensor_pb";

export interface Config {
  topic: string;
}

function onSetpoint(
  message: Message,
  { topic = "out/proto/actuator", base64 = false },
): Message[] {
  let binPayload;
  if (base64) {
    binPayload = base64Decode(message.payload);
  } else {
    binPayload = message.raw_payload
  }

  let setPoint = fromBinary(SensorMessageSchema, binPayload)
  return [
    {
      timestamp: message.timestamp,
      topic: topic,
      payload: JSON.stringify(setPoint),
    },
  ];
}

export function onMessage(
  message: Message,
  { topic = "out/proto/sensor", cmdtopic = "out/proto/actuator", base64 = false },
): Message[] {
  const payloadType = message.topic.split("/").slice(-1)[0];

  let data;
  if (payloadType == "environment") {
    const payload = JSON.parse(message.payload);
    data = {
      case: "environment",
      value: create(EnvironmentSensorSchema, {
        ...payload,
        temperature: payload.temperature,
        humidity: payload.humidity,
      }),
    };
  } else if (payloadType == "location") {
    const payload = JSON.parse(message.payload);
    data = {
      case: "location",
      value: create(LocationSensorSchema, {
        location: {
          latitude: payload.latitude,
          longitude: payload.longitude,
        },
      }),
    };
  } else if (payloadType == "setpoint") {
    return onSetpoint(message, {topic: cmdtopic, base64: base64});
  }

  if (!data) {
    return [];
  }

  const sensor = create(SensorMessageSchema, {
    sensor: data,
  });

  const outputTopic = topic.replaceAll("{{type}}", payloadType);

  let binPayload = toBinary(SensorMessageSchema, sensor);
  if (base64) {
    binPayload = base64Encode(binPayload);
  }

  return [
    {
      timestamp: message.timestamp,
      topic: outputTopic,
      payload: binPayload,
    },
  ];
}
