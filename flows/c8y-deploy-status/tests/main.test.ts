import { expect, test, describe, jest } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";
import * as deployOperation from "../../c8y-deploy-operation/src/main";

const t = new Date("2026-09-24T18:45:32.568Z");
const topic = "te/device/main///cmd/device_profile/c8y-mapper-218";

function msg(payload: object | string, msgTopic = topic): tedge.Message {
  return {
    time: t,
    topic: msgTopic,
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
  };
}

function command(status: string, deployment: object = {}): object {
  return {
    status,
    name: "demo/13.6",
    deployment: { key: "demo", version: "13.6", priority: 100, ...deployment },
    operations: [],
  };
}

describe("deployment status", () => {
  test("successful command publishes the deployment and its state", () => {
    const out = flow.onMessage(
      msg(command("successful")),
      tedge.createContext({}),
    );
    expect(out).toHaveLength(2);

    expect(out[0].topic).toBe("te/device/main///twin/c8y_Deployment_demo");
    expect(out[0].mqtt).toEqual({ retain: true, qos: 1 });
    expect(tedge.decodeJsonPayload(out[0].payload)).toEqual({
      deploymentKey: "demo",
      priority: 100,
      version: "13.6",
      assignedAt: t.toISOString(),
    });

    expect(out[1].topic).toBe("te/device/main///twin/c8y_DeploymentState_demo");
    expect(tedge.decodeJsonPayload(out[1].payload)).toEqual({
      deploymentKey: "demo",
      version: "13.6",
      state: "SUCCESS",
      updatedAt: t.toISOString(),
    });
  });

  test.each([
    ["init", "PENDING"],
    ["scheduled", "CONFIRMED"],
    ["executing", "IN_PROGRESS"],
    ["failed", "FAILURE"],
    ["custom_step", "IN_PROGRESS"],
  ])("status %s only publishes the state %s", (status, state) => {
    const out = flow.onMessage(msg(command(status)), tedge.createContext({}));
    expect(out).toHaveLength(1);
    expect(out[0].topic).toBe("te/device/main///twin/c8y_DeploymentState_demo");
    expect(tedge.decodeJsonPayload(out[0].payload).state).toBe(state);
  });

  test("child device", () => {
    const out = flow.onMessage(
      msg(
        command("executing"),
        "te/device/child01///cmd/device_profile/c8y-mapper-1",
      ),
      tedge.createContext({}),
    );
    expect(out[0].topic).toBe(
      "te/device/child01///twin/c8y_DeploymentState_demo",
    );
  });

  test("sanitizes the deployment key", () => {
    const out = flow.onMessage(
      msg(command("executing", { key: "eu/west+1.a" })),
      tedge.createContext({}),
    );
    expect(out[0].topic).toBe(
      "te/device/main///twin/c8y_DeploymentState_eu_west_1_a",
    );
    expect(tedge.decodeJsonPayload(out[0].payload).deploymentKey).toBe(
      "eu/west+1.a",
    );
  });
});

describe("ignored messages", () => {
  test("cleared command (empty payload)", () => {
    expect(flow.onMessage(msg(""), tedge.createContext({}))).toHaveLength(0);
  });

  test("command without deployment information", () => {
    const out = flow.onMessage(
      msg({ status: "init", name: "profile", operations: [] }),
      tedge.createContext({}),
    );
    expect(out).toHaveLength(0);
  });

  test("deployment without a version", () => {
    const out = flow.onMessage(
      msg(command("init", { version: undefined })),
      tedge.createContext({}),
    );
    expect(out).toHaveLength(0);
  });

  test("sub workflow", () => {
    const out = flow.onMessage(
      msg(
        command("init"),
        "te/device/main///cmd/device_profile/sub:device_profile:c8y-mapper-1",
      ),
      tedge.createContext({}),
    );
    expect(out).toHaveLength(0);
  });
});

