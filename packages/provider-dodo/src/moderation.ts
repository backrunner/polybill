import {
  invalid,
  moderationDecision,
  object,
  type ModerationProvider,
} from "@polybill/adapter-kit";
import { PolybillError } from "@polybill/core";
import { dodoRequest } from "./client.js";

const operation = "moderation.screen";

export const dodoModeration: ModerationProvider = {
  name: "dodo",
  media: ["text", "image"],
  async screen(context, input) {
    if (
      (input.text === undefined && input.image === undefined) ||
      (input.text !== undefined && (input.text.trim().length === 0 || input.text.length > 8000)) ||
      (input.image !== undefined && !validImage(input.image)) ||
      (input.reference !== undefined && input.reference.length > 128)
    )
      throw new PolybillError("Invalid Dodo moderation input", {
        code: "invalid_request",
        operation,
        provider: "dodo",
        connectionId: context.connection.id,
        retryable: false,
      });
    const response = await dodoRequest(context, "POST", "/moderation/screen", {
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.image === undefined ? {} : { image: input.image }),
      ...(input.reference === undefined ? {} : { request_id: input.reference }),
    });
    const value = object(response.json(), "dodo", operation);
    if (value.request_id !== (input.reference ?? null)) throw invalid("dodo", operation);
    return { decision: moderationDecision(value.decision, "dodo") };
  },
};

function validImage(value: string): boolean {
  const base64 = value.replace(/^data:image\/(jpeg|png|webp|gif|bmp);base64,/iu, "");
  if (base64.length === 0 || base64.length > 6_991_530 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(base64))
    return false;
  const unpaddedLength = base64.replace(/=+$/u, "").length;
  return (
    unpaddedLength % 4 !== 1 &&
    (unpaddedLength === base64.length || base64.length % 4 === 0) &&
    Math.floor((unpaddedLength * 3) / 4) <= 5 * 1024 * 1024
  );
}
