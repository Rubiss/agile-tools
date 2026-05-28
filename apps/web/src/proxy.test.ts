import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import { proxy } from './proxy';

const ORIGINAL_ENV = { ...process.env };

describe('proxy', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('redirects forwarded http traffic to https in production', () => {
    process.env = { ...process.env, NODE_ENV: 'production' };

    const response = proxy(
      new NextRequest('http://internal.example.com/admin/jira', {
        headers: {
          'x-forwarded-proto': 'http',
          'x-forwarded-host': 'agile.example.com',
        },
      }),
    );

    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('https://agile.example.com/admin/jira');
  });

  it('redirects loopback traffic in production when bypass is disabled', () => {
    process.env = { ...process.env, NODE_ENV: 'production' };

    const response = proxy(new NextRequest('http://127.0.0.1:3000/admin/jira'));
    const location = response.headers.get('location');

    expect(response.status).toBe(308);
    expect(location).not.toBeNull();

    const redirectUrl = new URL(location!);
    expect(redirectUrl.protocol).toBe('https:');
    expect(redirectUrl.pathname).toBe('/admin/jira');
    expect(redirectUrl.port).toBe('3000');
  });

  it('passes loopback traffic through in production when bypass is enabled', () => {
    process.env = {
      ...process.env,
      NODE_ENV: 'production',
      ALLOW_LOOPBACK_HTTP_BYPASS: 'true',
    };

    const response = proxy(new NextRequest('http://127.0.0.1:3000/admin/jira'));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('passes requests through outside production', () => {
    process.env = { ...process.env, NODE_ENV: 'development' };

    const response = proxy(new NextRequest('http://localhost:3000/admin/jira'));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('passes /metrics through in production', () => {
    process.env = { ...process.env, NODE_ENV: 'production' };

    const response = proxy(
      new NextRequest('http://internal.example.com/metrics', {
        headers: {
          'x-forwarded-proto': 'http',
          'x-forwarded-host': 'agile.example.com',
        },
      }),
    );
    const trailingSlashResponse = proxy(
      new NextRequest('http://internal.example.com/metrics/', {
        headers: {
          'x-forwarded-proto': 'http',
          'x-forwarded-host': 'agile.example.com',
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(trailingSlashResponse.status).toBe(200);
    expect(trailingSlashResponse.headers.get('location')).toBeNull();
  });
});