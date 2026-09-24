import {
  Message,
  Context,
  decodePayload,
  decodeJsonPayload,
} from "../../common/tedge";

export interface Config {
  debug?: boolean | string;
}

export interface FlowContext extends Context {
  config: Config;
}

/**
 * Deployment meta information added to the device_profile command by the c8y-deploy-operation flow
 */
interface Deployment {
  key?: string;
  version?: string;
  priority?: number;
}

interface DeviceProfileCommand {
  status?: string;
  deployment?: Deployment;
}

type DeploymentState =
  | "PENDING"
  | "CONFIRMED"
  | "IN_PROGRESS"
  | "SUCCESS"
  | "FAILURE";

const STATE_MAPPING: Record<string, DeploymentState> = {
  init: "PENDING",
  scheduled: "CONFIRMED",
  executing: "IN_PROGRESS",
  successful: "SUCCESS",
  failed: "FAILURE",
};

/**
 * Map the command status to a deployment state. Any other (custom) workflow
 * state means the command is still in progress
 */
export function toDeploymentState(
  status: string | undefined,
): DeploymentState | undefined {
  if (!status) {
    return undefined;
  }
  return STATE_MAPPING[status] ?? "IN_PROGRESS";
}

/**
 * Make the key safe to use in an MQTT topic and a Cumulocity fragment name
 */
export function sanitize(value: string): string {
  return `${value}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

function isEnabled(value: boolean | string | undefined): boolean {
  return value === true || value === "true";
}

export function onMessage(message: Message, context: FlowContext): Message[] {
  const { debug = false } = context.config || {};

  // The retained command is cleared (empty payload) once it has finished
  if (decodePayload(message.payload).trim() === "") {
    return [];
  }
  const command: DeviceProfileCommand = decodeJsonPayload(message.payload);

  // Only react to deployment commands
  const { key, version, priority } = command.deployment ?? {};
  if (!key || !version) {
    return [];
  }

  // te/<entity topic id>/cmd/device_profile/<cmd_id>
  const parts = message.topic.split("/");
  const target = parts.slice(0, 5).join("/");
  const cmdId = parts[parts.length - 1] ?? "";

  // Ignore sub workflows
  if (cmdId.startsWith("sub:")) {
    return [];
  }

  const fragmentKey = sanitize(key);
  const messages: Message[] = [];

  // Membership / current deployment (only once it is successful)
  if (command.status === "successful") {
    messages.push({
      time: message.time,
      topic: `${target}/twin/c8y_Deployment_${fragmentKey}`,
      mqtt: { retain: true, qos: 1 },
      payload: JSON.stringify({
        deploymentKey: key,
        priority,
        version,
        assignedAt: message.time,
      }),
    });
  }

  // Deployment state
  const state = toDeploymentState(command.status);
  if (state) {
    messages.push({
      time: message.time,
      topic: `${target}/twin/c8y_DeploymentState_${fragmentKey}`,
      mqtt: { retain: true, qos: 1 },
      payload: JSON.stringify({
        deploymentKey: key,
        version,
        state,
        updatedAt: message.time,
      }),
    });
  }

  if (isEnabled(debug)) {
    console.log("Deployment status", { topic: message.topic, messages });
  }
  return messages;
}
