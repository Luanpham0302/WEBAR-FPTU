type MatchingController = {
  _detectAndMatch?: (input: unknown, targetIndexes: number[]) => unknown;
};

// MindAR 1.2.5 tries targets in index order and accepts the first one that
// passes a low matching bar, without comparing candidates. When two trigger
// images share features, the lower index can win on a frame showing the higher
// one; tracking then rejects it, but the same thing repeats on the next frame
// and the right target is never tried. Starting from a different index every
// frame gives each target a turn, so a false match costs one frame at most.
//
// This wraps a private MindAR method. If a MindAR update renames it, the
// wrapper does nothing and MindAR behaves as shipped.
export function rotateMatchOrder(controller: unknown) {
  const target = controller as MatchingController | null | undefined;
  const detectAndMatch = target?._detectAndMatch;

  if (!target || typeof detectAndMatch !== 'function') {
    console.warn('rotateMatchOrder: MindAR internals changed, not applied.');
    return;
  }

  let frame = 0;

  target._detectAndMatch = (input, targetIndexes) => {
    const count = targetIndexes.length;
    const start = count > 0 ? frame++ % count : 0;

    return detectAndMatch.call(target, input, [
      ...targetIndexes.slice(start),
      ...targetIndexes.slice(0, start),
    ]);
  };
}
