import type { D1DatabaseLike } from "@polybill/store-d1";
import type { SerializedInboxRecord } from "./queue-wire.js";

export interface QueueProducer<T> {
  send(body: T): Promise<void>;
}

export interface QueueMessage<T> {
  readonly body: T;
  ack(): void;
  retry(): void;
}

export interface QueueBatch<T> {
  readonly messages: readonly QueueMessage<T>[];
}

export type DurableObjectIdLike = object;

export interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
}

export interface WorkerEnv {
  readonly POLYBILL_DB: D1DatabaseLike;
  readonly POLYBILL_WEBHOOK_QUEUE: QueueProducer<SerializedInboxRecord>;
  readonly REDEMPTION_COORDINATOR: DurableObjectNamespaceLike;
  readonly POLYBILL_TENANT_ID: string;
  readonly POLYBILL_CONNECTION_ID: string;
  readonly POLYBILL_PROVIDER: string;
  readonly POLYBILL_ENVIRONMENT: string;
  readonly POLYBILL_API_KEY: string;
  readonly POLYBILL_WEBHOOK_SECRET: string;
  readonly POLYBILL_DIGEST_KEY: string;
  readonly POLYBILL_ENCRYPTION_KEY: string;
  readonly POLYBILL_X402_GATEWAY?: string;
  readonly POLYBILL_X402_PAY_TO?: string;
  readonly POLYBILL_X402_NETWORK?: string;
  readonly POLYBILL_X402_ATOMIC_PER_MINOR?: string;
  readonly POLYBILL_X402_RECEIPT_SIGNER?: string;
}
