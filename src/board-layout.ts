export const BOARD_CARD_LIMIT = 5;

export function updateBoardColumnHeight(
  heights: Record<string, number>,
  title: string,
  height: number,
): Record<string, number> {
  return heights[title] === height ? heights : { ...heights, [title]: height };
}

export function boardCardExtraPadding(
  count: number,
  naturalHeight: number,
  boardHeight: number,
  columns = 1,
): number {
  // 网格列（双列）不做 extra 拉伸，避免测量值与布局相互反馈造成死循环；
  // 超出限定的卡片依靠容器 overflow-y 滚动查看。
  if (columns > 1) return 0;
  const limit = BOARD_CARD_LIMIT * columns;
  if (count < limit || naturalHeight <= 0) return 0;
  // Keep the row just below the viewport despite subpixel rounding.
  const roundingBuffer = count > limit ? 2 : 0;
  return Math.max(0, (boardHeight - naturalHeight + roundingBuffer) / BOARD_CARD_LIMIT);
}
