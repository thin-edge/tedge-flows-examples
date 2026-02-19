# ThingsBoard server-side RPC flow

This flow demonstrates how to integrate **ThingsBoard server-side RPC** with **thin-edge.io commands**.

This RPC flow is designed to work in conjunction with the following components:

- [ThingsBoard Registration flow](../thingsboard-registration/README.md): Handles device registration and message buffering.
- [ThingsBoard Telemetry Flow](../thingsboard/README.md): Handles telemetry and attribute updates.

## Supported Mapping Features

The flow supports mapping from the ThingsBoard Device/Gateway server-side RPC requests to the thin-edge.io commands,
and from the thin-edge.io commands with the final status (`successful`/`failed`) to the ThingsBoard Device/Gateway server-side RPC responses.

For the main device, Device API is selected, whilst for child devices and services, Gateway API is used.

**Note:**
The flow does not do anything for client-side RPC. However, the MQTT bridge configuration maps `v1/devices/me/request/+` and `v1/devices/me/response/+` topics.
You can publish a client-side RPC onto this topic instead of the original topic:

```
tb/me/client/rpc/request/{{rpc-id}}
```

and the response comes onto:

```
tb/me/client/rpc/response/{{rpc-id}}
```

Refer to the [end-to-end guide](./e2e-guide.md) to get a step-by-step guide on how to use this flow.

On the top of top of this flow, [ThingsBoard Registration flow](../thingsboard-registration/README.md) is required.
For the support of Telemetry/Attributes, use a dedicated flow [ThingsBoard Telemetry flow](../thingsboard/README.md).

## Setup

See the setup of [ThingsBoard Registration Flow](../thingsboard-registration/README.md#setup).

## Example Conversion

### Server-side RPC -> Commands

#### [Request] ThingsBoard RPC for the main device

topic : `tb/me/server/rpc/request/{{rpc-id}}`

```json
{
  "method": "restart",
  "params": {
    "execute": "now"
  }
}
```

#### --> [Request] thin-edge.io command for the main device

topic: `te/device/main///cmd/restart/tb-mapper-{{rpc-id}}`

```json
{
  "status": "init",
  "execute": "now"
}
```

#### [Response] thin-edge.io command for the main device

topic: `tbflow/device/main///cmd/restart/tb-mapper-{{rpc-id}}`

```json
{
  "status": "successful",
  "execute": "now"
}
```

#### --> [Response] ThingsBoard RPC for the main device

topic: `tb/me/server/rpc/response/{{rpc-id}}`

```json
{
  "status": "successful",
  "execute": "now"
}
```

#### [Request] ThingsBoard RPC for child devices

topic : `tb/gateway/rpc`

```json
{
  "device":"MAIN:device:child1",
  "data":{
    "id": {{rpc-id}},
    "method":"setConfig",
      "params": {
        "key": "temperature",
        "value": 25
    }
  }
}
```

#### --> [Request] thin-edge.io command for child devices

topic: `te/device/child1///cmd/setConfig/tb-mapper-{{rpc-id}}`

```json
{
  "status": "init",
  "key": "temperature",
  "value": 25
}
```

#### [Response] thin-edge.io command for child devices

topic: `tbflow/device/child1///cmd/setConfig/tb-mapper-{{rpc-id}}`

```json
{
  "status": "failed",
  "reason": "Permission denied"
}
```

#### --> [Response] ThingsBoard RPC for child devices

topic : `tb/gateway/rpc`

```json
{
  "device":"MAIN:device:child1",
  "data":{
    "id": {{rpc-id}},
    "method":"setConfig",
      "params": {
        "status": "failed",
        "reason": "Permission denied"
    }
  }
}
```
