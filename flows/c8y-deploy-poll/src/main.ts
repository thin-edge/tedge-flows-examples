import { Message, Context, decodePayload } from "../../common/tedge";

export interface Config {
  // Deployment to evaluate, e.g. "demo"
  deployment_key?: string;
  // Target state to evaluate: "active" (default), "latest" or a version
  target_state?: string;
  // Device context sent to the server: an object (TOML table) or a JSON string
  context?: Record<string, unknown> | string;
  // Path to a JSON file with additional device context (read by poll.sh)
  context_file?: string;
  // Add the (normalized) architecture of the device to the context as "arch"
  detect_arch?: boolean | string;
  // Priority requested by the device. Leave empty to use the server priority
  priority?: number | string;
  // Poll interval, e.g. "24h"
  interval?: number | string;
  // Maximum delay before the first poll after the flow is installed
  startup_delay?: number | string;
  // First retry delay after a failed request (doubled on each failure)
  retry_min?: number | string;
  // Maximum number of operation requests for the same version
  max_attempts?: number | string;
  // Time after which an ASSIGNED deployment without progress is considered failed
  assigned_timeout?: number | string;
  // Report a deployment or operation without any status change for this long
  // (warning only, nothing is requested). Empty: disabled
  in_progress_timeout?: number | string;
  // Operations which block a new deployment while they are in progress
  busy_operations?: string[] | string;
  // "client": dry run first, then request the operation if needed
  // "server": always request the operation and let the server decide
  operation_request?: string;
  // Additional query parameters used in "server" mode, e.g. "onlyIfChanged=true"
  server_query?: string;
  // Allow requesting operations for target states other than "active"
  allow_preview?: boolean | string;
  // Publish events describing what the flow is doing: "off", "changes" or "all"
  events?: string;
  // External id of the device (used to spread the polls of a fleet)
  device_id?: string;
  topic_root?: string;
  debug?: boolean | string;
}

export interface FlowContext extends Context {
  config: Config;
}

export const BASE_PATH = "/c8y/service/deployment-device-proxy/deployments";
export const TOPIC_PREFIX = "tedge-flows/c8y-deploy-poll";
export const EVENT_TYPE = "c8y_DeploymentPoll";

const KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const IN_FLIGHT_STATES = ["ASSIGNED", "PENDING", "CONFIRMED", "IN_PROGRESS"];

// How long to wait for the retained messages and the context file after startup
const STARTUP_GRACE_MS = 5_000;
const CONTEXT_WAIT_MS = 30_000;
// How long a request can stay unanswered before a new dry run is scheduled
const RESPONSE_TIMEOUT_MS = 5 * 60_000;
// Time window in which poll.sh may execute an operation request
const CREATE_TTL_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Phase = "dry" | "create" | "server";

/** Request published (retained) for poll.sh */
export interface RequestSpec {
  due: number; // epoch seconds
  expires: number; // epoch seconds, 0 = never
  id: string;
  path: string;
  body: string;
}

/** Result printed by poll.sh */
export interface Evaluation {
  id: string;
  ok: boolean;
  // HTTP status code of a failed request, if known
  status?: number;
  error?: string;
  available?: boolean;
  version?: string;
  priority?: number;
  reason?: string;
  operationCreated?: boolean;
}

/** c8y_DeploymentState_<key> */
export interface DeploymentState {
  deploymentKey?: string;
  version?: string;
  state?: string;
  updatedAt?: string;
  [field: string]: unknown;
}

/** c8y_Deployment_<key> */
export interface DeploymentMembership {
  deploymentKey?: string;
  priority?: number;
  version?: string;
  assignedAt?: string;
  [field: string]: unknown;
}

/** Retained state owned by this flow */
export interface PollState {
  version?: string;
  attempts?: number;
  requestedAt?: string;
  lastPollAt?: string;
  lastRequestId?: string;
  failures?: number;
  priority?: number;
  // Signature of the last published event (used by events = "changes")
  lastEvent?: string;
  // Last reported deployment result: "<version>|<state>|<updatedAt>"
  reportedResult?: string;
}

export type EventMode = "off" | "changes" | "all";

export interface Settings {
  key: string;
  targetState: string;
  interval: number; // ms
  startupDelay: number; // ms
  retryMin: number; // ms
  maxAttempts: number;
  assignedTimeout: number; // ms
  inProgressTimeout: number; // ms, 0 = disabled
  busyOperations: string[];
  mode: "client" | "server";
  serverQuery: string;
  allowPreview: boolean;
  detectArch: boolean;
  events: EventMode;
  deviceId: string;
  topicRoot: string;
  waitForContext: boolean;
  debug: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isEnabled(value: boolean | string | undefined): boolean {
  return value === true || value === "true";
}

/**
 * Return the value, or undefined if it is not set. Params which are not set
 * are substituted with "null"
 */
function valueOrUndefined(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const trimmed = `${value}`.trim();
  return trimmed === "" || trimmed === "null" ? undefined : trimmed;
}

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse a duration such as "24h", "5m", "30s" or a number of seconds, to milliseconds
 */
export function parseDuration(
  value: number | string | undefined,
  fallback: number,
): number {
  const text = valueOrUndefined(value);
  if (text === undefined) {
    return fallback;
  }
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/);
  if (!match) {
    return fallback;
  }
  return Math.round(parseFloat(match[1]) * UNITS[match[2] ?? "s"]);
}

function parseInteger(value: unknown): number | undefined {
  const text = valueOrUndefined(value);
  if (text === undefined || !/^\d+$/.test(text)) {
    return undefined;
  }
  return parseInt(text, 10);
}

export const DEFAULT_BUSY_OPERATIONS = [
  "device_profile",
  "firmware_update",
  "software_update",
  "config_update",
];

