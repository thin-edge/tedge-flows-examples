/*
  Serialize json messages into protobuf
*/
// import * as proto from 'protobufjs';
import { Message } from "../../common/tedge";
import { create, toBinary } from "@bufbuild/protobuf";
import { base64Encode } from "@bufbuild/protobuf/wire";
import {
  SensorMessageSchema,
  EnvironmentSensorSchema,
  LocationSensorSchema,
} from "./gen/sensor_pb";

export interface Config {
  topic: string;
}

export function onMessage(
  message: Message,
  { topic = "out/proto/sensor" },
): Message[] {
  const payload = JSON.parse(message.payload);

  const payloadType = message.topic.split("/").slice(-1)[0];

  let data;
  if (payloadType == "environment") {
    data = {
      case: "environment",
      value: create(EnvironmentSensorSchema, {
        ...payload,
        temperature: payload.temperature,
        humidity: payload.humidity,
      }),
    };
  } else if (payloadType == "location") {
    data = {
      case: "location",
      value: create(LocationSensorSchema, {
        location: {
          latitude: payload.latitude,
          longitude: payload.longitude,
        },
      }),
    };
  }
  if (!data) {
    return [];
  }

  const sensor = create(SensorMessageSchema, {
    sensor: data,
  });

  const outputTopic = topic.replaceAll("{{type}}", payloadType);

  return [
    {
      timestamp: message.timestamp,
      topic: outputTopic,
      payload: base64Encode(toBinary(SensorMessageSchema, sensor)),
    },
  ];
}
