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

**Type 2: location data**

Topic: **te/device/main///m/location**

```json
{
  "latitude": -27.47544883926631,
  "longitude": 153.02223634041275
}
```

### Decoding Protobuf messages

The encoded measurements produced by the protobuf example flow ...

```
$ tedge flows test --base64-output te/device/main///m/environment '{ "temperature": 29, "humidity": 50 }'

[c8y-mqtt/proto/sensor_data] ChIJAAAAAAAAPUARAAAAAAAASUA=
```

... can be decoded back by the same protobuf example flow:

```
$ tedge flows test --base64-input c8y-mqtt/proto/setpoint ChIJAAAAAAAAPUARAAAAAAAASUA=                                           

[te/device/main///sig/setpoint] {"$typeName":"sensorpackage.SensorMessage","sensor":{"case":"environment","value":{"$typeName":"sensorpackage.EnvironmentSensor","metaInfo":{},"temperature":29,"humidity":50}}}

```
