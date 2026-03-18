## log-surge

This flow demonstrates how to use `tedge-flows` to monitor system logs for surges in error messages and raise alarms accordingly.

### Description

The flow uses a single filter to do the message normalization, filtering and aggregation.

The flow is represented by the following steps:

1. Parse and normalize the journald message
1. Optionally filter the message based on a given regex pattern
1. Increment the counter for message's log level
1. Every tick, check the statistics for a threshold and publish an alarm if there are too many log messages of a specific. Reset the counter afterwards.

### Input

The flow can be fed from data journald in JSON format (e.g. published via MQTT, or in the future by just executing a command).

```sh
journalctl -o json -b ----cursor-file=./tmp.cursor --no-pager -n 100
```

### Improvements

- Allow the flow to receive input from a command's standard output rather than over MQTT. The command could then be executed periodically by the mapper, and the output.

## Using it

### Install dependencies

```sh
npm install
```

### Run tests

```sh
npm run test
```

### Create package

Build the package and pull in all the dependencies and transpile the JavaScript down to the targer version (e.g. `ES2018`)

```sh
npm run build
```

The output package (which is a standalone JavaScript file) is under `./lib/main.js`.

### Run test package

First build the test variant of the package (which includes an entrypoint to start the script)

```sh
npm run build:test
npm run start:quickjs
npm run start:nodejs
```

Then run the build package under different JavaScript engines (you'll have to install the dependencies yourself).

```sh
npm run start:nodejs

# using quickjs runtime
npm run start:quickjs

# using wasm based quickjs version
npm run start:wasm-quickjs
```

### Device Parameter Schema

Create the DTM definition to control the parameters in Cumulocity

```sh
c8y api --raw POST /service/dtm/definitions/properties --template '{
  "identifier": "flow_params_local_log-surge",
  "jsonSchema": {
    "title": "Flow Parameters - Log Surge Detection",
    "description": "Monitor high amount of log entries",
    "properties": {
      "with_logs": {
        "type": "boolean",
        "default": false,
        "description": "Publish individual log entries (useful for debugging)."
      },
      "debug": {
        "type": "boolean",
        "default": false,
        "description": "Enable debug messages."
      },
      "publish_statistics": {
        "type": "boolean",
        "default": true,
        "description": "Publish aggregated statistics instead of individual log entries."
      },
      "threshold_total": {
        "type": "integer",
        "minimum": 0,
        "default": 500,
        "description": "Total number of log entries (regardless of log level) before triggering an alarm. 0 disables the alarm."
      },
      "threshold_error": {
        "type": "integer",
        "minimum": 0,
        "default": 10,
        "description": "Number of error log entries before triggering an alarm. 0 disables the alarm."
      },
      "threshold_warning": {
        "type": "integer",
        "minimum": 0,
        "default": 50,
        "description": "Number of warning log entries before triggering an alarm. 0 disables the alarm."
      },
      "threshold_info": {
        "type": "integer",
        "minimum": 0,
        "default": 0,
        "description": "Number of info log entries before triggering an alarm. 0 disables the alarm."
      },
      "text_filter": {
        "type": "array",
        "description": "Optional list of regex patterns used to filter log messages. Only matching messages will be included.",
        "items": {
          "type": "string",
          "format": "regex"
        },
        "minItems": 1
      }
    },
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
