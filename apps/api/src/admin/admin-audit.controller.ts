import { Controller, Get, Query } from '@nestjs/common';
import {
  type AuditChainStatus,
  type AuditEntry,
  type AuditQuery,
  AuditQuerySchema,
  type Page,
} from '@cip/contracts';
import { AuditService } from '../audit/audit.service.js';
import { Access } from '../common/access.js';
import { ZodPipe } from '../common/zod.pipe.js';

@Controller('admin/audit')
@Access('audit.view')
export class AdminAuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query(new ZodPipe(AuditQuerySchema)) query: AuditQuery): Promise<Page<AuditEntry>> {
    return this.audit.query(query);
  }

  /** Walks the hash chain; `ok: false` names the first row that does not verify. */
  @Get('verify')
  verify(): Promise<AuditChainStatus> {
    return this.audit.verifyChain();
  }
}
