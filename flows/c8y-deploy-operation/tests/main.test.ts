import { expect, test, describe } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as flow from "../src/main";

const t = new Date("2026-09-24T18:45:32.568Z");

function operation(overrides: object = {}): object {
  return {
    delivery: { log: [], time: "2026-09-24T18:45:32.568Z", status: "PENDING" },
    agentId: "87143",
    creationTime: "2026-09-24T18:45:32.561Z",
    deviceId: "87143",
    id: "218",
    status: "PENDING",
    c8y_ComposedTargetState: {
      deploymentKey: "demo",
      version: "13.6",
      priority: 100,
      firmware: {
        name: "tedge-rugix-image",
        version: "20260528.1440",
        url: "https://github.com/thin-edge/tedge-rugix-image/releases/download/20260528.1440/tedge-raspios-arm64-tryboot_20260528.1440.rugixb",
      },
      software: [
        {
          name: "tedge",
          version: "2.0.1",
          softwareType: "apt",
          action: "install",
        },
        {
          name: "htop",
          version: "latest",
          softwareType: "apt",
          action: "install",
        },
      ],
    },
    description: "Apply target state demo/13.6",
    externalSource: { externalId: "deploy1020304", type: "c8y_Serial" },
    ...overrides,
  };
}

function msg(payload: object): tedge.Message {
  return {
    time: t,
    topic: "c8y/devicecontrol/notifications",
    payload: JSON.stringify(payload),
  };
}

describe("c8y_ComposedTargetState to device_profile", () => {
  test("converts the operation of the main device", () => {
    const ctx = tedge.createContext({ device_id: "deploy1020304" });
    const out = flow.onMessage(msg(operation()), ctx);
    expect(out).toHaveLength(1);
    expect(out[0].topic).toBe(
      "te/device/main///cmd/device_profile/c8y-mapper-218",
    );
    expect(out[0].mqtt).toEqual({ retain: true, qos: 1 });
    expect(tedge.decodeJsonPayload(out[0].payload)).toEqual({
      status: "init",
      name: "demo/13.6",
      deployment: { key: "demo", version: "13.6", priority: 100 },
      operations: [
        {
          operation: "firmware_update",
          payload: {
            name: "tedge-rugix-image",
            version: "20260528.1440",
            remoteUrl:
              "https://github.com/thin-edge/tedge-rugix-image/releases/download/20260528.1440/tedge-raspios-arm64-tryboot_20260528.1440.rugixb",
          },
          "@skip": false,
        },
        {
          operation: "software_update",
          payload: {
            updateList: [
              {
                type: "apt",
                modules: [
                  { name: "tedge", version: "2.0.1", action: "install" },
                  { name: "htop", version: "latest", action: "install" },
                ],
              },
            ],
          },
          "@skip": false,
        },
      ],
    });
  });

  test("ignores other operations", () => {
    const ctx = tedge.createContext({});
    const out = flow.onMessage(
      msg({ id: "1", c8y_Restart: {}, agentId: "1", deviceId: "1" }),
      ctx,
    );
    expect(out).toHaveLength(0);
  });

  test("supports a custom topic root and command id prefix", () => {
    const ctx = tedge.createContext({
      topic_root: "tedge",
      cmd_id_prefix: "custom",
    });
    const out = flow.onMessage(msg(operation()), ctx);
    expect(out[0].topic).toBe(
      "tedge/device/main///cmd/device_profile/custom-218",
    );
  });

  test("groups software by type, maps delete to remove and orders operations like the c8y mapper", () => {
    const ctx = tedge.createContext({
      c8y_url: "t12345.example.cumulocity.com",
      proxy_url: "https://tedge:8001",
    });
    const out = flow.onMessage(
      msg(
        operation({
          c8y_ComposedTargetState: {
            deploymentKey: "demo",
            software: [
              {
                name: "ot-simulators",
                version: "1.0.2",
                softwareType: "container-group",
                url: "https://mytenant.example.cumulocity.com/inventory/binaries/19133",
                action: "install",
              },
              {
                name: "vim",
                version: "",
                softwareType: "apt",
                action: "delete",
              },
              {
                name: "nginx",
                version: "1.2.3::container",
                url: " ",
                action: "install",
              },
              { name: "legacy", version: "1.0", action: "install" },
            ],
            configuration: [
              {
                name: "tedge.toml",
                type: "/etc/tedge/tedge.toml",
                url: "https://mytenant.example.cumulocity.com/inventory/binaries/757538",
              },
            ],
          },
        }),
      ),
      ctx,
    );
    const payload = tedge.decodeJsonPayload(out[0].payload);
    expect(payload.name).toBe("demo");
    expect(payload.operations.map((op: any) => op.operation)).toEqual([
      "config_update",
      "software_update",
    ]);
    expect(payload.operations[0].payload).toEqual({
      name: "tedge.toml",
      type: "/etc/tedge/tedge.toml",
      remoteUrl: "https://tedge:8001/c8y/inventory/binaries/757538",
      serverUrl:
        "https://mytenant.example.cumulocity.com/inventory/binaries/757538",
    });
    expect(payload.operations[1].payload.updateList).toEqual([
      {
        type: "container-group",
        modules: [
          {
            name: "ot-simulators",
            version: "1.0.2",
            url: "https://tedge:8001/c8y/inventory/binaries/19133",
            action: "install",
          },
        ],
      },
      { type: "apt", modules: [{ name: "vim", action: "remove" }] },
      {
        type: "container",
        modules: [{ name: "nginx", version: "1.2.3", action: "install" }],
      },
      {
        type: "default",
        modules: [{ name: "legacy", version: "1.0", action: "install" }],
      },
    ]);
  });

  test("creates a failed command for an invalid software action", () => {
    const ctx = tedge.createContext({});
    const out = flow.onMessage(
      msg(
        operation({
          c8y_ComposedTargetState: {
            deploymentKey: "demo",
            version: "1",
            software: [{ name: "foo", version: "1", action: "upgrade" }],
          },
        }),
      ),
      ctx,
    );
    const payload = tedge.decodeJsonPayload(out[0].payload);
    expect(payload.status).toBe("failed");
    expect(payload.reason).toContain("upgrade");
    expect(payload.deployment).toEqual({ key: "demo", version: "1" });
  });

  test("keeps all deployment meta information", () => {
    const ctx = tedge.createContext({});
    const out = flow.onMessage(
      msg(
        operation({
          c8y_ComposedTargetState: {
            deploymentKey: "demo",
            version: "13.7",
            priority: 50,
            rolloutId: "r-42",
            labels: { env: "prod" },
            firmware: { name: "fw", version: "1", url: "https://x/fw" },
            software: [],
            configuration: [],
          },
        }),
      ),
      ctx,
    );
    expect(tedge.decodeJsonPayload(out[0].payload).deployment).toEqual({
      key: "demo",
      version: "13.7",
      priority: 50,
      rolloutId: "r-42",
      labels: { env: "prod" },
    });
  });
});

