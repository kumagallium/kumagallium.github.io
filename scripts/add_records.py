"""Publications / Presentations DB に未登録の成果をまとめて追加するスクリプト。

使い方（ネットワークが通る環境で実行）:
    cd ~/develop/kumagallium.github.io
    python3 scripts/add_records.py

DB のスキーマを取得して各プロパティの実際の型に合わせて値を送る。
既存タイトルと照合し、登録済みのものはスキップする。
"""
import json
import os
import urllib.request
import urllib.error

TOKEN = os.environ.get("NOTION_TOKEN") or open(
    os.path.join(os.path.dirname(__file__), "..", ".notion_token")).read().strip()
HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
}

PUBLICATIONS_DB_ID = "eac0998c-f09b-4446-a856-59aeb64f3815"
PRESENTATIONS_DB_ID = "4bd20b5d-2364-47fb-ae8c-7583f495ca49"


def api(method, url, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=HEADERS, method=method)
    try:
        return json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e:
        print("--- Notion API error ---")
        print(e.read().decode())
        raise


def schema(db_id):
    return api("GET", f"https://api.notion.com/v1/databases/{db_id}")["properties"]


def existing_titles(db_id):
    titles, payload = set(), {}
    while True:
        d = api("POST", f"https://api.notion.com/v1/databases/{db_id}/query", payload)
        for r in d["results"]:
            for v in r["properties"].values():
                if v.get("type") == "title":
                    titles.add("".join(x["plain_text"] for x in v["title"]).strip())
        if not d.get("has_more"):
            return titles
        payload["start_cursor"] = d["next_cursor"]


def to_prop(ptype, value):
    """DB 側の実際の型に合わせて値を組み立てる。送らない場合は None を返す。"""
    if value is None or value == "":
        return None
    if ptype == "title":
        return {"title": [{"text": {"content": str(value)}}]}
    if ptype == "rich_text":
        return {"rich_text": [{"text": {"content": str(value)}}]}
    if ptype == "number":
        return {"number": float(value) if not isinstance(value, bool) else None}
    if ptype == "url":
        return {"url": str(value)}
    if ptype == "select":
        return {"select": {"name": str(value)}}
    if ptype == "multi_select":
        return {"multi_select": [{"name": str(value)}]}
    if ptype == "checkbox":
        return {"checkbox": bool(value)}
    if ptype == "date":
        return {"date": {"start": str(value)}}
    return None


def build(props_schema, values):
    out = {}
    for key, value in values.items():
        if key not in props_schema:
            print(f"  [warn] プロパティ '{key}' は DB に存在しないためスキップ")
            continue
        if isinstance(value, bool) and value is False:
            # チェックボックスの False は送っても害はないが、型が違う場合は送らない
            if props_schema[key]["type"] != "checkbox":
                continue
        p = to_prop(props_schema[key]["type"], value)
        if p is not None:
            out[key] = p
    return out


PUBLICATIONS = [
    {
        "Title": "ProvMind: provenance-grounded reasoning for materials synthesis",
        "Author": "Yiming Zhang, Ryo Tamura, Masaya Kumagai, Koji Tsuda",
        "Journal": "npj Computational Materials",
        "Year": 2026,
        "URL": "https://www.nature.com/articles/s41524-026-02303-7",
        "First": False,
    },
]

PRESENTATIONS = [
    {
        "Title": "Starrydata's data science ecosystem driven by open literature data",
        "Author": ("Yukari Katsura, Tomoya Mato, Eiji Koyama, Erina Fujita, Dewi Yana, "
                   "Yoshihiro Sakamoto, Atsumi Tanaka, Masaya Kumagai, Kaoru Kimura, "
                   "Masahiko Demura"),
        "Event": "International Conference on Thermoelectrics 2026 (ICT2026)",
        "Type": "Poster",
        "Country": "USA",
        "Year": 2026,
        "Category": "国際会議 / ポスター発表",
        "URL": "https://www.ict2026houston.com/",
        "First": False,
        "Invited": False,
    },
    {
        "Title": ("データ科学との融合による核燃料研究の新展開"
                  "（20）放電プラズマ焼結によって作製したU2NiC3の熱物性と機械学習予測との比較"),
        "Author": "中村 寛信, 孫 一帆, 熊谷 将也, 黒﨑 健, 大石 佑治",
        "Event": "日本原子力学会2026年秋の大会",
        "Type": "Oral",
        "Country": "Japan",
        "Year": 2026,
        "Category": "国内学会 / 口頭発表",
        "URL": "https://pub.confit.atlas.jp/ja/event/aesj2026f",
        "First": False,
        "Invited": False,
    },
]


def run(entries, db_id, label):
    props_schema = schema(db_id)
    print(f"{label} DB properties: "
          + ", ".join(f"{k}({v['type']})" for k, v in props_schema.items()))
    known = existing_titles(db_id)
    for e in entries:
        if e["Title"].strip() in known:
            print(f"[skip] {label}: {e['Title'][:60]}")
            continue
        res = api("POST", "https://api.notion.com/v1/pages",
                  {"parent": {"database_id": db_id},
                   "properties": build(props_schema, e)})
        print(f"[added] {label}: {e['Title'][:60]} -> {res['url']}")


if __name__ == "__main__":
    run(PUBLICATIONS, PUBLICATIONS_DB_ID, "Publication")
    run(PRESENTATIONS, PRESENTATIONS_DB_ID, "Presentation")
