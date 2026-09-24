## c8y-deploy-operation

Converts a Cumulocity `c8y_ComposedTargetState` operation into a thin-edge.io `device_profile` command.

The conversion follows what the c8y mapper does for the built-in `c8y_DeviceProfile` operation. Because the command uses the c8y mapper's command id prefix (`c8y-mapper-<operationId>`), the mapper takes care of the rest:

- sets the Cumulocity operation to EXECUTING, SUCCESSFUL or FAILED
- updates the firmware, software list and configuration fragments once the command succeeds
- clears the retained command message

The deployment details (`deploymentKey`, `version`, `priority` etc.) are kept in the command's `deployment` field. Use the [c8y-deploy-status](../c8y-deploy-status/) flow to report the deployment's progress to Cumulocity.

### Example

Input (topic `c8y/devicecontrol/notifications`):

```json
{
  "agentId": "87143",
  "deviceId": "87143",
  "id": "218",
  "status": "PENDING",
  "c8y_ComposedTargetState": {
    "deploymentKey": "demo",
    "version": "13.6",
    "priority": 100,
    "firmware": {
      "name": "tedge-rugix-image",
      "version": "20260528.1440",
      "url": "https://github.com/thin-edge/tedge-rugix-image/releases/download/20260528.1440/tedge-raspios-arm64-tryboot_20260528.1440.rugixb"
    },
    "software": [
      {
        "name": "tedge",
        "version": "2.0.1",
        "softwareType": "apt",
        "action": "install"
      },
      {
        "name": "htop",
        "version": "latest",
        "softwareType": "apt",
        "action": "install"
      }
    ]
  },
  "externalSource": { "externalId": "deploy1020304", "type": "c8y_Serial" }
}
```

Output (topic `te/device/main///cmd/device_profile/c8y-mapper-218`, retained):

```json
{
  "status": "init",
  "name": "demo/13.6",
  "deployment": {
    "key": "demo",
    "version": "13.6",
    "priority": 100
  },
  "operations": [
    {
      "operation": "firmware_update",
      "payload": {
        "name": "tedge-rugix-image",
        "version": "20260528.1440",
        "remoteUrl": "https://github.com/thin-edge/tedge-rugix-image/releases/download/20260528.1440/tedge-raspios-arm64-tryboot_20260528.1440.rugixb"
      },
      "@skip": false
    },
    {
      "operation": "software_update",
      "payload": {
        "updateList": [
          {
            "type": "apt",
            "modules": [
              { "name": "tedge", "version": "2.0.1", "action": "install" },
              { "name": "htop", "version": "latest", "action": "install" }
            ]
          }
        ]
      },
      "@skip": false
    }
  ]
}
```

### Conversion rules

These match the c8y mapper's `c8y_DeviceProfile` conversion:

- The profile name is `<deploymentKey>/<version>`
- Operations are ordered: firmware, then configuration (one `config_update` per item), then software
- Software modules are grouped by `softwareType`. If `softwareType` is missing, the legacy `<version>::<type>` format is used, and the type falls back to `default`
- Software action `delete` becomes `remove`. Any other action except `install` creates a `failed` command, so the operation is marked as FAILED
- Empty versions and URLs are left out
- URLs pointing to the Cumulocity tenant (`c8y_url`) are changed to use the local Cumulocity proxy (`proxy_url`), e.g. `https://example.cumulocity.com/inventory/binaries/19133` becomes `http://127.0.0.1:8001/c8y/inventory/binaries/19133`. The original URL is kept as `serverUrl` for configuration items
- All other target state fields (e.g. `deploymentKey`, `version` and `priority`) are kept in the `deployment` object, with `deploymentKey` renamed to `key`. Workflows can read them as `${.payload.deployment.key}`, `${.payload.deployment.version}` and `${.payload.deployment.priority}`

### Target device

The target entity is found from `externalSource.externalId`, checking in this order:

1. The main device, if the operation's `agentId` equals its `deviceId`
2. The main device, if the external id matches `device_id`
3. Entities in the mapper context with a matching `external_id` (or `@id`). Only keys that are entity topic ids (e.g. `device/child01//` or `te/device/child01//`) are used, because other flows store unrelated values in the same shared context
4. A child device using the default external id scheme `<device_id>:device:<child>`

If none of these match, the operation is ignored.

### Configuration

These values come from the c8y mapper config, so no manual setup is needed:

| Flow setting                | Mapper config                                                | Used for                                                |
| --------------------------- | ------------------------------------------------------------ | ------------------------------------------------------- |
| input topic prefix          | `${mapper.bridge.topic_prefix}` (`c8y.bridge.topic_prefix`)  | Subscribing to `<prefix>/devicecontrol/notifications`   |
| `device_id`                 | `${mapper.device.id}` (`device.id`)                          | Resolving the main device and child devices             |
| `c8y_url`                   | `${mapper.http}` (`c8y.http`)                                | Deciding which URLs point to the Cumulocity tenant      |
| `proxy_url` (host and port) | `${mapper.proxy.client.host}`, `${mapper.proxy.client.port}` | Rewriting Cumulocity URLs to go through the local proxy |

If a mapper value can't be resolved, it is ignored: URLs are not rewritten, and the proxy falls back to `http://127.0.0.1:8001`.

Other settings are in [params.toml.template](./params.toml.template), e.g. set `proxy_scheme = "https"` if `c8y.proxy.cert_path` is configured.

### Notes

- The device must support the `device_profile` command, which `tedge-agent` supports by default. The c8y mapper must also have `c8y.enable.device_profile` enabled (the default).
- The status is reported by operation id, so `c8y.smartrest.use_operation_id` must be `true` (the default).
- To list `c8y_ComposedTargetState` in the device's supported operations, create an empty operation file, e.g. `sudo touch /etc/tedge/operations/c8y/c8y_ComposedTargetState`. The file has no command, so the c8y mapper does not handle the operation itself and leaves it to this flow.
