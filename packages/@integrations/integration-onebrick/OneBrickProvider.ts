import React from 'react'

import type {SyncOperation} from '@ledger-sync/cdk-core';
import { zId} from '@ledger-sync/cdk-core'
import {makeSyncProvider, zWebhookInput} from '@ledger-sync/cdk-core'
import {ledgerSyncProviderBase, makePostingsMap} from '@ledger-sync/cdk-ledger'
import {
  A,
  Deferred,
  identity,
  md5Hash,
  parseMoney,
  Rx,
  rxjs,
  z,
} from '@ledger-sync/util'

import {
  accountItemSchema,
  makeOneBrickClient,
  transactionBrickSchema,
  zOneBrickConfig,
} from './OneBrickClient'

const connectInputSchema = z.object({
  publicToken: z.string().nullish(),
  redirect_url: z.string().nullish(),
})

type OnebrickEntity = z.infer<typeof def['sourceOutputEntity']>
type OnebrickSyncOperation = SyncOperation<OnebrickEntity>

const zOneBrickWebhookBody = z.object({
  accessToken: z.string(),
  bankId: z.string().nullish(),
  userId: z.string().nullish(),
})

const def = makeSyncProvider.def({
  ...ledgerSyncProviderBase.def,
  name: z.literal('onebrick'),
  integrationConfig: zOneBrickConfig,
  connectionSettings: z.object({accessToken: z.string()}),
  connectInput: connectInputSchema,
  connectOutput: z.object({
    publicToken: z.string(),
  }),
  sourceOutputEntity: z.discriminatedUnion('entityName', [
    z.object({
      id: z.string(),
      entityName: z.literal('account'),
      entity: accountItemSchema,
    }),
    z.object({
      id: z.string(),
      entityName: z.literal('transaction'),
      entity: transactionBrickSchema,
    }),
  ]),
  webhookInput: zWebhookInput,
})

export const oneBrickProvider = makeSyncProvider({
  ...ledgerSyncProviderBase(def, {
    sourceMapEntity: (data) => {
      if (data.entityName === 'account') {
        const a = data.entity
        return {
          id: a.accountId,
          entityName: 'account',
          entity: {
            name: a.accountHolder,
            type: 'asset/digital_wallet',
            institutionName: a.type,
            informationalBalances: {
              current: A(
                parseMoney((a.balances.current ?? 0).toString()),
                a.currency.toUpperCase(),
              ),
            },
            defaultUnit: a.currency as Unit,
          },
        }
      }
      if (data.entityName === 'transaction') {
        const t = data.entity
        return {
          id: t.reference_id,
          entityName: 'transaction',
          entity: {
            date: t.date,
            description: data.entity.description,
            externalCategory: data.entity.category.category_name,
            // TODO: Check how merchant_id maps to payee
            postingsMap: makePostingsMap({
              main: {
                accountExternalId: data.entity.account_id as Id.external,
                amount: A(
                  data.entity.amount * (t.direction === 'in' ? 1 : -1),
                  (data.entity.account_currency ?? 'IDR') as Unit,
                ),
              },
            }),
          },
        }
      }
      return null
    },
  }),
  preConnect: (config, {envName}) =>
    Promise.resolve({
      publicToken: config.secrets[envName as 'production' | 'sandbox'],
      redirect_url: config.redirectUrl,
    }),
  useConnectHook: (_) => {
    const [options, setOptions] = React.useState<
      z.infer<typeof connectInputSchema>
    >({publicToken: undefined, redirect_url: undefined})
    const [deferred] = React.useState(
      new Deferred<typeof def['_types']['connectOutput']>(),
    )
    React.useEffect(() => {
      if (options.publicToken && options.redirect_url) {
        window.open(
          `https://cdn.onebrick.io/sandbox-widget/?accessToken=${options.publicToken}&redirect_url=${options.redirect_url}/api/webhook/onebrick`,
          'popup',
        )
      }
    }, [options])
    return (opts) => {
      setOptions({
        publicToken: opts.publicToken,
        redirect_url: opts.redirect_url,
      })
      return deferred.promise
    }
  },

  sourceSync: ({settings, config}) => {
    const client = makeOneBrickClient({
      ...config,
      accessToken: settings.accessToken,
    })
    async function* iterateEntities() {
      const res = await client.getAccountList({
        accessToken: settings.accessToken,
      })
      yield res.map((a) =>
        _op({
          type: 'data',
          data: {id: a.accountId, entity: a, entityName: 'account'},
        }),
      )

      const res2 = await client.getTransactions({
        accessToken: settings.accessToken,
      })
      yield res2.map((t) =>
        _op({
          type: 'data',
          data: {id: t.reference_id, entity: t, entityName: 'transaction'},
        }),
      )
    }

    return rxjs
      .from(iterateEntities())
      .pipe(Rx.mergeMap((ops) => rxjs.from([...ops, _op({type: 'commit'})])))
  },

  handleWebhook: (input, config) => {
    const {accessToken, userId} = zOneBrickWebhookBody.parse(input.body)
    // Get the bank detail using bankId so we can put it up there

    // rxjs.of(input.body as any).pipe(
    //   Rx.mergeMap((res: OnebrickRedirect) => {
    //     const conn = identity<z.infer<typeof base['connectionSettings']>>({
    //       ...safeJSONParse(safeJSONParse(process.env['ONEBRICK_CREDENTIALS'])),
    //       accessToken: res.accessToken,
    //     })
    //     const sync$: rxjs.Observable<OnebrickSyncOperation> =
    //       oneBrickProvider.sourceSync(conn)
    //     return rxjs.concat(sync$)
    //   }),
    // ),
    const settings = def.connectionSettings.parse({accessToken})

    const sync$: rxjs.Observable<OnebrickSyncOperation> =
      oneBrickProvider.sourceSync({settings, config, options: {}})

    return [
      {
        connectionExternalId: md5Hash(accessToken),
        settings,
        ledgerId: zId('ldgr').parse(userId),
        source$: sync$,
        triggerSync: true,
      },
    ]

    // return rxjs.concat(
    //   rxjs.of(
    //     def._op('connUpdate', {
    //       // TODO: Figure out if accessToken is actually the only unique thing about
    //       // onebrick connection, and whether they could be rotated...
    //       id: `conn_onebrick_${md5Hash(accessToken)}`,
    //       settings,
    //     }),
    //   ),
    //   sync$,
    // )
  },
})

const _op: typeof identity<OnebrickSyncOperation> = identity
