export interface Timestamp {
  seconds: number;
  nanoseconds: number;
}

export interface Flow {
  onMessage(message: Message, config: any): Message[];
  onInterval?: (timestamp: Timestamp, config: any) => Message[];
  onConfigUpdate?: (message: Message, config: any) => void;
}

export interface Message {
  timestamp: Timestamp;
  topic: string;
  payload: string | Uint8Array<ArrayBufferLike>;
  retain?: boolean;
}

export function mockGetTime(time: number = Date.now()): Timestamp {
  const seconds = time / 1000;
  const whole_seconds = Math.trunc(seconds);
  const nanoseconds = (seconds - whole_seconds) * 10e9;
  return {
    seconds: whole_seconds,
    nanoseconds,
  };
}

export function Run(module: Flow, messages: Message[], config: any): Message[] {
  const outputMessages: Message[] = [];
  messages.forEach((message) => {
    const timestamp = mockGetTime();
    message.timestamp = timestamp;
    const output = module.onMessage(message, config);
    outputMessages.push(...output);
    if (output.length > 0) {
      console.log(JSON.stringify(output));
    }
  });

  if (module.onInterval) {
    const output = module.onInterval(mockGetTime(), config);
    outputMessages.push(...output);
    console.log(JSON.stringify(output));
  }
  return outputMessages;
}
