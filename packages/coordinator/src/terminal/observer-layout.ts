import type { ObservedRole } from '../roles.js';

const RIGHT_COLUMN: ObservedRole[] = ['frontend', 'backend', 'audit'];

export interface ObserverPlacement<Id> { target: Id; direction: 'right' | 'down'; above: boolean; }

// Left column: the anchor (overview pane in Herdr, lead window in Kitty) with advisor below.
// Right column: frontend, backend, audit in that order.
// A right-column pane opens below its nearest earlier neighbour, or above the next one (open below, then swap up).
export function placeObserver<Id>(role: ObservedRole, owned: Partial<Record<ObservedRole, Id>>, anchor: Id): ObserverPlacement<Id> {
  if (role === 'advisor') return { target: anchor, direction: 'down', above: false };
  const index = RIGHT_COLUMN.indexOf(role);
  const before = RIGHT_COLUMN.slice(0, index).reverse().find((id) => owned[id] !== undefined);
  if (before) return { target: owned[before]!, direction: 'down', above: false };
  const after = RIGHT_COLUMN.slice(index + 1).find((id) => owned[id] !== undefined);
  if (after) return { target: owned[after]!, direction: 'down', above: true };
  return { target: anchor, direction: 'right', above: false };
}
