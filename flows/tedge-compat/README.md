## tedge-compat

Translates legacy `tedge/` MQTT topics to the new `te/` topic structure introduced in thin-edge.io 1.0.

The legacy topic scheme is still supported via a built-in compatibility layer in `tedge-agent`, but that layer is deprecated. Use this flow to migrate any legacy publisher to the new API without modifying the publisher itself.

See the official [MQTT topics backward-compatibility docs](https://thin-edge.github.io/thin-edge.io/next/legacy/mqtt-topics/#backward-compatibility) for full details.

### Topic mappings

#### Main device

| Type         | Legacy topic                     | New topic                   | Payload change                      |
| ------------ | -------------------------------- | --------------------------- | ----------------------------------- |
| Measurements | `tedge/measurements`             | `te/device/main///m/`       | None                                |
| Events       | `tedge/events/<type>`            | `te/device/main///e/<type>` | None                                |
| Alarms       | `tedge/alarms/<severity>/<type>` | `te/device/main///a/<type>` | `"severity"` field added to payload |

#### Child devices

| Type         | Legacy topic                                | New topic                         | Payload change                      |
| ------------ | ------------------------------------------- | --------------------------------- | ----------------------------------- |
| Measurements | `tedge/measurements/<child_id>`             | `te/device/<child_id>///m/`       | None                                |
| Events       | `tedge/events/<type>/<child_id>`            | `te/device/<child_id>///e/<type>` | None                                |
| Alarms       | `tedge/alarms/<severity>/<type>/<child_id>` | `te/device/<child_id>///a/<type>` | `"severity"` field added to payload |

### Input topics

The flow subscribes to all legacy telemetry topics:

```
tedge/measurements
tedge/measurements/+
tedge/events/+
tedge/events/+/+
tedge/alarms/+/+
tedge/alarms/+/+/+
```

### Notes

- Alarm severity is moved from the topic into the payload as `{ "severity": "<severity>", ... }`.
- Messages on unrecognised topics are silently dropped.
