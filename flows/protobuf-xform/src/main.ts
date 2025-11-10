/*
  Serialize json messages into protobuf
*/
// import * as proto from 'protobufjs';
import { decodeJSON, encodeJSON, Message } from "../../common/tedge";
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
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
  { topic = "out/proto/actuator" },
): Message[] {
  const setPoint = fromBinary(SensorMessageSchema, message.payload);
  return [
    {
      time: message.time,
      topic: topic,
      payload: encodeJSON(setPoint),
    },
  ];
}

export function onMessage(
  message: Message,
  { topic = "out/proto/sensor", cmdtopic = "out/proto/actuator" },
): Message[] {
  const payloadType = message.topic.split("/").slice(-1)[0];

  let data;
  if (payloadType == "environment") {
    const payload = decodeJSON(message.payload);
    data = {
      case: "environment",
      value: create(EnvironmentSensorSchema, {
        ...payload,
        temperature: payload.temperature,
        humidity: payload.humidity,
      }),
    };
  } else if (payloadType == "location") {
    const payload = decodeJSON(message.payload);
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
    return onSetpoint(message, { topic: cmdtopic });
  }

  if (!data) {
    return [];
  }

  const sensor = create(SensorMessageSchema, {
    sensor: data,
  });

  const outputTopic = topic.replaceAll("{{type}}", payloadType);

  const binPayload = toBinary(SensorMessageSchema, sensor);

  return [
    {
      time: message.time,
      topic: outputTopic,
      payload: binPayload,
    },
  ];
}