describe("target entity resolution", () => {
  test("child device using the default external id scheme", () => {
    const ctx = tedge.createContext({ device_id: "gateway01" });
    const out = flow.onMessage(
      msg(
        operation({
          deviceId: "999",
          externalSource: {
            externalId: "gateway01:device:child01",
            type: "c8y_Serial",
          },
        }),
      ),
      ctx,
    );
    expect(out[0].topic).toBe(
      "te/device/child01///cmd/device_profile/c8y-mapper-218",
    );
  });

  test("entity registered in the mapper context", () => {
    const ctx = tedge.createContext({});
    ctx.mapper.set("device/plc01//", { external_id: "custom-plc" });
    const out = flow.onMessage(
      msg(
        operation({
          deviceId: "999",
          externalSource: { externalId: "custom-plc", type: "c8y_Serial" },
        }),
      ),
      ctx,
    );
    expect(out[0].topic).toBe(
      "te/device/plc01///cmd/device_profile/c8y-mapper-218",
    );
  });

  test("unknown child device is ignored", () => {
    const ctx = tedge.createContext({ device_id: "gateway01" });
    const out = flow.onMessage(
      msg(
        operation({
          deviceId: "999",
          externalSource: { externalId: "unknown", type: "c8y_Serial" },
        }),
      ),
      ctx,
    );
    expect(out).toHaveLength(0);
  });

  test("ignores unrelated mapper context keys (regression)", () => {
    // Other flows can store lookups keyed by the external id in the shared mapper context
    const ctx = tedge.createContext({});
    ctx.mapper.set("deploy1020304", { external_id: "deploy1020304" });
    ctx.mapper.set("name:deploy1020304", { "@id": "deploy1020304" });
    const out = flow.onMessage(msg(operation()), ctx);
    expect(out[0].topic).toBe(
      "te/device/main///cmd/device_profile/c8y-mapper-218",
    );
  });

  test("child device registered in the mapper context with the topic root", () => {
    const ctx = tedge.createContext({});
    ctx.mapper.set("unrelated", { external_id: "custom-plc" });
    ctx.mapper.set("te/device/plc01//", { "@id": "custom-plc" });
    const out = flow.onMessage(
      msg(
        operation({
          deviceId: "999",
          externalSource: { externalId: "custom-plc", type: "c8y_Serial" },
        }),
      ),
      ctx,
    );
    expect(out[0].topic).toBe(
      "te/device/plc01///cmd/device_profile/c8y-mapper-218",
    );
  });
});

describe("toEntityTopicId", () => {
  test.each([
    ["device/main//", "device/main//"],
    ["device/main///", "device/main//"],
    ["te/device/child01//", "device/child01//"],
    ["factory/plc/service/modbus", "factory/plc/service/modbus"],
    ["deploy1020304", undefined],
    ["device.id", undefined],
    ["device/main", undefined],
    ["device/+//", undefined],
  ])("%s", (key, expected) => {
    expect(flow.toEntityTopicId(key, "te")).toBe(expected);
  });
});

