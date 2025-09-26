import { expect, test } from "@jest/globals";
import * as tedge from "../../common/tedge";
import * as testMessage1 from "./data/testMessage1.json";

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

describe("process", () => {
  let flow: typeof import("../src/main");

  beforeEach(() => {
    jest.resetModules();
    flow = require("../src/main");
  });

  test("Maps modem data to the c8y_Mobile digital twin", () => {
    const output = flow.onMessage(
      {
        timestamp: tedge.mockGetTime(),
        topic: "example",
        payload: JSON.stringify(testMessage1),
      },
      {},
    );
    expect(output).toHaveLength(1);

    expect(output[0].topic).toMatch(/\/twin\/c8y_Mobile$/);

    const payload = JSON.parse(output[0].payload);
    expect(payload).toHaveProperty("iccid", "8949360000421790514");
    expect(payload).toHaveProperty("imsi", "262231017669630");
    expect(payload).toHaveProperty("currentOperator", "Vodafone.de");
    expect(payload).toHaveProperty("imei", "860018046114881");
    expect(payload).toHaveProperty("cellId", "10785033");
    expect(payload).toHaveProperty("lac", "44331");
    expect(payload).toHaveProperty("lac", "44331");
    expect(payload).toHaveProperty("connType", "lte");
  });

  test("It only publishes on changes", () => {
    const output1 = flow.onMessage(
      {
        timestamp: tedge.mockGetTime(),
        topic: "example",
        payload: JSON.stringify(testMessage1),
      },
      {},
    );
    expect(output1).toHaveLength(1);

    const output2 = flow.onMessage(
      {
        timestamp: tedge.mockGetTime(),
        topic: "example",
        payload: JSON.stringify(testMessage1),
      },
      {},
    );
    expect(output2).toHaveLength(0);
  });

  test("Sends an event when the cell id changes", () => {
    const message1 = clone(testMessage1);
    const output1 = flow.onMessage(
      {
        timestamp: tedge.mockGetTime(),
        topic: "example",
        payload: JSON.stringify(message1),
      },
      {},
    );
    expect(output1).toHaveLength(1);

    const message2 = clone(testMessage1);
    message2.modem.location["3gpp"].cid = "00A4910A";
    const output2 = flow.onMessage(
      {
        timestamp: tedge.mockGetTime(),
        topic: "example",
        payload: JSON.stringify(message2),
      },
      {},
    );

    expect(output2).toHaveLength(2);
    const payload = JSON.parse(output2[0].payload);
    expect(payload).toHaveProperty("cellId", "10785034");
    expect(payload).toHaveProperty("lac", "44331");
  });
});
