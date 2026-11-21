# Artist merch follows Office Collection IDs

Records, Management and Nation artist pages read Office's `collectionIds` list. The legacy single `collectionId` is used only when the list is absent. An explicit empty list hides merch, and malformed IDs never fetch the full store or fall back to the old collection.

Products retain the existing Shopify cache with the shared publication epoch. Office's native collection save increments that epoch's source version; the existing minute job refreshes the website. No webhook or additional credential is introduced. Products are deduplicated by Shopify ID and distributed across the selected collections within the existing eight-product grid. At most four collection reads run simultaneously.

Validation: seven new behavioral cases cover authoritative selection/clearing, old single-ID profiles, malformed fields, new collections in an already full grid, duplicate products/IDs, bounded reads and errors. All 920 tests and the Cloudflare build/secret scan passed. Website change is compatible with the old Office response while the new collection editor is being promoted.
