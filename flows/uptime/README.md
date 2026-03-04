## uptime

This flow demonstrates how to use `tedge-flows` to monitor the uptime (as a percentage) of a service.

### Description

The flow is represented by the following steps:

1. Receives status changes, record the timestamps
1. Every tick, publish the statistics

### Input

The flow expects the thin-edge.io service status message to be one of the following formats:

**JSON payload**

```json
{ "status": "down | up" }
```

**Text payload**

```
1 or 0
```

### Device Parameter Schema

1. Create the DTM definition to control the parameters in Cumulocity

   ```sh
   c8y api --raw POST /service/dtm/definitions/properties --template '{
       "identifier": "flow_params_c8y_uptime",
       "jsonSchema": {
           "title": "Flow Parameters - Cumulocity Uptime",
           "description": "Track the uptime",
           "properties": {
           "window_size_minutes": {
               "type": "integer",
               "default": 1000,
               "title": "Window Size (Minutes)",
               "order": 1
           },
           "stats_topic": {
               "type": "string",
               "title": "Statistics Topic",
               "order": 2
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
