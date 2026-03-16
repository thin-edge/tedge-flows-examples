## tedge-measurement-batch

Split batched ThinEdge JSON measurement payloads into individual messages.

### Description

Some systems publish multiple measurements in a single MQTT message as a JSON
array rather than individual JSON objects. The thin-edge.io mapper only
accepts single-object payloads, so this flow acts as a pre-processing step
that transparently converts batch payloads into a stream of individual
measurement messages.

The flow processes messages as follows:

1. Subscribe to all `te/+/+/+/+/m/+` measurement topics.
2. If the payload is a **JSON array**, emit one message per element on the
   same topic. Each element that lacks a `time` field is automatically
   stamped with the message receive time.
3. If the payload is a **JSON object** (already a single measurement), emit
   nothing — the built-in thin-edge.io flow handles it without interference.

### Example

**Input** – one message with a batched payload:

```
topic:   te/device/main///m/env
payload: [
  {"time": "2020-10-15T05:30:47+00:00", "temperature": 25},
  {"time": "2020-10-15T05:30:48+00:00", "temperature": 26},
  {"location": {"latitude": 32.54, "longitude": -117.67, "altitude": 98.6}}
]
```

**Output** – three individual messages (all on the same topic):

```
{"time": "2020-10-15T05:30:47+00:00", "temperature": 25}
{"time": "2020-10-15T05:30:48+00:00", "temperature": 26}
{"time": "<receive-time>", "location": {"latitude": 32.54, "longitude": -117.67, "altitude": 98.6}}
```

### Parameters

| Parameter | Type    | Default | Description                         |
| --------- | ------- | ------- | ----------------------------------- |
| `debug`   | boolean | `false` | Log each received message to stdout |

### References

- thin-edge.io issue [#3613](https://github.com/thin-edge/thin-edge.io/issues/3613) – Support batching ThinEdge JSON
