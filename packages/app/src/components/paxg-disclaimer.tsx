/**
 * REQUIREMENTS §1.1: wherever PAXG levels appear, say that they can differ from spot gold and from a
 * broker's XAUUSD quotes. This sentence is the only place the UI may write "XAUUSD": the label scan
 * (criterion 7.4) allows it inside `[data-paxg-disclaimer]` and nowhere else.
 */
export function PaxgDisclaimer({ className = '' }: { className?: string }) {
  return (
    <p className={`text-xs text-fg-muted ${className}`} data-paxg-disclaimer="">
      PAXG is a token backed by physical gold, not spot gold: its price can differ from spot gold and from a
      broker&apos;s XAUUSD quotes, so PAXG levels cannot be copied one-to-one onto an XAUUSD chart.
    </p>
  );
}
