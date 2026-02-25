import { expect, test } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";

jest.useFakeTimers();

describe("Map ThingsBoard RPC to thin-edge command", () => {
  let context: tedge.Context;

  beforeEach(() => {
    context = tedge.createContext();

    // mapper KV store should know the main device's name
    context.mapper.set("tb-entity-to-name:device/main//", "MAIN");
    context.mapper.set("tb-name-to-entity:MAIN", "device/main//");
    context.mapper.set("tb-entity-to-name:device/child1//", "CHILD1");
    context.mapper.set("tb-name-to-entity:CHILD1", "device/child1//");
    context.mapper.set(
      "tb-entity-to-name:device/child1/service/app1",
      "CHILD1 APP1",
    );
    context.mapper.set(
      "tb-name-to-entity:CHILD1 APP1",
      "device/child1/service/app1",
    );
  });

  test("params is string", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tb/me/server/rpc/request/15",
      payload: JSON.stringify({
        method: "myMethod",
        params: "do",
      }),
    };

    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("te/device/main///cmd/myMethod/tb-mapper-15");

    const payload = tedge.decodeJsonPayload(output[0].payload);
    expect(payload).toStrictEqual({
      status: "init",
      value: "do",
    });
  });

  test("params is object", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tb/me/server/rpc/request/15",
      payload: JSON.stringify({
        method: "myMethod",
        params: {
          key: "control1",
          value: "on",
        },
      }),
    };

    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe("te/device/main///cmd/myMethod/tb-mapper-15");

    const payload = tedge.decodeJsonPayload(output[0].payload);
    expect(payload).toStrictEqual({
      status: "init",
      key: "control1",
      value: "on",
    });
  });

  test("child device", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tb/gateway/rpc",
      payload: JSON.stringify({
        device: "CHILD1",
        data: { id: 0, method: "myRemoteMethod1", params: "myText" },
      }),
    };

    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe(
      "te/device/child1///cmd/myRemoteMethod1/tb-mapper-0",
    );

    const payload = tedge.decodeJsonPayload(output[0].payload);
    expect(payload).toStrictEqual({
      value: "myText",
      status: "init",
    });
  });

  test("service", () => {
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tb/gateway/rpc",
      payload: JSON.stringify({
        device: "CHILD1 APP1",
        data: { id: 0, method: "myRemoteMethod1", params: "myText" },
      }),
    };

    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(1);

    expect(output[0].topic).toBe(
      "te/device/child1/service/app1/cmd/myRemoteMethod1/tb-mapper-0",
    );

    const payload = tedge.decodeJsonPayload(output[0].payload);
    expect(payload).toStrictEqual({
      value: "myText",
      status: "init",
    });
  });

  test("should ignore response rpc for child device", () => {
    // "id" is at the top level for response, whilst it is inside "data" nest for request.
    const message: tedge.Message = {
      time: tedge.mockGetTime(),
      topic: "tb/gateway/rpc",
      payload: JSON.stringify({
        device: "CHILD1",
        id: 0,
        data: { method: "myRemoteMethod1", params: "myText" },
      }),
    };

    const output = flow.onMessage(message, context);
    expect(output).toHaveLength(0);
  });
});
