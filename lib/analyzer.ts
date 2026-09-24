export type Category = "Capacity" | "Performance" | "Reliability" | "Logging";
export type MetricKind = "cpu" | "memory" | "error_ratio" | "latency_ms" | "availability" | "series" | "unknown";
export type Interpretation = "auto" | "cpu_ratio" | "cpu_percent" | "memory_ratio" | "memory_percent" | "error_ratio" | "latency_seconds" | "latency_ms";
export type Point = [number, number];
export type Metric = { name: string; service: string; kind: MetricKind; values: Point[]; query?: string };
export type LogEvent = { service: string; message: string; level: string; timestamp?: number; durationMs?: number; status?: number };
export type Source = { id: string; name: string; type: "Prometheus" | "Splunk" | "Application logs"; mode: "sample" | "import" | "live"; metrics: Metric[]; logs: LogEvent[]; notes: string[]; importedAt: string };
export type Finding = { id: string; title: string; service: string; category: Category; severity: "High" | "Medium" | "Low"; confidence: "Strong" | "Directional"; signal: string; measure: string; unit: string; source: string; sourceId: string; description: string; evidence: string[]; steps: string[]; caveat: string; query: string };
export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_EVENTS = 20000;
export const MAX_POINTS = 60000;
export const cpuQuery = '100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])))';
export const memoryQuery = '100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)';
const scalar = (v: unknown) => typeof v === "string" || typeof v === "number" ? String(v) : "";
const obj = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const number = (v: unknown): number | undefined => { if(v === "" || v == null || typeof v === "boolean") return undefined; const n = Number(v); return Number.isFinite(n) ? n : undefined; };
const average = (a: number[]) => a.reduce((s,v) => s+v,0) / a.length;
export const percentile = (a: number[], q: number) => { const b = [...a].sort((x,y)=>x-y); return b[Math.max(0,Math.ceil(b.length*q)-1)]; };
export const formatNumber = (v: number) => v.toLocaleString("en-US",{maximumFractionDigits:1});
export function timestamp(v: unknown): number | undefined { const n=number(v); if(n !== undefined && n > 0) return n > 1e12 ? n/1000 : n; const d=Date.parse(scalar(v)); return Number.isFinite(d) ? d/1000 : undefined; }
function inferMetric(name: string, interpretation: Interpretation): {kind: MetricKind; factor: number} {
  if (interpretation !== "auto") {
    const kind: MetricKind = interpretation.startsWith("cpu_") ? "cpu" : interpretation.startsWith("memory_") ? "memory" : interpretation.startsWith("latency_") ? "latency_ms" : "error_ratio";
    return {kind, factor: interpretation.endsWith("ratio") && kind!=="error_ratio" ? 100 : interpretation === "latency_seconds" ? 1000 : 1};
  }
  if (/^(up|probe_success)$/.test(name)) return {kind:"availability",factor:1};
  if (/prometheus_tsdb_head_series/.test(name)) return {kind:"series",factor:1};
  if (/cpu.*(?:utilization|usage)_(?:ratio|percent)$/.test(name)) return {kind:"cpu",factor:name.endsWith("ratio")?100:1};
  if (/memory.*(?:utilization|usage)_(?:ratio|percent)$/.test(name)) return {kind:"memory",factor:name.endsWith("ratio")?100:1};
  if (/error_(?:rate_)?ratio$/.test(name)) return {kind:"error_ratio",factor:1};
  if (/(?:latency|duration)_(?:p95_)?(?:milliseconds|ms)$/.test(name)) return {kind:"latency_ms",factor:1};
  return {kind:"unknown",factor:1};
}
function parseLabels(s: string) { const labels:Record<string,string>={}; for(const m of s.matchAll(/([a-zA-Z_][\w]*)\s*=\s*"((?:[^"\\]|\\.)*)"/g)) {try{labels[m[1]]=JSON.parse('"'+m[2]+'"')}catch{labels[m[1]]=m[2]}} return labels; }
function serviceOf(v: Record<string, any>) {return scalar(v.service || v.service_name || v["service.name"] || v.app || v.job || v.instance || v.host || v.container || v.sourcetype || "unlabeled").slice(0,150);}
function metricFromSeries(row: unknown, interpretation: Interpretation): Metric | undefined {
  const r=obj(row), labels=obj(r.metric), name=scalar(labels.__name__||r.name||"query_result");
  const inferred=inferMetric(name,interpretation);
  const raw = Array.isArray(r.values) ? r.values : Array.isArray(r.value) ? [r.value] : [];
  const values:Point[]=[];
  for(const v of raw) {if(!Array.isArray(v))continue;const t=number(v[0]),n=number(v[1]);if(t!==undefined&&n!==undefined)values.push([t,n*inferred.factor]);}
  if(!values.length)return;
  return {name,service:serviceOf(labels),kind:inferred.kind,values:values.sort((a,b)=>a[0]-b[0])};
}
function parseCSV(text: string): Record<string,string>[] {
  const rows:string[][]=[];let row:string[]=[],field="",quoted=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++;}else if(quoted||!field)quoted=!quoted;else field+=c;}else if(c===','&&!quoted){row.push(field);field="";}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(Boolean))rows.push(row);row=[];field="";}else field+=c;}
  if(quoted)throw new Error("The CSV has an unclosed quoted field.");if(field||row.length){row.push(field);rows.push(row);}const headers=rows.shift()?.map(x=>x.trim())||[];
  if(headers.length<2)throw new Error("The CSV needs a header row and at least two columns.");
  return rows.map((r,i)=>{if(r.length!==headers.length)throw new Error(`CSV row ${i+2} has ${r.length} fields; expected ${headers.length}.`);return Object.fromEntries(headers.map((h,j)=>[h,r[j]]));});
}
function logFromRow(input: unknown): LogEvent | undefined {
  if(typeof input==='string')input={message:input};const wrapper=obj(input);if(wrapper.preview===true||wrapper.preview===1)return;
  let r=obj(wrapper.result||input);
  if(typeof r._raw==='string'&&r._raw.trim().startsWith('{')){try{r={...obj(JSON.parse(r._raw)),...r};}catch{}}
  const message=scalar(r.message||r.msg||r.event||r._raw||r.log||r.error);
  if(!message && !r.level && !r.severity && !r.status && !r.status_code && !r.duration_ms) return;
  const level=(scalar(r.level||r.severity||r.log_level||r.loglevel)||message.match(/\b(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|CRITICAL)\b/i)?.[1]||"unknown").toUpperCase();
  let durationMs=number(r.duration_ms??r.durationMs??r.latency_ms??r.response_time_ms??r.elapsed_ms??r.time_ms);
  if(durationMs===undefined){const secs=number(r.duration_seconds??r.duration_s??r.response_time_seconds);if(secs!==undefined)durationMs=secs*1000;}
  if(durationMs===undefined){const m=message.match(/\b(?:duration|latency|response_time|elapsed)(?:_ms)?[=: ]+([\d.]+)\s*(ms|s)\b/i);if(m)durationMs=Number(m[1])*(m[2]==="s"?1000:1);}
  if(durationMs!==undefined&&durationMs<0)durationMs=undefined;
  const status=number(r.status??r.status_code??r.http_status??r.response_code)??number(message.match(/\b(?:status|status_code)[=: ]+(\d{3})\b/i)?.[1])??number(message.match(/"(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS) [^"]+"\s+(\d{3})\b/)?.[1]);
  const plainService=message.match(/\b(?:service|app)[=:]([a-zA-Z0-9_.\/-]+)/)?.[1];
  return {service:plainService && serviceOf(r)==="unlabeled" ? plainService : serviceOf(r),message:message.slice(0,2000),level,timestamp:timestamp(r.timestamp??r.time??r._time??r['@timestamp']??message.match(/^\d{4}-\d\d-\d\dT\S+/)?.[0]),durationMs,status};
}
export function parseSource(text: string, name="Imported data", type: "auto"|"prometheus"|"splunk"|"logs"="auto", interpretation: Interpretation="auto"): Source {
  if(new TextEncoder().encode(text).length>MAX_BYTES)throw new Error("Use a file smaller than 5 MB. Export a narrower time window if needed.");
  text=text.replace(/^\uFEFF/,"").trim();if(!text)throw new Error("Add metrics or log events to start an analysis.");
  const source:Source={id:`source-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,name:name.slice(0,150),type:type==="splunk"?"Splunk":"Application logs",mode:"import",metrics:[],logs:[],notes:[],importedAt:new Date().toISOString()};
  let parsed:any;let json=false;try{parsed=JSON.parse(text);json=true}catch{}
  if(json&&parsed?.schema==="signalops/v1") {
    source.type=parsed.type==="Splunk"?"Splunk":"Prometheus";
    if(Array.isArray(parsed.notes))source.notes.push(...parsed.notes.filter((v:unknown)=>typeof v==="string").slice(0,30).map((v:string)=>v.slice(0,1000)));
    for(const item of Array.isArray(parsed.metrics)?parsed.metrics:[]) {
      const r=obj(item); const kinds:MetricKind[]=["cpu","memory","error_ratio","latency_ms","availability","series","unknown"];
      if(!kinds.includes(r.kind))throw new Error("The metric bundle contains an unsupported metric kind.");
      const values:Point[]=(Array.isArray(r.values)?r.values:[]).filter((v:any)=>Array.isArray(v)&&number(v[0])!==undefined&&number(v[1])!==undefined).map((v:any)=>[Number(v[0]),Number(v[1])]);
      if(values.length)source.metrics.push({name:scalar(r.name),service:scalar(r.service)||"unlabeled",kind:r.kind,values:values.sort((a,b)=>a[0]-b[0]),query:scalar(r.query)});
    }
    source.logs=(Array.isArray(parsed.logs)?parsed.logs:[]).map(logFromRow).filter(Boolean) as LogEvent[];
  } else if(json && parsed?.status==="error")throw new Error("This export contains a Prometheus API error, not metric data.");
  else if(json && Array.isArray(parsed?.data?.result)) {
    source.type="Prometheus";source.metrics=parsed.data.result.map((r:any)=>metricFromSeries(r,interpretation)).filter(Boolean);
  } else if((type==="prometheus"||type==="auto") && !json && !/^(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)\s/m.test(text) && /^(?:[a-zA-Z_:][\w:]*)(?:\{[^\n]*\})?\s+[-+\d.]/m.test(text)) {
    source.type="Prometheus";const series=new Map<string,Metric>();let ignored=0;
    for(const line of text.split(/\r?\n/)){if(!line.trim()||line.startsWith('#'))continue;const m=line.match(/^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+([-+\d.eE]+)(?:\s+([-+\d.eE]+))?\s*$/);if(!m){ignored++;continue;}const labels=parseLabels(m[2]||"");const inferred=inferMetric(m[1],interpretation);const key=m[1]+JSON.stringify(labels);const metric=series.get(key)||{name:m[1],service:serviceOf(labels),kind:inferred.kind,values:[]};const val=number(m[3]);if(val!==undefined)metric.values.push([m[4]?Number(m[4])/1000:Date.now()/1000,val*inferred.factor]);series.set(key,metric);}
    source.metrics=[...series.values()];if(ignored)source.notes.push(`${ignored} metric lines could not be parsed.`);
  } else {
    let rows:any[]=[];
    if(json){rows=Array.isArray(parsed)?parsed:Array.isArray(parsed?.results)?parsed.results:Array.isArray(parsed?.events)?parsed.events:[parsed];if(parsed?.results||parsed?.result)source.type="Splunk";}
    else if(/(?:^|,)(?:"?)(?:message|_raw|level|service|timestamp|duration_ms)(?:"?)(?:,|$)/i.test(text.split('\n')[0]))rows=parseCSV(text);
    else {let skipped=0;for(const line of text.split(/\r?\n/).filter(l=>l.trim())){if(line.trim().startsWith('{')||line.trim().startsWith('[')){try{const r=JSON.parse(line);if(r.result)source.type="Splunk";rows.push(r);}catch{skipped++;}}else rows.push(line);}if(skipped)source.notes.push(`${skipped} malformed JSON lines were skipped.`);}
    if(rows.length>MAX_EVENTS)throw new Error("This input exceeds 20,000 events. Export a smaller sample.");
    if(rows.some(r=>obj(r).count!==undefined))source.notes.push("Count fields are not used as event weights. Import raw events; aggregated search results can bias event shares.");
    source.logs=rows.map(logFromRow).filter(Boolean) as LogEvent[];
    if(rows.length>source.logs.length)source.notes.push(`${rows.length-source.logs.length} records had no recognized log fields or were preview results.`);
  }
  const points=source.metrics.reduce((n,m)=>n+m.values.length,0);
  if(points>MAX_POINTS||source.logs.length>MAX_EVENTS)throw new Error("This input exceeds 60,000 metric points or 20,000 log events. Export a smaller sample.");
  if(!points&&!source.logs.length)throw new Error("No usable data found. Import a Prometheus matrix/vector response, metrics text, JSON/NDJSON events, CSV with headers, or plain-text logs.");
  const unknown=source.metrics.filter(m=>m.kind==="unknown").length;if(unknown)source.notes.push(`${unknown} metric series have unknown units or are raw counters. They are retained but excluded from optimization rules. Choose a signal interpretation for a single-query export.`);
  if(source.metrics.some(m=>m.values.length<12))source.notes.push("Short metric snapshots cannot establish sustained utilization. Capacity reduction needs at least 12 points spanning 6 hours.");
  if(source.logs.some(l=>l.service==="unlabeled"))source.notes.push("Some events have no service field and are grouped as unlabeled.");
  return source;
}
function normalizedMessage(s:string){return s.replace(/\b\d{4}-\d{2}-\d{2}T\S+/g,"<time>").replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi,"<id>").replace(/\b\d+(?:\.\d+)?\b/g,"<n>").trim().slice(0,300);}
function errorEvent(l:LogEvent){return /^(ERROR|FATAL|CRITICAL)$/.test(l.level)||(l.status!==undefined&&l.status>=500);}
export function analyze(sources: Source[]): Finding[] {
  const results:Finding[]=[];
  function add(s:Source,service:string,rule:string,f:Omit<Finding,"id"|"source"|"sourceId"|"service">){results.push({...f,id:`${s.id}:${service}:${rule}:${results.length}`,service,source:s.type,sourceId:s.id});}
  for(const s of sources){
    for(const m of s.metrics){
      const valid=m.values.filter(([,v])=>Number.isFinite(v)&&(m.kind==="cpu"||m.kind==="memory"?v>=0&&v<=100:m.kind==="error_ratio"||m.kind==="availability"?v>=0&&v<=1:v>=0));
      if(!valid.length)continue;const vals=valid.map(v=>v[1]), avg=average(vals), p95=percentile(vals,.95), max=Math.max(...vals), span=Math.max(...valid.map(v=>v[0]))-Math.min(...valid.map(v=>v[0]));
      const evidence=[`${valid.length} valid samples over ${formatNumber(span/3600)} hours.`,`Average ${formatNumber(avg)}${m.kind==="cpu"||m.kind==="memory"?"%":""}; p95 ${formatNumber(p95)}; peak ${formatNumber(max)}.`,`Metric: ${m.name}.`];
      const caveat="Observations describe only the supplied window. Confirm peak demand, redundancy, and service objectives before changing resources.";
      if(m.kind==="cpu"&&avg<20&&p95<40&&valid.length>=12&&span>=6*3600)add(s,m.service,"cpu-low",{title:"Right-size underused compute",category:"Capacity",severity:"Medium",confidence:"Directional",signal:`${formatNumber(avg)}% avg CPU`,measure:formatNumber(avg),unit:"%",description:"CPU use stays low throughout the observed window, making this workload a candidate for a capacity review.",evidence,steps:["Compare at least 7 days of CPU, memory, traffic, and peak demand.","Check redundancy and minimum replica requirements.","Trial one smaller instance or a small resource-request reduction; watch latency and saturation before expanding."],caveat,query:m.query||cpuQuery});
      if((m.kind==="cpu"||m.kind==="memory")&&avg>=85)add(s,m.service,`${m.kind}-high`,{title:m.kind==="cpu"?"Relieve CPU saturation":"Investigate memory pressure",category:"Capacity",severity:"High",confidence:valid.length>=12&&span>=3600?"Strong":"Directional",signal:`${formatNumber(avg)}% avg ${m.kind}`,measure:formatNumber(avg),unit:"%",description:`Average ${m.kind} utilization exceeds the 85% review threshold. Investigate pressure before reducing capacity.`,evidence,steps:["Correlate the pressure with traffic, deployments, and latency.",m.kind==="cpu"?"Profile hot code paths and inspect concurrency or CPU throttling.":"Inspect heap growth, cache sizes, and out-of-memory events.","Validate a targeted change under representative load."],caveat,query:m.query||(m.kind==="cpu"?cpuQuery:memoryQuery)});
      if(m.kind==="error_ratio"&&avg>=.01)add(s,m.service,"errors-metric",{title:"Reduce failed requests",category:"Reliability",severity:avg>=.05?"High":"Medium",confidence:valid.length>=12?"Strong":"Directional",signal:`${formatNumber(avg*100)}% mean error ratio`,measure:formatNumber(avg*100),unit:"%",description:"The mean of the supplied error-ratio samples exceeds 1%.",evidence:[...evidence,"This is an unweighted mean across time, not total failed requests divided by total requests."],steps:["Break errors down by status, endpoint, and dependency.","Correlate spikes with deploys and saturation.","Address the largest error signature and verify against your service objective."],caveat:"Error-ratio definitions depend on the source query; compare with your own SLO.",query:m.query||"Use the source error-ratio query, grouped by service and status."});
      if(m.kind==="availability"&&vals.some(v=>v===0))add(s,m.service,"availability",{title:"Investigate failed scrapes or probes",category:"Reliability",severity:"High",confidence:"Strong",signal:`${vals.filter(v=>v===0).length}/${vals.length} failed samples`,measure:String(vals.filter(v=>v===0).length),unit:" failed",description:"The availability signal was zero in at least one sample.",evidence,steps:["Check target health and scrape errors in Prometheus.","Inspect network reachability, timeouts, and exporter health.","Confirm recovery across several scrape intervals."],caveat:"A scrape failure is not proof that the application was unavailable to users.",query:m.query||'up == 0'});
      if(m.kind==="series"&&max>1000000)add(s,m.service,"series",{title:"Review active-series cardinality",category:"Logging",severity:"Medium",confidence:"Directional",signal:`${formatNumber(max)} active series`,measure:formatNumber(max/1000000),unit:"M",description:"Active time series exceed the one-million-series review threshold.",evidence,steps:["Find metrics and label values contributing the most series.","Check for unbounded labels such as request IDs or user IDs.","Drop unused metrics or constrain labels, then measure memory and query latency."],caveat:"High cardinality may be intentional. This threshold alone does not establish waste or monetary savings.",query:m.query||"topk(20, count by (__name__)({__name__=~\".+\"}))"});
      if(m.kind==="latency_ms"&&p95>500)add(s,m.service,"metric-latency",{title:"Inspect elevated latency samples",category:"Performance",severity:p95>=1000?"High":"Medium",confidence:vals.length>=20?"Strong":"Directional",signal:`${formatNumber(p95)} ms sample p95`,measure:formatNumber(p95),unit:"ms",description:"The p95 of supplied latency values exceeds 500 ms.",evidence,steps:["Compare to the latency objective for this service.","Inspect slow paths, dependency timings, and queue depth.","Profile a representative slow request and verify the improvement."],caveat:"A percentile of aggregated latency samples is not the overall request latency percentile.",query:m.query||"Review the query used to generate this latency export."});
    }
    const services=new Map<string,LogEvent[]>();for(const log of s.logs){const a=services.get(log.service)||[];a.push(log);services.set(log.service,a);}
    for(const [service,logs] of services){const n=logs.length, errors=logs.filter(errorEvent),debug=logs.filter(l=>/^(DEBUG|TRACE)$/.test(l.level)),retry=logs.filter(l=>/\b(retry|retrying|retries|backoff)\b/i.test(l.message)),durations=logs.filter(l=>l.durationMs!==undefined).map(l=>l.durationMs!);
      const baseCaveat="Log events can be sampled, duplicated, or emitted multiple times per request. Event share is not request failure rate. Validate changes against the full source.";
      if(n>=20&&errors.length/n>=.02&&errors.length>=3)add(s,service,"log-errors",{title:"Investigate elevated error volume",category:"Reliability",severity:errors.length/n>=.1?"High":"Medium",confidence:"Strong",signal:`${formatNumber(errors.length/n*100)}% error events`,measure:formatNumber(errors.length/n*100),unit:"%",description:"Error-level events or HTTP 5xx responses form a material share of this service's imported logs.",evidence:[`${errors.length} error events out of ${n} total events (${formatNumber(errors.length/n*100)}%).`,`Rule: at least 20 events, at least 3 errors, and an error-event share of 2% or more.`,...errors.slice(0,3).map(l=>l.message)],steps:["Group errors by signature, endpoint, and dependency.","Inspect the most frequent signature and correlate it with deploys or resource pressure.","Fix one contributing cause and compare error-event share over equivalent traffic windows."],caveat:baseCaveat,query:s.type==="Splunk"?`search index=<your_index> service="${service.replace(/["\\]/g,"")}"
