"""追加済みの Presentations 行に Month / State / Category_en を補完するスクリプト。

既存行から Category -> Category_en の対応と Month の表記フォーマットを推定し、
対象の発表（TARGETS）に対して未設定のプロパティだけを埋める。

使い方:
    cd ~/develop/kumagallium.github.io
    python3 scripts/fill_presentation_props.py          # 推定結果の確認のみ（dry-run）
    python3 scripts/fill_presentation_props.py --apply  # 実際に更新
"""
import collections
import json
import os
import sys
import urllib.error
import urllib.request

TOKEN = os.environ.get("NOTION_TOKEN") or open(
    os.path.join(os.path.dirname(__file__), "..", ".notion_token")).read().strip()
HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
}
PRESENTATIONS_DB_ID = "4bd20b5d-2364-47fb-ae8c-7583f495ca49"

# 補完したい発表（Title の先頭一致で特定する）
TARGETS = [
    {
        "match": "Starrydata's data science ecosystem",
        "Month": 5,          # ICT2026: May 17-21, 2026
        "State": "Texas",    # 既存の select オプションになければスキップして候補を表示
    },
    {
        "match": "データ科学との融合による核燃料研究の新展開（20）",
        "Month": 9,          # 日本原子力学会2026年秋の大会
    },
]


def api(method, url, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=HEADERS, method=method)
    try:
        return json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e:
        print("--- Notion API error ---")
        print(e.read().decode())
        raise


def all_rows():
    rows, payload = [], {}
    while True:
        d = api("POST", f"https://api.notion.com/v1/databases/{PRESENTATIONS_DB_ID}/query", payload)
        rows += d["results"]
        if not d.get("has_more"):
            return rows
        payload["start_cursor"] = d["next_cursor"]


def plain(prop):
    if prop is None:
        return None
    t = prop.get("type")
    if t == "title":
        return "".join(x["plain_text"] for x in prop["title"]).strip()
    if t == "rich_text":
        return "".join(x["plain_text"] for x in prop["rich_text"]).strip()
    if t == "select":
        return prop["select"]["name"] if prop["select"] else None
    return None


def main():
    apply = "--apply" in sys.argv
    schema = api("GET", f"https://api.notion.com/v1/databases/{PRESENTATIONS_DB_ID}")["properties"]
    state_options = [o["name"] for o in schema.get("State", {}).get("select", {}).get("options", [])]
    cat_en_options = [o["name"] for o in schema.get("Category_en", {}).get("select", {}).get("options", [])]

    rows = all_rows()

    # Category -> Category_en の対応を既存行から推定
    pairs = collections.defaultdict(collections.Counter)
    months = collections.Counter()
    for r in rows:
        p = r["properties"]
        cat, cat_en = plain(p.get("Category")), plain(p.get("Category_en"))
        if cat and cat_en:
            pairs[cat][cat_en] += 1
        m = plain(p.get("Month"))
        if m:
            months[m] += 1
    cat_map = {k: v.most_common(1)[0][0] for k, v in pairs.items()}

    print("Category -> Category_en の推定:")
    for k, v in cat_map.items():
        print(f"  {k} -> {v}")
    print("既存 Month の表記例:", ", ".join(m for m, _ in months.most_common(12)) or "(なし)")
    print("State の選択肢:", ", ".join(state_options) or "(なし)")
    print("Category_en の選択肢:", ", ".join(cat_en_options) or "(なし)")

    # Month の桁揃え（"05" のようなゼロ埋めが主流ならそれに合わせる）
    zero_padded = sum(1 for m in months if len(m) == 2 and m.startswith("0"))
    def fmt_month(n):
        return f"{n:02d}" if zero_padded > len(months) / 2 else str(n)

    for t in TARGETS:
        target = next((r for r in rows
                       if (plain(r["properties"].get("Title")) or "").startswith(t["match"])), None)
        if target is None:
            print(f"[not found] {t['match']}")
            continue
        props = target["properties"]
        update = {}

        if not plain(props.get("Month")) and "Month" in schema:
            update["Month"] = {"rich_text": [{"text": {"content": fmt_month(t["Month"])}}]}

        cat = plain(props.get("Category"))
        if not plain(props.get("Category_en")) and cat in cat_map:
            update["Category_en"] = {"select": {"name": cat_map[cat]}}

        if "State" in t and not plain(props.get("State")):
            if t["State"] in state_options:
                update["State"] = {"select": {"name": t["State"]}}
            else:
                print(f"  [warn] State '{t['State']}' は選択肢にないためスキップ")

        if not update:
            print(f"[skip] {t['match']} — 補完すべき項目なし")
            continue
        print(f"[{'apply' if apply else 'dry-run'}] {t['match']}: "
              + json.dumps(update, ensure_ascii=False))
        if apply:
            api("PATCH", f"https://api.notion.com/v1/pages/{target['id']}", {"properties": update})

    if not apply:
        print("\n確認できたら --apply を付けて再実行してください。")


if __name__ == "__main__":
    main()
