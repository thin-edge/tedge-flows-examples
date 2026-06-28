## collectd

This flows converts messages received from collectd into thin-edge measurements

### Description

Messages are received from collectd over the MQTT topics `collectd/${host}/${group}/${key}`.

These messages are CSV encoded (using `':'` column separators)
and contain a unix timestamp followed by the measurement value: `${time}:${value}`.

Each collectd input metric is translated into a thin-edge measurement `{"time": ${time}, "${group}": {"${key}": ${value}}}`.

The topic for these output measurements is configurable, using the script `config.topic` option.
By default, the translated measurements are published on `te/device/main///m/collectd`.
