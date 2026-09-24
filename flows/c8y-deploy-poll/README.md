## c8y-deploy-poll

Periodically asks the Cumulocity deployment service whether a new version of a deployment is available for the device, and requests a `c8y_ComposedTargetState` operation when the device is not up to date.

The operation is handled by the other deployment flows:

- [c8y-deploy-operation](../c8y-deploy-operation/) converts the operation into a `device_profile` command
- [c8y-deploy-status](../c8y-deploy-status/) reports the progress and the last successfully applied version

All three flows need to be installed.

> [!NOTE]
> The deployment service is still being developed, so this flow is experimental.

### How it works

The evaluate endpoint does not know which version the device is running, and every call with `createOperation=true` creates a new operation. The flow therefore first does a dry run, and only requests an operation if the offered version is new:

```
 dry run: POST .../deployments/<key>/targetstates/<target_state>/evaluate   {context...}
   │
   ├─ available: false                             → wait for the next poll
   ├─ version == last successful version           → in sync, wait for the next poll
   ├─ version is ASSIGNED/PENDING/…/IN_PROGRESS    → in progress, wait for the next poll
   ├─ version failed max_attempts times            → give up (until a new version is offered)
   └─ otherwise
        └─ POST ...evaluate?createOperation=true   → c8y_DeploymentState_<key> = ASSIGNED
                                                      (the operation arrives via c8y-deploy-operation)
```

Flow steps cannot make HTTP requests, so the requests are sent by [poll.sh](./poll.sh):

1. The step publishes the next request (retained) on `tedge-flows/c8y-deploy-poll/<key>/request`:

   ```
   <due epoch seconds> <expires epoch seconds|0> <request id> <path> <json body>
   ```

2. Every minute, `poll.sh` reads the request. Once it is due, it sends the request via `tedge http post` (each request only once) and prints the result:

   ```json
   {
     "id": "mfxv8r2o-3",
     "path": "/c8y/service/deployment-device-proxy/deployments/demo/targetstates/active/evaluate",
     "ok": true,
     "response": "{\"available\":true,\"deploymentKey\":\"demo\",\"version\":\"13.6\",\"priority\":100,\"payload\":{...}}"
   }
   ```

3. The step decides what to do next and publishes the next request.

Each device polls at a fixed time within the `interval`, derived from the device id and deployment key, so a fleet does not poll at the same time. Failed requests are retried with an exponential backoff (starting at `retry_min`). Operation requests are never retried blindly: a failed operation request is followed by a new dry run.

### Operations in progress

Deployments can take a long time (e.g. hours for a firmware update), so no operation is requested while the device is busy, however long it takes:

- The deployment is in progress: `c8y_DeploymentState_<key>` is `ASSIGNED`, `PENDING`, `CONFIRMED` or `IN_PROGRESS` (published by c8y-deploy-status). Only `ASSIGNED` expires (`assigned_timeout`), as the operation normally arrives within seconds.
- A command of the main device listed in `busy_operations` is not finished (`te/device/main///cmd/<operation>/<id>` with a status other than `successful` or `failed`). This also covers operations which were not requested by this flow, e.g. a firmware update or another deployment started from Cumulocity, and works without c8y-deploy-status.

While the device is busy, the flow keeps polling (and reports `in_progress` or `device_busy` events), but does not request an operation. In `server` mode, a plain check (without `createOperation`) is done instead.

A deployment or operation which never finishes blocks new deployments. Set `in_progress_timeout` (e.g. `24h`) to report it with a `stuck` event and a warning in the logs when its status has not changed for that long. Nothing is requested, so the device can be checked before a new deployment is started.

### Device context

The request body is built from (later sources override earlier ones):

1. the detected architecture as `arch`, if `detect_arch` is enabled
2. the `context` param, e.g. `context = { type = "deluxe" }`
3. the JSON file set by `context_file`, e.g. `{"type": "deluxe"}`
4. the `priority` param, if set. Otherwise the server assigns the priority

