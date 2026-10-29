/**
 * Schedule fix option scorer.
 * Deterministically scores and ranks fix options by:
 * 1. Fewest fixed-item conflicts (primary)
 * 2. Fewest guest-visible changes (secondary)
 * 3. Total minutes moved (tertiary)
 */
import type {
  ScheduleItem,
  ScheduleFixOption,
  ScheduleFixOperation,
  FixScore,
} from '@eventpilot/shared';

/**
 * Score a single fix option by simulating its operations against the current schedule.
 * Counts fixed-item conflicts, guest-visible changes, and total minutes moved.
 *
 * @param items - Current schedule items before the fix
 * @param operations - Ordered operations that comprise this fix option
 * @returns A FixScore with deterministic ranking criteria
 */
export function scoreFixOption(
  items: readonly ScheduleItem[],
  operations: readonly ScheduleFixOperation[],
): FixScore {
  // Apply operations to get modified items
  const modified = applyOperations(items, operations);

  let fixedConflicts = 0;
  let guestVisibleChanges = 0;
  let totalMinutesMoved = 0;

  const originalMap = new Map(items.map((item) => [item.id, item]));

  for (const item of modified) {
    const original = originalMap.get(item.id);
    if (!original) continue;

    const moved = Math.abs(item.startMin - original.startMin);
    if (moved > 0) {
      totalMinutesMoved += moved;

      if (item.fixed) {
        fixedConflicts += 1;
      }
      if (item.guestVisible) {
        guestVisibleChanges += 1;
      }
    }
  }

  return { fixedConflicts, guestVisibleChanges, totalMinutesMoved };
}

function applySwap(
  item: ScheduleItem,
  op: ScheduleFixOperation,
  itemMap: Map<string, ScheduleItem>,
): void {
  if (item.fixed || !op.swapWithId) return;
  const other = itemMap.get(op.swapWithId);
  if (!other || other.fixed) return;

  const tempStart = item.startMin;
  item.startMin = other.startMin;
  other.startMin = tempStart;
}

function applySingleOperation(itemMap: Map<string, ScheduleItem>, op: ScheduleFixOperation): void {
  const item = itemMap.get(op.itemId);
  if (!item) return;

  if (op.op === 'shift' && !item.fixed) {
    item.startMin += op.minutes ?? 0;
  } else if (op.op === 'swap') {
    applySwap(item, op, itemMap);
  } else if (op.op === 'cancel_optional' && !item.fixed) {
    itemMap.delete(op.itemId);
  }
}

/**
 * Apply fix operations to a copy of the schedule items.
 * Returns new items with updated start times (originals not mutated).
 *
 * @param items - Current schedule items (not mutated)
 * @param operations - Ordered operations to apply
 * @returns New array of ScheduleItem objects with operations applied
 */
export function applyOperations(
  items: readonly ScheduleItem[],
  operations: readonly ScheduleFixOperation[],
): ScheduleItem[] {
  const itemMap = new Map(items.map((item) => [item.id, { ...item }]));

  for (const op of operations) {
    applySingleOperation(itemMap, op);
  }

  return Array.from(itemMap.values());
}

/**
 * Score and rank fix options deterministically.
 * Sort order: fixedConflicts ASC, guestVisibleChanges ASC, totalMinutesMoved ASC.
 * Lower composite score = better option.
 *
 * @param items - Current schedule items to score against
 * @param options - Candidate fix options to rank
 * @returns Sorted array of ScheduleFixOption with scores populated
 */
export function rankFixOptions(
  items: readonly ScheduleItem[],
  options: readonly ScheduleFixOption[],
): ScheduleFixOption[] {
  const scored = options.map((option) => {
    const score = scoreFixOption(items, option.operations);
    return { ...option, score };
  });

  scored.sort((a, b) => {
    if (a.score.fixedConflicts !== b.score.fixedConflicts) {
      return a.score.fixedConflicts - b.score.fixedConflicts;
    }
    if (a.score.guestVisibleChanges !== b.score.guestVisibleChanges) {
      return a.score.guestVisibleChanges - b.score.guestVisibleChanges;
    }
    return a.score.totalMinutesMoved - b.score.totalMinutesMoved;
  });

  return scored;
}
