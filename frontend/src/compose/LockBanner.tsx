export function LockBanner({ lockedByDisplayName }: { lockedByDisplayName: string }) {
  return (
    <div className="lock-banner" role="status">
      <strong>{lockedByDisplayName}</strong> est en train de modifier ce brouillon. Vous pourrez le
      reprendre dès que son verrou expirera (~90s d'inactivité) — cette page réessaie
      automatiquement.
    </div>
  );
}