| stats count by level, status`:`Filter service=${service} and level in ERROR/FATAL/CRITICAL, or HTTP status >= 500.`});
      if(durations.length>=20){const p95=percentile(durations,.95);if(p95>500)add(s,service,"log-latency",{title:"Inspect slow request paths",category:"Performance",severity:p95>=1000?"High":"Medium",confidence:"Strong",signal:`${formatNumber(p95)} ms p95`,measure:formatNumber(p95),unit:"ms",description:"The p95 of parsed duration values is above the 500 ms review threshold.",evidence:[`${durations.length} events have explicit duration units.`,`p50 ${formatNumber(percentile(durations,.5))} ms · p95 ${formatNumber(p95)} ms · max ${formatNumber(Math.max(...durations))} ms.`,"Percentile method: nearest rank; all supplied duration events carry equal weight."],steps:["Break down slow events by route and dependency.","Inspect database queries, network waits, and queue time for the slowest paths.","Set a service-specific target and remeasure p95 after the change."],caveat:"This is the percentile of supplied events, not necessarily all requests. Sampling and mixed endpoints can bias it.",query:s.type==="Splunk"?'search index=<your_index> | stats count perc95(duration_ms) by service':"Group explicit duration_ms values by service; compute the nearest-rank p95."});}
      if(n>=20&&debug.length/n>=.3)add(s,service,"debug",{title:"Reduce verbose logging volume",category:"Logging",severity:"Medium",confidence:"Strong",signal:`${formatNumber(debug.length/n*100)}% debug / trace`,measure:formatNumber(debug.length/n*100),unit:"%",description:"Debug and trace events dominate a substantial portion of this service's log sample.",evidence:[`${debug.length} DEBUG or TRACE events out of ${n} events.`,`Rule: at least 20 events and DEBUG/TRACE share at or above 30%.`,...debug.slice(0,2).map(l=>l.message)],steps:["Identify verbose statements that are no longer useful at the current log level.","Apply sampling or raise the production log level for those statements.","Retain incident diagnostics, audit events, and required retention; compare ingested bytes after a trial."],caveat:"Event counts do not measure byte volume or billable ingestion. Savings require byte and pricing data.",query:s.type==="Splunk"?'search index=<your_index> | stats count by service, level':"Count DEBUG and TRACE events by service and compare with all events."});
      if(n>=20&&retry.length>=5&&retry.length/n>=.05)add(s,service,"retries",{title:"Review retry amplification",category:"Reliability",severity:retry.length/n>=.2?"High":"Medium",confidence:"Directional",signal:`${formatNumber(retry.length/n*100)}% retry mentions`,measure:formatNumber(retry.length/n*100),unit:"%",description:"Retry or backoff messages appear frequently in the imported events.",evidence:[`${retry.length} of ${n} events mention retries or backoff.`,...retry.slice(0,3).map(l=>l.message)],steps:["Identify which dependency and operation trigger retries.","Check retry caps, exponential backoff, jitter, and timeout budgets.","Validate idempotency and avoid retries across several layers for the same request."],caveat:"Text mentions suggest retry activity but do not establish actual retry counts or root cause.",query:s.type==="Splunk"?'search index=<your_index> ("retry" OR "retrying" OR "backoff") | stats count by service':"Search messages for retry, retrying, retries, or backoff; correlate request IDs."});
      const patterns=new Map<string,number>();for(const l of logs.filter(l=>/^(WARN|WARNING|ERROR|FATAL|CRITICAL)$/.test(l.level))){const key=normalizedMessage(l.message);if(key)patterns.set(key,(patterns.get(key)||0)+1);}const top=[...patterns].sort((a,b)=>b[1]-a[1])[0];
      if(top&&top[1]>=10&&top[1]/n>=.3)add(s,service,"duplicates",{title:"Investigate a repeated log signature",category:"Logging",severity:"Medium",confidence:"Directional",signal:`${top[1]} similar events`,measure:String(top[1]),unit:" events",description:"One normalized warning or error message accounts for at least 30% of this service's log events.",evidence:[`Pattern: ${top[0]}`,`${top[1]} matches out of ${n} total events.`,`Numbers, timestamps, and UUIDs are normalized before comparison.`],steps:["Inspect the repeated signature for a persistent underlying fault.","Fix the source condition first; consider rate limiting only if events remain redundant.","Retain counts and enough samples to diagnose future incidents."],caveat:"Normalization can group unrelated events. Review raw examples before suppressing any logs.",query:"Group warning/error messages after normalizing timestamps, numbers, and UUIDs."});
    }
  }
  const priority={High:0,Medium:1,Low:2};return results.sort((a,b)=>priority[a.severity]-priority[b.severity]||a.title.localeCompare(b.title));
}
export function summary(sources:Source[]){const findings=analyze(sources);return {findings,services:new Set(sources.flatMap(s=>[...s.metrics.map(m=>m.service),...s.logs.map(l=>l.service)])).size,events:sources.reduce((n,s)=>n+s.logs.length,0),points:sources.reduce((n,s)=>n+s.metrics.reduce((n,m)=>n+m.values.length,0),0)};}
export function reportMarkdown(sources:Source[]):string {const s=summary(sources);return `# SignalOps optimization report\n\nGenerated: ${new Date().toISOString()}\n\n${sources.every(s=>s.mode==="sample")?"**SAMPLE DATA — simulated environment.**\n\n":""}${s.services} services · ${s.events} events · ${s.points} metric points · ${s.findings.length} opportunities\n\n## Sources\n${sources.map(x=>`- ${x.name} (${x.type}; ${x.mode})`).join('\n')}\n\n${s.findings.map((f,i)=>`## ${i+1}. ${f.title}\n\n${f.service} · ${f.severity} priority · ${f.category} · ${f.confidence} evidence\n\n${f.description}\n\n**Observed:** ${f.signal}\n\n${f.evidence.map(e=>`- ${e}`).join('\n')}\n\n**Suggested actions**\n\n${f.steps.map((v,j)=>`${j+1}. ${v}`).join('\n')}\n\n**Limitations:** ${f.caveat}\n\n**Verification query / approach**\n\n\`\`\`text\n${f.query}\n\`\`\`\n`).join('\n')}\n## Analysis notes\n\n${sources.flatMap(x=>x.notes).map(x=>`- ${x}`).join('\n')||"No parser warnings."}\n\nRecommendations are rule-based hypotheses. No infrastructure changes have been made. Validate under representative load before acting.\n`;}
