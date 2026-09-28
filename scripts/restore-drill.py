"""Restore a downloaded backup into an explicit isolated config and test it.

Provision a fresh APP and CACHE first; see RUNBOOK.md. No production writes.
"""
import argparse
import gzip
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import subprocess
import tempfile
import time
from production import CONFIG, ROOT, digest, wrangler


def table_rows(sql):
    db = sqlite3.connect(':memory:')
    db.executescript(sql)
    if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok' or db.execute('PRAGMA foreign_key_check').fetchall():
        raise ValueError('Restored SQL has integrity or foreign key errors')
    names = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    rows = {name: sorted(db.execute('SELECT * FROM "'+name.replace('"','""')+'"').fetchall(), key=repr) for name in names}
    db.close()
    return rows


def drill(directory, config):
    start = time.monotonic()
    directory, config = Path(directory), Path(config).resolve()
    current = json.loads(CONFIG.read_text())
    target = json.loads(config.read_text())
    if not target['name'].startswith('etymology-feed-restore-') or target.get('routes') or target.get('triggers', {}).get('crons'):
        raise ValueError('Expected an isolated restore Worker without routes or cron')
    prod_app = next(v['database_id'] for v in current['d1_databases'] if v['binding'] == 'APP')
    test_app = next(v['database_id'] for v in target['d1_databases'] if v['binding'] == 'APP')
    if prod_app == test_app or current['kv_namespaces'] == target['kv_namespaces']:
        raise ValueError('Restore must isolate APP and CACHE')
    manifest = json.loads((directory / 'manifest.json').read_text())
    if digest(directory / 'app.sql.gz') != manifest['sha256']:
        raise ValueError('Backup checksum mismatch')
    sql = directory / 'app.sql'
    sql.write_bytes(gzip.decompress((directory / 'app.sql.gz').read_bytes()))
    if digest(sql) != manifest['sql_sha256']:
        raise ValueError('SQL checksum mismatch')
    expected = table_rows(sql.read_text())
    if {k: len(v) for k,v in expected.items()} != manifest['table_counts']:
        raise ValueError('Backup table counts differ from manifest')
    # Refuse to overlay an existing APP: the target must be a fresh database.
    result = json.loads(wrangler('d1','execute','APP','--remote','--json','--command',
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_cf_KV'", config=config, capture=True))
    if result[0]['results']:
        raise ValueError('Restore target is not empty')
    wrangler('d1','execute','APP','--remote','--file',sql,'-y',config=config)
    restored = directory / 'restored.sql'
    wrangler('d1','export','APP','--remote','--output',restored,config=config,capture=True)
    if table_rows(restored.read_text()) != expected:
        raise ValueError('Remote restore differs from the backup')
    token = secrets.token_urlsafe(48)
    with tempfile.TemporaryDirectory() as tmp:
        secret_file = Path(tmp) / 'secrets.json'
        secret_file.write_text(json.dumps({'RESTORE_TOKEN':token,'BETTER_AUTH_SECRET':secrets.token_urlsafe(48)}))
        secret_file.chmod(0o600)
        wrangler('secret','bulk',secret_file,config=config)
    output = wrangler('deploy',config=config,capture=True)
    urls = re.findall(r'https://[a-z0-9.-]+\.workers\.dev',output)
    if not urls:
        raise ValueError('Restore Worker URL not returned')
    subprocess.run(['node','scripts/smoke-restore.mjs',urls[-1]],cwd=ROOT,
                   env={**os.environ,'RESTORE_TOKEN':token},check=True)
    evidence = {'backup':manifest['created_at'],'restored_app':test_app,'worker':target['name'],
                'table_counts':manifest['table_counts'],'all_rows_match':True,
                'private_http_smoke_passed':True,'elapsed_seconds':round(time.monotonic()-start,1)}
    (directory / 'verification.json').write_text(json.dumps(evidence,indent=2)+'\n')
    print(json.dumps(evidence,indent=2))


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory')
    parser.add_argument('--config',required=True)
    args=parser.parse_args()
    drill(args.directory,args.config)
