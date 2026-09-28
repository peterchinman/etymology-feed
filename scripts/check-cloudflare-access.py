"""Read-only credential preflight. Never print tokens or API response bodies."""
import json
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def main():
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not token:
        raise SystemExit("CLOUDFLARE_API_TOKEN is missing")
    cfg = json.loads((Path(__file__).resolve().parents[1] /
                      "apps/api/wrangler.production.json").read_text())
    account = cfg["account_id"]
    zone = "da274e3d8816f45b2d816e80c3480ab3"

    def get(path, label):
        request = Request("https://api.cloudflare.com/client/v4/" + path,
                          headers={"Authorization": "Bearer " + token})
        try:
            with urlopen(request, timeout=30) as response:
                data = json.load(response)
        except HTTPError as error:
            raise SystemExit(f"{label}: HTTP {error.code}; check token scope") from None
        if not data.get("success"):
            raise SystemExit(f"{label}: API rejected request; check token scope")
        print(f"{label}: accessible")
        return data["result"]

    if get("user/tokens/verify", "Token")["status"] != "active":
        raise SystemExit("Token is not active")
    get(f"accounts/{account}", "Account")
    workers = get(f"accounts/{account}/workers/scripts", "Workers")
    if not any(worker["id"] == cfg["name"] for worker in workers):
        raise SystemExit("Production Worker was not found")
    for database in cfg["d1_databases"]:
        get(f"accounts/{account}/d1/database/{database['database_id']}",
            database["binding"] + " database metadata")
    namespaces = get(f"accounts/{account}/storage/kv/namespaces", "KV")
    if not any(ns["id"] == cfg["kv_namespaces"][0]["id"] for ns in namespaces):
        raise SystemExit("Production CACHE was not found")
    get(f"accounts/{account}/r2/buckets/etymology-feed-backups", "Private backup bucket")
    if get(f"zones/{zone}", "Domain")["status"] != "active":
        raise SystemExit("Domain is not active")
    get(f"zones/{zone}/workers/routes", "Worker routes")
    print("Read-only preflight passed. Write permissions are exercised at deployment/backup time.")


if __name__ == "__main__":
    main()
