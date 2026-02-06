export function handleThinEdgeCommand(
  teTopic: string,
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

  // Convert only a final state message
  if (
    responseData.status !== "successful" &&
    responseData.status !== "failed"
  ) {
    return [];
  }

  // Determine if this is for the main device or a child device
  const isMainDevice = deviceName === mainDeviceName;
  const tbResponseTopic = isMainDevice
    ? `tb/me/server/rpc/response/${rpcId}`
    : `tb/gateway/rpc`;

  // For gateway devices, wrap the response
  const responsePayload = isMainDevice
    ? responseData
    : {
        device: deviceName,
        id: parseInt(rpcId),
        data: responseData,
      };

  // TODO: The second message, clearing the retained cmd message, must be retained.
  return [
    {
      topic: tbResponseTopic,
      payload: JSON.stringify(responsePayload),
    },
    {
      topic: teTopic,
      payload: "",
    },
  ];
}
