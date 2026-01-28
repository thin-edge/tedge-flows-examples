# ThingsBoard Flow

This flow demonstrates how to map **thin-edge.io** data to **ThingsBoard**.

## Supported Mapping Features

The flow supports mapping from/to Thin Edge JSON to/from the ThingsBoard Device/Gateway API.
For the main device, Device API is selected, whilst for child devices and services, Gateway API is used.

- [x] Measurements -> Telemetry
- [x] Twin -> Attributes
- [x] Alarms -> Telemetry
- [x] Events -> Telemetry
- [ ] Commands -> RPC (todo)

## Flow Custom Configuration

- `add_type_to_key`: `<true|false>`
  - Determines whether the measurements/twin type is prefixed to the keys.
  - For example,
    - topic: `te/device/main///m/sensor`
    - payload: `{"temperature: 10}`
    - If set to `true`, the converted payload becomes: `{"sensor::temperature": 10}`

- `alarm_prefix`: `<string>`
- `event_prefix`: `<string>`
  - To distinguish alarms and events from other data types, the step prepends these prefixes to the type from the MQTT topic to form the telemetry key used by ThingsBoard.
    Refer to the [alarm example](#alarms---telemetry) and [event example](#events---telemetry) to see how this works (`alarm::` and `event::` respectively).

- If you don't want to add timestamp to telemetry, remove the builtin `add-timestamp` step from `flow.toml`.

## Setup

### ThingsBoard Setup

Register the main device beforehand. It must be **gateway**.
The device ID and access token will be used in the later mosquitto bridge setup.

### Flow Configuration

Set `config.main_device_name` to your device's main name in `flow.toml`.

```toml
config.main_device_name = "{{MAIN_DEVICE_NAME}}"
```

If you are unsure which value to use, run the following command to get your device ID:

```sh
tedge config get device.id
```

**Note**: this settings is a workaround to tell the main device's name to the flow. Once the access to the entity store is implemented, this settings will be removed.

### Mosquitto Bridge Configuration

You must manually create a mosquitto bridge configuration.
Replace `{{URL}}`, `{{DEVICE_ID}}`, and `{{ACCESS_TOKEN}}` for your tenant.

File: `/etc/tedge/mosquitto-conf/thingsboard-bridge.conf`

Content:

```sh
### Bridge
connection edge_to_things
address {{URL}}:8883
bridge_capath /etc/ssl/certs
remote_clientid {{DEVICE_ID}}
local_clientid ThingsBoard
remote_username {{ACCESS_TOKEN}}
try_private false
start_type automatic
cleansession true
local_cleansession false
notifications true
notifications_local_only true
notification_topic te/device/main/service/mosquitto-things-bridge/status/health
bridge_attempt_unsubscribe false

### Topics
### ThingsBoard Device API topics (for the main device)
topic telemetry out 1 tb/me/ v1/devices/me/
topic attributes both 1 tb/me/ v1/devices/me/
topic attributes/request/+ out 1 tb/me v1/devices/me/
topic attributes/response/+ in 1 tb/me/ v1/devices/me/
topic rpc/request/+ in 1 tb/me/ v1/devices/me/
topic rpc/response/+ out 1 tb/me/ v1/devices/me/

### ThingsBoard Gateway API topics
topic connect out 1 tb/gateway/ v1/gateway/
topic disconnect out 1 tb/gateway/ v1/gateway/
topic telemetry out 1 tb/gateway/ v1/gateway/
topic attributes both 1 tb/gateway/ v1/gateway/
topic attributes/request/+ out 1 tb/gateway/ v1/gateway/
topic attributes/response/+ in 1 tb/gateway/ v1/gateway/
topic rpc in 1 tb/gateway/ v1/gateway/
topic claim out 1 tb/gateway/ v1/gateway/
```

Note: After creating the bridge configuration file, you must restart the `mosquitto` service.

```sh
sudo systemctl restart mosquitto
```

## Example Conversion

### Measurements -> Telemetry

#### thin-edge.io measurements (for main device)

topic: `te/device/main///m/sensor`

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

topic: `te/device/child1///m/sensor`

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

topic: `te/device/main///twin/software`

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

topic: `te/device/child1///twin/software`

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

topic: `te/device/main///a/temperature_high`

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

topic: `te/device/main///a/temperature_high`

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

topic: `te/device/main///e/login_event`

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

## Device Name Mapping Rules

This flow uses predefined transformation rules to derive ThingsBoard device names from thin-edge.io entity IDs.

Device names are generated by filtering out empty path segments and joining the remaining parts with colons (`:`).
The only exception is the main device, which defaults to a configurable alias defined in `config.main_device_name`.

Example: (Assuming `config.main_device_name` is set to **MAIN**)

| thin-edge.io Topic Pattern         | ThingsBoard Name                |
| :--------------------------------- | :------------------------------ |
| `te/device/main///m/`              | MAIN                            |
| `te/device/child1///m/`            | MAIN:device:child1              |
| `te/device/main/service/app1/m/`   | MAIN:device:main:service:app1   |
| `te/device/child1/service/app2/m/` | MAIN:device:child1:service:app2 |

If you want a custom logic for naming, update `getDeviceName()` in `src/main.ts`.
