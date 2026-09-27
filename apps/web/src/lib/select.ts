/**
 * Text selection on a card. Holding a finger on the text selects natively;
 * a double tap selects the word under the finger. While any text on the card
 * is selected, the card cannot be swiped.
 */

const words =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'word' })
    : null;

/** The word containing `offset` in `text`, as [start, end), or null. */
export function wordAt(
  text: string,
  offset: number,
): [start: number, end: number] | null {
  if (!words) return null;
  for (const { index, segment, isWordLike } of words.segment(text)) {
    const end = index + segment.length;
    // A caret at a word's end (tapping its last letter's right half) still
    // belongs to that word.
    if (isWordLike && offset >= index && offset <= end) return [index, end];
    if (index > offset) break;
  }
  return null;
}

type CaretDocument = Document & {
  caretPositionFromPoint?: (
    x: number,
    y: number,
  ) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as CaretDocument;
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = doc.caretRangeFromPoint?.(x, y);
  return range
    ? { node: range.startContainer, offset: range.startOffset }
    : null;
}

/** Select the word under a screen point inside `within`. */
export function selectWordAt(x: number, y: number, within: Element): boolean {
  const caret = caretAt(x, y);
  if (!caret || caret.node.nodeType !== Node.TEXT_NODE) return false;
  if (!within.contains(caret.node)) return false;
  const span = wordAt(caret.node.textContent ?? '', caret.offset);
  const selection = window.getSelection();
  if (!span || !selection) return false;
  const range = document.createRange();
  range.setStart(caret.node, span[0]);
  range.setEnd(caret.node, span[1]);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/** True while some text inside `element` is selected. */
export function hasSelectionIn(element: Element | undefined): boolean {
  const selection = window.getSelection();
  if (!element || !selection || selection.isCollapsed) return false;
  for (let index = 0; index < selection.rangeCount; index++) {
    if (selection.getRangeAt(index).intersectsNode(element)) return true;
  }
  return false;
}
