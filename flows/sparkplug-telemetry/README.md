## sparkplug-telemetry

This flows converts messages from an input topic.

### Description

The flow processes messages as follows:

1. step 1
1. step 2

### Example

1. Publish a message

   ```sh
   tedge mqtt pub te/device/press01///m/raw '{
       "spindle.temperature.celsius": 67.3,
       "spindle.rpm": 12400,
       "spindle.load.percent": 78.5,
       "coolant.temperature.celsius": 24.1,
       "coolant.flow.litres_per_min": 8.2,
       "hydraulic.pressure.bar": 142.7,
       "hydraulic.temperature.celsius": 38.4,
       "axis.x.position.mm": 103.441,
       "axis.y.position.mm": 55.002,
       "axis.z.position.mm": 12.875,
       "axis.x.load.percent": 32.1,
       "axis.y.load.percent": 28.6,
       "axis.z.load.percent": 19.2,
       "feed.rate.mm_per_min": 800.0,
       "door.open": 0,
       "estop.active": 0,
       "program.cycle_count": 4821,
       "program.part_count": 9203,
       "alarm.code": 0,
       "power.kw": 3.74
   }'
   ```

1. Send a subset of values

   ```sh
   tedge mqtt pub te/device/press01///m/raw '{
       "door.open": 0,
       "estop.active": 0,
       "program.cycle_count": 4821,
       "program.part_count": 9203,
       "alarm.code": 0,
       "power.kw": 3.74
   }'
   ```

1. Publish a new set of values, the birth message should be re-sent as the list has changed

   ```sh
   tedge mqtt pub te/device/press01///m/raw '{
       "spindle.temperature.celsius": 67.3,
       "spindle.rpm": 12400,
       "spindle.load.percent": 78.5,
       "coolant.temperature.celsius": 24.1,
       "coolant.flow.litres_per_min": 8.2,
       "hydraulic.pressure.bar": 142.7,
       "hydraulic.temperature.celsius": 38.4,
       "axis.x.position.mm": 103.441,
       "axis.y.position.mm": 55.002,
       "axis.z.position.mm": 12.875,
       "axis.x.load.percent": 32.1,
       "axis.y.load.percent": 28.6,
       "axis.z.load.percent": 19.2,
       "feed.rate.mm_per_min": 800.0,
       "door.open": 0,
       "estop.active": 0,
       "program.cycle_count": 4821,
       "program.part_count": 9203,
       "alarm.code": 0,
       "power.kw": 3.74,
       "power.kVA": 5.3428571429
   }'
   ```
