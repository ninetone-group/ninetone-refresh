import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalTeamSlug } from '../src/lib/team-aliases.ts';
test('temporary team URLs retain permanent redirects to original slugs',()=>{
 assert.equal(canonicalTeamSlug('office-cc812810d6565ba7adcdbc73074592dc'),'stefan_hallgren');
 assert.equal(canonicalTeamSlug('office-8c37b65e4fbc56cf90e3390232a7fabc'),'philip_vedl');
 assert.equal(canonicalTeamSlug('stefan_hallgren'),undefined);
 assert.equal(canonicalTeamSlug('unknown'),undefined);
});
