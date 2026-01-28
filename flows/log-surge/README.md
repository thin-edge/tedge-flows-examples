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
