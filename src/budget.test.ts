import './testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { budgetRefusal, type UsageWindow } from './budget.js';

const window = (used: number, budget = 1000): UsageWindow => ({
  window_hours: 5, budget, used, remaining: budget > 0 ? Math.max(0, budget - used) : null, reviews: 0, coverage_passes: 0, since: '',
});

test('the budget refuses at exactly the budget, and lets one token below through', () => {
  assert.equal(budgetRefusal(undefined, () => window(999)), null);
  const refused = budgetRefusal(undefined, () => window(1000));
  assert.ok(refused);
  assert.match(refused.error, /1000 of 1000/);
  assert.equal(refused.usage.used, 1000);
  assert.ok(budgetRefusal(undefined, () => window(1001)));
});

test('no budget, or ignoreBudget, never refuses', () => {
  assert.equal(budgetRefusal(undefined, () => window(5000, 0)), null);
  assert.equal(budgetRefusal(true, () => window(5000)), null);
});
