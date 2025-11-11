# thin-edge.io flow data format

- single compressed file: tar.gz

- contents
  - Manifest file containing
    - engine specific (topic)

    (topic, and link to the smart function)

  - JavaScript code (bundled to a single javascript ecmascript module, ESM). .js

## Example

```sh
/opt/homebrew/etc/tedge/flows/images/uptime:1.1.2
|-- dist
|   `-- main.js
|-- flow.toml
```

**file: flow.toml**

```toml
# info
[project]
name = "uptime"
version = "1.1.2"
description = "Calculate the uptime of a given service status"
tags = ["azure", "operations"]

# input source
[input]
mqtt.topics = [
    "te/device/main/service/mosquitto-c8y-bridge/status/health",
    "te/device/main/service/tedge-mapper-bridge-c8y/status/health",
]

# steps - list of smart functions
[[steps]]
script = "dist/main.js"
interval = "10s"
config.window_size_minutes = 1440
config.stats_topic = "twin/onlineTracker"
config.default_status = "uninitialized"
```

**file: dist/main.js**

```js
export async function onMessage(message, context) {
  return [
    {
      topic: "foo",
      payload: new TextEncoder().encode(
        JSON.stringify({
          type: "other",
        }),
      ),
    },
  ];
}
```

### Manifest file details

- the file does not have to be toml, we can use other formats as toml, yaml and json are all interchangeable.
- file does not have to be called "flow.toml", so could be renamed to "manifest.json" etc.

- human readable name
- version (for tracking)
-

### Future considerations

- Support hosting the smart functions in OCI registries using the ORAS standard
  - https://oras.land/docs/

- Allows to have linked an artifact to additional SBOMs

- Allow users to add annotations
