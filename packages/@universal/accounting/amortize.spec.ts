import {
  A,
  compactStringify,
  DateTime,
  FREQUENCIES,
  Interval,
  iterateSubintervals,
  math,
  omit,
} from '@ledger-sync/util'
import {computeAmortization} from './amoritze'

const jsonStringifySnapshotSerializer: jest.SnapshotSerializerPlugin = {
  serialize(val) {
    return compactStringify(val)
  },
  test() {
    return true
  },
}

expect.addSnapshotSerializer(jsonStringifySnapshotSerializer)

// TODO: The behavior of parseDateRagneExpression is really not well defined
// Neither is timezone handling... Need to be a lot more consistent
const tzSuffix = DateTime.local()
  .toISO()
  .slice('+08:00'.length * -1)

const timeSuffix = `00:00:00.000${tzSuffix}`

describe('sanity checks', () => {
  // https://github.com/moment/luxon/pull/778/files
  test("DateTime#diff can handle 'quarters' as a unit", () => {
    const t = () => DateTime.local().diff(DateTime.fromMillis(0), 'quarters')
    expect(t).not.toThrow()
  })

  test('interval to duration', () => {
    const interval = Interval.fromISO('2020-03-01/2020-03-01')

    expect(interval.toISODate()).toBe(`2020-03-01/2020-03-01`)
    expect(interval.toISO()).toBe(
      `2020-03-01T${timeSuffix}/2020-03-01T${timeSuffix}`,
    )
    expect(interval.toISOTime()).toBe(`${timeSuffix}/${timeSuffix}`)
    expect(interval.toDuration().toObject()).toEqual({milliseconds: 0})
  })

  test('duration calculation for irregular size intervals (e.g. leap month)', () => {
    expect(
      DateTime.fromISO('2020-01-01')
        .until(DateTime.fromISO('2020-03-01'))
        .toDuration('months')
        .toObject(),
    ).toEqual({months: 2})
    expect(
      DateTime.fromISO('2020-01-15')
        .until(DateTime.fromISO('2020-01-31'))
        .toDuration('months')
        .toObject(),
    ).toEqual({months: 0.5161290322580645})

    expect(
      DateTime.fromISO('2020-02-01')
        .until(DateTime.fromISO('2020-02-15'))
        .toDuration('months')
        .toObject(),
    ).toEqual({months: 0.4827586206896552})

    expect(
      DateTime.fromISO('2020-01-15')
        .until(DateTime.fromISO('2020-02-15'))
        .toDuration('months')
        .toObject(),
    ).toEqual({months: 1})
  })
})

test.each([
  ['2020-01-01/2020-01-05', FREQUENCIES.days],
  ['2020-01-01/2020-03-01', FREQUENCIES.weeks],
  ['2020-01-01/2020-03-01', FREQUENCIES.months],
  ['2020-01-01/2020-03-01', FREQUENCIES.quarters],
  ['2020-01-01/2020-03-01', FREQUENCIES.years],
])('subdivide interval %o %o', (isoInterval, frequency) => {
  const interval = Interval.fromISO(isoInterval)
  const segments = [...iterateSubintervals(interval, frequency)]

  expect(math.equals(math.sum(segments.map((r) => r.ratio)), 1)).toBe(true)

  expect(
    segments.map((r) => ({
      ...r,
      interval: r.interval.toISODate(),
      duration: r.duration.toObject(),
    })),
  ).toMatchSnapshot()
})

test.each([
  [A(100, 'USD'), '2020-01-01/2020-01-04', FREQUENCIES.days],
  [A(100, 'USD'), '2020-01-01/2020-03-01', FREQUENCIES.weeks],
  [A(100, 'USD'), '2020-01-01/2020-03-01', FREQUENCIES.months],
  [A(100, 'USD'), '2020-01-01/2020-03-01', FREQUENCIES.quarters],
  [A(100, 'USD'), '2020-01-01/2020-03-01', FREQUENCIES.years],
])('amoritize %o over %o %o', (amount, isoInterval, frequency) => {
  const interval = Interval.fromISO(isoInterval)
  const posts = computeAmortization(amount, interval, frequency)

  const postSum = math.sum(posts.map((p) => p.amount.quantity))
  expect(math.equals(postSum, amount.quantity)).toBe(true)

  expect(posts.map((p) => omit(p, ['extra']))).toMatchSnapshot()
})
