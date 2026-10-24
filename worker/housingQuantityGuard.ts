// Validate against server-owned furniture inventory, not client inventory.
// Caller identity must be independently authenticated before public release.
export interface OwnedFurnitureRow { item_key: string; quantity: number }
export interface RequestedPlacement {
  instanceId: string; furnitureId: string; x: number; y: number; rotation?: number;
}

export function validateHousingPlacements(
  ownedRows: OwnedFurnitureRow[],
  requested: unknown,
): RequestedPlacement[] {
  if (!Array.isArray(requested)) throw new RangeError('Housing placements must be an array');
  if (requested.length > 48) throw new RangeError('Housing exceeds grid capacity');
  const remaining = new Map<string, number>();
  for (const row of ownedRows) {
    if (!Number.isSafeInteger(row.quantity) || row.quantity < 0) throw new RangeError('Invalid owned furniture quantity');
    if (typeof row.item_key !== 'string' || !row.item_key) throw new RangeError('Invalid owned furniture key');
    const total = (remaining.get(row.item_key) ?? 0) + row.quantity;
    if (!Number.isSafeInteger(total)) throw new RangeError('Invalid owned furniture quantity');
    remaining.set(row.item_key, total);
  }
  const instances = new Set<string>();
  const cells = new Set<string>();
  const validated: RequestedPlacement[] = [];
  for (const item of requested) {
    if (!item || typeof item.instanceId !== 'string' || !item.instanceId ||
      typeof item.furnitureId !== 'string' || !item.furnitureId ||
      !Number.isSafeInteger(item.x) || !Number.isSafeInteger(item.y) ||
      item.x < 0 || item.x > 7 || item.y < 0 || item.y > 5 ||
      (item.rotation !== undefined && !Number.isSafeInteger(item.rotation))) {
      throw new RangeError('Invalid housing placement');
    }
    const cell = item.x + ',' + item.y;
    if (instances.has(item.instanceId) || cells.has(cell)) throw new RangeError('Duplicate housing placement');
    const available = remaining.get(item.furnitureId) ?? 0;
    if (available < 1) throw new RangeError('Furniture placement exceeds owned quantity');
    remaining.set(item.furnitureId, available - 1);
    instances.add(item.instanceId);
    cells.add(cell);
    validated.push(item);
  }
  return validated;
}
