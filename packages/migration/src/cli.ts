import type { AdoptionMode } from "./types.js";

export type MigrationCliCommand =
  | { readonly action: "analyze" | "plan"; readonly format: "json" | "text" }
  | {
      readonly action: "dry-run" | "apply" | "resume" | "verify" | "cutover";
      readonly planId: string;
      readonly format: "json" | "text";
      readonly confirmed: boolean;
    }
  | {
      readonly action: "cutback";
      readonly planId: string;
      readonly mode: "observe_only" | "shadow_read";
      readonly format: "json" | "text";
      readonly confirmed: boolean;
    };

export interface MigrationCliBackend {
  execute(command: MigrationCliCommand): Promise<unknown>;
}

export interface MigrationCliIo {
  write(value: string): void;
}

export async function runMigrationCli(
  argv: readonly string[],
  backend: MigrationCliBackend,
  io: MigrationCliIo,
): Promise<number> {
  try {
    const command = parseMigrationCli(argv);
    requireConfirmation(command);
    const result = await backend.execute(command);
    io.write(
      command.format === "json" ? `${JSON.stringify(result, null, 2)}\n` : `${text(result)}\n`,
    );
    return 0;
  } catch (error) {
    io.write(`${error instanceof Error ? error.message : "Migration command failed"}\n`);
    return 1;
  }
}

export function parseMigrationCli(argv: readonly string[]): MigrationCliCommand {
  const [action, ...arguments_] = argv;
  const format = option(arguments_, "--format") ?? "text";
  if (format !== "json" && format !== "text") throw new TypeError("--format must be json or text");
  if (action === "analyze" || action === "plan") return { action, format };
  if (!["dry-run", "apply", "resume", "verify", "cutover", "cutback"].includes(action ?? ""))
    throw new TypeError("Unknown migration command");
  const planId = option(arguments_, "--plan");
  if (planId === undefined || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/.test(planId))
    throw new TypeError("--plan is required and must be a stable plan ID");
  const confirmed = arguments_.includes("--yes");
  if (action === "cutback") {
    const mode = option(arguments_, "--mode") as AdoptionMode | undefined;
    if (mode !== "observe_only" && mode !== "shadow_read")
      throw new TypeError("cutback --mode must be observe_only or shadow_read");
    return { action, planId, mode, format, confirmed };
  }
  return {
    action: action as "dry-run" | "apply" | "resume" | "verify" | "cutover",
    planId,
    format,
    confirmed,
  };
}

function requireConfirmation(command: MigrationCliCommand): void {
  if (
    (command.action === "apply" || command.action === "cutover" || command.action === "cutback") &&
    !command.confirmed
  )
    throw new TypeError(`${command.action} requires --yes`);
}

function option(values: readonly string[], name: string): string | undefined {
  const index = values.indexOf(name);
  if (index < 0) return undefined;
  const value = values[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new TypeError(`${name} requires a value`);
  return value;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "ok";
  return JSON.stringify(value);
}
