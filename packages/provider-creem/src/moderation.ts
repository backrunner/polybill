import {
  invalid,
  moderationDecision,
  object,
  stringField,
  type ModerationProvider,
} from "@polybill/adapter-kit";
import { PolybillError } from "@polybill/core";
import { creemRequest } from "./client.js";

const operation = "moderation.screen";

export const creemModeration: ModerationProvider = {
  name: "creem",
  media: ["text"],
  async screen(context, input) {
    if (
      input.image !== undefined ||
      typeof input.text !== "string" ||
      input.text.trim().length === 0
    )
      throw new PolybillError("Creem moderation requires a text prompt", {
        code: "unsupported_capability",
        operation,
        provider: "creem",
        connectionId: context.connection.id,
        retryable: false,
      });
    const response = await creemRequest(context, "POST", "/v1/moderation/prompt", {
      prompt: input.text,
      ...(input.reference === undefined ? {} : { external_id: input.reference }),
    });
    const value = object(response.json(), "creem", operation);
    const id = stringField(value, "id", "creem", operation);
    const usage = object(value.usage, "creem", operation);
    const units = usage.units;
    if (
      value.object !== "moderation_result" ||
      value.prompt !== input.text ||
      (value.external_id ?? undefined) !== input.reference ||
      id.length === 0 ||
      id.length > 64 ||
      typeof units !== "number" ||
      !Number.isSafeInteger(units) ||
      units < 0
    )
      throw invalid("creem", operation);
    return {
      decision: moderationDecision(value.decision, "creem"),
      resultId: id,
      usageUnits: units,
    };
  },
};
