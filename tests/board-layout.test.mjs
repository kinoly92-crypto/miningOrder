import assert from 'node:assert/strict';
import test from 'node:test';
import { BOARD_CARD_LIMIT, boardCardExtraPadding } from '../src/board-layout.ts';
import { BOARD_COLUMNS } from '../src/constants.ts';

test('board only displays active and completed dispatches', () => {
  assert.deepEqual(BOARD_COLUMNS.map((column) => column.key), ['dispatched', 'done']);
});

test('tiled cards retain their natural padding for any grid width', () => {
  for (const columns of [2, 3, 4, 5]) {
    assert.equal(boardCardExtraPadding(30, 800, 1200, columns), 0);
  }
});

test('sparse columns keep their natural card sizes', () => {
  assert.equal(BOARD_CARD_LIMIT, 5);
  assert.equal(boardCardExtraPadding(0, 0, 1000), 0);
  assert.equal(boardCardExtraPadding(4, 600, 1000), 0);
});

test('five cards fill the shared height without shrinking taller content', () => {
  assert.equal(boardCardExtraPadding(5, 800, 1000), 40);
  assert.equal(boardCardExtraPadding(5, 1000, 1000), 0);
  assert.equal(boardCardExtraPadding(5, 1100, 1000), 0);
});

test('overflowing columns fill the viewport and keep the sixth card below it', () => {
  const height = 1000;
  const firstFiveHeight = 800;
  const extra = boardCardExtraPadding(8, firstFiveHeight, height);
  assert.equal(extra, 40.4);
  assert.ok(firstFiveHeight + BOARD_CARD_LIMIT * extra > height);
  assert.ok(firstFiveHeight + BOARD_CARD_LIMIT * extra - 10 < height);
});