function parseList(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => `${v}`.trim()).filter((v) => v !== "");
  }
  const text = valueOrUndefined(value);
  if (text === undefined) {
    return fallback;
  }
  return text
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

function parseEventMode(value: unknown): EventMode {
  const mode = valueOrUndefined(value);
  return mode === "changes" || mode === "all" ? mode : "off";
}

export function getSettings(config: Config = {}): Settings {
  const mode =
    valueOrUndefined(config.operation_request) === "server"
      ? "server"
      : "client";
  return {
    key: valueOrUndefined(config.deployment_key) ?? "",
    targetState: valueOrUndefined(config.target_state) ?? "active",
    interval: parseDuration(config.interval, 86_400_000),
    startupDelay: parseDuration(config.startup_delay, 300_000),
    retryMin: parseDuration(config.retry_min, 300_000),
    maxAttempts: parseInteger(config.max_attempts) ?? 3,
    assignedTimeout: parseDuration(config.assigned_timeout, 3_600_000),
    inProgressTimeout: parseDuration(config.in_progress_timeout, 0),
    busyOperations: parseList(config.busy_operations, DEFAULT_BUSY_OPERATIONS),
    mode,
    serverQuery: (valueOrUndefined(config.server_query) ?? "").replace(
      /^[?&]+/,
      "",
    ),
    allowPreview: isEnabled(config.allow_preview),
    detectArch: isEnabled(config.detect_arch),
    events: parseEventMode(config.events),
    deviceId: valueOrUndefined(config.device_id) ?? "",
    topicRoot: valueOrUndefined(config.topic_root) ?? "te",
    waitForContext: valueOrUndefined(config.context_file) !== undefined,
    debug: isEnabled(config.debug),
  };
}

export function isValidKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

export function topics(settings: Settings) {
  const { key, topicRoot } = settings;
  return {
    request: `${TOPIC_PREFIX}/${key}/request`,
    state: `${TOPIC_PREFIX}/${key}/state`,
    response: `${TOPIC_PREFIX}/${key}/response`,
    context: `${TOPIC_PREFIX}/${key}/context`,
    detect: `${TOPIC_PREFIX}/${key}/detect`,
    membership: `${topicRoot}/device/main///twin/c8y_Deployment_${key}`,
    deploymentState: `${topicRoot}/device/main///twin/c8y_DeploymentState_${key}`,
    event: `${topicRoot}/device/main///e/${EVENT_TYPE}`,
  };
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

function toObject(value: unknown, source: string): Record<string, unknown> {
  if (value === undefined || value === null || value === "") {
    return {};
  }
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      console.warn(`Ignoring invalid JSON in the device context`, { source });
      return {};
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn(`Ignoring device context which is not an object`, { source });
    return {};
  }
  return parsed as Record<string, unknown>;
}

// Normalized architecture names, e.g. "aarch64" => "arm64"
const ARCHITECTURES: [RegExp, string][] = [
  [/^(amd64|x86_64)$/, "amd64"],
  // armv8l: 32-bit kernel (or process) on a 64-bit CPU
  [/^armv8l$/, "armv7"],
  [/^(arm64|aarch64|arm64e|armv8.*)$/, "arm64"],
  [/^(armhf|armv7.*)$/, "armv7"],
  [/^(armel|armv6.*|armv5.*)$/, "armv6"],
  [/^(i386|i686|i586)$/, "386"],
  [/^riscv64$/, "riscv64"],
];

/**
 * Return the normalized architecture, or undefined if it is not known. A dpkg
 * "<os>-<cpu>" architecture (e.g. "musl-linux-arm64") is reduced to the cpu
 */
function knownArch(value: unknown): string | undefined {
  const raw = valueOrUndefined(value)?.toLowerCase();
  if (raw === undefined) {
    return undefined;
  }
  for (const candidate of [raw, raw.substring(raw.lastIndexOf("-") + 1)]) {
    for (const [pattern, arch] of ARCHITECTURES) {
      if (pattern.test(candidate)) {
        return arch;
      }
    }
  }
  return undefined;
}

/**
 * Normalize an architecture reported by dpkg or uname. Unknown values are
 * returned as is
 */
export function normalizeArch(value: unknown): string | undefined {
  const raw = valueOrUndefined(value)?.toLowerCase();
  if (raw === undefined) {
    return undefined;
  }
  const arch = knownArch(raw);
  if (arch === undefined) {
    console.warn("Unknown architecture, using it as is", { arch: raw });
  }
  return arch ?? raw;
}

/**
 * Device context detected by poll.sh, e.g. {"machine":"aarch64","dpkg":"arm64"}.
 * The userland architecture (dpkg) is preferred over the kernel one (uname -m),
 * as a 64-bit kernel can run a 32-bit OS (e.g. Raspberry Pi OS 32-bit)
 */
export function detectedContext(line: string): Record<string, string> {
  let detected: any;
  try {
    detected = JSON.parse(line);
  } catch {
    return {};
  }
  const arch =
    knownArch(detected?.dpkg) ??
    knownArch(detected?.machine) ??
    normalizeArch(detected?.dpkg) ??
    normalizeArch(detected?.machine);
  return arch ? { arch } : {};
}

/**
 * Build the evaluate request body. Later sources override earlier ones:
 * the detected context, the context param, the context file and the priority param
 */
export function buildBody(
  contextParam: unknown,
  contextFile: unknown,
  priority: unknown,
  detected: Record<string, string> = {},
): string {
  const body: Record<string, unknown> = {};
  for (const [source, value] of [
    ["detected", detected],
    ["context", contextParam],
    ["context_file", contextFile],
  ]) {
    for (const [key, item] of Object.entries(toObject(value, `${source}`))) {
      if (key === "priority") {
        console.warn(
          "Ignoring 'priority' in the device context, use the priority param",
        );
        continue;
      }
      if (typeof item !== "string") {
        console.warn("Ignoring device context value which is not a string", {
          key,
        });
        continue;
      }
      body[key] = item;
    }
  }
  const prio = parseInteger(priority);
  if (prio !== undefined) {
    body.priority = prio;
  }
  return JSON.stringify(body);
}

