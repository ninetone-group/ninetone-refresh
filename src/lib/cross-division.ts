/**
 * Loader half of the cross-division redirect (src/lib/roster-redirect.ts
 * holds the pure matcher and the WHY). Separate module so roster-redirect
 * stays free of FM imports and its tests run under plain Node.
 */
import {
  getArtists,
  getPreviousArtists,
  getClients,
  getPreviousClients,
  getBookingPageSet,
} from "./ninetone";
import {
  ARTIST_PATH,
  PREVIOUS_ARTIST_PATH,
  CLIENT_PATH,
  PREVIOUS_CLIENT_PATH,
  NATION_PATH,
  crossDivisionTarget,
  type CrossDivisionCandidate,
} from "./roster-redirect.ts";

export type Division = "records" | "management" | "nation";

type Loader = { division: Division; path: string; load: () => Promise<ReadonlyArray<{ SLUG?: unknown }>> };

// Preference order — see roster-redirect.ts. Current pages first, then
// previous rosters.
const LOADERS: ReadonlyArray<Loader> = [
  { division: "records", path: ARTIST_PATH, load: () => getArtists() },
  { division: "management", path: CLIENT_PATH, load: () => getClients() },
  { division: "nation", path: NATION_PATH, load: () => getBookingPageSet().then((s) => s.allRoster) },
  { division: "records", path: PREVIOUS_ARTIST_PATH, load: () => getPreviousArtists() },
  { division: "management", path: PREVIOUS_CLIENT_PATH, load: () => getPreviousClients() },
];

/**
 * Where a slug the `from` division does not know should go, or null for a
 * 404. `from`'s own rosters are skipped — the route already searched them.
 * A roster that fails to load is treated as empty: a redirect lookup must
 * never turn a 404 into a 500.
 */
export async function crossDivisionRedirect(slug: string, from: Division): Promise<string | null> {
  if (!slug) return null;
  const others = LOADERS.filter((l) => l.division !== from);
  const loaded = await Promise.allSettled(others.map((l) => l.load()));
  const candidates: CrossDivisionCandidate[] = others.map((l, i) => {
    const r = loaded[i];
    return { path: l.path, roster: r.status === "fulfilled" ? r.value : [] };
  });
  return crossDivisionTarget(slug, candidates);
}
