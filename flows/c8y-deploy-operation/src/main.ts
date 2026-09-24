import { Message, Context, decodeJsonPayload } from "../../common/tedge";

export interface Config {
  // Name of the operation fragment to translate
  fragment?: string;
  // Root of the thin-edge.io MQTT topics
  topic_root?: string;
  // Prefix of the command id. It must match the prefix used by the c8y mapper
  // so that the mapper reports the command status back to the Cumulocity operation
  cmd_id_prefix?: string;
  // External id of the main device (used to resolve the target entity)
  device_id?: string;
  // Cumulocity URL, e.g. "example.cumulocity.com". Binary URLs pointing to this
  // tenant are rewritten to go via the local thin-edge.io Cumulocity proxy
  c8y_url?: string;
  // Base URL of the local thin-edge.io Cumulocity proxy
  proxy_url?: string;
  debug?: boolean | string;
}

export interface FlowContext extends Context {
  config: Config;
}

interface C8yFirmware {
  name: string;
  version: string;
  url: string;
}

interface C8ySoftwareModule {
  name: string;
  version?: string;
  url?: string;
  softwareType?: string;
  action: string;
}

interface C8yConfiguration {
  name: string;
  type: string;
  url: string;
}

interface C8yTargetState {
  deploymentKey?: string;
  version?: string;
  priority?: number;
  firmware?: C8yFirmware;
  software?: C8ySoftwareModule[];
  configuration?: C8yConfiguration[];
}

interface SoftwareModuleItem {
  name: string;
  version?: string;
  url?: string;
  action: "install" | "remove";
}

interface SoftwareList {
  type: string;
  modules: SoftwareModuleItem[];
}

type DeviceProfileOperation =
  | {
      operation: "firmware_update";
      payload: { name: string; version: string; remoteUrl: string };
      "@skip": boolean;
    }
  | {
      operation: "config_update";
      payload: {
        name: string;
        type: string;
        remoteUrl: string;
        serverUrl: string;
      };
      "@skip": boolean;
    }
  | {
      operation: "software_update";
      payload: { updateList: SoftwareList[] };
      "@skip": boolean;
    };

export interface DeviceProfileCommand {
  status: "init" | "failed";
  reason?: string;
  name: string;
  deployment: Deployment;
  operations: DeviceProfileOperation[];
}

/**
 * Meta information about the deployment, e.g. { key: "demo", version: "13.6", priority: 100 }
 */
export interface Deployment {
  key?: string;
  version?: string;
  priority?: number;
  [field: string]: unknown;
}

// Target state fields which are converted to device_profile operations
const OPERATION_FIELDS = ["firmware", "software", "configuration"];

/**
 * Keep all target state fields except the ones converted to operations,
 * renaming deploymentKey to key
 */
export function getDeployment(targetState: C8yTargetState): Deployment {
  const deployment: Deployment = {};
  for (const [field, value] of Object.entries(targetState)) {
    if (OPERATION_FIELDS.includes(field)) {
      continue;
    }
    deployment[field === "deploymentKey" ? "key" : field] = value;
  }
  return deployment;
}

const DEFAULT_SOFTWARE_TYPE = "default";
const DEFAULT_PROXY_URL = "http://127.0.0.1:8001";

/**
 * Return the value, or undefined if it is not set. Template references to
 * mapper config values that are not set (e.g. "${mapper.device.id}") are
 * substituted with "null"
 */
function valueOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const trimmed = `${value}`.trim();
  return trimmed === "" || trimmed === "null" ? undefined : trimmed;
}

function isEnabled(value: boolean | string | undefined): boolean {
  return value === true || value === "true";
}

/**
 * Split the version and software type, matching the behaviour of the c8y mapper.
 * If softwareType is not set, the legacy "<version>::<type>" format is used.
 */
export function getModuleVersionAndType(
  module: C8ySoftwareModule,
): [string | undefined, string | undefined] {
  const version = (module.version ?? "").trim();
  const softwareType = (module.softwareType ?? "").trim();

  if (softwareType) {
    return [version || undefined, softwareType];
  }
  if (!version) {
    return [undefined, undefined];
  }
  const sep = version.lastIndexOf("::");
  if (sep < 0) {
    return [version, undefined];
  }
  const v = version.substring(0, sep);
  const t = version.substring(sep + 2);
  return [v || undefined, t || undefined];
}

