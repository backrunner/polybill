export interface ScriptedStep {
  readonly method: string;
  readonly url: string;
  readonly response?: Response;
  readonly error?: Error;
}

export interface ScriptedFetch {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: readonly Request[];
  assertConsumed(): void;
}

export function createScriptedFetch(script: readonly ScriptedStep[]): ScriptedFetch {
  const remaining = [...script];
  const requests: Request[] = [];
  return {
    requests,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      const step = remaining.shift();
      if (step === undefined)
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      if (request.method !== step.method || request.url !== step.url) {
        throw new Error(
          `Expected ${step.method} ${step.url}, received ${request.method} ${request.url}`,
        );
      }
      if (step.error !== undefined) throw step.error;
      if (step.response === undefined) throw new Error("Scripted step has no response");
      return step.response.clone();
    },
    assertConsumed() {
      if (remaining.length !== 0)
        throw new Error(`${remaining.length} scripted requests were not consumed`);
    },
  };
}
