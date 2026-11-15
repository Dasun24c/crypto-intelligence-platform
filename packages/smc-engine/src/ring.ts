/** A ring's contents for checkpoints: the retained items, oldest first. */
export interface RingState<T> {
  capacity: number;
  /** Index of the oldest retained item. */
  start: number;
  items: T[];
}

/**
 * The last `capacity` items of a sequence, addressed by their index in the whole sequence (the
 * candle number on a timeframe), so look-backs read `get(n - k)`.
 */
export class Ring<T> {
  private readonly items: (T | undefined)[];
  private start = 0;
  private end = 0;

  constructor(readonly capacity: number) {
    if (!(Number.isInteger(capacity) && capacity > 0)) throw new RangeError('ring capacity must be positive');
    this.items = new Array<T | undefined>(capacity);
  }

  /** Index of the oldest retained item. */
  get first(): number {
    return this.start;
  }

  /** Index the next item gets (the number pushed so far). */
  get next(): number {
    return this.end;
  }

  push(item: T): number {
    const index = this.end;
    this.items[index % this.capacity] = item;
    this.end++;
    if (this.end - this.start > this.capacity) this.start++;
    return index;
  }

  /** The item at `index`, or undefined when it is not retained. */
  get(index: number): T | undefined {
    return index >= this.start && index < this.end ? this.items[index % this.capacity] : undefined;
  }

  /** Whether every index in [from, to] is retained. */
  holds(from: number, to: number): boolean {
    return from >= this.start && to < this.end && from <= to;
  }

  snapshot(): RingState<T> {
    const items: T[] = [];
    for (let i = this.start; i < this.end; i++) items.push(this.items[i % this.capacity]!);
    return { capacity: this.capacity, start: this.start, items };
  }

  static restore<T>(state: RingState<T>): Ring<T> {
    const ring = new Ring<T>(state.capacity);
    if (state.items.length > state.capacity) throw new RangeError('ring state holds more than its capacity');
    ring.start = state.start;
    ring.end = state.start;
    for (const item of state.items) {
      ring.items[ring.end % ring.capacity] = item;
      ring.end++;
    }
    return ring;
  }
}
