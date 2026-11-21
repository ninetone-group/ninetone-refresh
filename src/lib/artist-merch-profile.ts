import {fmFind} from './filemaker.ts';
import {usesOffice} from './office.ts';
import {artistCollectionIds, type ArtistCollections} from './artist-merch.ts';

/** fmFind returns flattened field values, unlike fmFindWithPortals. */
export async function artistMerchProfile(
  artist: ArtistCollections,
  theme: string,
  lookup: (layout:string,slug:string)=>Promise<ArtistCollections[]> = (layout,slug)=>fmFind<ArtistCollections>(layout,{query:[{SLUG:slug,filterActive:'==*'}],limit:1}),
  office = usesOffice(),
): Promise<ArtistCollections> {
  if(!office || Object.hasOwn(artist,'shopifyCollections') || typeof artist.SLUG!=='string' || !artistCollectionIds(artist).length)return artist;
  const layout=theme==='records'?'API_ARTIST_DETAIL':theme==='management'?'API_Management':'API_Booking';
  const rows=await lookup(layout,artist.SLUG);
  return rows[0]??artist;
}
