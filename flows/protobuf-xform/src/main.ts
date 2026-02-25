/*
  Serialize json messages into protobuf
*/
// import * as proto from 'protobufjs';
import {
  Message,
  Context,
  decodePayload,
  decodeJsonPayload,
  encodePayload,
} from "../../common/tedge";
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import { base64Decode, base64Encode } from "@bufbuild/protobuf/wire";
import {
  SensorMessageSchema,
  EnvironmentSensorSchema,
  LocationSensorSchema,
} from "./gen/sensor_pb";

export interface Config {
  topic: string;
  cmdtopic: string;
  base64: boolean;
}

export interface FlowContext extends Context {
  config: Config;
}

function onSetpoint(
  message: Message,
  { topic = "out/proto/actuator", base64 = false },
): Message[] {
  let binPayload: Uint8Array;
  if (base64) {
    binPayload = base64Decode(decodePayload(message.payload));
  } else {
    binPayload = message.payload as Uint8Array;
  }

  let setPoint = fromBinary(SensorMessageSchema, binPayload);
  return [
    {
      time: message.time,
      topic: topic,
      payload: JSON.stringify(setPoint),
    },
  ];
}

export function onMessage(message: Message, context: FlowContext): Message[] {
  const payloadType = message.topic.split("/").slice(-1)[0];

  const {
    topic = "out/proto/sensor",
    cmdtopic = "out/proto/actuator",
    base64 = false,
  } = context.config;

  let data;
  if (payloadType == "environment") {
    const payload = decodeJsonPayload(message.payload);
    data = {
      case: "environment" as const,
      value: create(EnvironmentSensorSchema, {
        ...payload,
        temperature: payload.temperature,
        humidity: payload.humidity,
      }),
    };
  } else if (payloadType == "location") {
    const payload = decodeJsonPayload(message.payload);
    data = {
      case: "location" as const,
      value: create(LocationSensorSchema, {
        location: {
          latitude: payload.latitude,
          longitude: payload.longitude,
        },
      }),
    };
  } else if (payloadType == "setpoint") {
    return onSetpoint(message, { topic: cmdtopic, base64: base64 });
  }

  if (!data) {
    return [];
  }

  const sensor = create(SensorMessageSchema, {
    sensor: data,
  });

  const outputTopic = topic.replaceAll("{{type}}", payloadType);

  let binPayload = toBinary(SensorMessageSchema, sensor);

  return [
    {
      time: message.time,
      topic: outputTopic,
      payload: binPayload,
    },
  ];
}
