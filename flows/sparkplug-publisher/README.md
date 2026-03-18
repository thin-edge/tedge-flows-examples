## sparkplug-publisher

Translates thin-edge.io measurements, events, and alarms into Sparkplug B
`[ND]BIRTH` + `[ND]DATA` payloads and publishes them to the broker.

### How it works

| thin-edge.io topic          | Sparkplug B output                     | Notes                                                      |
| --------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| `te/device/{id}///m/{type}` | `spBv1.0/{group}/[ND]DATA/{node}/{id}` | Each JSON field → metric                                   |
| `te/device/{id}///e/{type}` | `spBv1.0/{group}/[ND]DATA/{node}/{id}` | `Event/{type}` String metric                               |
| `te/device/{id}///a/{type}` | `spBv1.0/{group}/[ND]DATA/{node}/{id}` | `Alarm/{type}/Active` Boolean + `Alarm/{type}/Text` String |

**Report by Exception** — `DATA` messages are only published when something
changes; e.g. an alarm `DATA` fires only on raise or clear.

**Alias compression** — on a device's first message a `BIRTH` is published
(retained, QoS 1) that declares every metric with its full name and an integer
alias. All subsequent `DATA` messages carry only the alias, not the name.

If a new metric appears later (e.g. a new alarm type), a fresh `BIRTH` is
re-issued containing the complete schema and last-known values for all metrics.

### Testing

In one terminal, subscribe to all Sparkplug B output so you can see what is
published:

```sh
tedge mqtt sub 'spBv1.0/#'
```

In a second terminal, publish test messages:

#### Measurements

```sh
# Child device measurement → DBIRTH (first time) + DDATA
tedge mqtt pub te/device/press01///m/raw '{
  "spindle.temperature.celsius": 67.3,
  "spindle.rpm": 12400,
  "coolant.temperature.celsius": 24.1
}'

# Second measurement from same device → DDATA only (alias compression)
tedge mqtt pub te/device/press01///m/raw '{
  "spindle.temperature.celsius": 68.1,
  "spindle.rpm": 12450,
  "coolant.temperature.celsius": 24.2
}'

# Edge node measurement (deviceId matches edgeNodeId) → NBIRTH + NDATA
tedge mqtt pub te/device/gateway01///m/raw '{"cpu.percent": 12.4, "mem.free.mb": 512}'
```

#### Events

```sh
# Fire an event → DBIRTH (if first from this device) + DDATA
# Metric name on wire: Event/login
tedge mqtt pub te/device/press01///e/login '{"text": "Operator admin logged in"}'

# A second event of the same type → DDATA only
tedge mqtt pub te/device/press01///e/login '{"text": "Operator admin logged out"}'

# Different event type → re-BIRTH (new metric) + DDATA
tedge mqtt pub te/device/press01///e/door_open '{"text": "Safety door opened"}'
```

#### Alarms

thin-edge.io alarms use **retained MQTT messages** — raising an alarm publishes
a retained JSON message; clearing it publishes an empty retained message (which
removes the retained payload from the broker).

```sh
# Raise an alarm → DBIRTH (or re-BIRTH if first alarm for this device) + DDATA
# Metrics on wire: Alarm/HighTemp/Active=true, Alarm/HighTemp/Text="..."
tedge mqtt pub --retain te/device/press01///a/HighTemp \
  '{"text": "Spindle temperature exceeded 80°C", "severity": "critical"}'

# Clear the alarm (publish empty retained message) → DDATA with Active=false, Text=""
tedge mqtt pub --retain te/device/press01///a/HighTemp ''

# A second alarm type on the same device → re-BIRTH (new metric pair) + DDATA
tedge mqtt pub --retain te/device/press01///a/LowCoolant \
  '{"text": "Coolant flow below minimum", "severity": "major"}'
```

### Expected Sparkplug B output

Because the payloads are binary protobuf you won't see human-readable output
from `tedge mqtt sub`. Use [spmon](../../tools/spmon) to inspect them:

```sh
cd tools/spmon
./spmon --broker localhost --group tedge --node gateway01
```

Press `R` inside spmon to send a Sparkplug B NCMD rebirth command to the flow,
which will immediately re-publish retained BIRTH messages for every known device
with their current last-known metric values.

Or decode a single message with `mosquitto_sub` + a protobuf decoder of your
choice. The Sparkplug B topic layout is:

```
spBv1.0/{groupId}/DBIRTH/{edgeNodeId}/{deviceId}   ← retained, full schema
spBv1.0/{groupId}/DDATA/{edgeNodeId}/{deviceId}    ← alias-only, RbE updates
spBv1.0/{groupId}/NBIRTH/{edgeNodeId}              ← edge node birth (retained)
spBv1.0/{groupId}/NDATA/{edgeNodeId}               ← edge node data
```

With the default `flow.toml` config (`groupId=tedge`, `edgeNodeId=gateway01`):

```
spBv1.0/tedge/DBIRTH/gateway01/press01
spBv1.0/tedge/DDATA/gateway01/press01
spBv1.0/tedge/NBIRTH/gateway01
spBv1.0/tedge/NDATA/gateway01
```
