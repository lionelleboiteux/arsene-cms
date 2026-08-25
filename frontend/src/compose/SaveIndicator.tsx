/** AC-01: renders `evaluateAutosave`'s own UTC-formatted indicator string
 *  verbatim — presentation-in-writer-timezone is deliberately out of scope
 *  (src/domain/autosave.ts's own header comment). */
export function SaveIndicator({ indicator }: { indicator: string | null }) {
  return <p className="save-indicator">{indicator ?? 'Pas encore enregistré'}</p>;
}
