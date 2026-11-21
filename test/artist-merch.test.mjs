import assert from 'node:assert/strict';
import test from 'node:test';
import { artistCollectionIds, getArtistMerch, getArtistCollections } from '../src/lib/artist-merch.ts';

test('Office collection list supersedes the imported single ID, including an explicit clear', () => {
  assert.deepEqual(artistCollectionIds({collectionIds:[' 123 ', '456', '123'],collectionId:'789'}),['123','456']);
  assert.deepEqual(artistCollectionIds({collectionIds:[],collectionId:'789'}),[]);
  assert.deepEqual(artistCollectionIds({collectionId:' 789 '}),['789']);
  assert.deepEqual(artistCollectionIds({collectionId:'Upcoming'}),[]);
});

test('malformed Office IDs never fall back to the old collection or the entire store', async () => {
  for (const collectionIds of [null,'123',[''],['123','invalid'],['0'],Array(101).fill('123')]) {
    let called=false;
    assert.deepEqual(await getArtistMerch({collectionIds,collectionId:'789'},8,async()=>{called=true;return []}),[]);
    assert.equal(called,false);
  }
});

test('single-ID profiles retain their product order and empty profiles do not query Shopify', async () => {
  const products=[{id:2},{id:1}];const calls=[];
  const load=async opts=>{calls.push(opts);return products};
  assert.deepEqual(await getArtistMerch({collectionId:'123'},8,load),products);
  assert.deepEqual(calls,[{collectionId:'123',limit:8}]);
  assert.deepEqual(await getArtistMerch({},8,load),[]);
  assert.equal(calls.length,1);
});

test('newly selected collections contribute to the grid even when the first already has eight products', async () => {
  const first=Array.from({length:8},(_,i)=>({id:i+1}));
  const result=await getArtistMerch({collectionIds:['123','456']},8,async ({collectionId})=>collectionId==='123'?first:[{id:20},{id:21}]);
  assert.deepEqual(result.map(p=>p.id),[1,20,2,21,3,4,5,6]);
});

test('overlapping collections and repeated IDs do not duplicate products or requests', async () => {
  const calls=[];
  const result=await getArtistMerch({collectionIds:['123','456','123']},8,async ({collectionId})=>{
    calls.push(collectionId);return collectionId==='123'?[{id:1},{id:2}]:[{id:1},{id:3}];
  });
  assert.deepEqual(calls,['123','456']);assert.deepEqual(result.map(p=>p.id),[1,2,3]);
});

test('large selections use at most four simultaneous reads and respect the grid limit', async () => {
  let active=0,peak=0;const calls=[];
  const result=await getArtistMerch({collectionIds:Array.from({length:10},(_,i)=>String(i+1))},8,async ({collectionId})=>{
    active++;peak=Math.max(peak,active);calls.push(collectionId);
    await new Promise(resolve=>setImmediate(resolve));active--;return [{id:Number(collectionId)}];
  });
  assert.equal(peak,4);assert.equal(calls.length,10);assert.equal(result.length,8);
});

test('a failed collection read follows the existing caller error handling without querying other stores', async () => {
  await assert.rejects(getArtistMerch({collectionIds:['123']},8,async()=>{throw new Error('Shopify unavailable')}),/Shopify unavailable/);
  await assert.rejects(getArtistMerch({collectionIds:['123']},0),RangeError);
});


test('Office catalog supplies all chosen collections without a Shopify network request',async()=>{
 const c={id:'123',title:'Music',handle:'music',url:'https://artist.myshopify.com/collections/music'};
 assert.deepEqual(await getArtistCollections({shopifyStoreDomain:'artist.myshopify.com',collectionIds:['123','456'],shopifyCollections:[c,{...c,id:'999'}]}),[c]);
 assert.deepEqual(await getArtistCollections({shopifyStoreDomain:'other.myshopify.com',collectionIds:['123'],shopifyCollections:[c]}),[]);
 assert.deepEqual(await getArtistCollections({collectionIds:[],shopifyCollections:[c]}),[]);
});


test('artist shops use their own public Storefront loader and never the Ninetone Admin token',async()=>{
 const c={id:'123',handle:'music',title:'Music',url:'https://own-shop.myshopify.com/collections/music'};
 const calls=[];
 const products=await getArtistMerch({shopifyStoreDomain:'own-shop.myshopify.com',collectionIds:['123'],shopifyCollections:[c]},8,async()=>{throw Error('Wrong shop Admin read')},async(host,collection,limit)=>{calls.push([host,collection.id,limit]);return [{id:1}]});
 assert.deepEqual(products,[{id:1}]);assert.deepEqual(calls,[['own-shop.myshopify.com','123',8]]);
});
test('an empty legacy result can read the selected public collection without querying the entire store',async()=>{
 const c={id:'123',handle:'music',title:'Music',url:'https://shop.ninetone.com/collections/music'};
 let called=0;
 const products=await getArtistMerch({collectionIds:['123'],shopifyCollections:[c]},8,async()=>[],async(host,collection)=>{called++;assert.equal(host,'shop.ninetone.com');assert.equal(collection.id,'123');return [{id:2}]});
 assert.deepEqual(products,[{id:2}]);assert.equal(called,1);
});
