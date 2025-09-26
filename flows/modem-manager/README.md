## modem-manager

Publish modem manager (cellular) information including cell tower id which can be used for tracking.

### Description

- Detect changes of the cell tower id
- Send data periodically - configurable interval

The flow is represented by the following steps:

- Detect changes in the cell tower id, and send an event to the cloud to determine location information
- Publish c8y_Mobile information about the modem (using modem manager data)

### Input

The flow expects the modem manager input json in the following format:

**JSON payload**

```json
{
  "sim": {
    "dbus-path": "/org/freedesktop/ModemManager1/SIM/0",
    "properties": {
      "active": "yes",
      "eid": "--",
      "emergency-numbers": [],
      "esim-status": "--",
      "gid1": "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
      "gid2": "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
      "iccid": "8949360000421790514",
      "imsi": "262231017669630",
      "operator-code": "26223",
      "operator-name": "1&1",
      "preferred-networks": [
        "operator-code: 26223, access-technologies: lte",
        "operator-code: 20801, access-technologies: gsm, umts, lte"
      ],
      "removability": "--",
      "sim-type": "--"
    }
  },
  "modem": {
    "location": {
      "3gpp": {
        "cid": "00A49109",
        "lac": "0000",
        "mcc": "262",
        "mnc": "02",
        "tac": "00AD2B"
      },
      "cdma-bs": {
        "latitude": "--",
        "longitude": "--"
      },
      "gps": {
        "altitude": "--",
        "latitude": "--",
        "longitude": "--",
        "nmea": [],
        "utc": "--"
      }
    },
    "3gpp": {
      "5gnr": {
        "registration-settings": {
          "drx-cycle": "--",
          "mico-mode": "--"
        }
      },
      "enabled-locks": ["fixed-dialing"],
      "eps": {
        "initial-bearer": {
          "dbus-path": "/org/freedesktop/ModemManager1/Bearer/1",
          "settings": {
            "apn": "--",
            "ip-type": "--",
            "password": "--",
            "user": "--"
          }
        },
        "ue-mode-operation": "csps-1"
      },
      "imei": "860018046114881",
      "network-rejection-access-technology": "--",
      "network-rejection-error": "--",
      "network-rejection-operator-id": "--",
      "network-rejection-operator-name": "--",
      "operator-code": "26202",
      "operator-name": "Vodafone.de",
      "packet-service-state": "attached",
      "pco": "--",
      "registration-state": "home"
    },
    "cdma": {
      "activation-state": "--",
      "cdma1x-registration-state": "--",
      "esn": "--",
      "evdo-registration-state": "--",
      "meid": "--",
      "nid": "--",
      "sid": "--"
    },
    "dbus-path": "/org/freedesktop/ModemManager1/Modem/0",
    "generic": {
      "access-technologies": ["lte"],
      "bearers": ["/org/freedesktop/ModemManager1/Bearer/0"],
      "carrier-configuration": "--",
      "carrier-configuration-revision": "--",
      "current-bands": [
        "utran-1",
        "utran-8",
        "eutran-1",
        "eutran-3",
        "eutran-5",
        "eutran-7",
        "eutran-8",
        "eutran-20",
        "eutran-38",
        "eutran-40",
        "eutran-41"
      ],
      "current-capabilities": ["gsm-umts, lte"],
      "current-modes": "allowed: 3g, 4g; preferred: 3g",
      "device": "qcom-soc",
      "device-identifier": "69bc305f94b9e998c1f05afae06af3eb2f806829",
      "drivers": ["bam-dmux", "qcom-q6v5-mss", "rpmsg_ctrl"],
      "equipment-identifier": "860018046114881",
      "hardware-revision": "10000",
      "manufacturer": "1",
      "model": "0",
      "own-numbers": [],
      "physdev": "/sys/devices/platform/soc@0/4080000.remoteproc/4080000.remoteproc:bam-dmux",
      "plugin": "qcom-soc",
      "ports": [
        "rpmsg_ctrl2 (ignored)",
        "wwan0 (net)",
        "wwan0at0 (at)",
        "wwan0at1 (at)",
        "wwan0qmi0 (qmi)"
      ],
      "power-state": "on",
      "primary-port": "wwan0qmi0",
      "primary-sim-slot": "1",
      "revision": "UZ801_V3.0_21_V01R01B10  1  [Sep 07 2015 23:00:00]",
      "signal-quality": {
        "recent": "yes",
        "value": "80"
      },
      "sim": "/org/freedesktop/ModemManager1/SIM/0",
      "sim-slots": ["/org/freedesktop/ModemManager1/SIM/0", "/"],
      "state": "connected",
      "state-failed-reason": "--",
      "supported-bands": [
        "utran-1",
        "utran-8",
        "eutran-1",
        "eutran-3",
        "eutran-5",
        "eutran-7",
        "eutran-8",
        "eutran-20",
        "eutran-38",
        "eutran-40",
        "eutran-41"
      ],
      "supported-capabilities": ["gsm-umts, lte"],
      "supported-ip-families": ["ipv4", "ipv6", "ipv4v6"],
      "supported-modes": [
        "allowed: 3g; preferred: none",
        "allowed: 4g; preferred: none",
        "allowed: 3g, 4g; preferred: 4g",
        "allowed: 3g, 4g; preferred: 3g"
      ],
      "unlock-required": "sim-pin2",
      "unlock-retries": [
        "sim-pin (3)",
        "sim-puk (10)",
        "sim-pin2 (3)",
        "sim-puk2 (10)"
      ]
    }
  }
}
```
