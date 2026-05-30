// Live caption buffer — one utterance per segment. Never inject spaces: the
// provider deltas already carry correct spacing (Vietnamese tone marks must
// stay glued to their base letter, e.g. M + ã → Mã not M ã).

export interface LiveCaptionState {
  text: string;
  utteranceOpen: boolean;
}

export function applyLiveTranslationDelta(
  state: LiveCaptionState,
  incoming: string,
  isFinal: boolean,
): LiveCaptionState {
  if (!incoming) return state;

  if (isFinal) {
    return { text: incoming, utteranceOpen: false };
  }

  if (!state.utteranceOpen) {
    return { text: incoming, utteranceOpen: true };
  }

  const cur = state.text;
  if (!cur) {
    return { text: incoming, utteranceOpen: true };
  }

  // Cumulative snapshot (full line-so-far from the relay).
  if (incoming.startsWith(cur)) {
    return { text: incoming, utteranceOpen: true };
  }
  if (cur.startsWith(incoming)) {
    return state;
  }

  // True delta — append verbatim.
  return { text: cur + incoming, utteranceOpen: true };
}
