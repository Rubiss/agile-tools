'use client';

import { useEffect, useMemo, useState } from 'react';

type ViewerLocalTimeProps = {
  /** ISO 8601 timestamp to render. */
  timestamp: string;
  /**
   * Pre-formatted timestamp string in the scope's timezone. Used as the SSR
   * fallback (so server and first client render agree) and as the tooltip
   * tail after hydration.
   */
  scopeFallback: string;
  /** IANA timezone identifier the `scopeFallback` was rendered in, e.g. `America/New_York`. */
  scopeTimezone: string;
};

const ABSOLUTE_FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
};

const RELATIVE_UNITS: Array<{ unit: Intl.RelativeTimeFormatUnit; seconds: number }> = [
  { unit: 'year', seconds: 60 * 60 * 24 * 365 },
  { unit: 'month', seconds: 60 * 60 * 24 * 30 },
  { unit: 'week', seconds: 60 * 60 * 24 * 7 },
  { unit: 'day', seconds: 60 * 60 * 24 },
  { unit: 'hour', seconds: 60 * 60 },
  { unit: 'minute', seconds: 60 },
  { unit: 'second', seconds: 1 },
];

function safeRelativeTimeFormat(locale: string): Intl.RelativeTimeFormat {
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  } catch {
    return new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });
  }
}

function safeDateTimeFormat(locale: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, ABSOLUTE_FORMAT);
  } catch {
    return new Intl.DateTimeFormat('en-US', ABSOLUTE_FORMAT);
  }
}

function formatRelative(now: number, target: number, rtf: Intl.RelativeTimeFormat): string {
  const diffSeconds = Math.round((target - now) / 1000);
  const absSeconds = Math.abs(diffSeconds);
  // Treat anything under one minute as "now" so the label transitions cleanly
  // into "1 minute ago" without a 45–59s "seconds" window.
  if (absSeconds < 60) return rtf.format(0, 'second');

  for (const { unit, seconds } of RELATIVE_UNITS) {
    if (absSeconds >= seconds || unit === 'second') {
      const value = Math.round(diffSeconds / seconds);
      return rtf.format(value, unit);
    }
  }
  return rtf.format(0, 'second');
}

export function ViewerLocalTime({
  timestamp,
  scopeFallback,
  scopeTimezone,
}: ViewerLocalTimeProps): React.ReactElement {
  // Render the scope-zone string on first paint so SSR and hydration match.
  // After hydration we swap to the viewer's local zone + a live relative label.
  const [hydrated, setHydrated] = useState(false);
  const [, setTick] = useState(0);

  const targetMs = useMemo(() => {
    const ms = new Date(timestamp).getTime();
    return Number.isFinite(ms) ? ms : null;
  }, [timestamp]);

  useEffect(() => {
    setHydrated(true);
    // Only tick if the timestamp is parseable; otherwise the component is
    // permanently in the fallback state and re-renders would do nothing.
    if (targetMs === null) return;
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [targetMs]);

  const locale = useMemo(
    () =>
      typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US',
    [],
  );
  // Memoize Intl formatters by locale so we don't allocate fresh ones on
  // every 60s tick / re-render.
  const rtf = useMemo(() => safeRelativeTimeFormat(locale), [locale]);
  const dtf = useMemo(() => safeDateTimeFormat(locale), [locale]);

  const tooltip = `${scopeFallback} (scope timezone: ${scopeTimezone})`;
  const fallbackAriaLabel = `${scopeFallback} (scope timezone ${scopeTimezone})`;

  // SSR / pre-hydration render AND the invalid-timestamp fallback share the
  // same markup so server and first client paint agree, and so AT users always
  // get the canonical scope-zone string via title + aria-label.
  if (!hydrated || targetMs === null) {
    return (
      <time dateTime={timestamp} title={tooltip} aria-label={fallbackAriaLabel}>
        {scopeFallback}
      </time>
    );
  }

  const relative = formatRelative(Date.now(), targetMs, rtf);
  const localAbsolute = dtf.format(new Date(targetMs));
  const hoverTooltip = `${localAbsolute} — ${scopeFallback} (scope timezone: ${scopeTimezone})`;

  return (
    <time
      dateTime={timestamp}
      title={hoverTooltip}
      aria-label={`${relative}, ${localAbsolute} (${scopeFallback} in scope timezone ${scopeTimezone})`}
    >
      {relative}
    </time>
  );
}
