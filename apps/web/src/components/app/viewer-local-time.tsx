'use client';

import { useEffect, useState } from 'react';

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

function formatRelative(now: number, target: number, locale: string): string {
  const diffSeconds = Math.round((target - now) / 1000);
  const absSeconds = Math.abs(diffSeconds);
  const rtf = safeRelativeTimeFormat(locale);
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

  useEffect(() => {
    setHydrated(true);
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  if (!hydrated) {
    return (
      <time dateTime={timestamp} title={`Scope timezone: ${scopeTimezone}`}>
        {scopeFallback}
      </time>
    );
  }

  const target = new Date(timestamp);
  const targetMs = target.getTime();
  if (!Number.isFinite(targetMs)) {
    return (
      <time dateTime={timestamp} title={`Scope timezone: ${scopeTimezone}`}>
        {scopeFallback}
      </time>
    );
  }

  const locale =
    typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US';
  const relative = formatRelative(Date.now(), targetMs, locale);
  const localAbsolute = safeDateTimeFormat(locale).format(target);
  const tooltip = `${scopeFallback} (scope timezone: ${scopeTimezone})`;

  return (
    <time
      dateTime={timestamp}
      title={tooltip}
      aria-label={`${relative}, ${localAbsolute} (${scopeFallback} in scope timezone ${scopeTimezone})`}
    >
      {relative} · {localAbsolute}
    </time>
  );
}
