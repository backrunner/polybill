import type { IdGenerator, Logger } from "@polybill/application";
import { parseIsoDateTime, type Clock, type IsoDateTime } from "@polybill/core";

export class VirtualClock implements Clock {
  #now: IsoDateTime;

  constructor(start: string) {
    this.#now = parseIsoDateTime(start);
  }

  now(): IsoDateTime {
    return this.#now;
  }

  advance(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds))
      throw new RangeError("Clock advance must be a safe integer");
    this.#now = parseIsoDateTime(new Date(Date.parse(this.#now) + milliseconds).toISOString());
  }
}

export class DeterministicIds implements IdGenerator {
  #sequence = 0;
  next(prefix: string): string {
    return `${prefix}_${String(++this.#sequence).padStart(12, "0")}`;
  }
}

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
