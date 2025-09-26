/*
  Publish modem information
*/
import { Message } from "../../common/tedge";

export interface Config {
  interval_sec?: number;
}

export interface Mobile {
  currentOperator?: String;
  iccid?: String;
  cellId?: String;
  imei?: String;
  imsi?: String;
  mcc?: String;
  mnc?: String;
  lac?: String;
  connType?: String;
  signalQuality?: Number;
}

export interface State {
  mobile: Mobile;
}

const state: State = {
  mobile: {},
};

function hasChanged(obj1, obj2): boolean {
  return JSON.stringify(obj1) !== JSON.stringify(obj2);
}

export function onMessage(message: Message, config: Config): Message[] {
  const payload = JSON.parse(message.payload);
  const output: Message[] = [];

  const mobile: Mobile = {};

  // sim details
  if (payload.hasOwnProperty("sim")) {
    mobile.iccid = payload?.sim?.properties?.iccid;
    mobile.imsi = payload?.sim?.properties?.imsi;
  }

  // modem details
  if (
    payload.hasOwnProperty("modem") &&
    payload["modem"].hasOwnProperty("3gpp")
  ) {
    mobile.currentOperator = payload["modem"]["3gpp"]["operator-name"];
    mobile.imei = payload["modem"]["3gpp"]["imei"];
  }

  mobile.connType = (payload?.modem?.generic["access-technologies"] || []).join(
    ",",
  );

  // signalQuality
  const signalQualityRecent = payload?.modem?.generic["signal-quality"].recent;
  const signalQualityPercentageRaw =
    payload?.modem?.generic["signal-quality"].value;
  const signalQualityPercentage = parseInt(signalQualityPercentageRaw, 10);
  if (isFinite(signalQualityPercentage)) {
    mobile.signalQuality = signalQualityPercentage;
  }

  // location details
  if (
    payload.hasOwnProperty("modem") &&
    payload["modem"].hasOwnProperty("location")
  ) {
    const location = payload["modem"]["location"];
    mobile.cellId = Number(`0x${location["3gpp"]["cid"]}`).toFixed(0);
    mobile.mcc = location["3gpp"]["mcc"];
    mobile.mnc = location["3gpp"]["mnc"];

    const locationAreaCode = Number(`0x${location["3gpp"]["lac"]}`);
    const trackingAreaCode = Number(`0x${location["3gpp"]["tac"]}`);
    if (locationAreaCode === 0) {
      mobile.lac = trackingAreaCode.toFixed(0);
    } else {
      mobile.lac = locationAreaCode.toFixed(0);
    }
  }

  if (hasChanged(mobile, state.mobile)) {
    output.push({
      topic: "te/device/main///twin/c8y_Mobile",
      retain: true,
      payload: JSON.stringify({
        ...mobile,
        lastChanged: new Date(message.timestamp.seconds * 1000).toISOString(),
      }),
      timestamp: message.timestamp,
    });
  }

  // cell tower change detection
  if (!!state.mobile.cellId && state.mobile.cellId !== mobile.cellId) {
    output.push({
      topic: "te/device/main///e/cellTowerDetails",
      payload: JSON.stringify({
        text: "Cell tower changed",
        previousCellTowerDetails: {
          mcc: state.mobile.mcc,
          mnc: state.mobile.mnc,
          lac: state.mobile.lac,
        },
        cellTowerDetails: {
          mcc: mobile.mcc,
          mnc: mobile.mnc,
          lac: mobile.lac,
        },
      }),
      timestamp: message.timestamp,
    });
  }

  state.mobile = mobile;

  return output;
}