The architecture is detected by `poll.sh detect` (once an hour) from `dpkg --print-architecture` if available, otherwise from `uname -m`. dpkg is preferred, as it reports the architecture of the OS rather than the kernel: e.g. the 32-bit Raspberry Pi OS runs a 64-bit kernel (`aarch64`), but needs `armv7` software. The value is normalized:

| dpkg / uname -m                                             | `arch`                      |
| ----------------------------------------------------------- | --------------------------- |
| `amd64`, `x86_64`                                           | `amd64`                     |
| `arm64`, `aarch64`, `arm64e`, `armv8*` (except `armv8l`)    | `arm64`                     |
| `armhf`, `armv7*`, `armv8l` (32-bit kernel on a 64-bit CPU) | `armv7`                     |
| `armel`, `armv6*`, `armv5*`                                 | `armv6`                     |
| `i386`, `i686`, `i586`                                      | `386`                       |
| `riscv64`                                                   | `riscv64`                   |
| anything else                                               | as is (a warning is logged) |

A dpkg architecture with an OS prefix (e.g. `musl-linux-arm64`) is reduced to the CPU part. The selection criteria of a deployment are matched exactly, so the deployment has to use the same names. Set `arch` in `context` to override the detected value.

Only string values are sent. For example, with the default params on an arm64 device:

```json
{ "arch": "arm64", "type": "deluxe", "priority": 100 }
```

### Published messages

| Topic (retained)                                  | Payload                                                                                                                                                                |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `te/device/main///twin/c8y_DeploymentState_<key>` | `{"deploymentKey","version","state":"ASSIGNED","updatedAt"}` when an operation was requested                                                                           |
| `te/device/main///twin/c8y_Deployment_<key>`      | `{"deploymentKey","priority"}` after the first poll and when the priority changes. The `version` (last successfully applied version, set by c8y-deploy-status) is kept |
| `tedge-flows/c8y-deploy-poll/<key>/request`       | Next request for poll.sh                                                                                                                                               |
| `tedge-flows/c8y-deploy-poll/<key>/state`         | `{"version","attempts","requestedAt","lastPollAt","lastRequestId","failures","priority"}`                                                                              |

The state is kept in retained messages, so it survives restarts.

### Events

Set `events` to publish events describing what the flow is doing, e.g. to explain to a customer why a device has not been updated yet. The events are published on `te/device/main///e/c8y_DeploymentPoll`, which the c8y mapper forwards as Cumulocity events of type `c8y_DeploymentPoll`.

- `off` (default): no events
- `changes`: only when the outcome differs from the previous event, e.g. a daily poll which finds no update only creates an event the first time
- `all`: an event for every evaluation

Example (`te/device/main///e/c8y_DeploymentPoll`):

```json
{
  "text": "No update available for deployment demo: the rollout has not reached this device yet",
  "time": "2026-09-25T06:12:40.000Z",
  "deploymentKey": "demo",
  "targetState": "active",
  "outcome": "not_available",
  "reason": "threshold.exceeded",
  "priority": 42,
  "nextPollAt": "2026-09-26T06:12:40.000Z"
}
```

| `outcome`             | Example text                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `not_available`       | No update available for deployment demo: the rollout has not reached this device yet                                                                         |
| `in_sync`             | The device is up to date with version 13.6 of deployment demo                                                                                                |
| `in_progress`         | Version 13.6 of deployment demo is already being installed (IN_PROGRESS)                                                                                     |
| `device_busy`         | Another operation is in progress on the device (firmware_update c8y-mapper-5: executing). No operation is requested for deployment demo until it is finished |
| `stuck`               | Version 13.6 of deployment demo has not progressed for more than 24h (IN_PROGRESS since 2026-09-24T06:00:00.000Z). Please check the device                   |
| `new_version`         | Version 13.6 of deployment demo is available (`all` only, always followed by the next event)                                                                 |
| `operation_requested` | Requested the operation to install version 13.6 of deployment demo (attempt 1 of 3)                                                                          |
| `completed`           | Version 13.7 of deployment demo was installed successfully                                                                                                   |
| `failed`              | Installation of version 13.7 of deployment demo failed: firmware_update failed: Download failed. It is requested again at the next poll (attempt 2 of 3)     |
| `gave_up`             | Version 13.6 of deployment demo failed 3 times. It is not requested again until a new version is available                                                   |
| `preview`             | Version 13.6 of deployment demo is available for target state latest. No operation is requested for preview target states                                    |
| `not_created`         | The server did not create an operation for version 13.6 of deployment demo (`server` mode)                                                                   |
| `request_failed`      | Could not check deployment demo (HTTP 502), retrying in 10m                                                                                                  |
| `request_error`       | Could not check deployment demo (HTTP 404): the deployment or target state does not exist                                                                    |
| `request_lost`        | No result was received for the last request of deployment demo. Checking again                                                                               |

