import type { ProviderSourceScanner } from "./ports.js";
import type { MigrationEntityType, MigrationSourceItem } from "./types.js";

export interface MigrationImportCodec {
  decode(
    entityType: MigrationEntityType,
    value: Readonly<Record<string, unknown>>,
  ): MigrationSourceItem;
}

export const providerRecordImportCodec: MigrationImportCodec = {
  decode(entityType, value) {
    const id = value.id;
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/.test(id))
      throw new TypeError("Provider migration record has an invalid ID");
    return {
      key: `${entityType}:${id}`,
      entityType,
      sourceId: id,
      payload: value,
    };
  },
};

export interface ImportSourceOptions {
  readonly scanner: ProviderSourceScanner;
  readonly codec: MigrationImportCodec;
  readonly entityTypes: readonly MigrationEntityType[];
  readonly maxPagesPerType?: number;
  readonly maxItems?: number;
  readonly onCheckpoint?: (input: {
    readonly entityType: MigrationEntityType;
    readonly cursor?: string;
    readonly sequence: number;
  }) => Promise<void>;
}

export async function importSourceItems(
  options: ImportSourceOptions,
): Promise<readonly MigrationSourceItem[]> {
  const maximumPages = options.maxPagesPerType ?? 10_000;
  const maximumItems = options.maxItems ?? 1_000_000;
  positive(maximumPages, "maxPagesPerType");
  positive(maximumItems, "maxItems");
  const items: MigrationSourceItem[] = [];
  const keys = new Set<string>();
  for (const entityType of options.entityTypes) {
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      if (pages >= maximumPages) throw new RangeError("Migration source exceeded the page limit");
      const page = await options.scanner.scan(entityType, cursor);
      pages += 1;
      for (const raw of page.items) {
        const item = options.codec.decode(entityType, raw);
        if (item.entityType !== entityType)
          throw new TypeError("Migration codec changed the scanned entity type");
        if (keys.has(item.key)) throw new TypeError(`Duplicate migration item key: ${item.key}`);
        keys.add(item.key);
        items.push(item);
        if (items.length > maximumItems)
          throw new RangeError("Migration source exceeded the item limit");
      }
      if (page.nextCursor !== undefined) {
        if (page.nextCursor === cursor || cursors.has(page.nextCursor))
          throw new TypeError("Migration source returned a cursor cycle");
        cursors.add(page.nextCursor);
      }
      cursor = page.nextCursor;
      await options.onCheckpoint?.({
        entityType,
        ...(cursor === undefined ? {} : { cursor }),
        sequence: items.length,
      });
    } while (cursor !== undefined);
  }
  return items;
}

function positive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive safe integer`);
}
