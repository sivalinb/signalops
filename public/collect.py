#!/usr/bin/env python3
"""SignalOps read-only collector. Python 3.10+, no extra dependencies.

Run inside a network that can reach your telemetry server. The resulting JSON
file is local; import it into SignalOps. This script never uploads to SignalOps.

  python3 collect.py prometheus --url http://localhost:9090 --hours 24 --output metrics.json
  python3 collect.py splunk --url https://splunk.example.net:8089 --index main --hours 6 --output logs.json

For authentication, set SIGNALOPS_TOKEN in your shell or use --prompt-token.
For a private CA, set --ca-file /path/to/ca.pem. TLS verification stays enabled.
Use a token limited to read/search access. Files may contain sensitive log data.
"""
import argparse
import getpass
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

QUERIES = [
    ('node_cpu_usage_percent', 'cpu', '100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])))'),
    ('node_memory_usage_percent', 'memory', '100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)'),
    ('up', 'availability', 'up'),
    ('prometheus_tsdb_head_series', 'series', 'prometheus_tsdb_head_series'),
]
MAX_BYTES = 5 * 1024 * 1024

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Redirect refused. Use the final API base URL.')

def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('source', choices=['prometheus', 'splunk'])
    p.add_argument('--url', required=True)
    p.add_argument('--hours', type=int, choices=[1, 6, 24, 168], default=24)
    p.add_argument('--index', default='main')
    p.add_argument('--output', required=True)
    p.add_argument('--prompt-token', action='store_true')
    p.add_argument('--auth', choices=['bearer', 'session'], default='bearer')
    p.add_argument('--ca-file')
    a = p.parse_args()
    parsed = urllib.parse.urlsplit(a.url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        p.error('Use a valid HTTP(S) base URL without embedded credentials or query parameters.')
    token = getpass.getpass('Read-only token: ') if a.prompt_token else os.environ.get('SIGNALOPS_TOKEN', '')
    if token and parsed.scheme != 'https':
        p.error('Use HTTPS when supplying a token. HTTP is supported only for unauthenticated local endpoints.')
    if any(c in token for c in '\r\n'):
        p.error('Token contains an invalid newline.')
    import re
    if not re.fullmatch(r'[a-zA-Z0-9_.*-]{1,120}', a.index):
        p.error('Invalid index name.')
    context = ssl.create_default_context(cafile=a.ca_file)
    opener = urllib.request.build_opener(NoRedirect, urllib.request.HTTPSHandler(context=context))
    def request(path, query=None, form=None):
        url = a.url.rstrip('/') + '/' + path
        if query: url += '?' + urllib.parse.urlencode(query)
        headers = {'Accept': 'application/json'}
        if token: headers['Authorization'] = ('Splunk' if a.auth == 'session' and a.source == 'splunk' else 'Bearer') + ' ' + token
        data = urllib.parse.urlencode(form).encode() if form else None
        req = urllib.request.Request(url, headers=headers, data=data)
        with opener.open(req, timeout=25) as response:
            body = response.read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES: raise ValueError('Response is over 5 MB. Use a shorter window.')
            return body.decode('utf-8')
    if a.source == 'prometheus':
        end = int(time.time()); metrics = []; notes = []
        for name, kind, query in QUERIES:
            try:
                response = json.loads(request('api/v1/query_range', {'query': query, 'start': end-a.hours*3600, 'end': end, 'step': max(60, a.hours*3600//96), 'timeout': '15s', 'limit': 100}))
                if response.get('status') != 'success': raise ValueError('Query returned an error.')
                rows = response.get('data', {}).get('result', [])
                if not rows: notes.append(name + ': no series returned.')
                if len(rows) >= 100: notes.append(name + ': capped at 100 series.')
                for row in rows[:100]:
                    labels = row.get('metric', {})
                    metrics.append({'name': name, 'kind': kind, 'service': labels.get('instance') or labels.get('job') or 'unlabeled', 'query': query, 'values': row.get('values', [])})
            except (ValueError, urllib.error.URLError) as err:
                notes.append(name + ': ' + str(err))
        if not metrics: raise ValueError('No metrics returned. ' + ' '.join(notes))
        output = {'schema': 'signalops/v1', 'metrics': metrics, 'notes': notes}
        for note in notes: print(note, file=sys.stderr)
    else:
        if not token: p.error('Splunk requires SIGNALOPS_TOKEN or --prompt-token.')
        raw = request('services/search/v2/jobs/export', form={'search': 'search index=' + a.index + ' | head 5000', 'earliest_time': '-%dh' % a.hours, 'latest_time': 'now', 'output_mode': 'json', 'preview': 'false', 'max_time': '15'})
        results = []
        for line in raw.splitlines():
            if not line.strip(): continue
            row = json.loads(line)
            if row.get('result') and not row.get('preview'): results.append(row['result'])
        if not results: raise ValueError('No final events returned. Check the index, time window, and permissions.')
        output = {'results': results}
        print('Export is capped at 5,000 recent events and a 15-second search runtime.', file=sys.stderr)
    encoded = json.dumps(output, separators=(',', ':')).encode()
    if len(encoded) > MAX_BYTES: raise ValueError('Combined output is over 5 MB. Use a shorter window.')
    # Exclusive creation prevents overwriting an existing export.
    fd = os.open(a.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as out: out.write(encoded)
    print('Saved %s (%s bytes). Import this file into SignalOps.' % (a.output, len(encoded)))

if __name__ == '__main__':
    try: main()
    except (ValueError, urllib.error.URLError, OSError) as err:
        sys.exit('Collection failed: ' + str(err))
