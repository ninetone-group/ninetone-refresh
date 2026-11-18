import test from 'node:test';
import assert from 'node:assert/strict';
import {groupBookingTours,stockholmDay,stopDateLabel} from '../src/lib/booking-tours.ts';
const row=(id,changes={})=>({SLUG:'test_artist',id,tourId:'one',tourName:'A tour',tourDescription:'Public text',dateStart:'2026-11-21',dateEnd:'',venue:'Venue',location:'Inside',city:'Kosta',address:'Street 96',...changes});
test('same tour stays together, old stops remain, duplicate tour names stay separate',()=>{
 const tours=groupBookingTours([row('future'),row('past',{dateStart:'2026-11-01'}),row('second',{tourId:'two'})],'2026-11-18');
 assert.equal(tours.length,2);assert.equal(tours[0].past[0].id,'past');assert.equal(tours[0].upcoming[0].id,'future');
});
test('ongoing and today are not past; end-only and undated preserve uncertainty',()=>{
 const [tour]=groupBookingTours([row('ongoing',{dateStart:'2026-11-01',dateEnd:'2026-11-20'}),row('today',{dateStart:'2026-11-18'}),row('end',{dateStart:'',dateEnd:'2026-11-17'}),row('undated',{dateStart:''})],'2026-11-18');
 assert.deepEqual(tour.past.map(s=>s.id),['end']);assert.deepEqual(tour.upcoming.map(s=>s.id),['ongoing','today','undated']);
 assert.equal(stopDateLabel(tour.upcoming[2]),'Datum meddelas');assert.match(stopDateLabel(tour.upcoming[0]),/1 november 2026 – 20 november 2026/);
});
test('Stockholm midnight and reverse historical sorting',()=>{
 assert.equal(stockholmDay(new Date('2026-11-17T23:30:00Z')),'2026-11-18');
 const [tour]=groupBookingTours([row('old',{dateStart:'2020-01-01'}),row('recent',{dateStart:'2026-11-17'})],'2026-11-18');
 assert.deepEqual(tour.past.map(s=>s.id),['recent','old']);assert.equal(tour.upcoming.length,0);
});
test('invalid, duplicate, conflicting and missing data fail closed',()=>{
 for(const rows of [[row('same'),row('same')],[row('bad',{dateStart:'2026-02-31'})],[row('bad',{dateEnd:'2020-01-01'})],[row('a'),row('b',{tourDescription:'Different'})],[row('bad',{address:null})]])assert.throws(()=>groupBookingTours(rows,'2026-11-18'));
 assert.deepEqual(groupBookingTours([]),[]);
});
test('standalone stops have no invented tour copy',()=>{
 const [tour]=groupBookingTours([row('a',{tourId:'',tourName:'PRIVATE',tourDescription:'PRIVATE'})],'2026-11-18');
 assert.equal(tour.name,'');assert.equal(tour.description,'');
});