The result of a deployment (`completed` or `failed`) is reported when c8y-deploy-status publishes `SUCCESS` or `FAILURE` in `c8y_DeploymentState_<key>`, also for deployments which were not requested by this flow. The reason of a failure is taken from the failed `device_profile` command. Each result is reported once, and results from before the flow started are not reported again (e.g. after a restart). With `changes`, the first `in_sync` after a `completed` event is not reported.

The events contain the fields `deploymentKey`, `targetState`, `outcome` and `nextPollAt`, and depending on the outcome `version`, `reason`, `state`, `operation`, `since`, `priority`, `attempts`, `status` and `error`. The `reason` values are:

| `reason`                    | Meaning                                                         |
| --------------------------- | --------------------------------------------------------------- |
| `threshold.exceeded`        | The rollout has not reached this device yet (priority too high) |
| `selectionCriteria.noMatch` | The device context does not match the selection criteria        |
| `deployment.paused`         | The deployment is paused                                        |
| `deployment.stopped`        | The deployment is stopped                                       |

### Parameters

See [params.toml.template](./params.toml.template).

> [!NOTE]
> The defaults are set up for the `demo` deployment, so that the flow works out of the box with a short poll interval and events enabled. For a production installation, use a longer `interval` (e.g. `24h`), `startup_delay` and `retry_min` (e.g. `5m`), and set the device context of your devices.

| Parameter             | Default                                                                     | Description                                                                                                 |
| --------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `deployment_key`      | `demo`                                                                      | Deployment to evaluate (required). Letters, digits, `_` and `-` only                                        |
| `target_state`        | `active`                                                                    | Target state to evaluate: `active`, `latest` or a version                                                   |
| `detect_arch`         | `true`                                                                      | Add the normalized architecture of the device to the device context as `arch`                               |
| `context`             | `{ type = "deluxe" }`                                                       | Device context (string values)                                                                              |
| `context_file`        |                                                                             | JSON file with additional device context                                                                    |
| `priority`            | `100`                                                                       | Priority requested by the device. Only used if the deployment allows it                                     |
| `interval`            | `5m`                                                                        | Poll interval                                                                                               |
| `startup_delay`       | `10s`                                                                       | Maximum delay of the first poll after the flow is installed                                                 |
| `retry_min`           | `1m`                                                                        | First retry delay after a failed request                                                                    |
| `max_attempts`        | `3`                                                                         | Maximum number of operation requests for the same version                                                   |
| `assigned_timeout`    | `15m`                                                                       | Time after which an `ASSIGNED` deployment without progress counts as a failed attempt                       |
| `busy_operations`     | `["device_profile", "firmware_update", "software_update", "config_update"]` | Operations which block a new deployment while they are in progress                                          |
| `in_progress_timeout` |                                                                             | Report a deployment or operation without a status change for this long (e.g. `24h`). Warning only           |
| `operation_request`   | `client`                                                                    | `client`: dry run first. `server`: always request the operation and let the server decide                   |
| `server_query`        |                                                                             | Additional query parameters in `server` mode                                                                |
| `allow_preview`       | `false`                                                                     | Allow requesting operations for target states other than `active`                                           |
| `events`              | `changes`                                                                   | Publish `c8y_DeploymentPoll` events: `off`, `changes` (only when the outcome changes) or `all` (every poll) |
| `state_dir`           | `/tmp/c8y-deploy-poll`                                                      | Directory where poll.sh remembers the last executed request                                                 |
| `topic_root`          | `te`                                                                        | thin-edge.io MQTT topic root                                                                                |
| `debug`               | `false`                                                                     | Log each evaluation and scheduled request                                                                   |

