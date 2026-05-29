// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ForecastForm } from './forecast-form';

describe('ForecastForm', () => {
  it('submits a when forecast with the configured options', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<ForecastForm onSubmit={onSubmit} historicalWindowOptions={[30, 90]} />);

    fireEvent.change(screen.getByRole('spinbutton', { name: /number of remaining stories/i }), {
      target: { value: '24' },
    });
    await user.selectOptions(screen.getByRole('combobox', { name: /historical window in days/i }), '30');
    await user.click(screen.getByRole('button', { name: /run forecast/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      type: 'when',
      remainingStoryCount: 24,
      sampleMode: 'rolling',
      historicalWindowDays: 30,
      confidenceLevels: [50, 70, 85, 95],
    });
  });

  it('shows a validation error when no confidence levels are selected', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<ForecastForm onSubmit={onSubmit} />);

    for (const level of [50, 70, 85, 95]) {
      await user.click(screen.getByRole('checkbox', { name: `${level}% confidence` }));
    }

    await user.click(screen.getByRole('button', { name: /run forecast/i }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/select at least one confidence level/i)).toBeVisible();
  });

  it('uses a future-date constraint for how-many forecasts and submits a valid request', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const futureDate = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    render(<ForecastForm onSubmit={onSubmit} />);

    await user.click(screen.getByRole('radio', { name: /how many stories by a date\?/i }));
    const targetInput = screen.getByLabelText(/target completion date/i);

    expect(targetInput).toHaveAttribute('min');

    fireEvent.change(targetInput, {
      target: { value: futureDate },
    });
    await user.click(screen.getByRole('button', { name: /run forecast/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      type: 'how_many',
      targetDate: futureDate,
      sampleMode: 'rolling',
      historicalWindowDays: 90,
      confidenceLevels: [50, 70, 85, 95],
    });
  });

  it('submits an explicit date range sample', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<ForecastForm onSubmit={onSubmit} />);

    await user.selectOptions(
      screen.getByRole('combobox', { name: /historical sample mode/i }),
      'range',
    );
    fireEvent.change(screen.getByLabelText(/sample start date/i), {
      target: { value: '2026-01-01' },
    });
    fireEvent.change(screen.getByLabelText(/sample end date/i), {
      target: { value: '2026-03-31' },
    });
    await user.click(screen.getByRole('button', { name: /run forecast/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      type: 'when',
      remainingStoryCount: 10,
      sampleMode: 'range',
      sampleStartDate: '2026-01-01',
      sampleEndDate: '2026-03-31',
      confidenceLevels: [50, 70, 85, 95],
    });
  });
});