import { Module } from '@nestjs/common';

import { AccessPolicyService } from './access-policy.service.js';
import { RelationsRepository } from './relations.repository.js';

@Module({
  providers: [RelationsRepository, AccessPolicyService],
  exports: [AccessPolicyService],
})
export class PoliciesModule {}
