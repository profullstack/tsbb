import type {
  ActionHandler,
  ActionMap,
  ActionName,
  FilterHandler,
  FilterMap,
  FilterName,
  SlotHandler,
  SlotMap,
  SlotName,
  SlotNode,
} from '@tsbb/plugin-api';

type Entry = { slug: string; weight: number; handler: unknown };

function byWeight(a: Entry, b: Entry): number {
  return a.weight - b.weight;
}

/**
 * The hook bus.
 *
 * Failure policy differs by mechanism, on purpose:
 *
 *   filters  a throwing handler is skipped and the previous value carries on,
 *            because a broken plugin must not be able to blank a page.
 *   actions  run concurrently; a rejection is logged and swallowed, because
 *            nothing downstream is waiting on it.
 *   slots    a throwing handler contributes nothing. Same reasoning as filters.
 *
 * In every case the error is reported against the plugin's slug, so the admin
 * panel can show which plugin is misbehaving instead of a stack trace with no
 * owner.
 */
export class HookBus {
  #filters = new Map<string, Entry[]>();
  #actions = new Map<string, Entry[]>();
  #slots = new Map<string, Entry[]>();
  #onError: (slug: string, hook: string, error: unknown) => void;

  constructor(onError?: (slug: string, hook: string, error: unknown) => void) {
    this.#onError =
      onError ??
      ((slug, hook, error) => {
        console.error(`[plugin:${slug}] ${hook} failed:`, error);
      });
  }

  addFilter<K extends FilterName>(slug: string, hook: K, handler: FilterHandler<K>, weight = 0) {
    push(this.#filters, hook, { slug, weight, handler });
  }

  addAction<K extends ActionName>(slug: string, hook: K, handler: ActionHandler<K>) {
    push(this.#actions, hook, { slug, weight: 0, handler });
  }

  addSlot<K extends SlotName>(slug: string, name: K, handler: SlotHandler<K>, weight = 0) {
    push(this.#slots, name, { slug, weight, handler });
  }

  /** Drop everything a plugin registered. Used when it is disabled or reloaded. */
  removePlugin(slug: string): void {
    for (const map of [this.#filters, this.#actions, this.#slots]) {
      for (const [key, entries] of map) {
        const kept = entries.filter((e) => e.slug !== slug);
        if (kept.length) map.set(key, kept);
        else map.delete(key);
      }
    }
  }

  hasFilter(hook: FilterName): boolean {
    return (this.#filters.get(hook)?.length ?? 0) > 0;
  }

  async applyFilter<K extends FilterName>(
    hook: K,
    value: FilterMap[K]['value'],
    ctx: FilterMap[K]['ctx'],
  ): Promise<FilterMap[K]['value']> {
    const entries = this.#filters.get(hook);
    if (!entries?.length) return value;
    let current = value;
    for (const entry of entries) {
      try {
        current = await (entry.handler as FilterHandler<K>)(current, ctx);
      } catch (error) {
        this.#onError(entry.slug, hook, error);
      }
    }
    return current;
  }

  async emit<K extends ActionName>(hook: K, payload: ActionMap[K]): Promise<void> {
    const entries = this.#actions.get(hook);
    if (!entries?.length) return;
    await Promise.all(
      entries.map(async (entry) => {
        try {
          await (entry.handler as ActionHandler<K>)(payload);
        } catch (error) {
          this.#onError(entry.slug, hook, error);
        }
      }),
    );
  }

  /**
   * Render a slot. Handlers run concurrently because none of them can see each
   * other's output, then the results are ordered by weight so the page is
   * stable regardless of how the network behaved.
   */
  async renderSlot<K extends SlotName>(name: K, props: SlotMap[K]): Promise<string> {
    const entries = this.#slots.get(name);
    if (!entries?.length) return '';
    const parts = await Promise.all(
      entries.map(async (entry) => {
        try {
          const node = await (entry.handler as SlotHandler<K>)(props);
          return nodeToHtml(node);
        } catch (error) {
          this.#onError(entry.slug, `slot:${name}`, error);
          return '';
        }
      }),
    );
    return parts.join('');
  }

  /** What is registered where, for the admin panel's plugin detail page. */
  inventory(): { hook: string; kind: 'filter' | 'action' | 'slot'; slugs: string[] }[] {
    const rows: { hook: string; kind: 'filter' | 'action' | 'slot'; slugs: string[] }[] = [];
    const collect = (map: Map<string, Entry[]>, kind: 'filter' | 'action' | 'slot') => {
      for (const [hook, entries] of map) {
        rows.push({ hook, kind, slugs: entries.map((e) => e.slug) });
      }
    };
    collect(this.#filters, 'filter');
    collect(this.#actions, 'action');
    collect(this.#slots, 'slot');
    return rows.sort((a, b) => a.hook.localeCompare(b.hook));
  }
}

function push(map: Map<string, Entry[]>, key: string, entry: Entry): void {
  const entries = map.get(key) ?? [];
  entries.push(entry);
  entries.sort(byWeight);
  map.set(key, entries);
}

function nodeToHtml(node: SlotNode): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  return String(node);
}
