import {defineProxyFn, z, zFunction} from '@ledger-sync/util'
import type {Base, FieldSet, Records} from 'airtable'

export const $airtable =
  defineProxyFn<() => typeof import('airtable')>('$airtable')

export const zAirtableConnectionSettings = z.object({
  apiKey: z.string(),
  airtableBase: z.string(),
})

export const zAccount = z.object({
  Id: z.string(),
  'Provider Name': z.string(),
  Standard: z.string(),
  External: z.string(),
})
export const zTransaction = zAccount.extend({
  Date: z.string(),
  Amount: z.string(),
  Category: z.string(),
  Payee: z.string(),
})

export const makeAirtableClient = zFunction(
  zAirtableConnectionSettings,
  ({apiKey, airtableBase}) => {
    const Airtable = $airtable()
    let base: Base
    const initBase = () => {
      base = new Airtable({apiKey}).base(airtableBase)
    }
    return {
      initBase,
      insertData: zFunction(
        z.object({data: z.any(), entityName: z.string()}),
        async ({data, entityName}) => {
          try {
            // TODO: Need to find a way to prevent duplicate records
            // Refs:  https://community.airtable.com/t/solved-record-duplication-detection-deduping-and-duplicate-merging/340/5
            // https://community.airtable.com/t/unique-values-in-a-column/735/11
            await base(titleCase(entityName)).create([data])
          } catch (error) {
            console.log(error)
          }
        },
      ),

      getEntity: (
        entityName: string,
        cb: (data: Records<FieldSet>) => void,
      ) => {
        base(entityName)
          .select({
            view: 'Grid view',
          })
          .eachPage(
            function page(records, fetchNextPage) {
              // This function (`page`) will get called for each page of records.

              records.forEach(function (record) {
                console.log('Retrieved', record.get('Id'))
              })
              cb(records)
              // To fetch the next page of records, call `fetchNextPage`.
              // If there are more records, `page` will get called again.
              // If there are no more records, `done` will get called.
              fetchNextPage()
            },
            function done(err) {
              if (err) {
                console.error(err)
                return
              }
            },
          )
      },
      getEntity2: (entityName: string) =>
        base(entityName)
          .select({
            view: 'Grid view',
          })
          .all(),
    }
  },
)

function titleCase(str: string): string {
  return str.toLowerCase().replace(/\b\w/g, (s) => s.toUpperCase())
}
