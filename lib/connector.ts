import { cpuQuery, memoryQuery, MAX_BYTES } from './analyzer';
export const METRIC_QUERIES = [
  {name:'node_cpu_usage_percent',kind:'cpu',query:cpuQuery},
  {name:'node_memory_usage_percent',kind:'memory',query:memoryQuery},
  {name:'up',kind:'availability',query:'up'},
  {name:'prometheus_tsdb_head_series',kind:'series',query:'prometheus_tsdb_head_series'},
] as const;
export function publicAddress(address:string):boolean{
 if(address.includes(':')){const a=address.toLowerCase();return /^[23][0-9a-f]{3}:/.test(a)&&!a.startsWith('2001:db8:');}
 const parts=address.split('.').map(Number);if(parts.length!==4||parts.some(n=>!Number.isInteger(n)||n<0||n>255))return false;
 const [a,b]=parts;return a>0&&a<224&&a!==10&&a!==127&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&(b===168||b===0))&&!(a===100&&b>=64&&b<=127)&&!(a===198&&(b===18||b===19));
}
export function validateEndpoint(raw:unknown):URL {
 if(typeof raw!=='string'||raw.length>2000)throw new Error('Enter the HTTPS base URL of your telemetry server.');
 let u:URL;try{u=new URL(raw)}catch{throw new Error('Enter a valid HTTPS base URL.');}
 if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw new Error('Use an HTTPS base URL without credentials, query parameters, or a fragment.');
 const host=u.hostname.toLowerCase().replace(/\.$/,'');
 if(!host.includes('.')||host.includes(':')||/^[\d.]+$/.test(host)||/(^|\.)(localhost|local|internal|test|invalid|example)$/.test(host))throw new Error('Hosted connections require a public DNS hostname. For private networks, use the downloadable collector or an export.');
 u.hostname=host;if(!u.pathname.endsWith('/'))u.pathname+='/';return u;
}
export async function verifyPublicDNS(host:string){
 const answers=await Promise.all(['A','AAAA'].map(async type=>{const res=await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,{headers:{Accept:'application/dns-json'},signal:AbortSignal.timeout(8000)});if(!res.ok)throw new Error('DNS verification failed. Try an export instead.');return res.json() as Promise<{Status:number;Answer?:{type:number;data:string}[]}>;}));
 const addresses=answers.flatMap(r=>(r.Answer||[]).filter(x=>x.type===1||x.type===28).map(x=>x.data));
 if(!addresses.length||addresses.some(a=>!publicAddress(a)))throw new Error('The server does not resolve to a public address. Use the collector inside your network and import its output.');
}
export async function boundedText(response:Response,limit=MAX_BYTES):Promise<string>{
 if(!response.body) return '';
 const reader=response.body.getReader(),decoder=new TextDecoder();let bytes=0,text='';
 try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>limit)throw new Error('The response exceeds 5 MB. Select a shorter time window or export a smaller sample.');text+=decoder.decode(value,{stream:true});}return text+decoder.decode();}finally{await reader.cancel().catch(()=>{});}
}
export async function readRemote(url:URL,init:RequestInit){
 const response=await fetch(url,{...init,redirect:'manual',signal:AbortSignal.timeout(20000),cache:'no-store'});
 if(response.status>=300&&response.status<400)throw new Error('The server redirected the request. Enter its final HTTPS API base URL; credentials are never forwarded through redirects.');
 if(response.status===401||response.status===403)throw new Error('The server denied access. Check the read-only token and API permissions.');
 if(!response.ok)throw new Error(`The server returned HTTP ${response.status}. Check the base URL and API availability.`);
 return boundedText(response);
}
