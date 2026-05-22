import type { CSSProperties, ReactNode } from 'react';

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export interface BreadcrumbAction {
  label: string;
  href: string;
  icon?: ReactNode;
  variant?: 'default' | 'primary';
}

const navStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: '0.4rem',
  padding: '0.3rem 0.45rem 0.3rem 0.65rem',
  marginBottom: '1rem',
  borderRadius: '9999px',
  border: '1px solid var(--color-line)',
  background: 'var(--color-panel)',
  width: 'fit-content',
  maxWidth: '100%',
  fontFamily: 'var(--font-label)',
  fontSize: '0.78rem',
  fontWeight: 600,
  letterSpacing: '0.02em',
  color: 'var(--color-text-soft)',
};

const linkBaseStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.3rem',
  padding: '0.25rem 0.55rem',
  borderRadius: '9999px',
  color: 'var(--color-text-soft)',
  textDecoration: 'none',
  transition: 'background-color 160ms ease, color 160ms ease',
};

const currentStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.3rem',
  padding: '0.25rem 0.55rem',
  borderRadius: '9999px',
  background: 'var(--color-accent-soft)',
  color: 'var(--color-accent-strong)',
};

const separatorStyle: CSSProperties = {
  color: 'var(--color-line-strong)',
  display: 'inline-flex',
  alignItems: 'center',
};

const labelTextStyle: CSSProperties = {
  display: 'inline-block',
  maxWidth: 'min(60vw, 24rem)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  verticalAlign: 'bottom',
};

const dividerStyle: CSSProperties = {
  width: 1,
  alignSelf: 'stretch',
  background: 'var(--color-line)',
  margin: '0 0.15rem',
};

const actionStyle = (variant: 'default' | 'primary'): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.3rem',
  padding: '0.25rem 0.6rem',
  borderRadius: '9999px',
  textDecoration: 'none',
  color: variant === 'primary' ? 'var(--color-accent-strong)' : 'var(--color-text)',
  background: variant === 'primary' ? 'var(--color-accent-soft)' : 'transparent',
  border: variant === 'primary' ? '1px solid transparent' : '1px solid var(--color-line)',
  transition: 'background-color 160ms ease, color 160ms ease, border-color 160ms ease',
});

export function Breadcrumbs({
  items,
  actions,
}: {
  items: ReadonlyArray<BreadcrumbItem>;
  actions?: ReadonlyArray<BreadcrumbAction>;
}) {
  return (
    <nav aria-label="Breadcrumb" style={navStyle}>
      <a href="/" style={linkBaseStyle} aria-label="Home">
        <HomeIcon />
        <span>Home</span>
      </a>
      {items.map((item, index): ReactNode => {
        const isLast = index === items.length - 1;
        return (
          <span key={`${item.label}-${index}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', minWidth: 0 }}>
            <ChevronIcon />
            {item.href && !isLast ? (
              <a href={item.href} style={linkBaseStyle} title={item.label}>
                <span style={labelTextStyle}>{item.label}</span>
              </a>
            ) : (
              <span
                aria-current={isLast ? 'page' : undefined}
                style={isLast ? currentStyle : linkBaseStyle}
                title={item.label}
              >
                <span style={labelTextStyle}>{item.label}</span>
              </span>
            )}
          </span>
        );
      })}
      {actions && actions.length > 0 && (
        <>
          <span aria-hidden="true" style={dividerStyle} />
          {actions.map((action) => (
            <a
              key={action.href}
              href={action.href}
              style={actionStyle(action.variant ?? 'default')}
            >
              {action.icon}
              <span>{action.label}</span>
            </a>
          ))}
        </>
      )}
    </nav>
  );
}

function HomeIcon() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
      <path d="M10 21v-6h4v6" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      width={11}
      height={11}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={separatorStyle}
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}
