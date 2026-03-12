## tedge-config-context

Reads thin-edge.io configuration values and makes them available in the shared flow context so that other flows can access them at runtime.

### Description

The flow runs `tedge config list` on a configurable interval (default: 600 seconds) and processes each `key=value` line of its output.

For each supported configuration key (currently `device.id`), the value is stored in the flow context under that key via `context.mapper.set(key, value)`.

Other flows can then look up these values from the shared context instead of having to query the thin-edge.io configuration themselves. Below shows an example how other flows can access the value within the same mapper.

```js
export function onMessage(message, context) {
    const device_id = context.mapper.get("device.id") ?? "";
    if (device_id) {
        console.log(`device.id=${device_id}`;
    } else {
        console.log(`device.id is not set`);
    }
    return [];
}
```

### Supported keys

| Key         | Description                        |
| ----------- | ---------------------------------- |
| `device.id` | The thin-edge.io device identifier |
