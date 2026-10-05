## c8y-deploy-status

Reports the progress and result of a deployment to Cumulocity, using the device's digital twin.

This flow is the companion of the [c8y-deploy-operation](../c8y-deploy-operation/) flow. `c8y-deploy-operation` converts a `c8y_ComposedTargetState` operation into a `device_profile` command and stores the deployment details in the command's `deployment` field. This flow follows that command and publishes:

- `c8y_DeploymentState_<key>`: the version assigned to the device (`version`, `assignedAt`) and its progress (`state`, `updatedAt`, `error`), updated on every status change
- `c8y_Deployment_<key>`: the deployment the device belongs to, and the version it runs (`installedVersion`, `installedAt`), updated only once the command succeeds

The fragments follow the [Deployment Manager device integration](https://github.com/Cumulocity-IoT/c8y-deployment-manager/blob/main/docs/device-integration.md).

The messages are published to the thin-edge.io twin topic (`te/<entity>/twin/<fragment>`), so the c8y mapper adds them as fragments to the device's managed object in Cumulocity.

### Description

The flow processes messages as follows:

1. Subscribes to `device_profile` commands of all entities (`te/+/+/+/+/cmd/device_profile/+`)
1. Subscribes to the digital twin (`te/+/+/+/+/twin/+`) to remember the current `c8y_Deployment_<key>` and `c8y_DeploymentState_<key>` fragments
1. Ignores the message if:
   - it is empty (the command is cleared once it has finished)
   - the command has no `deployment.key` or `deployment.version`, e.g. a `c8y_DeviceProfile` operation
   - it is a sub workflow (command id starting with `sub:`)
1. If the command is successful, publishes `c8y_Deployment_<key>` with the command's version as `installedVersion`. The `priority` is kept from the current fragment (published by c8y-deploy-poll from the server's response), or taken from the command if there is none
1. Maps the command status to a deployment state and publishes `c8y_DeploymentState_<key>`:
   - `assignedAt` is kept from the current fragment if it is for the same version (e.g. the `ASSIGNED` state published by [c8y-deploy-poll](../c8y-deploy-poll/)). Otherwise the operation's creation time (`deployment.assignedAt`, added by [c8y-deploy-operation](../c8y-deploy-operation/)) is used, or the time of the message
   - `error` is set to the command's `reason` for `FAILURE`, and left out otherwise
1. If `c8y_Deployment_<key>` is published with another `installedVersion` or `installedAt` than this flow last reported (or knows from the retained fragment), they are restored, keeping the other fields such as the priority (see [Notes](#notes))
1. If `c8y_DeploymentState_<key>` is changed to `ASSIGNED` for the version this flow last reported from a command, the reported state is published again (see [Notes](#notes))

All messages are retained and published with QoS 1.

### Status mapping

| Command status                    | Deployment state |
| --------------------------------- | ---------------- |
| `init`                            | `PENDING`        |
| `scheduled`                       | `CONFIRMED`      |
| `executing`                       | `IN_PROGRESS`    |
| `successful`                      | `SUCCESS`        |
| `failed`                          | `FAILURE`        |
| any other (custom) workflow state | `IN_PROGRESS`    |

### Example

Input (topic `te/device/main///cmd/device_profile/c8y-mapper-218`):

```json
{
  "status": "successful",
  "name": "demo/13.6",
  "deployment": {
    "key": "demo",
    "version": "13.6",
    "priority": 100,
    "assignedAt": "2026-09-24T18:40:12.345Z"
  },
  "operations": []
}
```

Output (topic `te/device/main///twin/c8y_Deployment_demo`, retained):

```json
{
  "deploymentKey": "demo",
  "priority": 100,
  "installedVersion": "13.6",
  "installedAt": "2026-09-24T18:45:32.568Z"
}
```

Output (topic `te/device/main///twin/c8y_DeploymentState_demo`, retained):

```json
{
  "deploymentKey": "demo",
  "version": "13.6",
  "assignedAt": "2026-09-24T18:40:12.345Z",
  "state": "SUCCESS",
  "updatedAt": "2026-09-24T18:45:32.568Z"
}
```

For other statuses, only the `c8y_DeploymentState_<key>` message is published, e.g. `"state": "IN_PROGRESS"` while the command is executing.

### Fragment names

The deployment key is part of the topic and the Cumulocity fragment name, so any character other than letters, digits, `_` and `-` is replaced with `_`. For example, the key `eu/west.1` becomes the fragment `c8y_DeploymentState_eu_west_1`. The original key is still available in the `deploymentKey` field.

### Parameters

See [params.toml.template](./params.toml.template).

| Parameter | Default | Description                                 |
| --------- | ------- | ------------------------------------------- |
| `debug`   | `false` | Log the messages published for each command |

### Notes

- Commands are retained until they are cleared, so a command which is still in progress is processed again when the flow restarts. The published state is the same, but `updatedAt` is set to the time the message was processed again.
- A failed deployment updates `c8y_DeploymentState_<key>` only. The `installedVersion` in `c8y_Deployment_<key>` keeps the last version which was applied completely.
- If the version is already installed (e.g. the operation was repeated), `installedAt` is kept.
- The Deployment Manager recommends writing `SUCCESS` and `installedVersion` in one request. Twin fragments are published as separate messages, so `c8y_Deployment_<key>` is published first, so a `SUCCESS` state is never seen with an older installed version.
- [c8y-deploy-poll](../c8y-deploy-poll/) publishes `ASSIGNED` once its operation request returns, but the operation can reach the device (and even finish) before that. A version is always assigned before its command starts, so an `ASSIGNED` for the version this flow last reported is replaced by the reported state again. Once another version is assigned, an `ASSIGNED` for the earlier version is kept (e.g. going from v1 to v2 and back to v1).
- Only this flow changes the installed version. [c8y-deploy-poll](../c8y-deploy-poll/) publishes `c8y_Deployment_<key>` when the server returns a different priority, from its copy of the fragment, which can be older than an update which has just completed. The installed version is then restored, and the new priority is kept. Clearing the fragment (leaving the deployment) is not restored.
- The flow subscribes to the twin fragments it publishes, so `flow.toml` sets `expect_loop = true`. Without it, thin-edge.io 2.0 and later drops all of the flow's messages to prevent a loop.
- The [c8y-deploy-poll](../c8y-deploy-poll/) flow relies on these fragments to decide whether a new version needs to be requested. It also publishes the `ASSIGNED` state when it requests an operation, and the deployment priority.
