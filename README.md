# SignalOps

An observability optimization tool for Prometheus metrics, Splunk events, and other logs. Findings are computed with deterministic rules and include measured evidence, suggested steps, verification queries, and limitations. The initial environment is clearly marked sample data.

## Use the dashboard

1. Select **New analysis**.
2. Import a file, paste telemetry, or select a live Prometheus/Splunk connection.
3. Filter opportunities by category, service, or priority. Open a finding to inspect evidence.
4. **Export report** saves a Markdown report before the session is closed.

Imports stay in browser memory. There is no database or localStorage persistence. The first import replaces sample data; later imports add sources, up to eight. Live connections capture snapshots, not continuous monitoring. Tokens are used only for the current request and are cleared when the connection dialog closes. No infrastructure changes are performed.

## Data formats

- Prometheus `/api/v1/query_range` matrix or `/api/v1/query` vector JSON responses.
- Prometheus exposition text; unsupported raw counters are retained but never interpreted as utilization.
- Splunk JSON `results`, streaming JSON `result` records, CSV exports, and nested JSON `_raw` fields. Preview events are skipped.
- JSON arrays, NDJSON/JSONL, CSV with headers and quoted multiline fields, or plain text logs.
- SignalOps collector bundles (`schema: "signalops/v1"`).

Useful log fields: `service`, `level`, `message`, `timestamp`, `duration_ms`, and `status`. Common aliases are supported. Durations need explicit units. Select **Metric interpretation** for a single-query metric export whose name does not express its units. Do not override units for a mixed-signal export.

Per source limits: 5 MB, 20,000 events, 60,000 metric points. Parse notes identify malformed or unsupported records. Aggregate Splunk result counts are not treated as event weights; import raw events for meaningful event shares.

## Live sources

Prometheus runs fixed read-only range queries for node CPU, node memory, `up`, and TSDB head-series count. Node exporter is required for the CPU and memory queries. Each query is bounded to 100 series and about 97 points per series.

Splunk uses `POST /services/search/v2/jobs/export` with a fixed `search index=... | head 5000`, a chosen lookback window, and a 15-second search runtime. Use a token limited to search access. The sample may be incomplete. API access and network allowlisting depend on your Splunk deployment.

Hosted live sources require public HTTPS endpoints with valid certificates. The connector checks identity, input sizes, DNS addresses, timeouts, and redirect behavior; it never forwards credentials through a redirect. No production endpoint was supplied during development, so live end-to-end testing against a real Prometheus or Splunk account remains to be done.

## Private network collector

Download `collect.py` from **Data sources** and run it on a machine that can reach the server. Python 3.10+; no extra packages. It creates a local output file and never uploads data to SignalOps.

```sh
python3 collect.py prometheus --url http://localhost:9090 --hours 24 --output metrics.json
python3 collect.py splunk --url https://splunk.example.net:8089 --index main --hours 6 --prompt-token --output logs.json
```

Tokens can also be supplied through `SIGNALOPS_TOKEN`. `--auth session` supports Splunk session tokens. `--ca-file /path/to/ca.pem` supports a private CA; TLS verification remains enabled. HTTP is allowed only without a token. Files are created with owner-only permissions and exclusive creation to prevent accidental overwrite. Import the resulting file into the dashboard.

## Rules and limits of interpretation

- Low CPU: mean <20%, p95 <40%, at least 12 samples spanning 6 hours. This is a capacity-review candidate, not a resizing prescription.
- Resource pressure: mean CPU or memory >=85%.
- Latency: sample p95 >500 ms; log duration rules require 20 events.
- Error logs: at least 3 errors and >=2% of at least 20 events. High priority at 10%.
- Debug/trace: >=30% of at least 20 events.
- Retry mentions: at least 5 mentions and >=5% of at least 20 events.
- Repeated warning/error: at least 10 matches and >=30% of all events.
- Error ratio metrics: unweighted temporal mean >=1%; high priority at 5%.
- Availability: any `up` or probe sample equal to zero.
- TSDB series: peak over one million triggers a review.

Event shares are not request failure rates. Percentiles of preaggregated metrics are not global request percentiles. Sampling, window length, and missing fields affect the findings. Validate recommendations against full production telemetry, redundancy needs, and service objectives. No monetary savings are estimated.

## Development

This public source copy omits the private Site project ID and generated build cache. Deploy a new Site with your own project identity.

```sh
npm ci
npm run dev
node tests/analysis.test.mjs
npx tsc --noEmit
npm run build
```

The app uses the bundled Sites/Vinext starter and Cloudflare-compatible Worker output. Hosted identity uses platform-provided ChatGPT user headers; production access is owner-private. WebMCP exposes report reading and text-import analysis with the same session state as the interface.

Reference APIs: [Prometheus](https://prometheus.io/docs/prometheus/latest/querying/api/) and [Splunk](https://help.splunk.com/en/splunk-enterprise/rest-api-reference/9.4/search-endpoints/search-endpoint-descriptions).
