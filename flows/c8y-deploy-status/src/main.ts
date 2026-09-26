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
  // Time the version was assigned (the creation time of the operation)
  assignedAt?: string;
}

interface DeviceProfileCommand {
  status?: string;
  reason?: string;
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

const MEMBERSHIP_PREFIX = "c8y_Deployment_";
const STATE_PREFIX = "c8y_DeploymentState_";

/** c8y_Deployment_<key>: the deployment the device belongs to, and the version it runs */
export interface DeploymentMembership {
  deploymentKey?: string;
  priority?: number;
  installedVersion?: string;
  installedAt?: string;
  [field: string]: unknown;
}

/** c8y_DeploymentState_<key>: the version assigned to the device, and its progress */
export interface DeploymentStateFragment {
  deploymentKey?: string;
  version?: string;
  assignedAt?: string;
  state?: string;
  updatedAt?: string;
  error?: string;
  [field: string]: unknown;
}

function parseFragment(payload: Message["payload"]): any {
  const text = decodePayload(payload).trim();
  if (text === "") {
    return undefined;
  }
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Remember the deployment fragments of the digital twin (published by this flow
 * and the c8y-deploy-poll flow), so that the fields which are not known from the
 * command (e.g. assignedAt) are kept
 */
function trackTwin(message: Message, context: FlowContext): void {
  const fragment = message.topic.split("/")[6] ?? "";
  if (
    !fragment.startsWith(MEMBERSHIP_PREFIX) &&
    !fragment.startsWith(STATE_PREFIX)
  ) {
    return;
  }
  const value = parseFragment(message.payload);
  context.flow.set(message.topic, value);
}

function twinOf<T>(context: FlowContext, topic: string): T | undefined {
  const value = context.flow.get(topic);
  return value && typeof value === "object" ? (value as T) : undefined;
}

export function onMessage(message: Message, context: FlowContext): Message[] {
  const { debug = false } = context.config || {};

  // te/<entity topic id>/twin/<fragment>
  if (message.topic.split("/")[5] === "twin") {
    trackTwin(message, context);
    return [];
  }

  // The retained command is cleared (empty payload) once it has finished
  if (decodePayload(message.payload).trim() === "") {
    return [];
  }
  const command: DeviceProfileCommand = decodeJsonPayload(message.payload);

  // Only react to deployment commands
  const { key, version, priority, assignedAt } = command.deployment ?? {};
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
  const membershipTopic = `${target}/twin/${MEMBERSHIP_PREFIX}${fragmentKey}`;
  const stateTopic = `${target}/twin/${STATE_PREFIX}${fragmentKey}`;
  const messages: Message[] = [];
  const now = message.time.toISOString();

  // Installed version, only updated once the update has completed. It is
  // published before the SUCCESS state, so that the installed version is
  // never older than a reported success
  if (command.status === "successful") {
    const current = twinOf<DeploymentMembership>(context, membershipTopic);
    const unchanged = current?.installedVersion === version;
    const membership: DeploymentMembership = {
      deploymentKey: key,
      priority: priority ?? current?.priority,
      installedVersion: version,
      installedAt: (unchanged && current?.installedAt) || now,
    };
    context.flow.set(membershipTopic, membership);
    messages.push({
      time: message.time,
      topic: membershipTopic,
      mqtt: { retain: true, qos: 1 },
      payload: JSON.stringify(membership),
    });
  }

  // Deployment state. A write replaces the whole fragment, so all fields are
  // included. The assignment time is kept from the ASSIGNED state (c8y-deploy-poll)
  const state = toDeploymentState(command.status);
  if (state) {
    const current = twinOf<DeploymentStateFragment>(context, stateTopic);
    const deploymentState: DeploymentStateFragment = {
      deploymentKey: key,
      version,
      assignedAt:
        (current?.version === version && current?.assignedAt) ||
        (typeof assignedAt === "string" && assignedAt) ||
        now,
      state,
      updatedAt: now,
    };
    if (state === "FAILURE") {
      deploymentState.error = command.reason || "Deployment failed";
    }
    context.flow.set(stateTopic, deploymentState);
    messages.push({
      time: message.time,
      topic: stateTopic,
      mqtt: { retain: true, qos: 1 },
      payload: JSON.stringify(deploymentState),
    });
  }

  if (isEnabled(debug)) {
    console.log("Deployment status", { topic: message.topic, messages });
  }
  return messages;
}
