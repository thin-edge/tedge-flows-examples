import { FlowContext } from "./main";

const NAME_TO_ENTITY_PREFIX = "tb-name-to-entity:";

export function handleThingsBoardTopic(
  context: FlowContext,
  topic: string,
  payload: string,
) {
  const parts = topic.split("/");
  const parsedValue = JSON.parse(payload);
  const { time, ...parsedValueWithoutTime } = parsedValue;

  // Handle tb/me/server/rpc/request/{id}
  if (
    parts[1] === "me" &&
    parts[2] === "server" &&
    parts[3] === "rpc" &&
    parts[4] === "request"
  ) {
    const rpcId = parts[5];
    return handleMainDeviceRpc(parsedValueWithoutTime, rpcId);
  }

  // Handle tb/gateway/rpc
  if (parts[1] === "gateway" && parts[2] === "rpc") {
    return handleGatewayRpc(context, parsedValueWithoutTime);
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

  // TODO: this message should be retained
  return [
    {
      topic: teTopic,
      payload: JSON.stringify(tePayload),
    },
  ];
}

function handleGatewayRpc(context: FlowContext, payload: any) {
  // payload: {"device":"MyChildDevice","data":{"id":0,"method":"myRemoteMethod1","params":"myText"}}
  const { device, data, id } = payload;

  // If 'id' exists at the top level, this is a response payload, not a request
  if (id !== undefined) {
    return [];
  }

  const { id: rpcId, method, params } = data;

  const entityId = context.mapper.get(`${NAME_TO_ENTITY_PREFIX}${device}`);
  if (!entityId) {
    console.error(`Received RPC for unknown device ${device}`);
    return [];
  }

  const teTopic = `te/${entityId}/cmd/${method}/tb-mapper-${rpcId}`;
  const teObject = typeof params === "object" ? params : { value: params };

  const tePayload = {
    status: "init",
    ...teObject,
  };

  // TODO: this message should be retained
  return [
    {
      topic: teTopic,
      payload: JSON.stringify(tePayload),
    },
  ];
}
