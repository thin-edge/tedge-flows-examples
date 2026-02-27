# ThingsBoard Registration Flow

This flow handles device registration and message buffering for **ThingsBoard** integration with **thin-edge.io**.

This registration flow is designed to work in conjunction with the following components:

- [ThingsBoard Telemetry Flow](../thingsboard/README.md): Handles telemetry and attribute updates.
- [ThingsBoard Server RPC Flow](../thingsboard-server-rpc/README.md): Manages remote procedure calls and command execution.

## Description

The flow processes messages as follows:

1. **Device Registration Detection**: Monitors thin-edge.io registration messages on topic `te/device/+/+/+` to detect new child devices and services.

2. **Registration Processing**: When [a thin-edge.io registration message](https://thin-edge.github.io/thin-edge.io/references/mqtt-api/#entity-registration)
   is received (identified by `@type` field):
   - Converts thin-edge.io registration format to ThingsBoard gateway API format.
   - Creates `tb/gateway/connect` message with device name and profile type.
   - Creates `tb/gateway/attributes` message with parent device relationship and other key-value pairs in the registration message.
   - Stores the device name in the mapper context to track registered devices.
   - Replays any buffered messages that were received before registration.

3. **Message Buffering**: For unregistered devices:
   - Buffers incoming measurements, events, alarms, and other messages on `te/` topics.
   - The buffer size is configurable (default: 100 messages). Automatically discards oldest messages when buffer limit is reached.
   - Changes topic prefix from `te/` to `tbflow/` for internal routing.

4. **Message Forwarding**: For registered devices:
   - Forwards messages directly with `tbflow/` prefix instead of `te/` prefix.
     This ensures all the messages with `tbflow/` prefix are for already registered device.

## Setup

### ThingsBoard Setup

Register the main device beforehand. It must be **gateway**. The device ID and access token will be used in the later mosquitto bridge setup.

### Flow Configuration

Then, set `config.main_device_name` to your device's main name in `flow.toml`.

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
topic attributes/request/+ out 1 tb/me/ v1/devices/me/
topic attributes/response/+ in 1 tb/me/ v1/devices/me/
# Server-side RPC
topic rpc/request/+ in 1 tb/me/server/ v1/devices/me/
topic rpc/response/+ out 1 tb/me/server/ v1/devices/me/
# Client-side RPC
topic rpc/request/+ out 1 tb/me/client/ v1/devices/me/
topic rpc/response/+ in 1 tb/me/client/ v1/devices/me/

### ThingsBoard Gateway API topics
topic connect out 1 tb/gateway/ v1/gateway/
topic disconnect out 1 tb/gateway/ v1/gateway/
topic telemetry out 1 tb/gateway/ v1/gateway/
topic attributes both 1 tb/gateway/ v1/gateway/
topic attributes/request out 1 tb/gateway/ v1/gateway/
topic attributes/response in 1 tb/gateway/ v1/gateway/
topic rpc in 1 tb/gateway/ v1/gateway/
topic claim out 1 tb/gateway/ v1/gateway/
```

Note: After creating the bridge configuration file, you must restart the `mosquitto` service.

```sh
sudo systemctl restart mosquitto
```

## Other Flow Custom Configuration

- `default_device_profile` (optional, default: "default"): ThingsBoard device profile applied when `type` is not specified in registration payload
- `max_pending_messages` (optional, default: 100): Maximum number of messages to buffer per unregistered device

## Device Name Mapping Rules

For the main device, the name is determined by the value configured in `config.main_device_name`.

For child devices and services, the name is determined by the following priority:

1. Registration Payload: If a `name` is specified in the registration payload, it will be used as the device name.
2. Automatic Generation: If no name is provided, the system generates one using the rules below.

### Automatic Generation Rules

Device names are generated by filtering out empty path segments and joining the remaining parts with colons (`:`).

Example: (Assuming `config.main_device_name` is set to **MAIN**)

| thin-edge.io Topic Pattern         | ThingsBoard Name                |
| :--------------------------------- | :------------------------------ |
| `te/device/main///m/`              | MAIN                            |
| `te/device/child1///m/`            | MAIN:device:child1              |
| `te/device/main/service/app1/m/`   | MAIN:device:main:service:app1   |
| `te/device/child1/service/app2/m/` | MAIN:device:child1:service:app2 |

If you want a custom logic for naming, update `generateDeviceName()` in `src/main.ts`.

## Example Conversion

### Registration -> Connect

#### thin-edge.io Registration (Child Device)

topic: `te/device/child0//`

```json
{
  "@type": "child-device",
  "@parent": "device/main//",
  "name": "Temperature Sensor 1",
  "type": "sensor"
}
```

#### --> ThingsBoard Connect + Attributes

1. Connect Message

   topic: `tb/gateway/connect`

   ```json
   {
     "device": "Temperature Sensor 1",
     "type": "sensor"
   }
   ```

2. Attributes Message

   topic: `tb/gateway/attributes`

   ```json
   {
     "Temperature Sensor 1": {
       "parent_device": "device/main//"
     }
   }
   ```

### Forwarded Messages

All other message types (measurements, events, alarms, health) are forwarded with topic prefix changed from `te/` to `tbflow/` for downstream processing.

## Internal Storage

The flow uses `context.mapper` key-value store with the following prefixes:

- `tb-entity-to-name:{entityId}`: Stores device name for registered devices. It looks up from entity ID to device name.
- `tb-name-to-entity:{deviceName}`: Stores entity ID for registered devices. It looks up reversely from device name to entity ID.
- `tb-msg:{entityId}`: Stores buffered messages array for unregistered devices

Example keys and results:

- `tb-entity-to-name:device/child0//` -> `Temperature Sensor 1`
- `tb-name-to-entity:Temperature Sensor 1` -> `device/child0//`
- `tb-msg:device/child0//` -> `[{topic: "...", payload: "..."}, ...]`
