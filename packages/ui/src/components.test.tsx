// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { cn } from './cn.js';
import { Button, StatusBadge, Switch, Table } from './components.js';

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

  it('exposes a switch with its name and state, and reports changes', () => {
    const onChange = vi.fn();
    render(<Switch aria-label="Enabled" checked={false} onCheckedChange={onChange} />);
    const control = screen.getByRole('switch', { name: 'Enabled' });
    expect(control.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('lets the keyboard reach a table that scrolls sideways, and adds no tab stop to one that fits', () => {
    // jsdom lays nothing out: the sizes are set by hand and the observer is called as a browser would.
    const reports: Array<() => void> = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(report: () => void) {
          reports.push(report);
        }
        observe() {}
        disconnect() {}
      },
    );
    try {
      const { container } = render(
        <Table>
          <caption>Large trades in the window</caption>
          <tbody>
            <tr>
              <td>1</td>
            </tr>
          </tbody>
        </Table>,
      );
      const box = container.firstElementChild as HTMLDivElement;
      const resize = (scrollWidth: number, clientWidth: number) => {
        Object.defineProperty(box, 'scrollWidth', { configurable: true, value: scrollWidth });
        Object.defineProperty(box, 'clientWidth', { configurable: true, value: clientWidth });
        act(() => reports.forEach((report) => report()));
      };

      resize(800, 800);
      expect(box.hasAttribute('tabindex')).toBe(false);
      expect(screen.queryByRole('region')).toBeNull();

      resize(1106, 1006);
      expect(screen.getByRole('region', { name: 'Large trades in the window' })).toBe(box);
      expect(box.tabIndex).toBe(0);

      resize(1006, 1006);
      expect(box.hasAttribute('tabindex')).toBe(false);
      expect(screen.queryByRole('region')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
