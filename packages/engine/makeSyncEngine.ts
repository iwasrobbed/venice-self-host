import * as trpc from '@trpc/server'

import type {
  AnySyncProvider,
  ConnectedSource,
  Link,
  LinkFactory,
  MetaService,
  ZRaw,
} from '@ledger-sync/cdk-core'
import {
  extractId,
  handlersLink,
  makeId,
  makeSyncProvider,
  zId,
  zStandard,
  zWebhookInput,
} from '@ledger-sync/cdk-core'
import type {NonNullableOnly} from '@ledger-sync/util'
import {
  compact,
  identity,
  R,
  routerFromZFunctionMap,
  Rx,
  rxjs,
  splitPrefixedId,
  z,
  zFunction,
} from '@ledger-sync/util'

import {makeMetaLinks} from './makeMetaLinks'
import type {
  ConnectionInput,
  IntegrationInput,
  ParsedConn,
  ParsedInt,
  ParsedPipeline,
  PipelineInput,
  ZInput,
} from './makeSyncParsers'
import {makeSyncParsers} from './makeSyncParsers'
import {sync} from './sync'

export {type inferProcedureInput} from '@trpc/server'

type _inferInput<T> = T extends z.ZodTypeAny ? z.input<T> : never

export interface SyncEngineConfig<
  TProviders extends AnySyncProvider[],
  TLinks extends Record<string, LinkFactory>,
> {
  providers: TProviders
  linkMap?: TLinks

  /** Base url of the router when deployed, e.g. `localhost:3000/api/ledger-sync` */
  routerUrl?: string

  // Figure out why we have to say `Link<any>` here rather than AnyEntityPayload
  getLinksForPipeline?: (pipeline: ParsedPipeline) => Array<Link<any>>

  getDefaultPipeline?: (
    connInput?: ConnectionInput<TProviders[number]>,
  ) => PipelineInput<TProviders[number], TProviders[number], TLinks>
  defaultIntegrations?:
    | Array<IntegrationInput<TProviders[number]>>
    | {
        [k in TProviders[number]['name']]?: _inferInput<
          Extract<TProviders[number], {name: k}>['def']['integrationConfig']
        >
      }
}

export const makeSyncEngine = <
  TProviders extends AnySyncProvider[],
  TLinks extends Record<string, LinkFactory>,
