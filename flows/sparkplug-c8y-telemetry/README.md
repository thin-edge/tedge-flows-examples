## sparkplug-c8y-telemetry

This flow converts Sparkplug B DDATA/NDATA/DBIRTH/NBIRTH messages into
Cumulocity IoT measurement format. It is closely based on the
`sparkplug-telemetry` flow but produces Cumulocity-specific output instead of
thin-edge.io measurements.

### Description

The flow processes messages as follows:

1. Parses the Sparkplug B topic to extract the device/node identifier.
2. Decodes the binary protobuf payload.
3. Finds a metric named `Temperature` (configurable via `temperatureMetricName`).
4. Emits a Cumulocity measurement envelope to `c8y/measurement/measurements/create`.

#### Output format

```json
[
  {
    "cumulocityType": "measurement",
    "externalSource": [{ "externalId": "<deviceId>", "type": "c8y_Serial" }],
    "payload": {
      "time": "2026-02-25T10:00:00.000Z",
      "source": { "id": "12345" },
      "type": "c8y_TemperatureMeasurement",
      "c8y_Steam": {
        "Temperature": {
          "unit": "C",
          "value": 85.5
        }
      }
    }
  }
]
```

> **Note:** `externalSource` is included for when external-ID-based device
> resolution is supported. The `source.id` field is used as a fallback managed
> object ID until then.

### Configuration

| Key                     | Default         | Description                                                 |
| ----------------------- | --------------- | ----------------------------------------------------------- |
| `temperatureMetricName` | `"Temperature"` | Sparkplug B metric name to use as the temperature value     |
| `sourceId`              | `"12345"`       | Cumulocity managed object ID used as the measurement source |
| `temperatureUnit`       | `"C"`           | Unit label in the `c8y_Steam.Temperature` fragment          |
| `debug`                 | `false`         | Log decoding errors to the console                          |

### Example

1. Publish a Sparkplug B message via the `sparkplug-publisher` flow:

   ```sh
   tedge mqtt pub te/device/sensor01///m/raw '{"Temperature": 85.5}'
   ```

2. The flow decodes the Sparkplug B payload and outputs:

   ```sh
   # topic: c8y/measurement/measurements/create
   [{"cumulocityType":"measurement","externalSource":[{"externalId":"sensor01","type":"c8y_Serial"}],"payload":{"time":"...","source":{"id":"12345"},"type":"c8y_TemperatureMeasurement","c8y_Steam":{"Temperature":{"unit":"C","value":85.5}}}}]
   ```
