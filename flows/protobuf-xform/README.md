## protobuf-xform

This flow translates sensor data being received as json messages, and transforms them as protobuf messages.

### Description

The flow subscribes to specific measurement topics, and transforms the messages into a protobuf definition, where the definition uses `oneof` to support different sensor data formats (but the message may only contain one of the given formats at a time).

### Input

The flow expects the thin-edge.io service status message to be one of the following formats, where the `<type>` name in the topic is used to determine what sensor data is being used.

**Type 1: environment data**

Topic: **te/device/main///m/environment**

```json
{
  "temperature": 30.1,
  "humidity": 95
}
```

**Example**

```sh
tedge mqtt pub te/device/main///m/environment '{"temperature": 30.1,"humidity":95}'
```

**Type 2: location data**

Topic: **te/device/main///m/location**

```json
{
  "latitude": -27.47544883926631,
  "longitude": 153.02223634041275
}
```

**Example**

```sh
tedge mqtt pub te/device/main///m/location '{"latitude": -27.47544883926631,"longitude": 153.02223634041275}'
```

### Decoding Protobuf messages

The encoded measurements produced by the protobuf example flow:

```sh
tedge flows test --base64-output te/device/main///m/environment '{ "temperature": 29, "humidity": 50 }'

[c8y/mqtt/out/proto/sensor] ChIJAAAAAAAAPUARAAAAAAAASUA=
```

You can decode the message by using the `protoc` command (from the protobuf package).

```sh
echo -n ChIJAAAAAAAAPUARAAAAAAAASUA= \
| base64 -d \
| protoc --proto_path ./proto proto/sensor.proto --decode sensorpackage.SensorMessage

environment {
  temperature: 29
  humidity: 50
}
```
