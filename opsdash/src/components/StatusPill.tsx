const TONE_VAR: Record<'good' | 'warn' | 'bad' | 'muted', string> = {
  good: 'var(--good)',
  warn: 'var(--warn)',
  bad: 'var(--bad)',
  muted: 'var(--muted)',
};

export function StatusPill({
  label,
  tone,
}: {
  label: string;
  tone: 'good' | 'warn' | 'bad' | 'muted';
}) {
  const color = TONE_VAR[tone];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.35em',
        padding: '0.1em 0.6em',
        borderRadius: '999px',
        border: `1px solid ${color}`,
        color,
        fontSize: '0.85em',
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}
