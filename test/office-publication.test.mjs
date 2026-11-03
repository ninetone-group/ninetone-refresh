import test from 'node:test';import assert from 'node:assert/strict';
import {syncOfficePublication}from'../src/lib/office-publication.ts';
const fake=()=>{const m=new Map();return{m,get:async k=>m.get(k)??null,put:async(k,v)=>{m.set(k,v)}}};
test('committed revision invalidates once; manual Publish stays until next Office change',async()=>{
 const kv=fake();assert.equal(await syncOfficePublication(kv,async()=>'7'),true);assert.equal(kv.m.get('cache-version'),'office-7');
 kv.m.set('cache-version','manual-publish');assert.equal(await syncOfficePublication(kv,async()=>'7'),false);assert.equal(kv.m.get('cache-version'),'manual-publish');
 assert.equal(await syncOfficePublication(kv,async()=>'8'),true);assert.equal(kv.m.get('cache-version'),'office-8');
 assert.equal(await syncOfficePublication(kv,async()=>'7'),false);assert.equal(kv.m.get('cache-version'),'office-8');
});
test('failed origin or KV write cannot acknowledge an unpublished revision',async()=>{
 const kv=fake();await assert.rejects(syncOfficePublication(kv,async()=>{throw Error('down')}));assert.equal(kv.m.size,0);
 for(const v of ['0','-1','garbage'])await assert.rejects(syncOfficePublication(kv,async()=>v));assert.equal(kv.m.size,0);
 let fail=true;const put=kv.put;kv.put=async(k,v)=>{if(fail&&k==='cache-version')throw Error('KV');return put(k,v)};
 await assert.rejects(syncOfficePublication(kv,async()=>'9'));assert.equal(kv.m.size,0);fail=false;await syncOfficePublication(kv,async()=>'9');assert.equal(kv.m.get('office-publication-version'),'9');
});