function getDomainWithoutTenant(host: string): string {
  // Strip the port and the first label (tenant name or tenant id), so that
  // "t12345.example.com" and "mytenant.example.com" are treated as the same tenant
  const hostname = host.split(":")[0];
  const i = hostname.indexOf(".");
  return i < 0 ? hostname : hostname.substring(i + 1);
}

/**
 * Rewrite a Cumulocity URL so that it is downloaded via the local proxy, e.g.
 * https://example.cumulocity.com/inventory/binaries/1234 => http://127.0.0.1:8001/c8y/inventory/binaries/1234
 * URLs pointing to other hosts are left untouched.
 */
export function toLocalProxyUrl(
  url: string,
  c8yUrl: string | undefined,
  proxyUrl: string,
): string {
  if (!c8yUrl) {
    return url;
  }
  // Split the url without a regular expression, to avoid slow matching
  // (backtracking) on unexpected input
  const scheme = url.startsWith("https://")
    ? "https://"
    : url.startsWith("http://")
      ? "http://"
      : undefined;
  if (!scheme) {
    return url;
  }
  const hostStart = scheme.length;
  let hostEnd = hostStart;
  while (hostEnd < url.length && !"/?#".includes(url[hostEnd])) {
    hostEnd++;
  }
  if (hostEnd === hostStart) {
    return url;
  }
  const host = url.substring(hostStart, hostEnd);
  const rest = url.substring(hostEnd);
  const c8yHost = c8yUrl.replace(/^[a-z]+:\/\//, "").split("/")[0];
  if (getDomainWithoutTenant(host) !== getDomainWithoutTenant(c8yHost)) {
    return url;
  }
  const path = rest.startsWith("/") || rest === "" ? rest : `/${rest}`;
  return `${trimTrailingSlashes(proxyUrl)}/c8y${path}`;
}

/**
 * Remove trailing slashes (without a regular expression, as /\/+$/ is slow on
 * input with many slashes which are not at the end)
 */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end--;
  }
  return value.substring(0, end);
}

/**
 * Resolve the thin-edge.io topic identifier (e.g. "device/main//") from the Cumulocity external id
 */
export function resolveTopicId(
  operation: any,
  context: FlowContext,
): string | undefined {
  const externalId: string | undefined = operation?.externalSource?.externalId;
  const { device_id, topic_root = "te" } = context.config || {};
  const mainDeviceId =
    valueOrUndefined(device_id) ??
    valueOrUndefined(context.mapper.get("device.id"));

  // An operation for the agent itself always targets the main device
  if (operation?.agentId && operation.agentId === operation.deviceId) {
    return "device/main//";
  }
  if (!externalId) {
    return undefined;
  }
  if (mainDeviceId && externalId === mainDeviceId) {
    return "device/main//";
  }

  // Entities stored in the mapper context, keyed by their topic id (optionally
  // including the topic root). The mapper context is shared by all flows, so
  // ignore any other keys (e.g. lookups keyed by the external id)
  for (const key of context.mapper.keys()) {
    const topicId = toEntityTopicId(key, topic_root);
    if (!topicId) {
      continue;
    }
    const entity = context.mapper.get(key);
    if (
      entity &&
      typeof entity === "object" &&
      (entity.external_id === externalId || entity["@id"] === externalId)
    ) {
      return topicId;
    }
  }

  // Default external id scheme used by thin-edge.io for child devices
  if (mainDeviceId) {
    const childPrefix = `${mainDeviceId}:device:`;
    if (externalId.startsWith(childPrefix)) {
      const child = externalId.substring(childPrefix.length);
      if (child && !child.includes(":") && !child.includes("/")) {
        return `device/${child}//`;
      }
    }
  }
  return undefined;
}

/**
 * Return the entity topic id (e.g. "device/child01//") if the key is one,
 * otherwise undefined. A leading topic root (e.g. "te/") is removed
 */
export function toEntityTopicId(
  key: string,
  topicRoot: string,
): string | undefined {
  const rootPrefix = `${topicRoot}/`;
  const id = key.startsWith(rootPrefix)
    ? key.substring(rootPrefix.length)
    : key;
  const segments = id.split("/");
  // Allow a trailing slash, e.g. "device/main///"
  if (segments.length === 5 && segments[4] === "") {
    segments.pop();
  }
  if (segments.length !== 4 || !segments[0] || !segments[1]) {
    return undefined;
  }
  if (segments.some((s) => s.includes("+") || s.includes("#"))) {
    return undefined;
  }
  return segments.join("/");
}

