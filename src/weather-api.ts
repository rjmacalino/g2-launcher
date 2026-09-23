import type { WeatherCondition } from './statusbar'

// Open-Meteo (https://open-meteo.com): free, no API key, CORS-enabled. The
// old Weather placeholder was blocked on "an API key cannot ship inside an
// extractable package" - that constraint never actually applied here, it
// just took picking an API that does not require a key, so there is no proxy
// or backend anywhere in this feature.
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'

export type DailyForecast = {
  date: string
  condition: WeatherCondition
  highCelsius: number
  lowCelsius: number
}

export type ForecastResult = {
  current: { condition: WeatherCondition; celsius: number }
  daily: DailyForecast[]
}

// WMO weather codes, collapsed into the six buckets statusbar.ts can display
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
  current: { temperature_2m: number; weather_code: number }
  daily: {
    time: string[]
    weather_code: number[]
    temperature_2m_max: number[]
    temperature_2m_min: number[]
  }
}

function isOpenMeteoResponse(x: unknown): x is OpenMeteoResponse {
  if (!x || typeof x !== 'object') return false
  const r = x as Record<string, unknown>
  const current = r.current as Record<string, unknown> | undefined
  const daily = r.daily as Record<string, unknown> | undefined
  return (
    !!current &&
    typeof current.temperature_2m === 'number' &&
    typeof current.weather_code === 'number' &&
    !!daily &&
    Array.isArray(daily.time) &&
    Array.isArray(daily.weather_code) &&
    Array.isArray(daily.temperature_2m_max) &&
    Array.isArray(daily.temperature_2m_min)
  )
}

export async function fetchForecast(latitude: number, longitude: number): Promise<ForecastResult> {
  const url = new URL(FORECAST_URL)
  url.searchParams.set('latitude', latitude.toFixed(4))
  url.searchParams.set('longitude', longitude.toFixed(4))
  url.searchParams.set('current', 'temperature_2m,weather_code')
  url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min')
  url.searchParams.set('forecast_days', '7')
  url.searchParams.set('timezone', 'auto')

  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`Weather API returned ${res.status}`)

  const body: unknown = await res.json()
  if (!isOpenMeteoResponse(body)) throw new Error('Weather API returned an unexpected shape')

  const current = {
    condition: conditionFromCode(body.current.weather_code),
    celsius: body.current.temperature_2m,
  }

  const daily: DailyForecast[] = body.daily.time.map((date, i) => ({
    date,
    condition: conditionFromCode(body.daily.weather_code[i]),
    highCelsius: body.daily.temperature_2m_max[i],
    lowCelsius: body.daily.temperature_2m_min[i],
  }))

  return { current, daily }
}
