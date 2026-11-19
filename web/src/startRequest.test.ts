import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from './api';
import { buildStartBody, isBudgetRefusal, type StartForm } from './startRequest';

const form: StartForm = {
  input: 'ABC-1', reviewer: 'claude', model: ' ', includeWorkingTree: false, baseBranch: '',
  secondOpinion: null, reviewUnchanged: false, ignoreBudget: false,
};

test('the start body leaves out empty and off options', () => {
  assert.deepEqual(buildStartBody(form), { input: 'ABC-1', reviewer: 'claude' });
});

test('reviewUnchanged and ignoreBudget are sent only when on', () => {
  assert.deepEqual(buildStartBody({ ...form, reviewUnchanged: true }), { input: 'ABC-1', reviewer: 'claude', reviewUnchanged: true });
  assert.deepEqual(
    buildStartBody({ ...form, model: ' opus ', secondOpinion: 'none', ignoreBudget: true }),
    { input: 'ABC-1', reviewer: 'claude', model: 'opus', secondOpinion: 'none', ignoreBudget: true },
  );
});

test('only a 409 from the API is a budget refusal', () => {
  assert.equal(isBudgetRefusal(new ApiError('spent', 409)), true);
  assert.equal(isBudgetRefusal(new ApiError('bad', 400)), false);
  assert.equal(isBudgetRefusal(new Error('spent')), false);
});
