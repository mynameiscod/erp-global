import type { FilterQuery, Model, SortOrder } from 'mongoose';
import type { Page } from '@erp/contracts';

export async function paginate<T, R = T>(
  model: Model<T>,
  filter: FilterQuery<T>,
  opts: { page: number; pageSize: number; sort?: Record<string, SortOrder> },
  map: (doc: T) => R = (d) => d as unknown as R,
): Promise<Page<R>> {
  const [items, total] = await Promise.all([
    model
      .find(filter)
      .sort(opts.sort ?? { _id: -1 })
      .skip((opts.page - 1) * opts.pageSize)
      .limit(opts.pageSize)
      .lean<T[]>(),
    model.countDocuments(filter),
  ]);
  return { items: items.map(map), total, page: opts.page, pageSize: opts.pageSize };
}
