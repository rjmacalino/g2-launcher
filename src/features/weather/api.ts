import type { WeatherCondition } from './conditions'

// Open-Meteo (https://open-meteo.com): free, no API key, CORS-enabled. The
// old Weather placeholder was blocked on "an API key cannot ship inside an
// extractable package" - that constraint never actually applied here, it
// just took picking an API that does not require a key, so there is no proxy
// or backend anywhere in this feature.
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'

// Only daytime hours: a wearer expanding a day wants "what is it doing while
// I am out", not a 24-row list dominated by hours they will be asleep for.
const DAY_START_HOUR = 6
const DAY_END_HOUR = 18

// 16, not 7: Open-Meteo's actual maximum for a real forecast, not an
// arbitrary deeper number. Requested per direct question about "infinite
// scroll" - true infinite scroll is not buildable here for two independent
// reasons (see tool.ts): the native list widget gives no
// near-the-end scroll signal to hang pagination off, and a forecast beyond
// ~16 days is not real data to prefetch in the first place. Asking for more
// days than this costs nothing extra - it is the same single request either
// way - and 16 rows already fits under this platform's own 20-item list cap
// with room to spare.
const FORECAST_DAYS = 16

export type HourlyForecast = {
  hour: number
  condition: WeatherCondition
  celsius: number
}

export type DailyForecast = {
  date: string
  condition: WeatherCondition
  highCelsius: number
  lowCelsius: number
  // 6am-18:00 only, for the day-detail view. See DAY_START_HOUR/DAY_END_HOUR.
  hourly: HourlyForecast[]
}

export type ForecastResult = {
  current: { condition: WeatherCondition; celsius: number; isDay: boolean }
  daily: DailyForecast[]
}

// WMO weather codes, collapsed into the six buckets in conditions.ts
// (see WeatherCondition there). Open-Meteo documents the full code list;
// anything outside these ranges falls back to 'cloudy' rather than throwing,
// since a slightly-off condition word is a smaller failure than losing the
// whole forecast over one unrecognised code.
function conditionFromCode(code: number): WeatherCondition {
  if (code === 0) return 'clear'
  if (code >= 1 && code <= 3) return 'cloudy'
  if (code === 45 || code === 48) return 'fog'
  if (code >= 51 && code <= 67) return 'rain'
  if (code >= 71 && code <= 86) return 'snow'
  if (code >= 95) return 'storm'
  return 'cloudy'
}

type OpenMeteoResponse = {
  current: { temperature_2m: number; weather_code: number; is_day: number }
  daily: {
    time: string[]
    weather_code: number[]
    temperature_2m_max: number[]
    temperature_2m_min: number[]
  }
  hourly: {
    time: string[]
    weather_code: number[]
    temperature_2m: number[]
  }
}

function isOpenMeteoResponse(x: unknown): x is OpenMeteoResponse {
  if (!x || typeof x !== 'object') return false
  const r = x as Record<string, unknown>
  const current = r.current as Record<string, unknown> | undefined
  const daily = r.daily as Record<string, unknown> | undefined
  const hourly = r.hourly as Record<string, unknown> | undefined
  return (
    !!current &&
    typeof current.temperature_2m === 'number' &&
    typeof current.weather_code === 'number' &&
    typeof current.is_day === 'number' &&
    !!daily &&
    Array.isArray(daily.time) &&
    Array.isArray(daily.weather_code) &&
    Array.isArray(daily.temperature_2m_max) &&
    Array.isArray(daily.temperature_2m_min) &&
    !!hourly &&
    Array.isArray(hourly.time) &&
    Array.isArray(hourly.weather_code) &&
    Array.isArray(hourly.temperature_2m)
  )
}

// Open-Meteo's hourly time strings are 'YYYY-MM-DDTHH:MM', always local to
// the `timezone=auto` location, same as the daily dates - a plain string
// prefix match is enough to group hours under their day, no date parsing
// needed.
function hoursForDate(body: OpenMeteoResponse, date: string): HourlyForecast[] {
  const hours: HourlyForecast[] = []
  for (let i = 0; i < body.hourly.time.length; i++) {
    const t = body.hourly.time[i]
    if (!t.startsWith(date)) continue
    const hour = Number(t.slice(11, 13))
    if (hour < DAY_START_HOUR || hour > DAY_END_HOUR) continue
    hours.push({
      hour,
      condition: conditionFromCode(body.hourly.weather_code[i]),
      celsius: body.hourly.temperature_2m[i],
    })
  }
  return hours
}

export async function fetchForecast(latitude: number, longitude: number): Promise<ForecastResult> {
  const url = new URL(FORECAST_URL)
  url.searchParams.set('latitude', latitude.toFixed(4))
  url.searchParams.set('longitude', longitude.toFixed(4))
  url.searchParams.set('current', 'temperature_2m,weather_code,is_day')
  url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min')
  url.searchParams.set('hourly', 'temperature_2m,weather_code')
  url.searchParams.set('forecast_days', String(FORECAST_DAYS))
  url.searchParams.set('timezone', 'auto')

  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`Weather API returned ${res.status}`)

  const body: unknown = await res.json()
  if (!isOpenMeteoResponse(body)) throw new Error('Weather API returned an unexpected shape')

  // is_day only matters for the current reading, not the daily/hourly rows.
  // WMO code 0 ("clear sky") is correct at night too - a clear sky after
  // dark has no sun in it - but CONDITION_LABELS' word for it is "Sunny",
  // which is wrong once the sun is down. currentConditionWord in conditions.ts uses this flag to say
  // "Clear" instead of "Sunny" for the single point-in-time reading it
  // shows; the daily/hourly rows stay as-is, since "Sunny" describing a
  // whole day (or an hour inside the 6am-18:00 window this app already
  // restricts hourly rows to) is accurate regardless.
  const current = {
    condition: conditionFromCode(body.current.weather_code),
    celsius: body.current.temperature_2m,
    isDay: body.current.is_day === 1,
  }

  const daily: DailyForecast[] = body.daily.time.map((date, i) => ({
    date,
    condition: conditionFromCode(body.daily.weather_code[i]),
    highCelsius: body.daily.temperature_2m_max[i],
    lowCelsius: body.daily.temperature_2m_min[i],
    hourly: hoursForDate(body, date),
  }))

  return { current, daily }
}