### Device Parameter Schema

Create the DTM definition to control the parameters in Cumulocity

```sh
c8y api --raw POST /service/dtm/definitions/properties --template '{
  "identifier": "flow_params_c8y_c8y-deploy-poll",
  "jsonSchema": {
    "title": "Flow Parameters - Cumulocity Deployment Poll",
    "description": "Periodically check for a new deployment version and request it. The defaults are set up for the demo deployment",
    "additionalProperties": true,
    "$schema": "http://json-schema.org/draft-07/schema#",
    "properties": {
      "deployment_key": {
        "type": "string",
        "default": "demo",
        "title": "Deployment Key",
        "description": "Deployment to evaluate. Letters, digits, _ and - only",
        "pattern": "^[A-Za-z0-9_-]{1,128}$",
        "order": 1
      },
      "target_state": {
        "type": "string",
        "default": "active",
        "title": "Target State",
        "description": "Target state to evaluate: active, latest or a version. Operations are only requested for active, unless Allow Preview is enabled",
        "order": 2
      },
      "detect_arch": {
        "type": "boolean",
        "default": true,
        "title": "Detect Architecture",
        "description": "Add the architecture of the device to the device context as arch, e.g. arm64, armv7 or amd64. A value set in the Device Context or the context file takes precedence",
        "order": 3
      },
      "context": {
        "type": "object",
        "default": {
          "type": "deluxe"
        },
        "title": "Device Context",
        "description": "Device context sent to the server and matched against the selection criteria of the deployment, e.g. {\"arch\": \"arm64\"}. Values must be strings",
        "additionalProperties": {
          "type": "string"
        },
        "order": 4
      },
      "context_file": {
        "type": "string",
        "default": "",
        "title": "Device Context File",
        "description": "Path to a JSON file on the device with additional device context. Its values override the Device Context",
        "order": 5
      },
      "priority": {
        "type": "integer",
        "default": 100,
        "minimum": 0,
        "title": "Priority",
        "description": "Priority requested by the device. Leave empty to use the priority assigned by the server. Only used if the deployment allows it",
        "order": 6
      },
      "interval": {
        "type": "string",
        "default": "5m",
        "title": "Poll Interval",
        "description": "How often to check for a new version, e.g. 30m, 12h, 1d. Each device polls at a fixed offset within the interval",
        "pattern": "^[0-9]+(\\.[0-9]+)?(ms|s|m|h|d)?$",
        "order": 7
      },
      "startup_delay": {
        "type": "string",
        "default": "10s",
        "title": "Startup Delay",
        "description": "Maximum delay of the first poll after the flow is installed",
        "pattern": "^[0-9]+(\\.[0-9]+)?(ms|s|m|h|d)?$",
        "order": 8
      },
      "retry_min": {
        "type": "string",
        "default": "1m",
        "title": "Retry Delay",
        "description": "First retry delay after a failed request. Doubled on each failure, up to the poll interval",
        "pattern": "^[0-9]+(\\.[0-9]+)?(ms|s|m|h|d)?$",
        "order": 9
      },
      "max_attempts": {
        "type": "integer",
        "minimum": 1,
        "default": 3,
        "title": "Max Attempts",
        "description": "Maximum number of operation requests for the same version",
        "order": 10
      },
      "assigned_timeout": {
        "type": "string",
        "default": "15m",
        "title": "Assigned Timeout",
        "description": "Time after which an ASSIGNED deployment without any progress is requested again",
        "pattern": "^[0-9]+(\\.[0-9]+)?(ms|s|m|h|d)?$",
        "order": 11
      },
      "busy_operations": {
        "type": "array",
        "default": [
          "device_profile",
          "firmware_update",
          "software_update",
          "config_update"
        ],
        "title": "Busy Operations",
        "description": "Operations which block a new deployment while they are in progress on the device",
        "items": {
          "type": "string"
        },
        "uniqueItems": true,
        "order": 12
      },
      "in_progress_timeout": {
        "type": "string",
        "default": "",
        "title": "In Progress Timeout",
        "description": "Report a deployment or operation which has not changed its status for this long, e.g. 24h. Warning only. Leave empty to disable",
        "pattern": "^([0-9]+(\\.[0-9]+)?(ms|s|m|h|d)?)?$",
        "order": 13
      },
      "operation_request": {
        "type": "string",
        "enum": [
          "client",
          "server"
        ],
        "default": "client",
        "title": "Operation Request Mode",
        "description": "client: check for a new version first, then request the operation. server: always request the operation and let the server decide (requires server support)",
        "order": 14
      },
      "server_query": {
        "type": "string",
        "default": "",
        "title": "Server Query Parameters",
        "description": "Additional query parameters used in server mode",
        "order": 15
      },
      "allow_preview": {
        "type": "boolean",
        "default": false,
        "title": "Allow Preview",
        "description": "Allow requesting operations for target states other than active",
        "order": 16
      },
      "events": {
        "type": "string",
        "enum": [
          "off",
          "changes",
          "all"
        ],
        "default": "changes",
        "title": "Events",
        "description": "Publish c8y_DeploymentPoll events describing what the flow does. changes: only when the outcome changes. all: on every poll",
        "order": 17
      },
      "state_dir": {
        "type": "string",
        "default": "/tmp/c8y-deploy-poll",
        "title": "State Directory",
        "description": "Directory where poll.sh remembers the last executed request",
        "order": 18
      },
      "topic_root": {
        "type": "string",
        "default": "te",
        "title": "Topic Root",
        "description": "thin-edge.io MQTT topic root",
        "order": 19
      },
      "debug": {
        "type": "boolean",
        "default": false,
        "title": "Debug",
        "description": "Log each evaluation and scheduled request",
        "order": 20
      }
    },
    "required": [
      "deployment_key"
    ],
    "type": "object"
  },
  "contexts": [
    "asset",
    "event",
    "operation"
  ]
}
'
```

