## tedge-events

Demonstrates how to forward thin-edge.io telemetry data to the Cumulocity MQTT service. Currently supports **events** only.

### Description

The flow subscribes to all thin-edge.io event topics (`te/+/+/+/+/e/+`) and transforms each incoming message into a Cumulocity-compatible event payload before publishing it to the Cumulocity MQTT service.

For each event message the flow:

1. Extracts the event type from the last segment of the input topic (e.g. `myEvent` from `te/device/main///e/myEvent`).
2. Reads the `device.id` from the shared flow context (populated by the `tedge-config-context` flow) and uses it as the event `source`.
3. Attaches a monotonically incrementing `tedgeSequence` counter to each outgoing message for ordering/deduplication.
4. Appends `" (from mqtt-service)"` to the event `text` field (or uses `"test event"` as the default if no `text` was provided).
5. Publishes the enriched payload to the configured output topic (default: `c8y/mqtt/out/te/v1/events`).

### Configuration

| Parameter             | Default                     | Description                                                    |
| --------------------- | --------------------------- | -------------------------------------------------------------- |
| `output_events_topic` | `c8y/mqtt/out/te/v1/events` | MQTT topic where transformed events are published              |
| `debug`               | `false`                     | When `true`, logs each incoming message payload to the console |

### Related flows

- **tedge-config-context** — populates `device.id` in the shared mapper context used by this flow as the event `source`.
