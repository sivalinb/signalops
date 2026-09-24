import { getChatGPTUser } from '@/app/chatgpt-auth';
import { METRIC_QUERIES, validateEndpoint, verifyPublicDNS, readRemote, boundedText } from '@/lib/connector';
const lastRequest=new Map<string,number>();
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export async function POST(request:Request){
 const user=await getChatGPTUser();if(!user)return json({error:'Sign in to use a live connection.'},401);
 const origin=request.headers.get('origin');if(origin&&origin!==new URL(request.url).origin)return json({error:'Cross-origin connections are not allowed.'},403);
 try{
  if(!request.headers.get('content-type')?.includes('application/json'))return json({error:'Use a JSON request.'},415);
  const body=JSON.parse(await boundedText(new Response(request.body),16000));
  if(!['prometheus','splunk'].includes(body.type))throw new Error('Choose Prometheus or Splunk.');
  const endpoint=validateEndpoint(body.url);
  const token=typeof body.token==='string'?body.token:'';if(token.length>6000||/[\r\n]/.test(token))throw new Error('The token format is invalid.');
  if(![1,6,24,168].includes(body.hours))throw new Error('Choose a 1-hour, 6-hour, 24-hour, or 7-day window.');
  if(body.type==='splunk'&&(!token||typeof body.index!=='string'||!/^[a-zA-Z0-9_.*-]{1,120}$/.test(body.index)))throw new Error('Enter a token and an index name using letters, numbers, underscores, dots, dashes, or asterisks.');
  const now=Date.now();if(now-(lastRequest.get(user.userId)||0)<10000)return json({error:'Wait a few seconds before running another live query.'},429);
  if(lastRequest.size>500)lastRequest.clear();lastRequest.set(user.userId,now);
  await verifyPublicDNS(endpoint.hostname);
  const headers:Record<string,string>={Accept:'application/json'};if(token)headers.Authorization=`${body.auth==='session'&&body.type==='splunk'?'Splunk':'Bearer'} ${token}`;
  if(body.type==='splunk'){
   const url=new URL('services/search/v2/jobs/export',endpoint);
   const data=new URLSearchParams({search:`search index=${body.index} | head 5000`,earliest_time:`-${body.hours}h`,latest_time:'now',output_mode:'json',preview:'false',max_time:'15'});
   const text=await readRemote(url,{method:'POST',headers:{...headers,'Content-Type':'application/x-www-form-urlencoded'},body:data});
   return json({text,name:`${endpoint.hostname} / ${body.index}`,notes:['Read-only search, capped at 5,000 recent events and a 15-second search runtime. This sample may be incomplete.']});
  }
  const end=Math.floor(Date.now()/1000),start=end-body.hours*3600,step=Math.max(60,Math.ceil(body.hours*3600/96));
  const results=await Promise.allSettled(METRIC_QUERIES.map(async q=>{
   const url=new URL('api/v1/query_range',endpoint);url.search=new URLSearchParams({query:q.query,start:String(start),end:String(end),step:String(step),timeout:'15s',limit:'100'}).toString();
   const result=JSON.parse(await readRemote(url,{headers}));if(result.status!=='success'||!Array.isArray(result.data?.result))throw new Error(`No valid response for ${q.name}.`);
   return {query:q,rows:result.data.result.slice(0,100),warnings:Array.isArray(result.warnings)?result.warnings:[],capped:result.data.result.length>=100};
  }));
  const metrics:any[]=[],notes:string[]=[];
  for(let i=0;i<results.length;i++){const result=results[i];if(result.status==='rejected'){notes.push(`${METRIC_QUERIES[i].name}: ${result.reason instanceof Error?result.reason.message:'Query failed.'}`);continue;}const {query,rows,warnings,capped}=result.value;for(const row of rows){metrics.push({name:query.name,kind:query.kind,service:row.metric?.instance||row.metric?.job||'unlabeled',values:row.values,query:query.query});}if(!rows.length)notes.push(`${query.name}: no series returned. The corresponding exporter or metric may be absent.`);if(capped)notes.push(`${query.name}: limited to 100 series.`);if(warnings.length)notes.push(`${query.name}: Prometheus reported partial-data warnings.`);}
  if(!metrics.length)throw new Error('No usable metric series were returned. Check the endpoint, token, and node-exporter metrics. '+notes.join(' '));
  return json({text:JSON.stringify({schema:'signalops/v1',metrics}),name:endpoint.hostname,notes:[...notes,'Queries cover node CPU, node memory, scrape availability, and TSDB series. Application latency and error metrics require an import with an explicit signal interpretation.']});
 }catch(error){const message=error instanceof Error?error.message:'The connection failed.';return json({error:/timeout|aborted/i.test(message)?'The server took too long to respond. Try a shorter window or import an export.':/fetch failed|network|DNS/i.test(message)?'The endpoint could not be reached. Check its public HTTPS address and certificate, or use an export.':message},400);}
}
