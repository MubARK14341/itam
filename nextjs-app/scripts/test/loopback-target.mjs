export function assertLoopbackBaseUrl(value){
 const url=new URL(value);
 if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='4173'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Refusing non-local E2E target');
 return url.origin;
}
