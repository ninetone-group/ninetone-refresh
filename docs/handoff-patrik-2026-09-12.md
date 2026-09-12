# Överlämning till Patrik — Cloudflare-kontot och ninetone.com (2026-09-12)

Skrivet efter kvällens flytt av allt till Ninetones eget Cloudflare-konto.
Inget av det här påverkar den nuvarande sajten förrän steg 4 görs med flit.

## Vad som redan finns på Ninetones Cloudflare-konto

| Resurs | Namn | Status |
|---|---|---|
| Worker (sajten) | `ninetone-site` → https://ninetone-site.ninetone.workers.dev | live, alla hemligheter satta utom `YOUTUBE_API_KEY` |
| Worker (bildproxy mot FileMaker) | `ninetone-fm-image-proxy` → https://ninetone-fm-image-proxy.ninetone.workers.dev | live |
| KV-namespaces | `ninetone-cache-state` (översättningscache, 11 923 poster), `ninetone-session`, `ninetone-contact-submissions`, `ninetone-publication-state`, `ninetone-publication-releases` | fyllda / tomma enligt plan |
| Köer | `ninetone-translation-jobs` + DLQ | skapade, cron pausad (`PUBLICATION_TICK=off`) |
| Zon | `ninetone.com` | tillagd, **pending** — namnservrar INTE bytta |

Deploys görs från repot med `npm run deploy:cf` (bygg + `wrangler deploy`
i ett kommando). Github-repot är `ninetone-group/ninetone-refresh`.

## 1. Uppgradera till Workers Paid (5 USD/mån) — brådskande

Kontot ligger på Workers Free. Importen av översättningscachen slog i
gränsen på 1 000 KV-skrivningar per dag, så skrivningar ger 429 fram till
00:00 UTC. Sajten serveras ändå (läsningar går), men kontaktformuläret kan
inte spara inskick och inget nytt cachas förrän gränsen släpper. Free-planen
har dessutom 10 ms CPU per anrop, vilket inte räcker i produktion.

Workers & Pages → Plans → Workers Paid. Ta effekt direkt.

## 2. DNS för ninetone.com — rätta importen INNAN namnserverbyte

Cloudflares import jämförd mot one.coms auktoritativa svar (ns01.one.com,
2026-09-12). Alla poster ska vara **DNS only (grått moln)** så att bytet
inte ändrar något beteende.

**Lägg till (saknas i Cloudflare):**

| Typ | Namn | Innehåll | Notering |
|---|---|---|---|
| A | `files` | `85.30.50.13` | **FileMaker.** Utan denna svarar wildcard med one.coms parkerings-IP → FM slutar fungera för sajten och för alla som använder värdnamnet. Aldrig proxad. |
| A | `mail` | `195.198.96.82` | |
| A | `calendar` | `77.111.241.127` | |
| A | `ftp` | `46.30.211.142` | AAAA importerades, A saknas |
| A | `webmail` | `77.111.241.102` | |
| A | `autoconfig` | `77.111.241.102` | |
| A | `autodiscover` | `77.111.241.102` | |

**Ändra från Proxied till DNS only:** `*`, `ninetone.com` (roten), `www`,
`ftp` (AAAA), `link`, `shop`, `s1._domainkey`, `s2._domainkey`.
Proxad `shop` bryter Shopifys certifikat; proxade `_domainkey`-CNAME:er
bryter SendGrids DKIM.

**Redan korrekt importerat:** MX (Google Workspace, fem poster), alla fem
TXT på roten (SPF, två google-site-verification, openai-domain-verification,
`pm5qiee3…`), `_dmarc`, `*` (wildcard `77.111.241.102`), `link` → `ffm.to`,
SendGrid-DKIM (`s1`/`s2._domainkey`), `shop` → Shopify.

**Exportera hela zonen från one.coms panel och jämför.** Wildcarden döljer
explicita poster som varken Cloudflares skanning eller våra uppslag hittar.

**Två gamla fel som inte beror på flytten, men värda att rätta:**
- SPF innehåller `include:include:sendgrid.net` (ett `include:` för mycket)
  — SendGrid-mejl kan falla på SPF idag.
- Ingen DKIM för Google Workspace (`google._domainkey`). DMARC står på
  `p=none`, så inget går sönder, men det bör finnas innan policyn skärps.

## 3. Byt namnservrar hos one.com

Till `bill.ns.cloudflare.com` och `magali.ns.cloudflare.com`. Eftersom
posterna är identiska och DNS only händer inget synligt; gamla sajten,
mejlen och FileMaker fortsätter som förut. Kontrollera efteråt: sajten
laddar, mejl kommer fram, `files.ninetone.com` pekar på `85.30.50.13`.

## 4. Lansering (senare, ett medvetet beslut)

- Worker → Settings → Domains & Routes → lägg till `ninetone.com` och `www`.
  Det är hela bytet; gamla sajten slutar då att nås på domänen.
- Email Sending: `npx wrangler email sending enable ninetone.com` (för
  kontaktformulärets utskick från `noreply@ninetone.com`).
- Byt `ANTHROPIC_API_KEY` till Ninetones egen nyckel:
  `npx wrangler secret put ANTHROPIC_API_KEY`. Cachen påverkas inte.
  (Anthropics fråga om länder: svara utifrån var bolaget och användarna
  finns, dvs. Sverige. Anropen görs bara av Workern i bakgrunden.)
- `PUBLIC_NOINDEX=false` i bygget släpper in sökmotorer (meta-taggen,
  robots.txt och svarshuvudet styrs av samma flagga).
- Riktiga ID:n för GTM, Clarity och TikTok (platshållare är avstängda i
  koden tills de byts).

## Rör inte

- `files.ninetone.com` får aldrig proxas via Cloudflare.
- Ändra inte cron-inställningen (`PUBLICATION_TICK`) utan att läsa
  `docs/review-and-fixes-2026-09-12.md` — publiceringssystemet är i
  skuggläge och inte klart för att servera.
- Inga ändringar på FileMaker-sidan; Data API:et är integrationsytan.
