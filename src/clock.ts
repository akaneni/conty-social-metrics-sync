export interface Clock {
  now(): Date;
}

export type Sleep = (ms: number) => Promise<void>;

export const systemClock: Clock = { now: () => new Date() };

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
