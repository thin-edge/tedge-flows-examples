## certificate-alert

Monitors the thin-edge.io device certificate and raises Cumulocity alarms when
it is approaching its expiry date.

Every interval the flow runs `tedge cert show`, parses the certificate details,
and then:

1. **Publishes certificate metadata** to the digital twin at
   `te/device/main///twin/tedge_Certificate` (subject, issuer, validity window,
   signing authority, serial number). Can be disabled with `disable_twin`.

2. **Raises or clears alarms** based on the time remaining until expiry:
   - A **major alarm** (`certificateExpiresSoon_alarm`) is raised when the
     certificate expires within the `alarm` threshold (default `30d`).
   - A **warning alarm** (`certificateExpiresSoon_warn`) is raised when the
     certificate expires within the `warning` threshold (default `60d`).
   - Both alarms are **cleared** (empty retained message) once the certificate
     is renewed and outside both thresholds.

Alarming can be disabled entirely with `disable_alarms`.

## Experiment: Device Parameter Definition

The following Digital Twin Manager (DTM) definition describes the configurable aspects of the flow.

```sh
c8y api --raw POST /service/dtm/definitions/properties --template '{
    "identifier": "flow_params_local_certificate-alert",
    "jsonSchema": {
        "title": "Flow Parameters - Certificate Alert",
        "description": "Certificate expiration alerts",
        "properties": {
            "disable_alarms": {
                "type": "boolean",
                "default": false,
                "title": "Disable Alarms",
                "order": 1
            },
            "alarm": {
                "type": "string",
                "title": "Alarm threshold",
                "default": "30d",
                "order": 2
            },
            "warning": {
                "type": "string",
                "title": "Warning threshold",
                "default": "60d",
                "order": 3
            },
            "disable_twin": {
                "type": "boolean",
                "default": false,
                "title": "Don't publish certificate info via the digital twin",
                "order": 4
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
