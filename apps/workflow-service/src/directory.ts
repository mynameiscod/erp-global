import { Inject, Injectable } from '@nestjs/common';
import type { ApproverSpec, Recipient } from '@erp/metadata';
import { UpstreamError } from '@erp/service-kit';
import { CLIENTS, type Clients, type RecordInfo, type UserInfo } from './clients';

/**
 * Who is who: users, their roles, managers, delegates and unit heads, read from
 * identity, access and org services. Everything here is per request; nothing is cached
 * across requests, so changes (a new manager, a new head) apply at once.
 */
@Injectable()
export class Directory {
  constructor(@Inject(CLIENTS) private readonly clients: Clients) {}

  async users(ids: string[]): Promise<Map<string, UserInfo>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map();
    const list = await this.clients.identity.post<UserInfo[]>('/internal/users/batch', {
      ids: unique,
    });
    return new Map(list.map((u) => [u.id, u]));
  }

  async user(id: string): Promise<UserInfo | undefined> {
    return (await this.users([id])).get(id);
  }

  /** Role names and keys of a user, for HAS_ROLE(), and the role ids with where they hold them. */
  async roles(userId: string) {
    const list = await this.clients.access.get<
      { roleId: string; name: string; key: string | null; path: string }[]
    >(`/internal/access/users/${userId}/roles`);
    return {
      names: [...new Set(list.flatMap((r) => [r.name, r.key ?? '']).filter(Boolean))],
      /** Role ids the user holds at `path` or above it; anywhere for company-wide records. */
      idsAt: (path: string) =>
        new Set(list.filter((r) => path === '/' || path.startsWith(r.path)).map((r) => r.roleId)),
      /** The same, as role keys (pack roles). */
      keysAt: (path: string) =>
        new Set(
          list.filter((r) => r.key && (path === '/' || path.startsWith(r.path))).map((r) => r.key!),
        ),
    };
  }

  /** Codes of the unit and every unit above it, for IN_UNIT(). */
  async unitCodes(orgUnitId: string | null): Promise<string[]> {
    if (!orgUnitId) return [];
    const units = await this.ancestors(orgUnitId);
    return units.map((u) => u.code ?? '').filter(Boolean);
  }

  private async ancestors(orgUnitId: string) {
    try {
      return await this.clients.org.get<
        { id: string; code: string | null; headUserId: string | null }[]
      >(`/internal/org/units/${orgUnitId}/ancestors`);
    } catch (e) {
      if (e instanceof UpstreamError && e.status === 404) return [];
      throw e;
    }
  }

  /** Who may act for `userId` right now (out of office), if anyone. */
  async delegateOf(userId: string): Promise<string | null> {
    const res = await this.clients.identity.get<{ toUserId: string | null }>(
      `/internal/users/${userId}/delegate`,
    );
    return res.toUserId;
  }

  /** Users whose approvals `userId` may act on right now. */
  async delegatorsOf(userId: string): Promise<string[]> {
    return this.clients.identity.get<string[]>(`/internal/users/${userId}/delegators`);
  }

  /**
   * Resolves approvers or recipients for a record to active user ids.
   * `requesterId` is the person who raised the request (for "manager").
   */
  async resolve(
    specs: (ApproverSpec | Recipient)[],
    record: RecordInfo,
    requesterId: string,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const s of specs) {
      switch (s.type) {
        case 'users':
          ids.push(...s.userIds);
          break;
        case 'creator':
          ids.push(requesterId);
          break;
        case 'field': {
          const v = record.data[s.field];
          if (typeof v === 'string') ids.push(v);
          else if (Array.isArray(v))
            ids.push(...v.filter((x): x is string => typeof x === 'string'));
          break;
        }
        case 'manager': {
          const requester = await this.user(requesterId);
          if (requester?.managerId) ids.push(requester.managerId);
          break;
        }
        case 'unit_head': {
          if (!record.orgUnitId) break;
          const units = await this.ancestors(record.orgUnitId);
          const head = [...units].reverse().find((u) => u.headUserId);
          if (head?.headUserId) ids.push(head.headUserId);
          break;
        }
        case 'role': {
          const path = record.orgPath && record.orgPath !== '/' ? record.orgPath : undefined;
          // Company-wide records: the holders nearest the top of the org tree.
          const res = await this.clients.access.get<{ userIds: string[] }>(
            `/internal/access/role-holders?${s.roleId ? `roleId=${s.roleId}` : `roleKey=${s.roleKey}`}${path ? `&path=${encodeURIComponent(path)}` : ''}`,
          );
          ids.push(...res.userIds);
          break;
        }
      }
    }
    const users = await this.users(ids);
    return [...new Set(ids)].filter((id) => users.get(id)?.status === 'active');
  }
}