>(
  {
    providers,
    getDefaultPipeline,
    defaultIntegrations,
    getLinksForPipeline,
  }: SyncEngineConfig<TProviders, TLinks>,
  // Consider separating out clientConfigs from serverConfigs...
  /** Used to store metadata */
  metaService: MetaService,
) => {
  // NEXT: Validate defaultDest and defaultIntegrations at init time rather than run time.
  const providerMap = R.mapToObj(providers, (p) => [p.name, p])
  const metaLinks = makeMetaLinks(metaService)

  // TODO: Re-enable me when providers are no longer being constructed client side...
  // Perhaps validating the default pipeline also
  const defaultIntegrationInputs = Array.isArray(defaultIntegrations)
    ? defaultIntegrations
    : R.toPairs(defaultIntegrations ?? {}).map(
        ([name, config]): IntegrationInput => ({
          id: makeId('int', name, ''), // This will end up with an ending `_` is it an issue?
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          config: config as any,
        }),
      )
  /** getDefaultIntegrations will need to change to getIntegrations(forWorkspace) later  */
  const {zInt, zConn, zPipeline, zConnectContext} = makeSyncParsers({
    providers,
    getDefaultPipeline,
    getDefaultConfig: (name, id) =>
      defaultIntegrationInputs.find(
        (i) => (id && i.id === id) || (i.id && extractId(i.id)[1] === name),
      )?.config,
    metaService,
  })

  const getDefaultIntegrations = async () =>
    Promise.all(
      defaultIntegrationInputs.map((input) =>
        zInt.parseAsync(input).catch((err) => {
          console.error('Error initialzing', input, err)
          throw new Error(`Error initializing integration ${input.id} `)
        }),
      ),
    )
  // FIXME...
  // TODO: Remove this entire function. It gets more and more hacky...
  function parsedConn(
    int: ParsedInt,
    cs: ConnectedSource<TProviders[number]['def']>,
  ): ParsedConn {
    const conn: NonNullableOnly<ZRaw['connection'], 'settings'> = {
      id: makeId('conn', int.provider.name, `${cs.externalId}`),
      settings: int.provider.def.connectionSettings?.parse(cs.settings),
      envName: cs.envName,
      integrationId: int.id,
      ledgerId: cs.ledgerId,
    }

    console.log('[parsedConn]', conn)
    const helpers = makeSyncProvider.def.helpers(int.provider.def)
    // Questionable whether this should be the case...
    return {
      ...conn,
      integration: int,
      integrationId: int.id,
      institution: undefined, // FIXME...
      institutionId: undefined,
      // ConnectionUpdates can technically be synced without needing a pipeline at all...
      _source$: cs.source$.pipe(
        // Should we actually start with _opConn? Or let each provider control this
        // and reduce connectedSource to a mere [connectionId, Source] ?
        Rx.startWith(
          helpers._opConn(`${cs.externalId}`, {
            settings: conn.settings,
            institution: cs.institution,
          }),
        ),
      ),
      _destination$$: undefined,
    }
  }

  const syncEngine = {
    // Should we infer the input / return types if possible even without validation?
    health: zFunction([], z.string(), () => 'Ok ' + new Date().toISOString()),

    // MARK: - Metadata  etc

    listIntegrations: zFunction(
      z.object({type: z.enum(['source', 'destination']).nullish()}),
      // z.promise(z.array(z.object({type: z.enum(['source'])}))),
      async ({type}) => {
        const ints = await getDefaultIntegrations()
        return ints
          .map((int) => ({
            // ...int,
            id: int.id,
            provider: int.provider.name,
            isSource: !!int.provider.sourceSync,
            isDestination: !!int.provider.destinationSync,
          }))
          .filter(
            (int) =>
              !type ||
              (type === 'source' && int.isSource) ||
              (type === 'destination' && int.isDestination),
          )
      },
    ),
    searchInstitutions: zFunction(
      z.object({keywords: z.string().nullish()}).optional(),
      async ({keywords} = {}) => {
        const institutions = await metaService.searchInstitutions({
          keywords: keywords?.trim(),
        })
        const ints = await getDefaultIntegrations()
        const intsByProviderName = R.groupBy(ints, (int) => int.provider.name)
        return institutions.flatMap((ins) => {
          const [, providerName, externalId] = splitPrefixedId(ins.id)
          const standard = providerMap[
            providerName
          ]?.standardMappers?.institution?.(ins.external)
          const res = zStandard.institution.omit({id: true}).safeParse(standard)

          if (!res.success) {
            console.error('Invalid institution found', ins, res.error)
            return []
          }
          return (intsByProviderName[providerName] ?? []).map((int) => ({
            ins: {...res.data, id: ins.id, externalId},
            int: {id: int.id},
          }))
        })
      },
    ),
    listConnections: zFunction(
      z.object({ledgerId: zId('ldgr').nullish()}).optional(),
      async ({ledgerId} = {}) => {
        // Add info about what it takes to `reconnect` here for connections which
        // has disconnected
        const connections = await metaService.tables.connection.list({
          ledgerId,
        })
        const insById = R.pipe(
          await metaService.tables.institution.list({
            ids: compact(connections.map((c) => c.institutionId)),
          }),
          (insList) => R.mapToObj(insList, (ins) => [ins.id, ins]),
        )
        return connections.map((conn) => {
          const [, providerName, externalId] = splitPrefixedId(conn.id)
          const mappers = providerMap[providerName]?.standardMappers
          const standardConn = mappers?.connection(conn.settings)
          const standardIns = conn.institutionId
            ? mappers?.institution?.(insById[conn.institutionId]?.external)
            : undefined
          console.log('map connection', {conn, standardConn, standardIns})

          return {
            ...zStandard.connection.omit({id: true}).parse(standardConn),
            id: conn.id,
            externalId,
            institution: conn.institutionId
              ? {
                  ...zStandard.institution.omit({id: true}).parse(standardIns),
                  id: conn.institutionId,
                }
              : undefined,
          }
        })
      },
    ),

    getIntegration: zFunction(zInt, async (int) => ({
      config: int.config,
      provider: int.provider.name,
      id: int.id,
    })),

    // MARK: - Sync

    syncMetadata: zFunction(zInt.nullish(), async (int) => {
      const ints = int ? [int] : await getDefaultIntegrations()
      const stats = await sync({
        source: rxjs.merge(
          ...ints.map(
            (int) =>
              int.provider.metaSync?.({config: int.config}).pipe(
                handlersLink({
                  data: (op) =>
                    rxjs.of({
                      ...op,
                      data: {
                        ...op.data,
                        entity: {
                          external: op.data.entity,
                          standard: int.provider.standardMappers?.institution?.(
                            op.data.entity,
                          ),
                        },
                      },
                    }),
                }),
              ) ?? rxjs.EMPTY,
          ),
        ),
        // This single destination is a bottleneck to us removing
        // prefixed ids from protocol itself
        destination: metaLinks.persistInstitution(),
      })
      return `Synced ${stats} institutions from ${ints.length} providers`
    }),
    syncConnection: zFunction(zConn, async function syncConnection(conn) {
      console.log('[syncConnection]', conn)

      const defaultPipeline = () =>
        getDefaultPipeline?.(
          identity<ZInput['connection']>(conn) as ConnectionInput<
            TProviders[number]
          >,
        )

      const pipelines = await metaService
        .findPipelines({connectionId: conn.id})
        .then((pipes) => (pipes.length ? pipes : compact([defaultPipeline()])))
        .then((pipes) => Promise.all(pipes.map((p) => zPipeline.parseAsync(p))))

      await Promise.all(
        pipelines.map((pipe) =>
          syncEngine.syncPipeline.impl({
            ...pipe,
            // TODO: How do we refactor to get rid of _source$ and _destination$$
            source: {...pipe.source, _source$: conn._source$},
            destination: {
              ...pipe.destination,
              _destination$$: conn._destination$$,
            },
          }),
        ),
      )
    }),
    syncPipeline: zFunction(zPipeline, async function syncPipeline(pipeline) {
      console.log('[syncPipeline]', pipeline)
      const {
        source: src,
        links: links,
        destination: dest,
        watch,
        ...rest
      } = pipeline
      const source$ =
        src._source$ ??
        src.integration.provider.sourceSync?.({
          config: src.integration.config,
          settings: src.settings,
          options: rest.sourceOptions,
        })

      const destination$$ =
        dest._destination$$ ??
        dest.integration.provider.destinationSync?.({
          config: dest.integration.config,
          settings: dest.settings,
          options: rest.destinationOptions,
        })

      if (!source$) {
        throw new Error(`${src.integration.provider.name} is not a source`)
      }
      if (!destination$$) {
        throw new Error(
          `${dest.integration.provider.name} is not a destination`,
        )
      }

      await sync({
        // Raw Source, may come from fs, firestore or postgres
        source: source$.pipe(
          // logLink({prefix: 'postSource', verbose: true}),
          metaLinks.postSource({src}),
        ),
        links: getLinksForPipeline?.(pipeline) ?? links,
        // WARNING: It is insanely unclear to me why moving `metaLinks.link`
        // to after provider.destinationSync makes all the difference.
        // When syncing from firebase with a large number of docs,
        // we always seem to stop after 1600 or so documents.
        // I already checked this is because metaLinks.link runs a async comment
        // even delay(100) introduces issues.
        // It's worth trying to reproduce this with say a simple counter source and see if
        // it happens...
        destination: rxjs.pipe(
          destination$$,
          metaLinks.postDestination({pipeline, dest}),
        ),
        watch,
      })
    }),

    // MARK: - Connect lifecycle

    // SessionID would be awfully handy here...
    preConnect: zFunction(
      [zInt, zConnectContext],
      ({provider: p, config}, ctx) => p.preConnect?.(config, ctx),
    ),
    // useConnectHook happens client side only
    // for cli usage, can just call `postConnect` directly. Consider making the
    // flow a bit smoother with a guided cli flow
    postConnect: zFunction(
      // Questionable why `zConnectContext` should be there. Examine whether this is actually
      // needed
      [z.unknown(), zInt, zConnectContext],
      // How do we verify that the ledgerId here is the same as the ledgerId from preConnectOption?
      async (input, int, ctx) => {
        const {provider: p, config} = int
        console.log('didConnect start', p.name, input)
        if (!p.postConnect || !p.def.connectOutput) {
          return 'Noop'
        }
        const cs = await p.postConnect(
          p.def.connectOutput.parse(input),
          config,
          ctx,
        )

        await syncEngine.syncConnection.impl(parsedConn(int, {...cs, ...ctx}))

        console.log('didConnect finish', p.name, input)
        return 'Connection Success'
      },
    ),
    handleWebhook: zFunction([zInt, zWebhookInput], async (int, input) => {
      if (!int.provider.def.webhookInput || !int.provider.handleWebhook) {
        console.warn(`${int.provider.name} does not handle webhooks`)
        return
      }
      const res = await int.provider.handleWebhook(
        int.provider.def.webhookInput.parse(input),
        int.config,
      )
      // await Promise.all(
      //   csArray.map((cs) =>
      //     syncEngine.syncConnection.impl(parsedConn(int, cs)),
      //   ),
      // )
      return res.response?.body
    }),
    // What about delete? Should this delete also? Or soft delete?
    revokeConnection: zFunction(
      zConn,
      async ({settings, integration: {provider, config}}) =>
        provider.revokeConnection?.(settings, config),
    ),
  }

  // TODO: Figure out how to decouple makeRouter from here once we can figure
  // out how the types work...
  const makeRouter = () => trpc.router()

  // This is a single function for now because we can't figure out how to type
  // makeLedgerSyncNextRouter separately
  const router = routerFromZFunctionMap(makeRouter(), syncEngine)

  // router.createCaller().query('connectionsget')
  return [syncEngine, router, metaService] as const
}

/** Only purpose of this is to support type inference */
makeSyncEngine.config = <
  TProviders extends AnySyncProvider[],
  TLinks extends Record<string, LinkFactory>,
>(
  config: SyncEngineConfig<TProviders, TLinks>,
) => config
