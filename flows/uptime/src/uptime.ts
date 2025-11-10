export type Status = "online" | "offline" | "uninitialized";

interface StatusChange {
  timestamp: number;
  status: Status;
}

export class UptimeTracker {
  private history: StatusChange[] = [];
  private windowSizeMs: number;

  constructor(windowSizeMinutes: number) {
    this.windowSizeMs = windowSizeMinutes * 60 * 1000;
  }

  updateStatus(status: Status, timestamp?: number) {
    const last = this.history[this.history.length - 1];
    if (!last || last.status !== status) {
      if (timestamp) {
        this.history.push({ status, timestamp });
      }
    }
  }

  /**
   * Returns the uptime percentage, the total duration (ms) of the recorded history,
   * and the number of times the device was disconnected (offline interruptions).
   * If the observed duration is less than the window size, the percentage is calculated over the observed duration.
   * @param currentTime The current time in ms
   * @returns { percentage: number, durationMs: number, interruptions: number }
   */
  getUptimePercentage(currentTime: number = Date.now()): {
    percentage: number;
    durationMs: number;
    interruptions: number;
  } {
    const startTime = currentTime - this.windowSizeMs;
    const relevantHistory = this.getWindowedHistory(startTime, currentTime);

    if (relevantHistory.length === 0)
      return { percentage: 0, durationMs: 0, interruptions: 0 };

    let totalOnline = 0;
    let historyStart: number | undefined = undefined;
    let historyEnd = currentTime;
    let interruptions = 0;

    // Find the first real event (not a synthetic one at window start)
    for (let i = 0; i < relevantHistory.length; i++) {
      if (
        i > 0 ||
        relevantHistory[0].timestamp !== startTime ||
        (relevantHistory[0].status !== "offline" &&
          relevantHistory[0].status !== "uninitialized")
      ) {
        historyStart = relevantHistory[i].timestamp;
        break;
      }
    }
    if (historyStart === undefined) historyStart = relevantHistory[0].timestamp;

    for (let i = 0; i < relevantHistory.length - 1; i++) {
      const curr = relevantHistory[i];
      const next = relevantHistory[i + 1];
      if (curr.status === "online") {
        totalOnline += next.timestamp - curr.timestamp;
      }
      if (curr.status === "online" && next.status === "offline") {
        interruptions++;
      }
    }

    // Handle case where device is still online until now
    const last = relevantHistory[relevantHistory.length - 1];
    if (last && last.status === "online") {
      totalOnline += currentTime - last.timestamp;
    }

    const durationMs = historyEnd - historyStart;
    const denominator = durationMs > 0 ? durationMs : this.windowSizeMs;
    return {
      percentage: Math.min(100, (totalOnline / denominator) * 100),
      durationMs,
      interruptions,
    };
  }

  getInterruptionCount(currentTime: number = Date.now()): number {
    const startTime = currentTime - this.windowSizeMs;
    const relevantHistory = this.getWindowedHistory(startTime, currentTime);

    let count = 0;
    for (let i = 1; i < relevantHistory.length; i++) {
      if (
        relevantHistory[i - 1].status === "online" &&
        relevantHistory[i].status === "offline"
      ) {
        count++;
      }
    }

    return count;
  }

  /**
   * Get the current status
   * @returns status Current status
   */
  currentStatus(): Status {
    if (this.history.length > 0) {
      return this.history[this.history.length - 1].status;
    }
    return "uninitialized";
  }

  /**
   * Reset the tracker with a new window size and initial state.
   * @param windowSizeMinutes New window size in minutes
   * @param initialStatus Initial status ("online" or "offline")
   * @param initialTimestamp Optional initial timestamp (defaults to Date.now())
   */
  reset(
    windowSizeMinutes: number,
    initialStatus: Status,
    initialTimestamp?: number,
  ) {
    this.windowSizeMs = windowSizeMinutes * 60 * 1000;
    this.history = [
      {
        status: initialStatus,
        timestamp: initialTimestamp ?? Date.now(),
      },
    ];
  }

  /**
   * Returns true if the tracker is in the uninitialized state.
   * This is true if the first status is "uninitialized" or if the history is empty.
   */
  isUninitialized(): boolean {
    if (this.history.length === 0) return true;
    return this.history[0].status === "uninitialized";
  }

  private getWindowedHistory(
    startTime: number,
    endTime: number,
  ): StatusChange[] {
    const history: StatusChange[] = [];
    let i = this.history.findIndex((e) => e.timestamp >= startTime);

    if (i === -1) i = this.history.length;

    // Add the last known status before the window if needed
    if (i > 0 && this.history[i - 1].timestamp < startTime) {
      history.push({
        status: this.history[i - 1].status,
        timestamp: startTime,
      });
    } else if (
      i === 0 &&
      this.history.length > 0 &&
      this.history[0].timestamp > startTime
    ) {
      // Add default offline status if no prior status exists
      history.push({ status: "offline", timestamp: startTime });
    }

    // Add all entries inside the window
    for (
      ;
      i < this.history.length && this.history[i].timestamp <= endTime;
      i++
    ) {
      history.push(this.history[i]);
    }

    return history;
  }
}
