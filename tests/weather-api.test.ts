import { describe, expect, it, vi, afterEach } from 'vitest'
import { conditionFromCode, fetchForecast } from '../src/features/weather/api'

describe('conditionFromCode', () => {
  it('maps the documented WMO code ranges', () => {
    expect(conditionFromCode(0)).toBe('clear')
    expect(conditionFromCode(1)).toBe('cloudy')
    expect(conditionFromCode(3)).toBe('cloudy')
    expect(conditionFromCode(45)).toBe('fog')
    expect(conditionFromCode(48)).toBe('fog')
    expect(conditionFromCode(51)).toBe('rain')
    expect(conditionFromCode(67)).toBe('rain')
    expect(conditionFromCode(71)).toBe('snow')
    expect(conditionFromCode(86)).toBe('snow')
    expect(conditionFromCode(95)).toBe('storm')
    expect(conditionFromCode(99)).toBe('storm')
  })

  it('falls back to cloudy for a code outside every documented range, rather than throwing', () => {
    // 4 sits between the "mainly clear/overcast" (1-3) and "fog" (45/48)
    // ranges - a gap in Open-Meteo's own code list, not one of ours.
    expect(conditionFromCode(4)).toBe('cloudy')
    expect(conditionFromCode(-1)).toBe('cloudy')
  })
})

describe('fetchForecast', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubFetch(body: unknown, ok = true) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok,
        status: ok ? 200 : 500,
        json: async () => body,
      }),
    )
  }

  const openMeteoBody = {
    current: { temperature_2m: 18, weather_code: 0, is_day: 1 },
    daily: {
      time: ['2026-09-24', '2026-09-25'],
      weather_code: [0, 61],
      temperature_2m_max: [20, 16],
      temperature_2m_min: [10, 9],
    },
    hourly: {
      // One hour before dawn (5), one at the window's open edge (6), one in
      // the middle (12), one at the window's close edge (18), one after (19),
      // spread across both days - exercises hoursForDate's date-prefix match
      // and DAY_START_HOUR/DAY_END_HOUR boundaries together.
      time: [
        '2026-09-24T05:00',
        '2026-09-24T06:00',
        '2026-09-24T12:00',
        '2026-09-24T18:00',
        '2026-09-24T19:00',
        '2026-09-25T12:00',
      ],
      weather_code: [0, 0, 0, 0, 0, 61],
      temperature_2m: [10, 12, 20, 14, 13, 15],
    },
  }

  it('keeps only hours inside 6am-18:00, grouped under the right day', () => {
    stubFetch(openMeteoBody)
    return fetchForecast(1, 1).then(result => {
      expect(result.daily).toHaveLength(2)
      expect(result.daily[0].date).toBe('2026-09-24')
      expect(result.daily[0].hourly.map(h => h.hour)).toEqual([6, 12, 18])
      expect(result.daily[1].hourly.map(h => h.hour)).toEqual([12])
    })
  })

  it('maps is_day to a boolean on the current reading only', () => {
    stubFetch(openMeteoBody)
    return fetchForecast(1, 1).then(result => {
      expect(result.current.isDay).toBe(true)
      expect(result.current.condition).toBe('clear')
      expect(result.current.celsius).toBe(18)
    })
  })

  it('rejects a response missing the fields fetchForecast depends on', () => {
    stubFetch({ current: { temperature_2m: 18 } })
    return expect(fetchForecast(1, 1)).rejects.toThrow('unexpected shape')
  })

  it('rejects a non-2xx response without trying to parse it', () => {
    stubFetch({}, false)
    return expect(fetchForecast(1, 1)).rejects.toThrow('returned 500')
  })
})
