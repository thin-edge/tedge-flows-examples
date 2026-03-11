/*
  Serialize json messages into protobuf
*/
import { Message, Context, decodeJsonPayload } from "../../common/tedge";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  SensorMessageSchema,
  EnvironmentSensorSchema,
  LocationSensorSchema,
} from "./gen/sensor_pb";

export interface Config {
  topic: string;
}

export interface FlowContext extends Context {
  config: Config;
}

export function onMessage(message: Message, context: FlowContext): Message[] {
  const { topic = "c8y/mqtt/out/proto/sensor" } = context.config;
  const messageType = message.topic.split("/").slice(-1)[0];

  let data;
  if (messageType == "environment") {
    const payload = decodeJsonPayload(message.payload);
    data = {
      case: "environment" as const,
      value: create(EnvironmentSensorSchema, {
        ...payload,
        temperature: payload.temperature ?? 0.0,
        humidity: payload.humidity ?? 0.0,
      }),
    };
  } else if (messageType == "location") {
    const payload = decodeJsonPayload(message.payload);
    data = {
      case: "location" as const,
      value: create(LocationSensorSchema, {
        location: {
          latitude: payload.latitude ?? 0.0,
          longitude: payload.longitude ?? 0.0,
          altitude: payload.altitude ?? 0.0,
        },
      }),
    };
  } else {
    console.log(`WARN: Unknown message type. value=${messageType}`);
  }

  if (!data) {
    return [];
  }

  const outputTopic = topic.replaceAll("{{type}}", messageType);
  const binPayload = toBinary(
    SensorMessageSchema,
    create(SensorMessageSchema, {
      sensor: data,
    }),
  );

  return [
    {
      time: message.time,
      topic: outputTopic,
      payload: binPayload,
    },
  ];
}
