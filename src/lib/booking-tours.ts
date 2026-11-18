/** Public Office projection only. Never use booking titles/internal descriptions as copy. */
export type TourStop = {
  SLUG: string; id: string; tourId: string; tourName: string; tourDescription: string;
  dateStart: string; dateEnd: string; venue: string; location: string; city: string; address: string;
};
export type BookingTour = { id: string; name: string; description: string; upcoming: TourStop[]; past: TourStop[] };
export function stopPlaceDetails(stop: TourStop): string {
  const normalize = (s: string) => s.trim().toLocaleLowerCase('sv-SE');
  const seen = new Set([normalize(stop.venue)]);
  return [stop.address, ...stop.location.split('·')].map(s => s.trim()).filter(s => {
    if (!s || seen.has(normalize(s))) return false;
    seen.add(normalize(s));return true;
  }).join(' · ');
}
export function stockholmDay(now = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function isPastStop(stop: TourStop, today: string): boolean {
  const end = stop.dateEnd || stop.dateStart;
  return Boolean(end && end < today);
}
export function groupBookingTours(rows: TourStop[], today = stockholmDay()): BookingTour[] {
  const groups = new Map<string, BookingTour>();
  const ids = new Set<string>();
  for (const row of rows) {
    const fields = ['SLUG','id','tourId','tourName','tourDescription','dateStart','dateEnd','venue','location','city','address'] as const;
    if (!row || fields.some(k => typeof row[k] !== 'string') || !row.id || ids.has(row.id)) throw new Error('Invalid public booking');
    for (const d of [row.dateStart,row.dateEnd]) if (d && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || new Date(`${d}T12:00:00Z`).toISOString().slice(0,10) !== d)) throw new Error('Invalid booking date');
    if (row.dateStart && row.dateEnd && row.dateEnd < row.dateStart) throw new Error('Invalid booking range');
    ids.add(row.id);
    const key = row.tourId || 'standalone';
    let group = groups.get(key);
    if (!group) {
      group = { id: key, name: row.tourId ? row.tourName : '', description: row.tourId ? row.tourDescription : '', upcoming: [], past: [] };
      groups.set(key, group);
    } else if (row.tourId && (group.name !== row.tourName || group.description !== row.tourDescription)) throw new Error('Inconsistent tour projection');
    (isPastStop(row, today) ? group.past : group.upcoming).push(row);
  }
  const date = (r: TourStop) => r.dateStart || r.dateEnd || '9999-12-31';
  for (const g of groups.values()) {
    g.upcoming.sort((a,b) => date(a).localeCompare(date(b)) || a.id.localeCompare(b.id));
    g.past.sort((a,b) => date(b).localeCompare(date(a)) || a.id.localeCompare(b.id));
  }
  return [...groups.values()].sort((a,b) => {
    if (Boolean(a.upcoming.length) !== Boolean(b.upcoming.length)) return a.upcoming.length ? -1 : 1;
    return a.upcoming.length ? date(a.upcoming[0]).localeCompare(date(b.upcoming[0])) : date(b.past[0]).localeCompare(date(a.past[0]));
  });
}
export function stopDateLabel(stop: TourStop, lang: 'sv' | 'en' = 'sv'): string {
  const format = (value: string) => new Intl.DateTimeFormat(lang === 'sv' ? 'sv-SE' : 'en-GB', { day:'numeric',month:'long',year:'numeric',timeZone:'Europe/Stockholm' }).format(new Date(`${value}T12:00:00Z`));
  const start = stop.dateStart || stop.dateEnd;
  return !start ? (lang === 'sv' ? 'Datum meddelas' : 'Date to be announced') : stop.dateEnd && stop.dateEnd !== start ? `${format(start)} – ${format(stop.dateEnd)}` : format(start);
}
