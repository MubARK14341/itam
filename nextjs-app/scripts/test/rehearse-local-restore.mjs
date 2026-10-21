export const restoreLimitations=Object.freeze([
 'No database restore was executed.',
 'Storage object bytes outside PostgreSQL were not included.',
 'The local manifest replay has no Supabase platform migration ledger',
 'RPO and RTO were not approved or measured for production.',
]);
if(process.argv.slice(2).join(' ')!=='--plan')throw Error('Restore execution is disabled; use --plan to inspect limitations.');
console.log(JSON.stringify({mode:'plan_only',executed:false,limitations:restoreLimitations}));