describe("message formats", () => {
  test("binary payload", () => {
    const out = flow.onMessage(
      {
        time: t,
        topic,
        payload: tedge.encodeJsonPayload(command("executing")),
      },
      tedge.createContext({}),
    );
    expect(out).toHaveLength(1);
    expect(tedge.decodeJsonPayload(out[0].payload).state).toBe("IN_PROGRESS");
  });

  test("whitespace only payload is treated as cleared", () => {
    expect(flow.onMessage(msg("  \n"), tedge.createContext({}))).toHaveLength(
      0,
    );
  });

  test("service entity", () => {
    const out = flow.onMessage(
      msg(
        command("executing"),
        "te/device/main/service/app1/cmd/device_profile/c8y-mapper-1",
      ),
      tedge.createContext({}),
    );
    expect(out[0].topic).toBe(
      "te/device/main/service/app1/twin/c8y_DeploymentState_demo",
    );
  });

  test("custom topic root", () => {
    const out = flow.onMessage(
      msg(
        command("executing"),
        "custom/device/main///cmd/device_profile/c8y-mapper-1",
      ),
      tedge.createContext({}),
    );
    expect(out[0].topic).toBe(
      "custom/device/main///twin/c8y_DeploymentState_demo",
    );
  });

  test("command without a status publishes nothing", () => {
    const { status, ...withoutStatus } = command("init") as any;
    const out = flow.onMessage(msg(withoutStatus), tedge.createContext({}));
    expect(out).toHaveLength(0);
  });

  test("deployment without a priority", () => {
    const out = flow.onMessage(
      msg(command("successful", { priority: undefined })),
      tedge.createContext({}),
    );
    const deployment = tedge.decodeJsonPayload(out[0].payload);
    expect(deployment).not.toHaveProperty("priority");
    expect(deployment.deploymentKey).toBe("demo");
  });

  test("keeps all output messages retained with qos 1", () => {
    const out = flow.onMessage(
      msg(command("successful")),
      tedge.createContext({}),
    );
    for (const m of out) {
      expect(m.mqtt).toEqual({ retain: true, qos: 1 });
      expect(m.time).toBe(t);
    }
  });
});

describe("command lifecycle", () => {
  test("follows the device_profile command through its states", () => {
    const ctx = tedge.createContext({});
    const states = ["init", "scheduled", "executing", "successful"].map(
      (status) => {
        const out = flow.onMessage(msg(command(status)), ctx);
        return out
          .filter((m) => m.topic.includes("c8y_DeploymentState_"))
          .map((m) => tedge.decodeJsonPayload(m.payload).state);
      },
    );
    expect(states).toEqual([
      ["PENDING"],
      ["CONFIRMED"],
      ["IN_PROGRESS"],
      ["SUCCESS"],
    ]);
  });

  test("failed command does not publish the deployment membership", () => {
    const out = flow.onMessage(msg(command("failed")), tedge.createContext({}));
    expect(out.map((m) => m.topic)).toEqual([
      "te/device/main///twin/c8y_DeploymentState_demo",
    ]);
  });
});

describe("c8y-deploy-operation integration", () => {
  test("processes the command created by the c8y-deploy-operation flow", () => {
    const operation = {
      agentId: "87143",
      deviceId: "87143",
      id: "218",
      status: "PENDING",
      c8y_ComposedTargetState: {
        deploymentKey: "demo",
        version: "13.6",
        priority: 100,
        software: [
          {
            name: "htop",
            version: "latest",
            softwareType: "apt",
            action: "install",
          },
        ],
      },
      externalSource: { externalId: "deploy1020304", type: "c8y_Serial" },
    };
    const [cmd] = deployOperation.onMessage(
      msg(operation, "c8y/devicecontrol/notifications"),
      tedge.createContext({}),
    );

    // The agent later updates the command status
    const successful = {
      ...tedge.decodeJsonPayload(cmd.payload),
      status: "successful",
    };
    const out = flow.onMessage(
      msg(successful, cmd.topic),
      tedge.createContext({}),
    );
    expect(out.map((m) => m.topic)).toEqual([
      "te/device/main///twin/c8y_Deployment_demo",
      "te/device/main///twin/c8y_DeploymentState_demo",
    ]);
    expect(tedge.decodeJsonPayload(out[0].payload)).toEqual({
      deploymentKey: "demo",
      priority: 100,
      version: "13.6",
      assignedAt: t.toISOString(),
    });
  });
});

describe("helpers", () => {
  test.each([
    ["demo", "demo"],
    ["my-deploy_1", "my-deploy_1"],
    ["eu/west", "eu_west"],
    ["a+b#c", "a_b_c"],
    ["v1.2 beta", "v1_2_beta"],
  ])("sanitize(%s)", (input, expected) => {
    expect(flow.sanitize(input)).toBe(expected);
  });

  test.each([
    [undefined, undefined],
    ["", undefined],
    ["init", "PENDING"],
    ["scheduled", "CONFIRMED"],
    ["executing", "IN_PROGRESS"],
    ["successful", "SUCCESS"],
    ["failed", "FAILURE"],
    ["download_firmware", "IN_PROGRESS"],
  ])("toDeploymentState(%s)", (status, expected) => {
    expect(flow.toDeploymentState(status)).toBe(expected);
  });
});

describe("debug", () => {
  test.each([
    [true, 1],
    ["true", 1],
    [false, 0],
    ["false", 0],
  ])("debug=%s", (debug, calls) => {
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      flow.onMessage(msg(command("init")), tedge.createContext({ debug }));
      expect(spy).toHaveBeenCalledTimes(calls);
    } finally {
      spy.mockRestore();
    }
  });
});
