## measurement-aggregator

Collect individual per-topic MQTT datapoints and emit them together as a single aggregated [thin-edge.io measurement](https://thin-edge.github.io/thin-edge.io/references/mqtt-api/#telemetry-data).

### Problem

Many data sources publish one MQTT message per data point, each to a separate topic:

```
sensors/temperature  →  23.5
sensors/humidity     →  60
sensors/pressure     →  1013.25
```

Sending these as three individual measurements to Cumulocity IoT creates three separate data rows in the platform. This flow collects them within a configurable time window and flushes them as one combined measurement:

```json
{
  "time": "2024-06-01T12:00:00.000Z",
  "temperature": 23.5,
  "humidity": 60,
  "pressure": 1013.25
}
```

Or, if data sources publish named sub-series (e.g. `sensors/temperature/inside` and `sensors/temperature/outside`), configure `key_depth = 2` to get a nested measurement where multiple series are merged under a single group:

```json
{
  "time": "2024-06-01T12:00:00.000Z",
  "temperature": { "inside": 23.5, "outside": 30.1 },
  "humidity": { "room1": 60 }
}
```

### How it works

1. **Subscribe** – the flow subscribes to a configurable wildcard topic pattern (e.g. `sensors/#`).
2. **Buffer** – each incoming message is parsed and stored in an in-memory buffer keyed by the last segment(s) of the originating topic.
3. **Flush** – on every interval tick (default: 10 s) the buffer is emitted as a single measurement on the configured `output_topic` and then cleared.

### Supported payload formats

| Format                       | Example           |
| ---------------------------- | ----------------- |
| Plain number                 | `23.5`            |
| JSON number                  | `23.5`            |
| JSON object with `value` key | `{"value": 23.5}` |

Non-numeric payloads (plain strings, booleans, …) are silently ignored.

### Configuration

Copy `params.toml.template` to `params.toml` and adjust as needed:

```toml
# Output thin-edge.io measurement topic
output_topic = "te/device/main///m/aggregated"

# 1 = flat values:   "sensors/temperature"        → temperature: 23.5
# 2 = nested series: "sensors/temperature/inside" → temperature: { inside: 23.5 }
key_depth = 2

debug = false
```

### Example: named sub-series (key_depth = 2)

Suppose temperature sensors publish inside and outside readings on separate topics:

```
sensors/temperature/inside  → 23.5
sensors/temperature/outside → 30.1
sensors/humidity/room1      → 60
```

Set `key_depth = 2`. The second-to-last segment becomes the measurement group
and the last segment is the named series. Topics sharing the same group are
**merged** so all arrive as a single nested measurement:

```json
{
  "time": "2024-06-01T12:00:00.000Z",
  "temperature": { "inside": 23.5, "outside": 30.1 },
  "humidity": { "room1": 60 }
}
```

### flow.toml interval

The `interval` setting in `flow.toml` controls how often the buffer is flushed.
The default is `10s`. Increase it (e.g. `60s`) to widen the collection window,
giving slower data sources more time to publish before the measurement is sent.
