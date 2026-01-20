import { expect, test, describe, beforeEach } from "@jest/globals";
import * as tedge from "../../common/tedge";

jest.useFakeTimers();

const inputCumulocityCA = `
Certificate:   /etc/tedge/device-certs/tedge-certificate.pem
Subject:       CN=example, O=Thin Edge, OU=Device
Issuer:        C=United States, O=Cumulocity, CN=t123456
Status:        VALID (expires in: 227d 11m 31s)
Valid from:    Tue, 10 Jun 2025 14:03:43 +0000
Valid until:   Wed, 10 Jun 2026 14:03:43 +0000
Serial number: 17152455133923 (0xf999dfecae3)
Thumbprint:    7EA936355ECCA79E7D59D275ECE1E4A8BE5E9275
`
  .trimStart()
  .replaceAll("\n", "\u0000");

const expectedCumulocityCAOutput = {
  signedBy: "c8y-ca",
  issuer: "C=United States, O=Cumulocity, CN=t123456",
  serialNumberHex: "f999dfecae3",
  status: "VALID",
  subject: "CN=example, O=Thin Edge, OU=Device",
  validFrom: "2025-06-10T14:03:43.000Z",
  validUntil: "2026-06-10T14:03:43.000Z",
};

const inputSelfSigned = `
Certificate:   /etc/tedge/device-certs/tedge-certificate.pem
Subject:       CN=example, O=Thin Edge, OU=Device
Issuer:        CN=example, O=Thin Edge, OU=Device
Status:        VALID (expires in: 227d 11m 31s)
Valid from:    Tue, 10 Jun 2025 14:03:43 +0000
Valid until:   Wed, 10 Jun 2026 14:03:43 +0000
Serial number: 17152455133923 (0xf999dfecae3)
Thumbprint:    7EA936355ECCA79E7D59D275ECE1E4A8BE5E9275
`
  .trimStart()
  .replaceAll("\n", "\u0000");

const expectedSelfSigned = {
  signedBy: "self",
  issuer: "CN=example, O=Thin Edge, OU=Device",
  serialNumberHex: "f999dfecae3",
  status: "VALID",
  subject: "CN=example, O=Thin Edge, OU=Device",
  validFrom: "2025-06-10T14:03:43.000Z",
  validUntil: "2026-06-10T14:03:43.000Z",
};

describe("flow tests", () => {
  const now = new Date("2025-10-01T12:11:59Z").getTime();
  jest.setSystemTime(now);
  let flow: typeof import("../src/main");

  beforeEach(() => {
    jest.resetModules();
    flow = require("../src/main");
  });

  test("Publish certificate meta information to json - c8y-ca", () => {
    const output = flow.onMessage(
      {
        time: tedge.mockGetTime(),
        topic: "",
        payload: inputCumulocityCA,
      },
      {
        config: {
          disable_alarms: true,
        },
      },
    );
    expect(output).toHaveLength(1);
    const payload = JSON.parse(output[0].payload);
    expect(output[0].topic).toBe("te/device/main///twin/tedge_Certificate");
    expect(output[0].retain).toBe(true);
    expect(payload).toStrictEqual(expectedCumulocityCAOutput);
  });

  test("Publish certificate meta information to json - self signed", () => {
    const output = flow.onMessage(
      {
        time: tedge.mockGetTime(),
        topic: "",
        payload: inputSelfSigned,
      },
      {
        config: {
          disable_alarms: true,
        },
      },
    );
    expect(output).toHaveLength(1);
    const payload = JSON.parse(output[0].payload);
    expect(output[0].topic).toBe("te/device/main///twin/tedge_Certificate");
    expect(output[0].retain).toBe(true);
    expect(payload).toStrictEqual(expectedSelfSigned);
  });

  test("Publish a warning when certificate crosses threshold", () => {
    const output = flow.onMessage(
      {
        time: tedge.mockGetTime(),
        topic: "",
        payload: inputCumulocityCA,
      },
      {
        config: {
          disable_alarms: false,
          warning: "300d",
          alarm: "60d",
        },
      },
    );
    expect(output).toHaveLength(3);

    // meta message
    const payload = JSON.parse(output[0].payload);
    expect(output[0].topic).toBe("te/device/main///twin/tedge_Certificate");
    expect(output[0].retain).toBe(true);
    expect(payload).toStrictEqual(expectedCumulocityCAOutput);

    // alarm
    expect(output[1].topic).toBe(
      "te/device/main///a/certificateExpiresSoon_warn",
    );
    expect(output[2].retain).toBe(true);
    const warning = JSON.parse(output[1].payload);
    expect(warning).toStrictEqual({
      text: "Certificate will expire within 300d",
      severity: "warning",
      details: expectedCumulocityCAOutput,
    });

    // clear other alarm
    expect(output[2].topic).toBe(
      "te/device/main///a/certificateExpiresSoon_alarm",
    );
    expect(output[2].payload).toBe("");
    expect(output[2].retain).toBe(true);
  });

  test("Publish an alarm when certificate will expire less than given threshold", () => {
    const output = flow.onMessage(
      {
        time: tedge.mockGetTime(),
        topic: "",
        payload: inputCumulocityCA,
      },
      {
        config: {
          disable_alarms: false,
          warning: "365d",
          alarm: "300d",
        },
      },
    );
    expect(output).toHaveLength(3);

    // meta message
    const payload = JSON.parse(output[0].payload);
    expect(output[0].topic).toBe("te/device/main///twin/tedge_Certificate");
    expect(output[0].retain).toBe(true);
    expect(payload).toStrictEqual(expectedCumulocityCAOutput);

    // alarm
    expect(output[1].topic).toBe(
      "te/device/main///a/certificateExpiresSoon_alarm",
    );
    expect(output[2].retain).toBe(true);
    const warning = JSON.parse(output[1].payload);
    expect(warning).toStrictEqual({
      text: "Certificate will expire within 300d",
      severity: "major",
      details: expectedCumulocityCAOutput,
    });

    // clear other alarm
    expect(output[2].topic).toBe(
      "te/device/main///a/certificateExpiresSoon_warn",
    );
    expect(output[2].payload).toBe("");
    expect(output[2].retain).toBe(true);
  });

  test("De-duplication of output", () => {
    const output = flow.onMessage(
      {
        time: tedge.mockGetTime(),
        topic: "",
        payload: inputCumulocityCA,
      },
      {
        config: {
          disable_alarms: false,
          warning: "365d",
          alarm: "300d",
        },
      },
    );
    expect(output).toHaveLength(3);

    // execute a second time with the same input
    const output2 = flow.onMessage(
      {
        time: tedge.mockGetTime(),
        topic: "",
        payload: inputCumulocityCA,
      },
      {
        config: {
          disable_alarms: false,
          warning: "365d",
          alarm: "300d",
        },
      },
    );
    expect(output2).toHaveLength(0);
  });

  test("Only publish alarms", () => {
    const output = flow.onMessage(
      {
        time: tedge.mockGetTime(),
        topic: "",
        payload: inputCumulocityCA,
      },
      {
        config: {
          disable_alarms: false,
          disable_twin: true,
          warning: "365d",
          alarm: "300d",
        },
      },
    );
    expect(output).toHaveLength(2);

    expect(output[0].topic).toBe(
      "te/device/main///a/certificateExpiresSoon_alarm",
    );
    expect(output[0].retain).toBe(true);
    expect(output[0].payload).toMatch(/.+/);
    expect(output[1].topic).toBe(
      "te/device/main///a/certificateExpiresSoon_warn",
    );
    expect(output[1].retain).toBe(true);
    expect(output[1].payload).toBe("");
  });
});
