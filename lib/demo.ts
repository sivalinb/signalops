import { type Source, type Point, cpuQuery } from './analyzer';
export function demoSources():Source[]{
 const start=Date.UTC(2026,8,23)/1000;
 const wave=[48,51,45,59,54,63,61,77,69,74,58,65,82,68,61,73,67,80,70,75,56,66,69,64];
 const points=(vals:number[]):Point[]=>vals.map((v,i)=>[start+i*3600,v]);
 const metrics:Source={id:'sample-prometheus',name:'production / node-exporter',type:'Prometheus',mode:'sample',importedAt:'2026-09-24T00:00:00Z',notes:['Simulated metrics over 23 hours. No production source is connected.'],logs:[],metrics:[{name:'node_cpu_usage_percent',kind:'cpu',service:'checkout-api',values:points(wave),query:cpuQuery},{name:'node_cpu_usage_percent',kind:'cpu',service:'worker-pool',values:points([13,15,12,17,14,12,15,11,16,14,16,14,12,17,13,11,16,15,18,14,12,16,16,15]),query:cpuQuery}]};
 const splunk:Source={id:'sample-splunk',name:'production / application events',type:'Splunk',mode:'sample',importedAt:'2026-09-24T00:00:00Z',notes:['Simulated logs. Counts and findings are computed from the sample events.'],metrics:[],logs:[]};
 for(let i=0;i<500;i++){splunk.logs.push({service:'payments-api',timestamp:start+i*165,level:i%25<3?'ERROR':i%20===0?'WARN':'INFO',message:i%25<3?'Payment gateway request failed: upstream timeout':i%20===0?'Retrying payment provider request with backoff':'Payment processed',status:i%25<3?502:200});splunk.logs.push({service:'checkout-api',timestamp:start+i*165,level:'INFO',message:'Checkout request completed',durationMs:i%10===0?1840+i%80:120+(i%17)*16,status:200});}
 const logs:Source={id:'sample-logs',name:'catalog-api / application.log',type:'Application logs',mode:'sample',importedAt:'2026-09-24T00:00:00Z',notes:['Simulated application logs.'],metrics:[],logs:Array.from({length:500},(_,i)=>({service:'catalog-api',timestamp:start+i*165,level:i%100<62?'DEBUG':'INFO',message:i%100<62?'Resolved product cache key for catalog lookup':'Catalog request completed'}))};
 return [metrics,splunk,logs];
}
