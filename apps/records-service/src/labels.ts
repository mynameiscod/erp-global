import type { Model } from 'mongoose';
import { pickText, workflowFor, type EffectiveConfig, type FieldDef } from '@erp/metadata';
import type { Clients } from './clients';
import type { RecordDoc } from './models';

const ID_RE = /^[a-f0-9]{24}$/;

/** What a value refers to, when it needs a label from somewhere else. */
export type LabelKind =
  | { kind: 'record'; entity: string }
  | { kind: 'user' }
  | { kind: 'org_unit' }
  | { kind: 'option'; picklist: string }
  | { kind: 'status'; entity: string };

/** The label kind for a field type, or undefined for values shown as they are. */
export function labelKindFor(
  type: string,
  field: FieldDef | undefined,
  entity: string,
): LabelKind | undefined {
  if (type === 'user') return { kind: 'user' };
  if (type === 'org_unit') return { kind: 'org_unit' };
  if (type === 'status') return { kind: 'status', entity };
  if (!field) return undefined;
  if ((type === 'select' || type === 'multiselect') && field.picklist)
    return { kind: 'option', picklist: field.picklist };
  if (type === 'lookup' || type === 'lookup_many') {
    if (field.target === 'user') return { kind: 'user' };
    if (field.target === 'org_unit') return { kind: 'org_unit' };
    if (field.target) return { kind: 'record', entity: field.target };
  }
  return undefined;
}

/**
 * Collects values that need labels, then resolves them in a few batch calls:
 * titles of linked records, user and org unit names, option and state labels.
 */
export class Labeler {
  private readonly wanted = new Map<string, Set<string>>();
  private readonly resolved = new Map<string, Map<string, string>>();

  constructor(
    private readonly cfg: EffectiveConfig,
    private readonly lang: string,
    private readonly clients: Pick<Clients, 'identity' | 'org'>,
    private readonly records: Model<RecordDoc>,
  ) {}

  private bucket(k: LabelKind): string {
    return k.kind === 'record'
      ? `record:${k.entity}`
      : k.kind === 'option'
        ? `option:${k.picklist}`
        : k.kind === 'status'
          ? `status:${k.entity}`
          : k.kind;
  }

  add(k: LabelKind | undefined, value: unknown): void {
    if (!k || value === null || value === undefined || value === '') return;
    const values = Array.isArray(value) ? value : [value];
    const b = this.bucket(k);
    let set = this.wanted.get(b);
    if (!set) this.wanted.set(b, (set = new Set()));
    for (const v of values) set.add(String(v));
  }

  async resolve(): Promise<void> {
    await Promise.all(
      [...this.wanted].map(async ([b, set]) => {
        const ids = [...set];
        const out = new Map<string, string>();
        const [kind, arg] = b.split(':');
        if (kind === 'option') {
          const list = this.cfg.picklists.find((p) => p.key === arg);
          for (const o of list?.options ?? []) out.set(o.value, pickText(o.label, this.lang));
        } else if (kind === 'status') {
          const wf = workflowFor(this.cfg, arg);
          for (const s of wf?.states ?? []) out.set(s.key, pickText(s.label, this.lang));
        } else if (kind === 'user') {
          const valid = ids.filter((i) => ID_RE.test(i));
          if (valid.length) {
            const users = await this.clients.identity.post<{ id: string; name: string }[]>(
              '/internal/users/batch',
              { ids: valid },
            );
            for (const u of users) out.set(u.id, u.name);
          }
        } else if (kind === 'org_unit') {
          const valid = ids.filter((i) => ID_RE.test(i));
          if (valid.length) {
            const units = await this.clients.org.post<{ id: string; name: string }[]>(
              '/internal/org/units/batch',
              { ids: valid },
            );
            for (const u of units) out.set(u.id, u.name);
          }
        } else if (kind === 'record') {
          const target = this.cfg.entities.find((e) => e.key === arg);
          const valid = ids.filter((i) => ID_RE.test(i));
          if (valid.length) {
            const docs = await this.records
              .find({ _id: { $in: valid }, entity: arg }, { number: 1, data: 1 })
              .lean<Pick<RecordDoc, '_id' | 'number' | 'data'>[]>();
            for (const d of docs) {
              const title = target?.titleField ? d.data?.[target.titleField] : undefined;
              out.set(String(d._id), String(title ?? d.number ?? d._id));
            }
          }
        }
        this.resolved.set(b, out);
      }),
    );
  }

  /** The label of a value (joined for lists); the value itself when there is no label. */
  label(k: LabelKind | undefined, value: unknown): string {
    if (value === null || value === undefined) return '';
    if (!k) return String(value);
    const map = this.resolved.get(this.bucket(k));
    const one = (v: unknown) => map?.get(String(v)) ?? String(v);
    return Array.isArray(value) ? value.map(one).join(', ') : one(value);
  }
}
