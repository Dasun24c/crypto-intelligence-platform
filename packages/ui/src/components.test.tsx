// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { cn } from './cn.js';
import { Button, StatusBadge } from './components.js';

describe('ui', () => {
  it('lets later utilities win when merging classes', () => {
    expect(cn('px-2 text-sm', 'px-4')).toBe('text-sm px-4');
  });

  it('never shows status by colour alone', () => {
    render(<StatusBadge tone="crit" label="Down" />);
    const badge = screen.getByText('Down');
    expect(badge.querySelector('svg')).not.toBeNull();
  });

  it('disables a busy button and announces it', () => {
    render(<Button busy>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });
});
