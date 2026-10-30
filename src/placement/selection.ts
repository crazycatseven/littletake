export type SelectionMode = 'replace' | 'toggle' | 'append';

/** Editor-only state. The last selected object is the active Inspector target. */
export class EditorSelection {
  ids: string[] = [];
  anchor: string | null = null;
  constructor(id: string | null) { this.active = id; }
  get active(): string | null { return this.ids.at(-1) ?? null; }
  set active(id: string | null) { this.set(id ? [id] : []); }
  set(ids: string[], mode: SelectionMode = 'replace'): void {
    const next = new Set(mode === 'replace' ? [] : this.ids);
    for (const id of ids) {
      if (mode === 'toggle' && next.has(id)) next.delete(id);
      else { next.delete(id); next.add(id); }
    }
    this.ids = [...next];
    this.anchor = ids.at(-1) ?? this.active;
  }
  range(id: string, order: string[], append = false): void {
    const start = order.indexOf(this.anchor ?? id), end = order.indexOf(id);
    if (start < 0 || end < 0) { this.set([id]); return; }
    const anchor = this.anchor;
    this.set(order.slice(Math.min(start, end), Math.max(start, end) + 1).filter(value => value !== id).concat(id), append ? 'append' : 'replace');
    this.anchor = anchor;
  }
  retain(ids: string[]): void {
    const valid = new Set(ids);
    this.ids = this.ids.filter(id => valid.has(id));
    if (this.anchor && !valid.has(this.anchor)) this.anchor = this.active;
  }
}
