import {assertPublicationEnvironment,assertApprovedOrLocalSupabaseTarget,validateApprovedSupabaseTarget} from './production-boundary.mjs';
assertPublicationEnvironment(process.env);
assertApprovedOrLocalSupabaseTarget({url:'https://demo.invalid',projectRef:'demo'});
if(validateApprovedSupabaseTarget({url:'https://example.com',projectRef:'unknown'}).ok)throw Error('Hosted target unexpectedly accepted');
console.log(JSON.stringify({mode:'offline_configuration_only',hosted:false,database_queries:0}));