export function buildPath(settings: Settings, phase: Phase): string {
  const base = `${BASE_PATH}/${settings.key}/targetstates/${encodeURIComponent(settings.targetState)}/evaluate`;
  const query: string[] = [];
  if (phase === "create" || phase === "server") {
    query.push("createOperation=true");
  }
  if (phase === "server" && settings.serverQuery) {
    query.push(settings.serverQuery);
  }
  return query.length ? `${base}?${query.join("&")}` : base;
}

export function phaseOf(path: string, settings: Settings): Phase {
  if (!/[?&]createOperation=true(&|$)/.test(path)) {
    return "dry";
  }
  return settings.mode === "server" ? "server" : "create";
}

export function formatRequest(spec: RequestSpec): string {
  return `${spec.due} ${spec.expires} ${spec.id} ${spec.path} ${spec.body}`;
}

export function parseRequest(line: string): RequestSpec | undefined {
  const match = line
    .trim()
    .match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/);
  if (!match) {
    return undefined;
  }
  return {
    due: parseInt(match[1], 10),
    expires: parseInt(match[2], 10),
    id: match[3],
    path: match[4],
    body: match[5] ?? "{}",
  };
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * 32-bit FNV-1a hash, used to derive a stable per-device poll slot
 */
export function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The next time (ms) after now at which this device polls. Each device uses a
 * fixed offset within the interval, so polls are spread over the fleet and
 * stable across restarts
 */
export function nextSlot(now: number, settings: Settings): number {
  const { interval, deviceId, key } = settings;
  const offset = hash(`${deviceId}:${key}`) % interval;
  let next = Math.floor((now - offset) / interval) * interval + offset;
  while (next <= now) {
    next += interval;
  }
  return next;
}

/**
 * First poll after the flow is installed: within the startup delay
 */
export function startupDue(now: number, settings: Settings): number {
  const { startupDelay, deviceId, key } = settings;
  if (startupDelay <= 0) {
    return now;
  }
  return now + (hash(`startup:${deviceId}:${key}`) % startupDelay);
}

