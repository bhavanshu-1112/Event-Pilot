/**
 * Budget validation functions.
 * Ensures budget proposals maintain all invariants.
 */
import type { BudgetCategory, RebalanceCut } from '@eventpilot/shared';

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface RebalanceValidationConfig {
  /** Total budget in minor units */
  readonly totalMinor: number;
  /** Maximum percent a single category can be cut (0-100) */
  readonly maxCutPercent: number;
  /** Minimum contingency floor as percent of total (0-100) */
  readonly contingencyFloorPercent: number;
}

/**
 * Validate that a set of budget categories satisfies all allocation invariants.
 * Checks that the sum of allocations equals the total and that no allocation is negative.
 *
 * @param categories - The budget categories to validate
 * @param totalMinor - The expected total budget in minor units (paise)
 * @returns A ValidationResult indicating whether all invariants hold
 */
export function validateBudget(
  categories: readonly BudgetCategory[],
  totalMinor: number,
): ValidationResult {
  const errors: string[] = [];

  // Sum must equal total
  const sum = categories.reduce((acc, c) => acc + c.allocatedMinor, 0);
  if (sum !== totalMinor) {
    errors.push(`Sum of allocations (${String(sum)}) does not equal total (${String(totalMinor)})`);
  }

  // No negative allocations
  for (const cat of categories) {
    if (cat.allocatedMinor < 0) {
      errors.push(`Category "${cat.id}" has negative allocation: ${String(cat.allocatedMinor)}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function validateSingleCut(
  cut: RebalanceCut,
  cat: BudgetCategory,
  config: RebalanceValidationConfig,
  errors: string[],
): void {
  if (cat.locked) {
    errors.push(`Cut targets locked category "${cut.categoryId}"`);
  }

  if (cut.reduceByMinor <= 0) {
    errors.push(`Cut for "${cut.categoryId}" must be positive, got ${String(cut.reduceByMinor)}`);
  }

  const maxCut = Math.floor(cat.allocatedMinor * (config.maxCutPercent / 100));
  if (cut.reduceByMinor > maxCut) {
    errors.push(
      `Cut for "${cut.categoryId}" (${String(cut.reduceByMinor)}) exceeds max ${String(config.maxCutPercent)}% of allocation (${String(maxCut)})`,
    );
  }

  const floor = Math.ceil(config.totalMinor * (cat.floorPercent / 100));
  const newAllocation = cat.allocatedMinor - cut.reduceByMinor;
  if (newAllocation < floor) {
    errors.push(
      `Cut for "${cut.categoryId}" would reduce allocation to ${String(newAllocation)}, below floor of ${String(floor)}`,
    );
  }
}

function validateContingencyFloor(
  categoryMap: Map<string, BudgetCategory>,
  cuts: readonly RebalanceCut[],
  config: RebalanceValidationConfig,
  errors: string[],
): void {
  const contingency = categoryMap.get('contingency');
  if (!contingency) return;

  const contingencyCut = cuts.find((c) => c.categoryId === 'contingency');
  const cutAmount = contingencyCut?.reduceByMinor ?? 0;
  const newContingency = contingency.allocatedMinor - cutAmount;
  const contingencyFloor = Math.ceil(config.totalMinor * (config.contingencyFloorPercent / 100));
  if (newContingency < contingencyFloor) {
    errors.push(
      `Contingency after cuts (${String(newContingency)}) would be below floor (${String(contingencyFloor)})`,
    );
  }
}

/**
 * Validate a rebalance proposal against all business rules:
 * - No cuts to locked categories
 * - Each cut is positive and within maxCutPercent of the category's allocation
 * - No category falls below its floor
 * - Contingency floor is maintained
 *
 * @param categories - Current budget categories state
 * @param cuts - Proposed cuts to validate
 * @param config - Validation thresholds (total, max cut %, contingency floor %)
 * @returns A ValidationResult with any violations found
 */
export function validateRebalanceProposal(
  categories: readonly BudgetCategory[],
  cuts: readonly RebalanceCut[],
  config: RebalanceValidationConfig,
): ValidationResult {
  const errors: string[] = [];
  const categoryMap = new Map(categories.map((c) => [c.id, c]));

  for (const cut of cuts) {
    const cat = categoryMap.get(cut.categoryId);
    if (!cat) {
      errors.push(`Cut references unknown category "${cut.categoryId}"`);
      continue;
    }
    validateSingleCut(cut, cat, config, errors);
  }

  validateContingencyFloor(categoryMap, cuts, config, errors);

  const totalCut = cuts.reduce((acc, c) => acc + c.reduceByMinor, 0);
  if (totalCut <= 0) {
    errors.push('Total cut must be positive');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Apply validated cuts to categories and absorb the overrun into the specified category.
 * Returns new category objects with updated allocations (does not mutate originals).
 *
 * @param categories - Current budget categories (not mutated)
 * @param cuts - Validated cuts to apply
 * @param overrunCategoryId - Category that absorbs the freed budget
 * @param overrunMinor - Amount to add to the overrun category in minor units
 * @returns New array of BudgetCategory objects with updated allocations
 */
export function applyCuts(
  categories: readonly BudgetCategory[],
  cuts: readonly RebalanceCut[],
  overrunCategoryId: string,
  overrunMinor: number,
): BudgetCategory[] {
  const cutMap = new Map(cuts.map((c) => [c.categoryId, c.reduceByMinor]));

  return categories.map((cat) => {
    const cutAmount = cutMap.get(cat.id) ?? 0;
    const addAmount = cat.id === overrunCategoryId ? overrunMinor : 0;

    return {
      ...cat,
      allocatedMinor: cat.allocatedMinor - cutAmount + addAmount,
    };
  });
}
