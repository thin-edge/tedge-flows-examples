# ThingsBoard Telemetry Flow

This flow demonstrates how to map **thin-edge.io** data to **ThingsBoard** telemetry/attribute.

This telemetry flow is designed to work in conjunction with the following components:

- [ThingsBoard Registration flow](../thingsboard-registration/README.md): Handles device registration and message buffering.
- [ThingsBoard Server RPC Flow](../thingsboard-server-rpc/README.md): Manages remote procedure calls and command execution.

## Supported Mapping Features

The flow supports mapping from Thin Edge JSON to the ThingsBoard Device/Gateway API.
For the main device, Device API is selected, whilst for child devices and services, Gateway API is used.

- [x] Measurements -> Telemetry
- [x] Twin -> Attributes
- [x] Alarms -> Telemetry
- [x] Events -> Telemetry
- [x] Health Statuses -> Telemetry
- [x] Publishing heartbeats of the main device periodically
- [x] Publishing health status of the registered services periodically

On the top of top of this flow, [ThingsBoard Registration flow](../thingsboard-registration/README.md) is required.
For the support of RPC/commands, use a dedicated flow [ThingsBoard RPC flow](../thingsboard-server-rpc/README.md).

## Flow Custom Configuration

- `add_type_to_key`: `<true|false>`
  - Determines whether the measurements/twin type is prefixed to the keys.
  - For example,
    - input topic: `tbflow/device/main///m/sensor`
    - payload: `{"temperature: 10}`
    - If set to `true`, the converted payload becomes: `{"sensor::temperature": 10}`

- `alarm_prefix`: `<string>`
- `event_prefix`: `<string>`
  - To distinguish alarms and events from other data types, the step prepends these prefixes to the type from the MQTT topic to form the telemetry key used by ThingsBoard.
    Refer to the [alarm example](#alarms---telemetry) and [event example](#events---telemetry) to see how this works (`alarm::` and `event::` respectively).

- `enable_heartbeat`: `<true|false>`
- `interval`: `<time>`
  - If enabled, a heartbeat message will be published in a specified interval to the gateway device.
  - Also, status updates messages will be published for the registered services if their `status/health` are reported.

- If you don't want to add timestamp to telemetry, remove the builtin `add-timestamp` step from `flow.toml`.

## Setup

1. ThingsBoard Setup

   Register the main device beforehand. It must be **gateway**.
   The device ID and access token will be used in the later mosquitto bridge setup.

2. Install [ThingsBoard Registration flow](../thingsboard-registration/README.md)

   Finish the [setup of ThingsBoard Registration flow](../thingsboard-registration/README.md#setup).

## Example Conversion

**Note**:
All input topics from thin-edge.io (`te/...`) are forwarded through the registration flow and the prefix is changed to `tbflow/`.
This ensures that any message arriving at this flow belongs to a device that has already been successfully registered and validated.

### Measurements -> Telemetry

#### thin-edge.io measurements (for main device)

topic: `tbflow/device/main///m/sensor`

```json
{
  "temperature": 10,
  "time": "2020-10-15T05:30:47+00:00"
}
```

#### --> ThingsBoard telemetry

topic: `tb/me/telemetry`

```json
{
  "ts": 1602739847000,
  "values": {
    "sensor::temperature": 10
  }
}
```

#### thin-edge.io measurements (for child device)

topic: `tbflow/device/child1///m/sensor`

```json
{
  "temperature": 10,
  "time": "2020-10-15T05:30:47+00:00"
}
```

#### --> ThingsBoard telemetry

topic: `tb/gateway/telemetry`

```json
{
  "MAIN:device:child1": [
    "ts": 1602739847000,
    "values": {
      "sensor::temperature": 10
    }
  ]
}
```

### Twin -> Attributes

#### thin-edge.io twin (for main device)

topic: `tbflow/device/main///twin/software`

```json
{
  "os": "debian"
}
```

#### --> ThingsBoard attributes

topic: `tb/me/attributes`

```json
{
  "software::os": "debian"
}
```

#### thin-edge.io twin (for child device)

topic: `tbflow/device/child1///twin/software`

```json
{
  "os": "debian"
}
```

#### --> ThingsBoard attributes

topic: `tb/gateway/attributes`

```json
{
  "MAIN:device:child1": {
    "software::os": "debian"
  }
}
```

### Alarms -> Telemetry

#### thin-edge.io active alarms (for main device)

topic: `tbflow/device/main///a/temperature_high`

```json
{
  "severity": "critical",
  "text": "Temperature is very high",
  "time": "2020-10-15T05:30:47+00:00"
}
```

#### --> ThingsBoard active alarms

topic: `tb/me/telemetry`

```json
{
  "ts": 1602739847000,
  "values": {
    "alarm::temperature_high": {
      "status": "active",
      "severity": "critical",
      "text": "Temperature is very high"
    }
  }
}
```

#### thin-edge.io cleared alarms (for main device)

topic: `tbflow/device/main///a/temperature_high`

empty payload

#### --> ThingsBoard cleared alarms

topic: `tb/me/telemetry`

```json
{
  "alarm::temperature_high": {
    "status": "cleared"
  }
}
```

### Events -> Telemetry

#### thin-edge.io active events (for main device)

topic: `tbflow/device/main///e/login_event`

```json
{
  "text": "A user just logged in",
  "time": "2020-10-15T05:30:47+00:00"
}
```

#### --> ThingsBoard active events

topic: `tb/me/telemetry`

```json
{
  "ts": 1602739847000,
  "values": {
    "event::login_event": {
      "text": "A user just logged in"
    }
  }
}
```

### Health Status -> Telemetry

#### thin-edge.io health status (for services)

topic: `tbflow/device/main/service/foo/status/health`

```json
{
  "pid": 133,
  "status": "up",
  "time": 1771494587.4724746
}
```

#### --> ThingsBoard Telemetry

topic: `tb/gateway/telemetry`

```json
{
  "MAIN:device:main:service:foo": [
    "ts": 1771494587472,
    "values": {
      "health::status": "up",
      "health::pid": 133
    }
  ]
}
```

### Periodic heartbeat to main device

topic: `tb/me/telemetry`

```json
{
  "heartbeat": 1
}
```