### Design notes

- **Dry run before requesting an operation**: the evaluate endpoint does not know which version the device has installed, and each call with `createOperation=true` creates a new operation. The flow therefore compares the offered version with the device state first.
- **Retained request instead of HTTP in the step**: flow steps cannot do any I/O, and a process input cannot be triggered by a step. The step publishes the next request (retained) and poll.sh sends it once it is due. All decisions stay in the step, where they are unit tested, and the retained request is also the schedule, so polls missed while the device was off are caught up after a restart.
- **At most once**: poll.sh remembers the last executed request. Operation requests expire after 10 minutes, a pending request is only changed before it is due, and a request without a result is followed by a new dry run (never by a new operation request).
- **State in retained messages**: the flow context is not persisted, so the attempts, the last request, the last event and the last reported result are kept in `tedge-flows/c8y-deploy-poll/<key>/state`.
- **dpkg before uname**: `uname -m` reports the kernel architecture, which differs from the OS architecture on e.g. 32-bit Raspberry Pi OS with a 64-bit kernel.
- **server mode**: prepared for a deployment service which only creates an operation when the device needs it. The flow then sends a single request, and only a plain check while the device is busy.

### Notes

- Only the main device is supported, and each flow instance handles one deployment key. Install the flow again with other params to poll another deployment.
- Preview target states (`latest` or a version) are evaluated, but no operation is requested unless `allow_preview` is set.
- `server` mode is intended for a future version of the deployment service which only creates an operation if the device needs it. In this mode, `ASSIGNED` is only published if the response contains `"operationCreated": true`.
- The deployment service expects `c8y_Deployment_<key>.version` to be the assigned version, whereas c8y-deploy-status publishes the last successfully applied version. This flow relies on the latter.
- To reset the flow, clear its retained messages:

  ```sh
  tedge mqtt pub -r tedge-flows/c8y-deploy-poll/<key>/request ''
  tedge mqtt pub -r tedge-flows/c8y-deploy-poll/<key>/state ''
  ```
