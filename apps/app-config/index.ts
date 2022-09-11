import {makePostgresMetaService} from '@ledger-sync/core-integration-postgres'
import {
  type inferProcedureInput,
  makeSyncEngine,
} from '@ledger-sync/engine-backend'

import {getEnv, ledgerSyncConfig} from './ledgerSync.config'

export * from '@ledger-sync/cdk-core'
export {
  parseWebhookRequest,
  type inferProcedureInput,
} from '@ledger-sync/engine-backend'
export * from './constants'
export * from './ledgerSync.config'

export const [ledgerSync, ledgerSyncRouter, ledgerSyncMetaStore] =
  makeSyncEngine(
    ledgerSyncConfig,
    makePostgresMetaService({
      databaseUrl: getEnv('POSTGRES_URL'),
    }),
  )
export type LedgerSyncRouter = typeof ledgerSyncRouter
export type LedgerSyncInput = inferProcedureInput<
  LedgerSyncRouter['_def']['mutations']['syncPipeline']
>[0]
