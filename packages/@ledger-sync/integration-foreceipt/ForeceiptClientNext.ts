import {
  createHTTPClient,
  HTTPError,
  Rx,
  rxjs,
  z,
  zCast,
  zFunction,
} from '@ledger-sync/util'
import {
  authUpdateCurrentUserFromJSON,
  getQuerySnapshot$,
  initFirebase,
  // zAuthUserJson,
  // zFirebaseConfig,
} from '@ledger-sync/core-integration-firebase'
import firebase from 'firebase/compat/app'

class ForeceiptError extends Error {
  override name = 'ForeceiptError'

  constructor(
    public readonly data: unknown,
    public readonly originalError: HTTPError,
  ) {
    super(originalError.message)
    Object.setPrototypeOf(this, ForeceiptError.prototype)
  }
}
interface ForeceiptClientOptions {
  /** Should be received by caller */
  onRefreshCredentials?: (credentials: Foreceipt.Credentials) => void
}
export const zForeceiptConfig = z.object({
  credentials: zCast<Readonly<Foreceipt.Credentials>>(),
  options: zCast<ForeceiptClientOptions>(),
  _id: zCast<Id.external>(),
})
export const makeForeceiptClient = zFunction(zForeceiptConfig, (cfg) => {
  const patchCredentials = (partial: Partial<Foreceipt.Credentials>) => {
    cfg.credentials = {...cfg.credentials, ...partial}
    // cfg.options.onRefreshCredentials?.(cfg.credentials)
  }
  const fbaConfig = {
    // @ts-ignore
    apiUrl: 'https://api.foreceipt.io/v1/receipt',
    apiKey: 'AIzaSyCWLdIMQO_A_WGhP_gh8IzSEv2_HbOvdAs',
    authDomain: 'app.foreceipt.com',
    databaseURL: 'https://foreceipt-firestore.firebaseio.com',
    projectId: 'foreceipt-firestore',
    storageBucket: 'foreceipt-firestore.appspot.com',
    messagingSenderId: '982132137828',
    appId: '1:982132137828:web:cc83d2bcf734222c',
  }

  // TODO: Remove this when sync is complete
  const fba = firebase.initializeApp(
    {
      // @ts-ignore
      apiUrl: 'https://api.foreceipt.io/v1/receipt',
      apiKey: 'AIzaSyCWLdIMQO_A_WGhP_gh8IzSEv2_HbOvdAs',
      authDomain: 'app.foreceipt.com',
      databaseURL: 'https://foreceipt-firestore.firebaseio.com',
      projectId: 'foreceipt-firestore',
      storageBucket: 'foreceipt-firestore.appspot.com',
      messagingSenderId: '982132137828',
      appId: '1:982132137828:web:cc83d2bcf734222c',
    },
    // So every time is unique. remember to clean up open connection
    `foreceipt-${Math.random()}`,
  )
  const auth = fba.auth()
  const login = async () => {
    const {userJSON: uJson} = cfg.credentials
    if (uJson) {
      await authUpdateCurrentUserFromJSON(auth, uJson)
    } else {
      const res = await auth.signInWithEmailAndPassword(
        cfg.credentials.email,
        cfg.credentials.password,
      )
      if (!res.user) {
        throw new Error('Unable to ensure login. Missing res.user')
      }

      patchCredentials({userJSON: res.user.toJSON() as Record<string, unknown>})
    }

    if (!auth.currentUser) {
      throw new Error('Unexpectedly missing auth.currentUser')
    }
    return auth.currentUser
  }
  let fb: ReturnType<typeof initFirebase>
  const initFB = async () => {
    const res = await auth.signInWithEmailAndPassword(
      cfg.credentials.email,
      cfg.credentials.password,
    )
    if (!res.user) {
      throw new Error('Unable to ensure login. Missing res.user')
    }
    // fb = initFirebase({

    //   authUserJson: res.user.toJSON() as z.infer<typeof zFirebaseConfig>,
    //   publicConfig: fbaConfig,
    // })
    return fb
  }

  const ensureLogin = async () => {
    if (!auth.currentUser) {
      return await login()
    }
    return auth.currentUser
  }

  const ensureIdToken = async () => {
    if (cfg.credentials?.idTokenResult) {
      return cfg.credentials.idTokenResult
    }

    const currentUser = await ensureLogin()
    const _idTokenResult = await currentUser.getIdTokenResult()
    const idTokenResult = JSON.parse(JSON.stringify(_idTokenResult))
    patchCredentials({idTokenResult})

    return idTokenResult
  }

  const createClient = createHTTPClient({
    baseURL: 'https://api.foreceipt.io/v1/',
    requestTransformer: async (req) => {
      const idToken = await ensureIdToken()
      req.headers = {...req.headers, auth: idToken.token}
      return req
    },
    errorTransformer: (err) => {
      if (err.response && err.response.data) {
        return new ForeceiptError(err.response.data, err)
      }
      return err
    },
  })
  const getUserGuid = async () => {
    const idTokenRes = await ensureIdToken()
    return idTokenRes.claims['foreceipt_user_id'] as string
  }

  const getCurrentUser = async () =>
    createClient
      .post<string[]>('receipt/api/GetTeamMembersByUserId')
      .then(
        (r) =>
          r.data.map((d) => JSON.parse(d) as Foreceipt.TeamMember)[0] ?? null,
      )

  const getTeam = async (teamId: string) =>
    createClient
      .post<Foreceipt.Team>('receipt/api/GetTeam', {TeamId: teamId})
      .then((r) => r.data)
  const getTeamMembersInTeam = async (teamId: string) =>
    createClient
      .post<string[]>('receipt/api/GetTeamMembersInTeam', {TeamId: teamId})
      .then((r) => r.data.map((d) => JSON.parse(d) as Foreceipt.TeamMember))

  const getUserAndTeamGuid = async () => {
    const userGuid = await getUserGuid()
    let teamGuid = cfg.credentials.teamGuid
    if (teamGuid === null) {
      const member = await getCurrentUser()
      teamGuid = member?.team_guid ?? null

      patchCredentials({teamGuid})
    }
    return {userGuid, teamGuid}
  }

  const getReceiptsSnapshot$ = (updatedSince?: Date) =>
    rxjs.from(getUserAndTeamGuid()).pipe(
      Rx.mergeMap(({teamGuid, userGuid}) => {
        let query = fba
          .firestore()
          .collection<Foreceipt.Receipt>('Receipts')
          .where(
            teamGuid ? 'team_guid' : 'user_guid',
            '==',
            teamGuid || userGuid,
          )
        if (updatedSince) {
          query = query.orderBy('last_update_time').startAt(updatedSince)
        }

        return getQuerySnapshot$(query)
      }),
    )
  const getQuery$ = (updatedSince?: Date) =>
    rxjs.from(getUserAndTeamGuid()).pipe(
      Rx.mergeMap(({teamGuid, userGuid}) => {
        let query = fb.fst
          .collection<Foreceipt.Receipt>('Receipts')
          .where(
            teamGuid ? 'team_guid' : 'user_guid',
            '==',
            teamGuid || userGuid,
          )

        if (updatedSince) {
          query = query.orderBy('last_update_time').startAt(updatedSince)
        }

        return rxjs.of(query)
      }),
    )

  const getUserSettings$ = () =>
    rxjs.from(getUserAndTeamGuid()).pipe(
      Rx.mergeMap(({teamGuid, userGuid}) =>
        getQuerySnapshot$(
          fba
            .firestore()
            .collection<Foreceipt.UserSetting>('user_setting')
            .where('owner_guid', '==', teamGuid || userGuid),
        ),
      ),
      Rx.map((snap) =>
        snap.docs.map((d) => {
          const data = d.data() as Foreceipt.UserSetting
          return {
            type: data.setting_type,
            json: JSON.parse(data.setting_in_json) as Foreceipt.UserSettingJson,
          }
        }),
      ),
    )

  const EXPENSE_TYPE: Foreceipt.Receipt['content']['type'] = 1
  const INCOME_TYPE: Foreceipt.Receipt['content']['type'] = 2
  const TRANSFER_TYPE: Foreceipt.Receipt['content']['type'] = 3
  return {
    getReceipts: zFunction(z.date().optional(), async (updatedSince) => {
      const snap = await rxjs.firstValueFrom(getReceiptsSnapshot$(updatedSince))
      return snap.docs.map((d) => ({
        _docId: d.id,
        ...(d.data() as Foreceipt.Receipt),
      }))
    }),
    getUserAndTeamInfo: zFunction(async () => {
      const userGuid = await getUserGuid()
      const user = await getCurrentUser()
      const [team, teamMembers] = await Promise.all([
        user ? getTeam(user?.team_guid) : null,
        user ? getTeamMembersInTeam(user?.team_guid) : [],
      ])
      return {
        userGuid,
        teamGuid: user?.team_guid ?? null,
        user,
        team,
        teamMembers,
      }
    }),

    getUserSettings: zFunction(async () =>
      rxjs.firstValueFrom(getUserSettings$()),
    ),

    // TODO: Make it cleaner
    getReceiptsSnapshot$: zFunction(z.date().optional(), (updatedSince) =>
      getReceiptsSnapshot$(updatedSince),
    ),
    getUserSettings$: zFunction(() => getUserSettings$()),
    initFb: zFunction(() => initFB()),
    EXPENSE_TYPE,
    INCOME_TYPE,
    TRANSFER_TYPE,
    getQuery$,
    fbaConfig,
  }
})
