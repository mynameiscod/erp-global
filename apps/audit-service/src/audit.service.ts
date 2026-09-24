import { Inject, Injectable } from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import type { EventEnvelope } from '@erp/contracts';
import { paginate, TENANT_DATABASES } from '@erp/service-kit';
import type { TenantDatabases } from '@erp/tenancy';
import { chainHash, GENESIS_HASH, redact, type ChainFields } from './chain';
import { AuditHeadModel, AuditRecordModel, type AuditRecord } from './models';

export interface VerifyResult {
  valid: boolean;
  records: number;
  headSeq: number;
  brokenAt?: { seq: number; reason: string };
}

function fieldsOf(r: AuditRecord): ChainFields {
  return {
    tenantId: r.tenantId,
    seq: r.seq,
    eventId: r.eventId,
    type: r.type,
    source: r.source,
    actor: { type: r.actor.type, id: r.actor.id },
    occurredAt: r.occurredAt,
    recordedAt: r.recordedAt,
    correlationId: r.correlationId,
    payload: r.payload,
  };
}

function toDto(r: AuditRecord) {
  return {
    seq: r.seq,
    eventId: r.eventId,
    type: r.type,
    source: r.source,
    actor: r.actor,
    occurredAt: r.occurredAt,
    recordedAt: r.recordedAt,
    correlationId: r.correlationId ?? null,
    payload: r.payload,
    hash: r.hash,
  };
}

@Injectable()
export class AuditService {
  constructor(@Inject(TENANT_DATABASES) private readonly dbs: TenantDatabases) {}

  /** Appends one event to its tenant's chain. Runs inside the consumer's transaction. */
  async append(event: EventEnvelope, session: ClientSession): Promise<void> {
    const [Records, Heads] = await Promise.all([
      this.dbs.model(AuditRecordModel),
      this.dbs.model(AuditHeadModel),
    ]);
    const head = await Heads.findOne({}, null, { session }).lean();
    const seq = (head?.seq ?? 0) + 1;
    const prevHash = head?.hash ?? GENESIS_HASH;
    const fields: ChainFields = {
      tenantId: event.tenantId,
      seq,
      eventId: event.eventId,
      type: event.type,
      source: event.source,
      actor: { type: event.actor.type, id: event.actor.id },
      occurredAt: event.occurredAt,
      recordedAt: new Date().toISOString(),
      correlationId: event.correlationId,
      payload: redact(event.payload ?? null),
    };
    const hash = chainHash(prevHash, fields);
    await Records.create([{ ...fields, prevHash, hash }], { session });
    if (head) {
      // The seq condition makes a concurrent writer fail and retry instead of forking the chain.
      const res = await Heads.updateOne({ seq: head.seq }, { $set: { seq, hash } }, { session });
      if (res.modifiedCount !== 1) throw new Error('Audit chain head moved; retrying');
    } else {
      await Heads.create([{ seq, hash }], { session });
    }
  }

  async list(query: {
    type?: string;
    actorId?: string;
    from?: string;
    to?: string;
    page: number;
    pageSize: number;
  }) {
    const filter: Record<string, unknown> = {};
    if (query.type) filter.type = query.type;
    if (query.actorId) filter['actor.id'] = query.actorId;
    if (query.from || query.to) {
      filter.occurredAt = {
        ...(query.from && { $gte: query.from }),
        ...(query.to && { $lte: query.to }),
      };
    }
    return paginate(
      await this.dbs.model(AuditRecordModel),
      filter,
      { page: query.page, pageSize: query.pageSize, sort: { seq: -1 } },
      toDto,
    );
  }

  /**
   * Recomputes the chain from the first record. Detects edited records,
   * deleted or inserted records (sequence gaps) and a truncated tail (head mismatch).
   */
  async verify(): Promise<VerifyResult> {
    const [Records, Heads] = await Promise.all([
      this.dbs.model(AuditRecordModel),
      this.dbs.model(AuditHeadModel),
    ]);
    const head = await Heads.findOne().lean();
    let prevHash = GENESIS_HASH;
    let expected = 1;
    let count = 0;
    const broken = (seq: number, reason: string): VerifyResult => ({
      valid: false,
      records: count,
      headSeq: head?.seq ?? 0,
      brokenAt: { seq, reason },
    });

    for await (const r of Records.find().sort({ seq: 1 }).lean().cursor({ batchSize: 500 })) {
      if (r.seq !== expected) return broken(expected, 'missing record');
      if (r.prevHash !== prevHash) return broken(r.seq, 'link to previous record does not match');
      if (chainHash(prevHash, fieldsOf(r)) !== r.hash)
        return broken(r.seq, 'record content was changed');
      prevHash = r.hash;
      expected++;
      count++;
    }
    const headSeq = head?.seq ?? 0;
    if (headSeq !== count || (head && head.hash !== prevHash)) {
      return broken(count + 1, 'records after the last verified one are missing');
    }
    return { valid: true, records: count, headSeq };
  }
}