export function backoffDelay(failures: number, settings: Settings): number {
  const delay = settings.retryMin * Math.pow(2, Math.max(0, failures - 1));
  return Math.min(delay, settings.interval);
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * Parse the result line printed by poll.sh
 */
export function parseEvaluation(line: string): Evaluation | undefined {
  let result: any;
  try {
    result = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!result || typeof result.id !== "string") {
    return undefined;
  }
  if (!result.ok) {
    const error = `${result.error ?? ""}`;
    const match = error.match(/HTTP (?:client |server )?error: (\d{3})/);
    return {
      id: result.id,
      ok: false,
      status: match ? parseInt(match[1], 10) : undefined,
      error,
    };
  }
  let response: any;
  try {
    response =
      typeof result.response === "string"
        ? JSON.parse(result.response)
        : result.response;
  } catch {
    return { id: result.id, ok: false, error: "Invalid JSON response" };
  }
  if (!response || typeof response !== "object") {
    return { id: result.id, ok: false, error: "Empty response" };
  }
  const available = response.available === true;
  const version =
    response.version === undefined || response.version === null
      ? undefined
      : `${response.version}`;
  return {
    id: result.id,
    ok: true,
    available: available && version !== undefined,
    version,
    priority:
      typeof response.priority === "number" ? response.priority : undefined,
    reason: response.reason,
    operationCreated:
      typeof response.operationCreated === "boolean"
        ? response.operationCreated
        : undefined,
  };
}

/**
 * Transport errors, server errors and rejected credentials can be fixed by
 * trying again later. Other client errors (e.g. unknown deployment) cannot
 */
export function isRetryable(evaluation: Evaluation): boolean {
  const { status } = evaluation;
  return (
    status === undefined ||
    status >= 500 ||
    status === 401 ||
    status === 408 ||
    status === 429
  );
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/** A command of the main device which is not finished yet */
export interface ActiveCommand {
  operation: string;
  cmdId: string;
  status: string;
  // Last time the status changed (as seen by this flow)
  changedAt: string;
  deploymentKey?: string;
  version?: string;
}

/** What the flow knows about the device */
export interface Twins {
  membership?: DeploymentMembership;
  state?: DeploymentState;
  // Active commands, keyed by topic
  commands?: Record<string, ActiveCommand>;
  // Reason of the last failed command of this deployment
  failure?: { version?: string; reason?: string };
}

const FINAL_STATUSES = ["successful", "failed"];

/**
 * Update the active commands from a command message. Return true if the set of
 * active commands changed
 */
export function trackCommand(
  twins: Twins,
  topic: string,
  payload: string,
  settings: Settings,
  time: Date,
): boolean {
  // <root>/device/main///cmd/<operation>/<cmd_id>
  const prefix = `${settings.topicRoot}/device/main///cmd/`;
  if (!topic.startsWith(prefix)) {
    return false;
  }
  const [operation, cmdId] = topic.substring(prefix.length).split("/");
  if (!operation || !cmdId || !settings.busyOperations.includes(operation)) {
    return false;
  }
  const commands = (twins.commands ??= {});
  const previous = commands[topic];
  let command: any;
  try {
    command = payload.trim() === "" ? undefined : JSON.parse(payload);
  } catch {
    command = undefined;
  }
  const status = typeof command?.status === "string" ? command.status : "";
  if (
    status === "failed" &&
    command?.deployment?.key === settings.key &&
    typeof command?.reason === "string"
  ) {
    twins.failure = {
      version:
        command.deployment.version !== undefined
          ? `${command.deployment.version}`
          : undefined,
      reason: command.reason,
    };
  }
  if (!status || FINAL_STATUSES.includes(status)) {
    if (!previous) {
      return false;
    }
    delete commands[topic];
    return true;
  }
  const deployment = command?.deployment;
  commands[topic] = {
    operation,
    cmdId,
    status,
    changedAt:
      previous && previous.status === status
        ? previous.changedAt
        : time.toISOString(),
    deploymentKey:
      typeof deployment?.key === "string" ? deployment.key : undefined,
    version:
      deployment?.version !== undefined ? `${deployment.version}` : undefined,
  };
  return !previous || previous.status !== status;
}

export function activeCommands(twins: Twins): ActiveCommand[] {
  return Object.values(twins.commands ?? {});
}

/**
 * The device is busy if a deployment is in progress, or another operation which
 * could conflict with a deployment is being executed
 */
export function isBusy(
  twins: Twins,
  poll: PollState,
  settings: Settings,
  now: number,
): boolean {
  const { state } = twins;
  if (state?.state && IN_FLIGHT_STATES.includes(state.state)) {
    const stale =
      state.state === "ASSIGNED" &&
      isStaleAssignment(state, poll, now, settings);
    if (!stale) {
      return true;
    }
  }
  return activeCommands(twins).length > 0;
}

export type ScheduleOutcome =
  | "not_available"
  | "in_sync"
  | "in_progress"
  | "device_busy"
  | "stuck"
  | "preview"
  | "not_created"
  | "request_error";

export type Decision =
  | { action: "create"; version: string }
  | { action: "assigned"; version: string }
  | {
      action: "schedule";
      outcome: ScheduleOutcome;
      reason: string;
      version?: string;
      // Status of the deployment or operation which is in progress
      state?: string;
      // Operation which is in progress (if it is not this deployment)
      operation?: string;
      // Last status change of the deployment or operation in progress
      since?: string;
    }
  | { action: "backoff"; reason: string }
  | { action: "give-up"; version: string; reason: string };

function isStaleAssignment(
  state: DeploymentState,
  poll: PollState,
  now: number,
  settings: Settings,
): boolean {
  const since = Date.parse(state.updatedAt ?? poll.requestedAt ?? "");
  return isNaN(since) || now - since > settings.assignedTimeout;
}

function isPreview(settings: Settings): boolean {
  return settings.targetState.toLowerCase() !== "active";
}

/**
 * Decide what to do with the result of an evaluate request
 */
export function decide(
  evaluation: Evaluation,
  phase: Phase,
  twins: Twins,
  poll: PollState,
  settings: Settings,
  now: number,
): Decision {
  if (!evaluation.ok) {
    if (!isRetryable(evaluation)) {
      return {
        action: "schedule",
        outcome: "request_error",
        reason: `request failed: ${evaluation.error ?? ""}`,
      };
    }
    return { action: "backoff", reason: evaluation.error ?? "request failed" };
  }
  if (!evaluation.available || evaluation.version === undefined) {
    return {
      action: "schedule",
      outcome: "not_available",
      reason: `not available: ${evaluation.reason ?? "unknown"}`,
    };
  }
  const version = evaluation.version;

  if (isPreview(settings) && !settings.allowPreview) {
    return {
      action: "schedule",
      outcome: "preview",
      reason: `preview of ${settings.targetState}: ${version}`,
      version,
    };
  }

  // The operation was requested
  if (phase === "create") {
    return { action: "assigned", version };
  }
  if (phase === "server") {
    return evaluation.operationCreated === true
      ? { action: "assigned", version }
      : {
          action: "schedule",
          outcome: "not_created",
          reason: `no operation created for ${version}`,
          version,
        };
  }

  // Dry run
  const { membership, state } = twins;
  const busy = inProgress(twins, poll, settings, now);
  if (busy) {
    return busy;
  }
  if (membership?.version === version) {
    return {
      action: "schedule",
      outcome: "in_sync",
      reason: `in sync: ${version}`,
      version,
    };
  }
  const attempts = poll.version === version ? (poll.attempts ?? 0) : 0;
  if (attempts >= settings.maxAttempts) {
    return {
      action: "give-up",
      version,
      reason: `${attempts} attempts failed for ${version}`,
    };
  }
  return { action: "create", version };
}

/**
 * Return a decision if a deployment or another operation is in progress. A new
 * operation is never requested while the device is busy, however long it takes.
 * If nothing changed for longer than in_progress_timeout, it is reported as stuck
 */
function inProgress(
  twins: Twins,
  poll: PollState,
  settings: Settings,
  now: number,
): Decision | undefined {
  const { key } = settings;
  const { state } = twins;
  const commands = activeCommands(twins);
  const own = commands.find((c) => c.deploymentKey === key);
  const other = commands.find((c) => c.deploymentKey !== key);

  let decision: Decision | undefined;
  if (state?.state && IN_FLIGHT_STATES.includes(state.state)) {
    const stale =
      state.state === "ASSIGNED" &&
      isStaleAssignment(state, poll, now, settings);
    if (!stale) {
      decision = {
        action: "schedule",
        outcome: "in_progress",
        reason: `in progress: ${state.version} (${state.state})`,
        version: state.version,
        state: state.state,
        since: state.updatedAt,
      };
    }
  }
  // The command of this deployment is running, even if the deployment state
  // is not known (e.g. c8y-deploy-status is not installed)
  if (!decision && own) {
    decision = {
      action: "schedule",
      outcome: "in_progress",
      reason: `in progress: ${own.version} (${own.operation} ${own.status})`,
      version: own.version,
      state: own.status,
      since: own.changedAt,
    };
  }
  if (!decision && other) {
    decision = {
      action: "schedule",
      outcome: "device_busy",
      reason: `device busy: ${other.operation} ${other.cmdId} (${other.status})`,
      state: other.status,
      operation: `${other.operation} ${other.cmdId}`,
      since: other.changedAt,
    };
  }
  if (!decision || decision.action !== "schedule") {
    return decision;
  }

  const since = Date.parse(decision.since ?? "");
  if (
    settings.inProgressTimeout > 0 &&
    !isNaN(since) &&
    now - since > settings.inProgressTimeout
  ) {
    return {
      ...decision,
      outcome: "stuck",
      reason: `no progress since ${decision.since}: ${decision.reason}`,
    };
  }
  return decision;
}

/**
 * Return the c8y_Deployment_<key> fragment to publish, or undefined if unchanged.
 * The version (the last successfully applied version) is never changed here
 */
export function membershipUpdate(
  current: DeploymentMembership | undefined,
  priority: number | undefined,
  key: string,
): DeploymentMembership | undefined {
  if (current && (priority === undefined || current.priority === priority)) {
    return undefined;
  }
  if (!current && priority === undefined) {
    return { deploymentKey: key };
  }
  return { ...(current ?? {}), deploymentKey: key, priority };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventOutcome =
  | ScheduleOutcome
  | "new_version"
  | "operation_requested"
  | "request_failed"
  | "gave_up"
  | "request_lost"
  | "completed"
  | "failed";

export interface PollEvent {
  outcome: EventOutcome;
  text: string;
  fields: Record<string, unknown>;
}

// Outcomes which are always followed by another event, so they are only
// published with events = "all"
const DETAIL_OUTCOMES: EventOutcome[] = ["new_version"];

const REASONS: Record<string, string> = {
  "threshold.exceeded": "the rollout has not reached this device yet",
  "selectionCriteria.noMatch":
    "the device does not match the selection criteria of the deployment",
  "deployment.paused": "the deployment is paused",
  "deployment.stopped": "the deployment is stopped",
};

export function describeReason(reason: string | undefined): string {
  return (reason && REASONS[reason]) ?? reason ?? "unknown reason";
}

export function formatDuration(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) {
    return `${ms / 3_600_000}h`;
  }
  if (ms >= 60_000 && ms % 60_000 === 0) {
    return `${ms / 60_000}m`;
  }
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

function errorHint(status: number | undefined): string {
  switch (status) {
    case 400:
      return "the request or the device context is invalid";
    case 403:
      return "the device is not allowed to access the deployment service";
    case 404:
      return "the deployment or target state does not exist";
    default:
      return "the request was rejected";
  }
}

function shortError(error: string | undefined): string {
  const text = (error ?? "").replace(/\s+/g, " ").trim();
  return text.length > 300 ? `${text.substring(0, 300)}...` : text;
}

export interface EventInfo {
  twins: Twins;
  attempts?: number;
  nextPollAt?: number; // ms
  now: number; // ms
}

/**
 * Describe the result of an evaluation, so that it can be explained to the
 * user (e.g. in the Cumulocity device events)
 */
export function describeEvent(
  decision: Decision,
  evaluation: Evaluation,
  phase: Phase,
  settings: Settings,
  info: EventInfo,
): PollEvent {
  const { key, targetState, maxAttempts } = settings;
  const deployment = `deployment ${key}`;
  const fields: Record<string, unknown> = {
    deploymentKey: key,
    targetState,
  };
  if (evaluation.priority !== undefined) {
    fields.priority = evaluation.priority;
  }
  if (!evaluation.ok) {
    fields.status = evaluation.status;
    fields.error = shortError(evaluation.error);
  }
  if (info.nextPollAt !== undefined) {
    fields.nextPollAt = new Date(info.nextPollAt).toISOString();
  }

  const event = (
    outcome: EventOutcome,
    text: string,
    extra = {},
  ): PollEvent => ({
    outcome,
    text,
    fields: { ...fields, outcome, ...extra },
  });

  switch (decision.action) {
    case "create":
      return event(
        "new_version",
        `Version ${decision.version} of ${deployment} is available`,
        { version: decision.version },
      );
    case "assigned":
      return event(
        "operation_requested",
        `Requested the operation to install version ${decision.version} of ${deployment} (attempt ${info.attempts ?? 1} of ${maxAttempts})`,
        { version: decision.version, attempts: info.attempts ?? 1 },
      );
    case "give-up":
      return event(
        "gave_up",
        `Version ${decision.version} of ${deployment} failed ${info.attempts ?? maxAttempts} times. It is not requested again until a new version is available`,
        { version: decision.version, attempts: info.attempts },
      );
    case "backoff": {
      const retry =
        info.nextPollAt !== undefined
          ? `, retrying in ${formatDuration(info.nextPollAt - info.now)}`
          : "";
      const status = evaluation.status ? ` (HTTP ${evaluation.status})` : "";
      return event(
        "request_failed",
        `Could not check ${deployment}${status}${retry}`,
      );
    }
    case "schedule":
    default:
      break;
  }

  const { version } = decision;
  switch (decision.outcome) {
    case "not_available": {
      const reason = describeReason(evaluation.reason);
      return event(
        "not_available",
        phase === "dry" || phase === "server"
          ? `No update available for ${deployment}: ${reason}`
          : `No operation requested for ${deployment}: ${reason}`,
        { reason: evaluation.reason },
      );
    }
    case "in_sync":
      return event(
        "in_sync",
        `The device is up to date with version ${version} of ${deployment}`,
        { version },
      );
    case "in_progress": {
      const { state } = decision;
      return event(
        "in_progress",
        `Version ${version} of ${deployment} is already being installed${state ? ` (${state})` : ""}`,
        { version, state, since: decision.since },
      );
    }
    case "device_busy":
      return event(
        "device_busy",
        `Another operation is in progress on the device (${decision.operation}: ${decision.state}). No operation is requested for ${deployment} until it is finished`,
        {
          operation: decision.operation,
          state: decision.state,
          since: decision.since,
        },
      );
    case "stuck": {
      const what = decision.operation
        ? `Operation ${decision.operation}`
        : `Version ${version} of ${deployment}`;
      return event(
        "stuck",
        `${what} has not progressed for more than ${formatDuration(settings.inProgressTimeout)} (${decision.state} since ${decision.since}). Please check the device`,
        {
          version,
          operation: decision.operation,
          state: decision.state,
          since: decision.since,
        },
      );
    }
    case "preview":
      return event(
        "preview",
        `Version ${version} of ${deployment} is available for target state ${targetState}. No operation is requested for preview target states`,
        { version },
      );
    case "not_created":
      return event(
        "not_created",
        `The server did not create an operation for version ${version} of ${deployment}`,
        { version },
      );
    case "request_error":
    default:
      return event(
        "request_error",
        `Could not check ${deployment} (HTTP ${evaluation.status ?? "error"}): ${errorHint(evaluation.status)}`,
      );
  }
}

export function eventSignature(event: PollEvent): string {
  const { outcome, fields } = event;
  // Being in sync right after a successful installation is not news
  if (outcome === "completed") {
    return ["in_sync", fields.version ?? "", "", "", "", "", ""].join("|");
  }
  return [
    outcome,
    fields.version ?? "",
    fields.reason ?? "",
    fields.state ?? "",
    fields.operation ?? "",
    fields.status ?? "",
    fields.attempts ?? "",
  ].join("|");
}

// Results reported before the flow started are not reported again (they were
// either reported already, or happened before the flow was installed)
const RESULT_GRACE_MS = 60_000;

/**
 * Describe the result of a deployment (published by c8y-deploy-status), or
 * return undefined if it was already reported or is not a new result
 */
export function describeResult(
  state: DeploymentState | undefined,
  twins: Twins,
  poll: PollState,
  settings: Settings,
  startedAt: number,
): { event: PollEvent; signature: string } | undefined {
  if (!state || (state.state !== "SUCCESS" && state.state !== "FAILURE")) {
    return undefined;
  }
  const signature = `${state.version}|${state.state}|${state.updatedAt ?? ""}`;
  if (signature === poll.reportedResult) {
    return undefined;
  }
  const updatedAt = Date.parse(state.updatedAt ?? "");
  if (isNaN(updatedAt) || updatedAt < startedAt - RESULT_GRACE_MS) {
    return undefined;
  }

  const { key, targetState, maxAttempts } = settings;
  const version = state.version;
  const fields: Record<string, unknown> = {
    deploymentKey: key,
    targetState,
    version,
    state: state.state,
  };
  if (state.state === "SUCCESS") {
    return {
      signature,
      event: {
        outcome: "completed",
        text: `Version ${version} of deployment ${key} was installed successfully`,
        fields: { ...fields, outcome: "completed" },
      },
    };
  }

  const reason =
    typeof state.error === "string"
      ? state.error
      : twins.failure?.version === version
        ? twins.failure?.reason
        : undefined;
  const attempts = poll.version === version ? poll.attempts : undefined;
  let next = "";
  if (attempts !== undefined) {
    next =
      attempts < maxAttempts
        ? `. It is requested again at the next poll (attempt ${attempts + 1} of ${maxAttempts})`
        : `. No further attempts are made (${attempts} of ${maxAttempts})`;
  }
  return {
    signature,
    event: {
      outcome: "failed",
      text: `Installation of version ${version} of deployment ${key} failed${reason ? `: ${shortError(reason)}` : ""}${next}`,
      fields: {
        ...fields,
        outcome: "failed",
        reason: reason ? shortError(reason) : undefined,
        attempts,
      },
    },
  };
}

/**
 * Return the event message to publish, if any, and record its signature in the
 * poll state. With events = "changes", an event is only published if the
 * outcome differs from the previous one
 */
export function eventMessage(
  event: PollEvent,
  poll: PollState,
  settings: Settings,
  time: Date,
): Message | undefined {
  if (settings.events === "off") {
    return undefined;
  }
  if (settings.events === "changes") {
    if (DETAIL_OUTCOMES.includes(event.outcome)) {
      return undefined;
    }
    const signature = eventSignature(event);
    if (signature === poll.lastEvent) {
      return undefined;
    }
    poll.lastEvent = signature;
  } else {
    poll.lastEvent = eventSignature(event);
  }
  const fields = Object.fromEntries(
    Object.entries(event.fields).filter(([, v]) => v !== undefined),
  );
  return {
    time,
    topic: topics(settings).event,
    payload: JSON.stringify({
      text: event.text,
      time: time.toISOString(),
      ...fields,
    }),
    mqtt: { qos: 1 },
  };
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

interface Cache {
  startedAt?: number;
  request?: RequestSpec;
  requestSeen?: boolean;
  poll?: PollState;
  twins: Twins;
  contextFile?: unknown;
  contextSeen?: boolean;
  detected?: Record<string, string>;
  counter: number;
}

// The flow context stores copies (JSON values), so the cache is loaded once per
// call and saved again when done
function loadCache(context: FlowContext): Cache {
  const cache = context.flow.get("cache");
  if (!cache || typeof cache !== "object") {
    return { twins: {}, counter: 0 };
  }
  return { ...cache, twins: cache.twins ?? {}, counter: cache.counter ?? 0 };
}

function saveCache(context: FlowContext, cache: Cache): void {
  context.flow.set("cache", cache);
}

function nowOf(time: Date | undefined): number {
  const t = time instanceof Date ? time.getTime() : Date.parse(`${time}`);
  return isNaN(t) ? Date.now() : t;
}

function parseJson(message: Message): any {
  const text = decodePayload(message.payload).trim();
  if (text === "") {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function retained(topic: string, payload: string, time: Date): Message {
  return { time, topic, payload, mqtt: { retain: true, qos: 1 } };
}

/**
 * Phase of a regular poll. In server mode the server decides whether to create
 * an operation, so a plain check is done while the device is busy
 */
function regularPhase(cache: Cache, settings: Settings, now: number): Phase {
  if (settings.mode !== "server") {
    return "dry";
  }
  return isBusy(cache.twins, cache.poll ?? {}, settings, now)
    ? "dry"
    : "server";
}

function newRequest(
  cache: Cache,
  settings: Settings,
  context: FlowContext,
  phase: Phase,
  due: number,
  now: number,
  expiring = phase === "create",
): RequestSpec {
  cache.counter += 1;
  return {
    due: Math.floor(due / 1000),
    expires: expiring ? Math.floor((now + CREATE_TTL_MS) / 1000) : 0,
    id: `${now.toString(36)}-${cache.counter}`,
    path: buildPath(settings, phase),
    body: buildBody(
      context.config?.context,
      cache.contextFile,
      context.config?.priority,
      settings.detectArch ? cache.detected : undefined,
    ),
  };
}

function publishRequest(
  cache: Cache,
  spec: RequestSpec,
  settings: Settings,
  time: Date,
): Message {
  cache.request = spec;
  cache.requestSeen = true;
  if (settings.debug) {
    console.log("Scheduled request", {
      due: new Date(spec.due * 1000).toISOString(),
      path: spec.path,
      body: spec.body,
    });
  }
  return retained(topics(settings).request, formatRequest(spec), time);
}

function publishPollState(
  cache: Cache,
  poll: PollState,
  settings: Settings,
  time: Date,
): Message {
  cache.poll = poll;
  return retained(topics(settings).state, JSON.stringify(poll), time);
}

/**
 * Make sure a request is scheduled, and that it matches the current config
 * (e.g. after the params or the context file changed)
 */
function reconcile(
  cache: Cache,
  context: FlowContext,
  settings: Settings,
  time: Date,
): Message[] {
  const now = nowOf(time);
  cache.startedAt ??= now;
  const elapsed = now - cache.startedAt;

  // Wait for the retained messages and the context file
  if (elapsed < STARTUP_GRACE_MS) {
    return [];
  }
  const waiting =
    (settings.waitForContext && !cache.contextSeen) ||
    (settings.detectArch && cache.detected === undefined);
  if (waiting && elapsed < CONTEXT_WAIT_MS) {
    return [];
  }

  const { request, poll = {} } = cache;
  if (!request) {
    const phase = regularPhase(cache, settings, now);
    const due = startupDue(now, settings);
    return [
      publishRequest(
        cache,
        newRequest(cache, settings, context, phase, due, now),
        settings,
        time,
      ),
    ];
  }

  // The request was executed, but its result never arrived (e.g. the flow was
  // restarted). Schedule a new dry run, as it is unknown if an operation was created.
  // After a restart, poll.sh first gets a chance to execute an overdue request
  const answered = poll.lastRequestId === request.id;
  const expected = Math.max(request.due * 1000, cache.startedAt);
  if (!answered && now > expected + RESPONSE_TIMEOUT_MS) {
    const phase = regularPhase(cache, settings, now);
    const next = newRequest(cache, settings, context, phase, now, now);
    const messages: Message[] = [];
    const updated: PollState = { ...poll };
    const event = eventMessage(
      {
        outcome: "request_lost",
        text: `No result was received for the last request of deployment ${settings.key}. Checking again`,
        fields: {
          deploymentKey: settings.key,
          targetState: settings.targetState,
          outcome: "request_lost",
        },
      },
      updated,
      settings,
      time,
    );
    if (event) {
      messages.push(event, publishPollState(cache, updated, settings, time));
    }
    messages.push(publishRequest(cache, next, settings, time));
    return messages;
  }

  // Update a pending request if the config or the busy state changed. Only
  // before it is due, as poll.sh might already be executing it
  if (!answered && now < request.due * 1000) {
    const current = phaseOf(request.path, settings);
    const phase =
      current === "create" ? current : regularPhase(cache, settings, now);
    const expected = newRequest(
      cache,
      settings,
      context,
      phase,
      request.due * 1000,
      now,
    );
    if (expected.path !== request.path || expected.body !== request.body) {
      expected.expires = request.expires;
      return [publishRequest(cache, expected, settings, time)];
    }
  }
  return [];
}

function handleResult(
  cache: Cache,
  evaluation: Evaluation,
  context: FlowContext,
  settings: Settings,
  time: Date,
): Message[] {
  const now = nowOf(time);
  const request = cache.request;
  if (!request || request.id !== evaluation.id) {
    if (settings.debug) {
      console.log("Ignoring result of an old request", { id: evaluation.id });
    }
    return [];
  }

  const t = topics(settings);
  const phase = phaseOf(request.path, settings);
  const poll: PollState = {
    ...(cache.poll ?? {}),
    lastRequestId: request.id,
  };
  const messages: Message[] = [];

  const decision = decide(evaluation, phase, cache.twins, poll, settings, now);
  if (settings.debug) {
    console.log("Deployment evaluation", { phase, evaluation, decision });
  }

  if (evaluation.ok) {
    poll.lastPollAt = time.toISOString();
    poll.failures = 0;
    if (evaluation.priority !== undefined) {
      poll.priority = evaluation.priority;
    }
    const membership = membershipUpdate(
      cache.twins.membership,
      evaluation.priority,
      settings.key,
    );
    if (membership) {
      cache.twins.membership = membership;
      messages.push(retained(t.membership, JSON.stringify(membership), time));
    }
  }

  let next: RequestSpec;
  const regular = regularPhase(cache, settings, now);
  switch (decision.action) {
    case "create":
      // In server mode (after a check while the device was busy), the server decides
      next = newRequest(
        cache,
        settings,
        context,
        settings.mode === "server" ? "server" : "create",
        now,
        now,
        true,
      );
      break;

    case "assigned": {
      const attempts =
        poll.version === decision.version ? (poll.attempts ?? 0) + 1 : 1;
      poll.version = decision.version;
      poll.attempts = attempts;
      poll.requestedAt = time.toISOString();
      const state: DeploymentState = {
        deploymentKey: settings.key,
        version: decision.version,
        state: "ASSIGNED",
        updatedAt: time.toISOString(),
      };
      cache.twins.state = state;
      messages.push(retained(t.deploymentState, JSON.stringify(state), time));
      next = newRequest(
        cache,
        settings,
        context,
        regular,
        nextSlot(now, settings),
        now,
      );
      break;
    }

    case "backoff": {
      poll.failures = (cache.poll?.failures ?? 0) + 1;
      console.warn("Deployment evaluation failed, retrying", {
        reason: decision.reason,
        failures: poll.failures,
      });
      // Never repeat an operation request, as the operation might have been created
      next = newRequest(
        cache,
        settings,
        context,
        regular,
        now + backoffDelay(poll.failures, settings),
        now,
      );
      break;
    }

    case "give-up":
      console.warn("Not requesting the deployment again", {
        reason: decision.reason,
      });
      next = newRequest(
        cache,
        settings,
        context,
        regular,
        nextSlot(now, settings),
        now,
      );
      break;

    case "schedule":
    default:
      if (!evaluation.ok) {
        console.error("Deployment evaluation failed", {
          reason: decision.reason,
        });
      }
      next = newRequest(
        cache,
        settings,
        context,
        regular,
        nextSlot(now, settings),
        now,
      );
      break;
  }

  const event = eventMessage(
    describeEvent(decision, evaluation, phase, settings, {
      twins: cache.twins,
      attempts: poll.attempts,
      nextPollAt: next.due * 1000,
      now,
    }),
    poll,
    settings,
    time,
  );
  if (event) {
    messages.push(event);
  }

  messages.push(publishPollState(cache, poll, settings, time));
  messages.push(publishRequest(cache, next, settings, time));
  return messages;
}

export function onStartup(time: Date, context: FlowContext): Message[] {
  const cache = loadCache(context);
  cache.startedAt = nowOf(time);
  saveCache(context, cache);
  return [];
}

export function onInterval(time: Date, context: FlowContext): Message[] {
  const settings = getSettings(context.config);
  if (!isValidKey(settings.key)) {
    return [];
  }
  const cache = loadCache(context);
  const messages = reconcile(cache, context, settings, time);
  saveCache(context, cache);
  return messages;
}

export function onMessage(message: Message, context: FlowContext): Message[] {
  const settings = getSettings(context.config);
  if (!isValidKey(settings.key)) {
    console.error("Invalid deployment_key", { key: settings.key });
    return [];
  }
  const cache = loadCache(context);
  const time = message.time instanceof Date ? message.time : new Date();
  const messages = processMessage(cache, message, context, settings, time);
  saveCache(context, cache);
  return messages;
}

/**
 * Report the result of a deployment once it is finished
 */
function reportResult(cache: Cache, settings: Settings, time: Date): Message[] {
  if (settings.events === "off") {
    return [];
  }
  cache.startedAt ??= nowOf(time);
  const poll: PollState = { ...(cache.poll ?? {}) };
  const result = describeResult(
    cache.twins.state,
    cache.twins,
    poll,
    settings,
    cache.startedAt,
  );
  if (!result) {
    return [];
  }
  poll.reportedResult = result.signature;
  const messages: Message[] = [];
  const event = eventMessage(result.event, poll, settings, time);
  if (event) {
    messages.push(event);
  }
  messages.push(publishPollState(cache, poll, settings, time));
  return messages;
}

function processMessage(
  cache: Cache,
  message: Message,
  context: FlowContext,
  settings: Settings,
  time: Date,
): Message[] {
  const t = topics(settings);
  switch (message.topic) {
    case t.request:
      cache.request = parseRequest(decodePayload(message.payload));
      cache.requestSeen = true;
      return reconcile(cache, context, settings, time);
    case t.state:
      cache.poll = parseJson(message) ?? {};
      return [];
    case t.membership:
      cache.twins.membership = parseJson(message);
      return [];
    case t.deploymentState: {
      cache.twins.state = parseJson(message);
      const messages = reportResult(cache, settings, time);
      if (settings.mode === "server") {
        messages.push(...reconcile(cache, context, settings, time));
      }
      return messages;
    }
    case t.context: {
      const text = decodePayload(message.payload).trim();
      const previous = JSON.stringify(cache.contextFile ?? null);
      cache.contextFile = text === "" ? undefined : text;
      cache.contextSeen = true;
      if (previous !== JSON.stringify(cache.contextFile ?? null)) {
        return reconcile(cache, context, settings, time);
      }
      return [];
    }
    case t.detect: {
      const previous = JSON.stringify(cache.detected ?? null);
      cache.detected = detectedContext(decodePayload(message.payload));
      if (previous !== JSON.stringify(cache.detected)) {
        return reconcile(cache, context, settings, time);
      }
      return [];
    }
    case t.response: {
      const evaluation = parseEvaluation(decodePayload(message.payload));
      if (!evaluation) {
        console.warn("Ignoring invalid poll result");
        return [];
      }
      return handleResult(cache, evaluation, context, settings, time);
    }
    default:
      if (
        trackCommand(
          cache.twins,
          message.topic,
          decodePayload(message.payload),
          settings,
          time,
        ) &&
        settings.mode === "server"
      ) {
        return reconcile(cache, context, settings, time);
      }
      return [];
  }
}
