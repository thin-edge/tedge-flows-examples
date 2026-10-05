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
      installedVersion: "13.6",
      installedAt: t.toISOString(),
    });

    expect(out[1].topic).toBe("te/device/main///twin/c8y_DeploymentState_demo");
    expect(tedge.decodeJsonPayload(out[1].payload)).toEqual({
      deploymentKey: "demo",
      version: "13.6",
      assignedAt: t.toISOString(),
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

describe("digital twin", () => {
  const stateTopic = "te/device/main///twin/c8y_DeploymentState_demo";
  const membershipTopic = "te/device/main///twin/c8y_Deployment_demo";

  test("keeps the assignment time of the ASSIGNED state", () => {
    const ctx = tedge.createContext({});
    const assigned = {
      deploymentKey: "demo",
      version: "13.6",
      assignedAt: "2026-09-24T10:00:00.000Z",
      state: "ASSIGNED",
      updatedAt: "2026-09-24T10:00:00.000Z",
    };
    expect(flow.onMessage(msg(assigned, stateTopic), ctx)).toHaveLength(0);

    const out = flow.onMessage(
      msg(command("executing", { assignedAt: "2026-09-24T10:00:01.000Z" })),
      ctx,
    );
    expect(tedge.decodeJsonPayload(out[0].payload)).toEqual({
      deploymentKey: "demo",
      version: "13.6",
      assignedAt: "2026-09-24T10:00:00.000Z",
      state: "IN_PROGRESS",
      updatedAt: t.toISOString(),
    });
  });

  test("ignores the assignment time of another version", () => {
    const ctx = tedge.createContext({});
    flow.onMessage(
      msg(
        {
          deploymentKey: "demo",
          version: "13.5",
          assignedAt: "2026-09-01T10:00:00.000Z",
          state: "SUCCESS",
        },
        stateTopic,
      ),
      ctx,
    );
    const out = flow.onMessage(
      msg(command("init", { assignedAt: "2026-09-24T10:00:01.000Z" })),
      ctx,
    );
    expect(tedge.decodeJsonPayload(out[0].payload).assignedAt).toBe(
      "2026-09-24T10:00:01.000Z",
    );
  });

  describe("ASSIGNED published after the command progressed", () => {
    const assigned = (version: string) => ({
      deploymentKey: "demo",
      version,
      assignedAt: "2026-09-24T10:00:05.000Z",
      state: "ASSIGNED",
      updatedAt: "2026-09-24T10:00:05.000Z",
    });

    test("restores the state of a finished command", () => {
      const ctx = tedge.createContext({});
      const done = flow.onMessage(
        msg(command("successful", { assignedAt: "2026-09-24T10:00:01.000Z" })),
        ctx,
      );
      // c8y-deploy-poll handles the response of its request after the command finished
      const out = flow.onMessage(msg(assigned("13.6"), stateTopic), ctx);
      expect(out).toHaveLength(1);
      expect(out[0].topic).toBe(stateTopic);
      expect(out[0].mqtt).toEqual({ retain: true, qos: 1 });
      expect(out[0].payload).toBe(done[1].payload);

      // The restored state is received back, nothing else is published
      expect(flow.onMessage(msg(out[0].payload, stateTopic), ctx)).toEqual([]);
    });

    test("restores the state of a running command, and keeps its assignment time", () => {
      const ctx = tedge.createContext({});
      flow.onMessage(
        msg(command("executing", { assignedAt: "2026-09-24T10:00:01.000Z" })),
        ctx,
      );
      const out = flow.onMessage(msg(assigned("13.6"), stateTopic), ctx);
      expect(tedge.decodeJsonPayload(out[0].payload).state).toBe("IN_PROGRESS");

      // The next status is processed before the restored state is received back
      const next = flow.onMessage(msg(command("successful")), ctx);
      expect(tedge.decodeJsonPayload(next[1].payload)).toMatchObject({
        assignedAt: "2026-09-24T10:00:01.000Z",
        state: "SUCCESS",
      });
    });

    test("an ASSIGNED received before the command is kept", () => {
      const ctx = tedge.createContext({});
      expect(flow.onMessage(msg(assigned("13.6"), stateTopic), ctx)).toEqual(
        [],
      );
    });

    test("a version assigned again after another version is kept", () => {
      const ctx = tedge.createContext({});
      // v1 -> v2 -> v1
      flow.onMessage(msg(command("successful", { version: "13.5" })), ctx);
      expect(flow.onMessage(msg(assigned("13.6"), stateTopic), ctx)).toEqual(
        [],
      );
      expect(flow.onMessage(msg(assigned("13.5"), stateTopic), ctx)).toEqual(
        [],
      );
    });
  });

  test("uses the command time if the assignment time is not known", () => {
    const out = flow.onMessage(msg(command("init")), tedge.createContext({}));
    expect(tedge.decodeJsonPayload(out[0].payload).assignedAt).toBe(
      t.toISOString(),
    );
  });

  test("keeps the assignment time through the command states", () => {
    const ctx = tedge.createContext({});
    const first = flow.onMessage(
      msg(command("init", { assignedAt: "2026-09-24T10:00:00.000Z" })),
      ctx,
    );
    // The published state is received back
    flow.onMessage(
      msg(tedge.decodeJsonPayload(first[0].payload), stateTopic),
      ctx,
    );
    const out = flow.onMessage(msg(command("successful")), ctx);
    expect(tedge.decodeJsonPayload(out[1].payload).assignedAt).toBe(
      "2026-09-24T10:00:00.000Z",
    );
  });

  test("a failure reports the reason and keeps the installed version", () => {
    const ctx = tedge.createContext({});
    flow.onMessage(
      msg(
        {
          deploymentKey: "demo",
          priority: 100,
          installedVersion: "13.5",
          installedAt: "2026-09-01T10:00:00.000Z",
        },
        membershipTopic,
      ),
      ctx,
    );
    const out = flow.onMessage(
      msg({ ...command("failed"), reason: "checksum mismatch" }),
      ctx,
    );
    expect(out.map((m) => m.topic)).toEqual([stateTopic]);
    expect(tedge.decodeJsonPayload(out[0].payload)).toEqual({
      deploymentKey: "demo",
      version: "13.6",
      assignedAt: t.toISOString(),
      state: "FAILURE",
      updatedAt: t.toISOString(),
      error: "checksum mismatch",
    });
  });

  test("a failure without a reason still reports an error", () => {
    const out = flow.onMessage(msg(command("failed")), tedge.createContext({}));
    expect(tedge.decodeJsonPayload(out[0].payload).error).toBe(
      "Deployment failed",
    );
  });

  test("a retry drops the error", () => {
    const ctx = tedge.createContext({});
    flow.onMessage(msg({ ...command("failed"), reason: "boom" }), ctx);
    const out = flow.onMessage(msg(command("executing")), ctx);
    expect(tedge.decodeJsonPayload(out[0].payload)).not.toHaveProperty("error");
  });

  test("repeating the installed version keeps the installation time", () => {
    const ctx = tedge.createContext({});
    flow.onMessage(
      msg(
        {
          deploymentKey: "demo",
          priority: 100,
          installedVersion: "13.6",
          installedAt: "2026-09-01T10:00:00.000Z",
        },
        membershipTopic,
      ),
      ctx,
    );
    const out = flow.onMessage(msg(command("successful")), ctx);
    expect(tedge.decodeJsonPayload(out[0].payload).installedAt).toBe(
      "2026-09-01T10:00:00.000Z",
    );
  });

  test("keeps the priority of the membership if the command has none", () => {
    const ctx = tedge.createContext({});
    flow.onMessage(
      msg({ deploymentKey: "demo", priority: 7 }, membershipTopic),
      ctx,
    );
    const out = flow.onMessage(
      msg(command("successful", { priority: undefined })),
      ctx,
    );
    expect(tedge.decodeJsonPayload(out[0].payload)).toEqual({
      deploymentKey: "demo",
      priority: 7,
      installedVersion: "13.6",
      installedAt: t.toISOString(),
    });
  });

  test("keeps the priority published by c8y-deploy-poll", () => {
    const ctx = tedge.createContext({});
    flow.onMessage(
      msg({ deploymentKey: "demo", priority: 7 }, membershipTopic),
      ctx,
    );
    const out = flow.onMessage(msg(command("successful")), ctx);
    expect(tedge.decodeJsonPayload(out[0].payload).priority).toBe(7);
  });

  describe("membership published from an older copy", () => {
    const older = {
      deploymentKey: "demo",
      priority: 50,
      installedVersion: "13.5",
      installedAt: "2026-09-01T10:00:00.000Z",
    };

    test("restores the installed version and keeps the new priority", () => {
      const ctx = tedge.createContext({});
      flow.onMessage(msg(command("successful")), ctx);
      // c8y-deploy-poll publishes a new priority from a copy taken before the update
      const out = flow.onMessage(msg(older, membershipTopic), ctx);
      expect(out).toHaveLength(1);
      expect(out[0].topic).toBe(membershipTopic);
      expect(out[0].mqtt).toEqual({ retain: true, qos: 1 });
      expect(tedge.decodeJsonPayload(out[0].payload)).toEqual({
        deploymentKey: "demo",
        priority: 50,
        installedVersion: "13.6",
        installedAt: t.toISOString(),
      });

      // The restored fragment is received back, nothing else is published
      expect(flow.onMessage(msg(out[0].payload, membershipTopic), ctx)).toEqual(
        [],
      );
    });

    test("restores the installed version if it is missing", () => {
      const ctx = tedge.createContext({});
      flow.onMessage(msg(command("successful")), ctx);
      const out = flow.onMessage(
        msg({ deploymentKey: "demo", priority: 50 }, membershipTopic),
        ctx,
      );
      expect(tedge.decodeJsonPayload(out[0].payload)).toMatchObject({
        priority: 50,
        installedVersion: "13.6",
      });
    });

    test("restores the installed version known from the retained fragment", () => {
      const ctx = tedge.createContext({});
      // after a restart
      const retained = { ...older, installedVersion: "13.6" };
      expect(flow.onMessage(msg(retained, membershipTopic), ctx)).toEqual([]);
      const out = flow.onMessage(
        msg({ deploymentKey: "demo", priority: 60 }, membershipTopic),
        ctx,
      );
      expect(tedge.decodeJsonPayload(out[0].payload)).toEqual({
        ...retained,
        priority: 60,
      });
    });

    test("a priority change keeps the installed version unchanged", () => {
      const ctx = tedge.createContext({});
      const done = flow.onMessage(msg(command("successful")), ctx);
      const current = tedge.decodeJsonPayload(done[0].payload);
      expect(
        flow.onMessage(msg({ ...current, priority: 60 }, membershipTopic), ctx),
      ).toEqual([]);
    });

    test("leaving the deployment is not restored", () => {
      const ctx = tedge.createContext({});
      flow.onMessage(msg(command("successful")), ctx);
      expect(flow.onMessage(msg("", membershipTopic), ctx)).toEqual([]);
      // joining again
      expect(
        flow.onMessage(
          msg({ deploymentKey: "demo", priority: 50 }, membershipTopic),
          ctx,
        ),
      ).toEqual([]);
    });
  });

  test("ignores other twin fragments and cleared fragments", () => {
    const ctx = tedge.createContext({});
    expect(
      flow.onMessage(msg({ a: 1 }, "te/device/main///twin/c8y_Other"), ctx),
    ).toHaveLength(0);
    flow.onMessage(
      msg(
        { version: "13.6", assignedAt: "2026-09-01T10:00:00.000Z" },
        stateTopic,
      ),
      ctx,
    );
    flow.onMessage(msg("", stateTopic), ctx);
    const out = flow.onMessage(msg(command("init")), ctx);
    expect(tedge.decodeJsonPayload(out[0].payload).assignedAt).toBe(
      t.toISOString(),
    );
  });
});

describe("c8y-deploy-operation integration", () => {
  test("processes the command created by the c8y-deploy-operation flow", () => {
    const operation = {
      agentId: "87143",
      deviceId: "87143",
      id: "218",
      status: "PENDING",
      creationTime: "2026-09-24T18:40:00.000Z",
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
      installedVersion: "13.6",
      installedAt: t.toISOString(),
    });
    // The operation creation time is used as the assignment time
    expect(tedge.decodeJsonPayload(out[1].payload).assignedAt).toBe(
      operation.creationTime,
    );
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