describe("toLocalProxyUrl", () => {
  test.each([
    [
      "https://example.cumulocity.com/inventory/binaries/1",
      "http://127.0.0.1:8001/c8y/inventory/binaries/1",
    ],
    [
      "https://t123.cumulocity.com/inventory/binaries/1?x=1",
      "http://127.0.0.1:8001/c8y/inventory/binaries/1?x=1",
    ],
    ["https://github.com/foo/bar", "https://github.com/foo/bar"],
    ["ftp://example.cumulocity.com/foo", "ftp://example.cumulocity.com/foo"],
  ])("%s", (url, expected) => {
    expect(
      flow.toLocalProxyUrl(
        url,
        "https://example.cumulocity.com",
        "http://127.0.0.1:8001",
      ),
    ).toBe(expected);
  });

  test("disabled when c8y_url is not set", () => {
    const url = "https://example.cumulocity.com/inventory/binaries/1";
    expect(flow.toLocalProxyUrl(url, "", "http://127.0.0.1:8001")).toBe(url);
  });
});

describe("values resolved from the mapper config", () => {
  const software = {
    c8y_ComposedTargetState: {
      deploymentKey: "demo",
      software: [
        {
          name: "app",
          version: "1.0",
          softwareType: "apt",
          url: "https://t123.example.cumulocity.com/inventory/binaries/1",
          action: "install",
        },
      ],
    },
  };

  function moduleUrl(config: object): string {
    const ctx = tedge.createContext(config);
    const out = flow.onMessage(msg(operation(software)), ctx);
    return tedge.decodeJsonPayload(out[0].payload).operations[0].payload
      .updateList[0].modules[0].url;
  }

  test("uses the resolved c8y url and proxy url", () => {
    // As substituted from ${mapper.http} and ${mapper.proxy.client.*}
    expect(
      moduleUrl({
        c8y_url: "mytenant.example.cumulocity.com:443",
        proxy_url: "https://tedge:8001",
      }),
    ).toBe("https://tedge:8001/c8y/inventory/binaries/1");
  });

  test("falls back to the default proxy url if not resolved", () => {
    expect(
      moduleUrl({
        c8y_url: "mytenant.example.cumulocity.com",
        proxy_url: "http://null:null",
      }),
    ).toBe("http://127.0.0.1:8001/c8y/inventory/binaries/1");
  });

  test("does not rewrite urls if the c8y url is not resolved", () => {
    expect(moduleUrl({ c8y_url: "null" })).toBe(
      "https://t123.example.cumulocity.com/inventory/binaries/1",
    );
  });

  test("ignores an unresolved device id", () => {
    const ctx = tedge.createContext({ device_id: "null" });
    const out = flow.onMessage(
      msg(
        operation({
          deviceId: "999",
          externalSource: {
            externalId: "null:device:child01",
            type: "c8y_Serial",
          },
        }),
      ),
      ctx,
    );
    expect(out).toHaveLength(0);
  });
});

describe("url parsing without slow regular expressions", () => {
  const c8y = "t12345.example.com";
  const proxy = "http://127.0.0.1:8001";

  test.each([
    [
      "https://t12345.example.com/inventory/binaries/1",
      `${proxy}/c8y/inventory/binaries/1`,
    ],
    ["https://t12345.example.com", `${proxy}/c8y`],
    ["https://t12345.example.com?x=1", `${proxy}/c8y/?x=1`],
    ["http://mytenant.example.com:443/a#b", `${proxy}/c8y/a#b`],
    ["https://other.com/file", "https://other.com/file"],
    ["ftp://t12345.example.com/file", "ftp://t12345.example.com/file"],
    ["https:///nohost", "https:///nohost"],
    ["not a url", "not a url"],
  ])("%s", (url, expected) => {
    expect(flow.toLocalProxyUrl(url, c8y, proxy)).toBe(expected);
  });

  test("trailing slashes of the proxy url are removed", () => {
    expect(
      flow.toLocalProxyUrl("https://t12345.example.com/a", c8y, `${proxy}///`),
    ).toBe(`${proxy}/c8y/a`);
    expect(flow.trimTrailingSlashes("a/b//")).toBe("a/b");
    expect(flow.trimTrailingSlashes("///")).toBe("");
    expect(flow.trimTrailingSlashes("")).toBe("");
  });

  test("adversarial input is processed quickly", () => {
    const started = Date.now();
    flow.toLocalProxyUrl('http://"' + '""'.repeat(50_000) + "\n", c8y, proxy);
    flow.toLocalProxyUrl(
      "https://t12345.example.com/a",
      c8y,
      "/".repeat(100_000) + "x",
    );
    flow.trimTrailingSlashes("/".repeat(100_000) + "x");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
