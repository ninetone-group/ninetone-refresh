/** A committed Office revision invalidates existing page/find caches together. */
export async function syncOfficePublication(kv: {get(key:string):Promise<string|null>;put(key:string,value:string):Promise<unknown>},loadVersion:()=>Promise<string>):Promise<boolean> {
 const version=await loadVersion();
 if(!/^[1-9][0-9]{0,18}$/.test(version))throw new Error('Invalid Office publication revision');
 const previous=await kv.get('office-publication-version');
 if(previous===version||(previous&&/^[1-9][0-9]{0,18}$/.test(previous)&&BigInt(previous)>BigInt(version)))return false;
 // Idempotent epoch: concurrent/retried ticks observing the same revision use
 // the same cache keys. Mark observed only after invalidation succeeds.
 await kv.put('cache-version',`office-${version}`);
 await kv.put('office-publication-version',version);
 return true;
}
