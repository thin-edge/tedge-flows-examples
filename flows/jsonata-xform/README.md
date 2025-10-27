## jsonata-xform

This flow demonstrates how to use jsonata-js to perform json transformations which follow similar substitutions rules supported by the Dynamic Mapper.

### Description

The flow is represented by the following steps:

1. Receives messages and transforms them as per the substitution rules

### Input

The flow expects the thin-edge.io service status message to be one of the following formats:

### Examples

#### Map sensor data from customer topic to tedge topic

Below shows the mapping done by the flow.

| -    | Topic                             |
| ---- | --------------------------------- |
| from | app/sensor1/DDATA/temperature     |
| to   | te/device/sensor1///m/temperature |

**file: /etc/tedge/flows/sensor.toml**

```toml
[input]
  [input.mqtt]
    topics = ["app/sensor1/DDATA/temperature"]

[[steps]]
  script = "/usr/share/tedge/flows/jsonata-xform:0.0.3/dist/main.mjs"
  [steps.config]
    # map to measurement
    targetTopic = "'te/device/' & _TOPIC_LEVEL_[1] & '///m/' & _TOPIC_LEVEL_[-1]"
    [[steps.config.substitutions]]
      # add timestamp
      pathSource = "$now()"
      pathTarget = "time"
    [[steps.config.substitutions]]
      # remap property
      pathSource = "value"
      pathTarget = "temperature.outside"
```

**Example**

```sh
tedge mqtt pub app/sensor1/DDATA/temperature "{\"value\":100.0}"
```

_Output_

```sh
[te/device/sensor1///m/temperature] {"time":"2025-10-27T08:53:59.213Z","temperature":{"outside":100}}
```
