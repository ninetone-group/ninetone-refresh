/** Redirect temporary migration URLs to their original public addresses. */
const aliases: Record<string,string> = {
  "office-d8ec9a359d8a55e999685f63e98cbcd4": "annbeath_frisk",
  "office-d81614f3d1885ae3a8623eb71bc0b93f": "embla_frisk",
  "office-650217bab1ed597cb3f3fd73302b3f11": "johanna_olandersson",
  "office-c6e82cd94b1859eab1f631bf404af42e": "per_skiold",
  "office-8ac9dd6a51015a8281dca9922f096347": "patrik_norman",
  "office-a3fa3d8471075e8cace2615273907830": "susanne_bertlin",
  "office-b6335851722c55e2a8bdbb3076f95b24": "molly_hl",
  "office-cc812810d6565ba7adcdbc73074592dc": "stefan_hallgren",
  "office-8c37b65e4fbc56cf90e3390232a7fabc": "philip_vedl"
};
export const canonicalTeamSlug = (slug: string): string | undefined => aliases[slug];
