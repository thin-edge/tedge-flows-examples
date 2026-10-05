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
// Flow context key of the last state published from a command, per twin topic
const REPORTED_PREFIX = "reported:";
// Flow context key of the installed version, per twin topic
const INSTALLED_PREFIX = "installed:";

type InstalledVersion = Pick<
  DeploymentMembership,
  "installedVersion" | "installedAt"
>;

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
function trackTwin(message: Message, context: FlowContext): Message[] {
  const fragment = message.topic.split("/")[6] ?? "";
  if (
    !fragment.startsWith(MEMBERSHIP_PREFIX) &&
    !fragment.startsWith(STATE_PREFIX)
  ) {
    return [];
  }
  const value = parseFragment(message.payload);
  context.flow.set(message.topic, value);
  if (fragment.startsWith(MEMBERSHIP_PREFIX)) {
    return trackMembership(message, value, context);
  }

  // The state last reported from a command only describes the deployment until
  // another version is assigned
  const reportedKey = `${REPORTED_PREFIX}${message.topic}`;
  const reported = twinOf<DeploymentStateFragment>(context, reportedKey);
  if (!reported) {
    return [];
  }
  if (value?.version !== reported.version) {
    context.flow.set(reportedKey, undefined);
    return [];
  }

  // c8y-deploy-poll publishes ASSIGNED once the operation request returns,
  // which can be after the command has already progressed (or even finished).
  // A version is assigned before its command starts, so restore the state
  if (value?.state === "ASSIGNED") {
    return [
      {
        time: message.time,
        topic: message.topic,
        mqtt: { retain: true, qos: 1 },
        payload: JSON.stringify(reported),
      },
    ];
  }
  return [];
}

/**
 * Keep the installed version of the membership fragment. This flow is the only
 * one which changes it, but c8y-deploy-poll publishes the fragment when the
 * server returns a different priority, and its copy can be older than an update
 * which has just completed. The installed version is restored, keeping the
 * other fields (e.g. the new priority)
 */
function trackMembership(
  message: Message,
  value: DeploymentMembership | undefined,
  context: FlowContext,
): Message[] {
  const installedKey = `${INSTALLED_PREFIX}${message.topic}`;
  // The device left the deployment
  if (!value) {
    context.flow.set(installedKey, undefined);
    return [];
  }
  const installed = twinOf<InstalledVersion>(context, installedKey);
  if (!installed) {
    // e.g. the retained fragment after a restart
    if (value.installedVersion !== undefined) {
      context.flow.set(installedKey, {
        installedVersion: value.installedVersion,
        installedAt: value.installedAt,
      });
    }
    return [];
  }
  if (
    value.installedVersion === installed.installedVersion &&
    value.installedAt === installed.installedAt
  ) {
    return [];
  }
  const restored: DeploymentMembership = { ...value, ...installed };
  context.flow.set(message.topic, restored);
  return [
    {
      time: message.time,
      topic: message.topic,
      mqtt: { retain: true, qos: 1 },
      payload: JSON.stringify(restored),
    },
  ];
}

function twinOf<T>(context: FlowContext, topic: string): T | undefined {
  const value = context.flow.get(topic);
  return value && typeof value === "object" ? (value as T) : undefined;
}

export function onMessage(message: Message, context: FlowContext): Message[] {
  const { debug = false } = context.config || {};

  // te/<entity topic id>/twin/<fragment>
  if (message.topic.split("/")[5] === "twin") {
    const messages = trackTwin(message, context);
    if (isEnabled(debug) && messages.length > 0) {
      console.log("Restoring the deployment twin", { messages });
    }
    return messages;
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
    // The priority is kept from c8y-deploy-poll, as the server can return a
    // different priority than the one the operation was created with
    const membership: DeploymentMembership = {
      deploymentKey: key,
      priority: current?.priority ?? priority,
      installedVersion: version,
      installedAt: (unchanged && current?.installedAt) || now,
    };
    context.flow.set(membershipTopic, membership);
    context.flow.set(`${INSTALLED_PREFIX}${membershipTopic}`, {
      installedVersion: membership.installedVersion,
      installedAt: membership.installedAt,
    });
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
    // The reported state is preferred, as the twin might hold a stale ASSIGNED
    const reportedKey = `${REPORTED_PREFIX}${stateTopic}`;
    const reported = twinOf<DeploymentStateFragment>(context, reportedKey);
    const current =
      reported?.version === version
        ? reported
        : twinOf<DeploymentStateFragment>(context, stateTopic);
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
    context.flow.set(reportedKey, deploymentState);
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
