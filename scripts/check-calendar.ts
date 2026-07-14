import { getCalendar } from '../src/google.js'

async function main() {
  const cal = getCalendar('work')
  const now = new Date()
  const oneWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

  const res = await cal.events.list({
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax: oneWeek.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 30,
  })

  const events = res.data.items ?? []
  if (events.length === 0) {
    console.log('No events in the next 7 days.')
  } else {
    console.log(`Work calendar - next 7 days (${events.length} events):`)
    for (const e of events) {
      const start = e.start?.dateTime ?? e.start?.date ?? 'unknown'
      console.log(`  ${start} | ${e.summary}`)
    }
  }
}

main().catch(console.error)
