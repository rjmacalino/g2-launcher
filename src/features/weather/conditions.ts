// The weather vocabulary shared by the forecast views and the status bar.
//
// Six buckets, not one per WMO weather code: Open-Meteo defines dozens of codes
// (drizzle, freezing rain, snow grains, and so on) that this small display has
// no room to distinguish usefully. api.ts collapses all of them into whichever
// of these a wearer would actually act on differently.
//
// Words, not glyphs: the firmware font has no weather symbols and silently drops
// them (see docs/platform.md, Glyphs). Icons will come from image containers.
export type WeatherCondition = 'clear' | 'cloudy' | 'fog' | 'rain' | 'snow' | 'storm'

export const CONDITION_LABELS: Record<WeatherCondition, string> = {
  clear: 'Sunny',
  cloudy: 'Cloudy',
  fog: 'Fog',
  rain: 'Rainy',
  snow: 'Snow',
  storm: 'Storm',
}

export type CurrentWeather = { condition: WeatherCondition; celsius: number; isDay: boolean }

// "Sunny" is a daytime-only word; WMO code 0 ("clear sky") is equally correct
// at night, when there is no sun to name. Only point-in-time readings need this:
// a whole day, or an hour inside the 6am-18:00 window the hourly view shows, is
// fairly called sunny.
export function currentConditionWord(w: CurrentWeather): string {
  if (w.condition === 'clear' && !w.isDay) return 'Clear'
  return CONDITION_LABELS[w.condition]
}
