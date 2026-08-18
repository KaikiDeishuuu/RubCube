import type { Move } from '@rubcube/cube-core';

export type KeyboardMoveMap = Readonly<Record<string, Move>>;

/** csTimer-style defaults, kept separate so the app can expose customization. */
export const DEFAULT_KEYBOARD_MOVES: KeyboardMoveMap = Object.freeze({
  j: Object.freeze({ face: 'U', turns: 1 }),
  f: Object.freeze({ face: 'U', turns: 3 }),
  i: Object.freeze({ face: 'R', turns: 1 }),
  k: Object.freeze({ face: 'R', turns: 3 }),
  e: Object.freeze({ face: 'L', turns: 1 }),
  d: Object.freeze({ face: 'L', turns: 3 }),
  h: Object.freeze({ face: 'F', turns: 1 }),
  g: Object.freeze({ face: 'F', turns: 3 }),
  s: Object.freeze({ face: 'D', turns: 1 }),
  l: Object.freeze({ face: 'D', turns: 3 }),
  w: Object.freeze({ face: 'B', turns: 1 }),
  o: Object.freeze({ face: 'B', turns: 3 }),
});

export function moveForKey(
  key: string,
  mapping: KeyboardMoveMap = DEFAULT_KEYBOARD_MOVES,
): Move | null {
  // Locale-invariant by construction: mapping keys are ASCII. The no-argument
  // toLocaleLowerCase is specified to use the host default locale, where tr/az
  // fold 'I' to the dotless 'ı' and unbind the R key. V8 happens not to apply
  // that fold today, but no engine guarantees it.
  return mapping[key.toLowerCase()] ?? null;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

export class KeyboardMoveController {
  constructor(
    private readonly target: Window | HTMLElement,
    private readonly onMove: (move: Move) => void,
    private readonly mapping: KeyboardMoveMap = DEFAULT_KEYBOARD_MOVES,
  ) {
    this.target.addEventListener('keydown', this.onKeyDown as EventListener);
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown as EventListener);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (
      event.repeat ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      isEditableTarget(event.target)
    ) {
      return;
    }
    const move = moveForKey(event.key, this.mapping);
    if (move === null) return;
    event.preventDefault();
    this.onMove(move);
  };
}
