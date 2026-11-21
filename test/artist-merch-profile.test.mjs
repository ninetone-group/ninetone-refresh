import assert from 'node:assert/strict';
import test from 'node:test';
import {artistMerchProfile} from '../src/lib/artist-merch-profile.ts';
import {getArtistCollections} from '../src/lib/artist-merch.ts';
test('flattened detail result supplies selected shop collections on every artist route',async()=>{
 const c={id:'123',title:'Music',handle:'music',url:'https://own.myshopify.com/collections/music'};
 const row={SLUG:'artist',collectionIds:['123'],shopifyStoreDomain:'own.myshopify.com',shopifyCollections:[c]};
 for(const [theme,expected] of [['records','API_ARTIST_DETAIL'],['management','API_Management'],['nation','API_Booking']]){
  const actual=await artistMerchProfile({SLUG:'artist',collectionIds:['123']},theme,async(layout,slug)=>{assert.equal(layout,expected);assert.equal(slug,'artist');return [row]},true);
  assert.equal(actual,row);assert.deepEqual(await getArtistCollections(actual),[c]);
 }
});
test('known metadata, cleared collections, and legacy source do not make unnecessary detail reads',async()=>{
 const no=async()=>{throw Error('Unexpected request')};
 for(const row of [{collectionIds:[]},{SLUG:'artist',collectionIds:['123'],shopifyCollections:[]}])assert.equal(await artistMerchProfile(row,'records',no,true),row);
 const row={SLUG:'artist',collectionIds:['123']};assert.equal(await artistMerchProfile(row,'records',no,false),row);
 assert.equal(await artistMerchProfile(row,'records',async()=>[],true),row);
});
