import { Message } from "../../common/tedge";
import { RegistrationPayload } from "./main";

export function convertDeviceRegistration(
  payload: RegistrationPayload,
  deviceName: string,
  defaultDeviceProfile: string,
): Message[] {
  if (payload["@type"] === "child-device") {
    return handleChildDeviceRegistration(
      payload,
      deviceName,
      defaultDeviceProfile,
    );
  }

  if (payload["@type"] === "service") {
    return handleServiceRegistration(payload, deviceName, defaultDeviceProfile);
  }

  return [];
}

function handleChildDeviceRegistration(
  payload: RegistrationPayload,
  deviceName: string,
  defaultDeviceProfile: string,
): Message[] {
  const messages = [];
  const messageTime = new Date();

  // Connect/register the device
  const connectPayload = {
    device: deviceName,
    type: payload.type || defaultDeviceProfile,
  };

  messages.push({
    time: messageTime,
    topic: "tb/gateway/connect",
    payload: JSON.stringify(connectPayload),
  });

  // Extend here if it needs to send more attributes keys
  // Custom keys in metadata will be sent as "twin" and the flow will convert them
  const attributes = {
    parent_device: payload["@parent"] || "unknown_parent",
  };

  const attributePayload = {
    [deviceName]: attributes,
  };

  messages.push({
    time: messageTime,
    topic: "tb/gateway/attributes",
    payload: JSON.stringify(attributePayload),
  });

  return messages;
}

// Register service as a separate device
function handleServiceRegistration(
  payload: RegistrationPayload,
  deviceName: string,
  defaultDeviceProfile: string,
): Message[] {
  const messages = [];
  const messageTime = new Date();

  const connectPayload = {
    device: deviceName,
    type: payload.type || defaultDeviceProfile,
  };

  // Connect service as device
  messages.push({
    time: messageTime,
    topic: "tb/gateway/connect",
    payload: JSON.stringify(connectPayload),
  });

  // Extend here if it needs to send more attributes keys
  // Custom keys in metadata will be sent as "twin" and the flow will convert them
  const attributes = {
    parent_device: payload["@parent"] || "unknown_parent",
  };

  const attributePayload = {
    [deviceName]: attributes,
  };

  messages.push({
    time: messageTime,
    topic: "tb/gateway/attributes",
    payload: JSON.stringify(attributePayload),
  });

  return messages;
}
