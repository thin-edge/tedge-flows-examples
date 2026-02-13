## thingsboard-registration

This flow handles device registration and message buffering for ThingsBoard integration with thin-edge.io.

### Description

The flow processes messages as follows:

1. **Device Registration Detection**: Monitors thin-edge.io registration messages on topic `te/device/+/+/+` to detect new child devices and services.

2. **Registration Processing**: When a registration message is received (identified by `@type` field):
   - Converts thin-edge.io registration format to ThingsBoard gateway API format
   - Creates `tb/gateway/connect` message with device name and profile type
   - Creates `tb/gateway/attributes` message with parent device relationship
   - Stores the device name in the mapper context to track registered devices
   - Replays any buffered messages that were received before registration

3. **Message Buffering**: For unregistered devices:
   - Buffers incoming measurements, events, alarms, and other messages
   - Implements a ring buffer with configurable maximum size (default: 100 messages)
   - Automatically discards oldest messages when buffer limit is reached
   - Changes topic prefix from `te/` to `tbflow/` for internal routing

4. **Message Forwarding**: For registered devices:
   - Forwards messages directly with `tbflow/` prefix
   - No buffering needed as device is already known to ThingsBoard

5. **Device Name Generation**: If registration payload doesn't contain an explicit `name`:
   - Main device: Uses configured `main_device_name` (default: "MAIN")
   - Child devices/services: Generates hierarchical names like `MAIN:device:child0` or `MAIN:device:main:service:tedge-mapper-c8y`

### Configuration

```toml
[input]
mqtt.topics = [
    "te/device/+/+/+",
    "te/device/+/+/+/m/+",
    "te/device/+/+/+/a/+",
    "te/device/+/+/+/e/+",
    "te/device/+/+/+/status/health",
    "te/device/+/+/+/twin/+",
]

[[steps]]
script = "thingsboard-registration/lib/main.js"
config.main_device_name = "{{MAIN_DEVICE_NAME}}"
config.default_device_profile = "default"
config.max_pending_messages = 100
```

### Config Parameters

- `main_device_name` (optional, default: "MAIN"): Name used for the main device
- `default_device_profile` (optional, default: "default"): ThingsBoard device profile applied when `type` is not specified in registration payload
- `max_pending_messages` (optional, default: 100): Maximum number of messages to buffer per unregistered device

### Input Format

#### Registration Message (Child Device)

```json
{
  "@type": "child-device",
  "@parent": "device/main//",
  "name": "Temperature Sensor 1",
  "type": "sensor"
}
```

#### Registration Message (Service)

```json
{
  "@type": "service",
  "@parent": "device/main//",
  "name": "Tedge Mapper",
  "type": "service"
}
```

### Output Format

#### Connect Message

```json
{
  "device": "Temperature Sensor 1",
  "type": "sensor"
}
```

Topic: `tb/gateway/connect`

#### Attributes Message

```json
{
  "Temperature Sensor 1": {
    "parent_device": "device/main//"
  }
}
```

Topic: `tb/gateway/attributes`

#### Forwarded Messages

All other message types (measurements, events, alarms) are forwarded with topic prefix changed from `te/` to `tbflow/` for downstream processing.

### Internal Storage

The flow uses `context.mapper` key-value store with the following prefixes:

- `tb-reg:{entityId}`: Stores device name for registered devices
- `tb-msg:{entityId}`: Stores buffered messages array for unregistered devices

Example keys:

- `tb-reg:device/child0//` → "Temperature Sensor 1"
- `tb-msg:device/child0//` → [{topic: "...", payload: "..."}, ...]