export function convertTargetState(
  targetState: C8yTargetState,
  profileName: string,
  config: Config,
): DeviceProfileCommand {
  const c8y_url = valueOrUndefined(config.c8y_url);
  // e.g. "http://null:null" if the mapper proxy settings could not be resolved
  const configuredProxyUrl = valueOrUndefined(config.proxy_url);
  const proxy_url =
    configuredProxyUrl &&
    !/:\/\/null(:|\/|$)|:null(\/|$)/.test(configuredProxyUrl)
      ? configuredProxyUrl
      : DEFAULT_PROXY_URL;
  const command: DeviceProfileCommand = {
    status: "init",
    name: profileName,
    deployment: getDeployment(targetState),
    operations: [],
  };

  // Keep the same order as the c8y mapper: firmware, configuration, software
  if (targetState.firmware) {
    const { name, version, url } = targetState.firmware;
    command.operations.push({
      operation: "firmware_update",
      payload: {
        name,
        version,
        remoteUrl: toLocalProxyUrl(url, c8y_url, proxy_url),
      },
      "@skip": false,
    });
  }

  for (const config of targetState.configuration ?? []) {
    command.operations.push({
      operation: "config_update",
      payload: {
        name: config.name,
        type: config.type,
        remoteUrl: toLocalProxyUrl(config.url, c8y_url, proxy_url),
        serverUrl: config.url,
      },
      "@skip": false,
    });
  }

  if (targetState.software && targetState.software.length > 0) {
    const updateList: SoftwareList[] = [];
    for (const module of targetState.software) {
      const [version, softwareType] = getModuleVersionAndType(module);
      const type = softwareType ?? DEFAULT_SOFTWARE_TYPE;

      let action: SoftwareModuleItem["action"];
      if (module.action === "install") {
        action = "install";
      } else if (module.action === "delete") {
        action = "remove";
      } else {
        throw new Error(
          `Invalid software action '${module.action}' for module '${module.name}'. It must be install or delete.`,
        );
      }

      // Keep the same field order as the c8y mapper: name, version, url, action
      const url = (module.url ?? "").trim();
      const item: SoftwareModuleItem = {
        name: module.name,
        ...(version !== undefined && { version }),
        ...(url && { url: toLocalProxyUrl(url, c8y_url, proxy_url) }),
        action,
      };

      const list = updateList.find((l) => l.type === type);
      if (list) {
        list.modules.push(item);
      } else {
        updateList.push({ type, modules: [item] });
      }
    }
    command.operations.push({
      operation: "software_update",
      payload: { updateList },
      "@skip": false,
    });
  }

  return command;
}

function getProfileName(operation: any, targetState: C8yTargetState): string {
  if (targetState.deploymentKey && targetState.version) {
    return `${targetState.deploymentKey}/${targetState.version}`;
  }
  return (
    targetState.deploymentKey ||
    operation.profileName ||
    operation.description ||
    `target-state-${operation.id}`
  );
}

export function onMessage(message: Message, context: FlowContext): Message[] {
  const {
    fragment = "c8y_ComposedTargetState",
    topic_root = "te",
    cmd_id_prefix = "c8y-mapper",
    debug = false,
  } = context.config || {};

  const operation = decodeJsonPayload(message.payload);
  const targetState: C8yTargetState | undefined = operation?.[fragment];
  if (!targetState || typeof targetState !== "object") {
    // Not a target state operation, so ignore it
    return [];
  }
  if (!operation.id) {
    console.warn("Ignoring operation without an id", { fragment });
    return [];
  }

  const topicId = resolveTopicId(operation, context);
  if (!topicId) {
    console.warn("Could not resolve the target device of the operation", {
      id: operation.id,
      externalSource: operation.externalSource,
    });
    return [];
  }

  const topic = `${topic_root}/${topicId}/cmd/device_profile/${cmd_id_prefix}-${operation.id}`;
  const profileName = getProfileName(operation, targetState);

  let command: DeviceProfileCommand;
  try {
    command = convertTargetState(targetState, profileName, context.config);
  } catch (err) {
    // Create a failed command so that the c8y mapper marks the operation as failed
    command = {
      status: "failed",
      reason: `${err instanceof Error ? err.message : err}`,
      name: profileName,
      deployment: getDeployment(targetState),
      operations: [],
    };
  }

  if (isEnabled(debug)) {
    console.log("Converted target state", { topic, command });
  }

  return [
    {
      time: message.time,
      topic,
      payload: JSON.stringify(command),
      mqtt: { retain: true, qos: 1 },
    },
  ];
}
