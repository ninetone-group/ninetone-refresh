/**
 * Decorative hover artwork — the `background-image` value for the portal
 * tiles (src/pages/index.astro) and SplitPortalHero.
 *
 * WHY THIS EXISTS
 *
 * These banners are photographic art that only ever renders under
 * `mix-blend-multiply` at `opacity-50` over a solid dark brand color, and
 * only on hover. They shipped as 864x1117 PNGs totalling 2,840,088 B across
 * seven files — and a CSS `background-image` on an `opacity-0` box is still
 * fetched eagerly (opacity is a paint-time property; it defers nothing), so
 * every first-time visitor downloaded all of it to see none of it. Touch
 * devices, which can never reach the hover state at all, paid the same.
 *
 * PNG was simply the wrong container for photographs: the originals are
 * already near their practical floor for zlib, yet WebP q82 at the SAME
 * pixel dimensions is ~96% smaller (2,840,088 B -> 113,914 B). The images
 * are NOT oversized — the portal grid is full-bleed, so a 640 CSS px column
 * needs 1280 device px at DPR 2 and an 864px source is already short.
 * Downscaling would make them worse; re-encoding is the whole fix.
 *
 * Compression is invisible here by construction. The multiply blend at 50%
 * alpha over #91000c / #13486f / #1a936f attenuates every per-pixel error by
 * (brand_channel/255)*0.5, and all three brand colors are dark. Measured
 * composited delta of q82 vs the original PNG: mean under 0.3/255 per
 * channel, max ~5/255 in isolated pixels — far below perceptual threshold.
 *
 * WHY A PLAIN url() AND NOT image-set()
 *
 * image-set() was the obvious way to keep the PNG as a declared fallback,
 * and it is the wrong tool HERE. The value lives in an inline `style`
 * attribute, which cannot express a cascade — there is no way to declare
 * `background-image` twice and let an older browser keep the one it
 * understands. So an unparsed image-set() drops the whole declaration.
 * And the two support sets line up such that it protects nobody: every
 * browser that parses unprefixed image-set() (Safari 17+, Chrome 88+)
 * already decodes WebP, while the browsers that lack WebP (Safari/iOS < 14)
 * also lack image-set() and would render NOTHING instead of the PNG.
 *
 * The honest fallback is the design itself. This layer defaults to
 * `opacity-0` over a solid brand color that is painted by a separate
 * element, so a browser that cannot load the image shows the brand-color
 * hover without the photo — precisely the experience every touch device
 * already has today, since the hover state is unreachable there. Nothing
 * breaks; the reveal is just flat. The PNGs stay in public/images/ as the
 * editable source of truth for regenerating these files.
 *
 * Centralised so a future banner cannot reintroduce the 700 KB version by
 * hand-writing `background-image: url(...)` at a new call site.
 */

/**
 * Build a `background-image` value pointing at the WebP sibling of `path`.
 * `resolve` is the caller's locale/base-aware url() binding — passed in
 * rather than imported so this stays a pure function and the caller keeps
 * using whichever binding it already holds.
 */
export function hoverArtBackground(
  path: string,
  resolve: (p: string) => string,
): string {
  return `url(${resolve(path.replace(/\.(png|jpe?g)$/i, ".webp"))})`;
}
