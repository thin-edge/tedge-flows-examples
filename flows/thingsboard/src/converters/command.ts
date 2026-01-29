import { getEntityIdFromDeviceName } from "../utils";

export function handleThingsBoardTopic(
  topic: string,
  payload: string,
  mainDeviceName: string,
) {
  const parts = topic.split("/");
  const parsedValue = JSON.parse(payload);

  // Handle tb/me/rpc/request/{id}
  if (parts[1] === "me" && parts[2] === "rpc" && parts[3] === "request") {
    const rpcId = parts[4];
    return handleMainDeviceRpc(parsedValue, rpcId);
  }

  // Handle tb/gateway/rpc
  if (parts[1] === "gateway" && parts[2] === "rpc") {
    return handleGatewayRpc(parsedValue, mainDeviceName);
  }

  return [];
}

function handleMainDeviceRpc(payload: any, rpcId: string) {
  // payload: {"method":"myRemoteMethod1","params":"myText"}
  const { method, params } = payload;

  const teTopic = `te/device/main///cmd/${method}/tb-mapper-${rpcId}`;
  const teObject = typeof params === "object" ? params : { value: params };

  const tePayload = {
    status: "init",
    ...teObject,
  };

  // Todo: this message should be retained
  return [
    {
      topic: teTopic,
      payload: JSON.stringify(tePayload),
    },
  ];
}

function handleGatewayRpc(payload: any, mainDeviceName: string) {
  // payload: {"device":"MyChildDevice","data":{"id":0,"method":"myRemoteMethod1","params":"myText"}}
  const { device, data, id } = payload;

  // If 'id' exists at the top level, this is a response payload, not a request
  if (id !== undefined) {
    return [];
  }

  const { id: rpcId, method, params } = data;

  const entityId = getEntityIdFromDeviceName(device, mainDeviceName);

  const teTopic = `te/${entityId}/cmd/${method}/tb-mapper-${rpcId}`;
  const teObject = typeof params === "object" ? params : { value: params };

  const tePayload = {
    status: "init",
    ...teObject,
  };

  return [
    {
      topic: teTopic,
      payload: JSON.stringify(tePayload),
    },
  ];
}

export function convertCommandResponseToRpc(
  payload: string,
  deviceName: string,
  cmdId: string,
  mainDeviceName: string,
) {
  // Check if this is a ThingsBoard-originated command (starts with tb-mapper-)
  if (!cmdId || !cmdId.startsWith("tb-mapper-")) {
    return [];
  }

  // Extract the original RPC ID
  const rpcId = cmdId.replace("tb-mapper-", "");

  const responseData = JSON.parse(payload);

  // Skip conversion if status is "init"
  if (responseData.status === "init") {
    return [];
  }

  // Determine if this is for the main device or a child device
  const isMainDevice = deviceName === mainDeviceName;
  const responseTopic = isMainDevice
    ? `tb/me/rpc/response/${rpcId}`
    : `tb/gateway/rpc`;

  // For gateway devices, wrap the response
  const responsePayload = isMainDevice
    ? responseData
    : {
        device: deviceName,
        id: parseInt(rpcId),
        data: responseData,
      };

  return [
    {
      topic: responseTopic,
      payload: JSON.stringify(responsePayload),
    },
  ];
}
