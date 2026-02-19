import os
import json
import requests

NOTION_TOKEN = os.environ["NOTION_TOKEN"]
NOTION_VERSION = "2022-06-28"

HEADERS = {
    "Authorization": f"Bearer {NOTION_TOKEN}",
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
}

DB_IDS = {
    "Profile":        "5e5bcbae-fd88-43c1-a2fe-1979776d3a21",
    "Publications ":  "eac0998c-f09b-4446-a856-59aeb64f3815",
    "Presentations":  "4bd20b5d-2364-47fb-ae8c-7583f495ca49",
    "Awards":         "64ec4bb4-2dce-4414-b48c-9b2a87b8e844",
    "Articles":       "edb728c2-4a6a-4746-bf72-3c9d0e1f62eb",
    "Contact":        "60c6db62-9ddd-4796-b736-baf05fcabb60",
    "Others":         "0569a734-04cd-4813-93c7-a9dcfef7b886",
    "Works":          "932a4ee5-be0a-467e-92a0-f130ca562223",
}


def query_database(db_id, sorts=None):
    url = f"https://api.notion.com/v1/databases/{db_id}/query"
    results = []
    payload = {}
    if sorts:
        payload["sorts"] = sorts
    while True:
        res = requests.post(url, headers=HEADERS, json=payload)
        res.raise_for_status()
        data = res.json()
        results.extend(data["results"])
        if not data.get("has_more"):
            break
        payload["start_cursor"] = data["next_cursor"]
    return results


def get_prop(props, key, _hint=None):
    """Notion プロパティの type フィールドを見て自動的に値を取得する"""
    if key not in props:
        return None
    p = props[key]
    ptype = p.get("type")
    if ptype == "title":
        return "".join(t["text"]["content"] for t in p.get("title", [])) or None
    if ptype == "rich_text":
        return "".join(t["text"]["content"] for t in p.get("rich_text", [])) or None
    if ptype == "number":
        return p.get("number")
    if ptype == "url":
        return p.get("url")
    if ptype == "select":
        s = p.get("select")
        return s["name"] if s else None
    if ptype == "multi_select":
        return ", ".join(m["name"] for m in p.get("multi_select", []))
    if ptype == "checkbox":
        return p.get("checkbox", False)
    if ptype == "formula":
        f = p.get("formula", {})
        return f.get("number") or f.get("string")
    return None


def sort_by_year(items):
    def year_key(x):
        y = x.get("Year")
        if y is None:
            return 0
        try:
            return int(y)
        except (ValueError, TypeError):
            return 0
    return sorted(items, key=year_key, reverse=True)


def build_link(url, label):
    return f"<a href={url} target='_blank'>{label}</a>"


SORT_BY_CREATED = [{"timestamp": "created_time", "direction": "ascending"}]


PROFILE_CATEGORY_ORDER = ["略歴", "所属", "経歴", "リンク"]


# --- Profile ---
def fetch_profile():
    rows = query_database(DB_IDS["Profile"], sorts=SORT_BY_CREATED)
    result = []
    for page in rows:
        props = page["properties"]
        text = get_prop(props, "Text", "rich_text")
        category = get_prop(props, "Category", "select")
        if text:
            result.append({"category": category, "text": text})
    result.sort(key=lambda x: PROFILE_CATEGORY_ORDER.index(x["category"])
                if x["category"] in PROFILE_CATEGORY_ORDER else len(PROFILE_CATEGORY_ORDER))
    return result


# --- Publications ---
def fetch_publications():
    rows = query_database(DB_IDS["Publications "])
    items = []
    for page in rows:
        props = page["properties"]
        items.append({
            "Author":  get_prop(props, "Author",  "rich_text"),
            "URL":     get_prop(props, "URL",     "url"),
            "Title":   get_prop(props, "Title",   "title"),
            "Journal": get_prop(props, "Journal", "rich_text"),
            "Volume":  get_prop(props, "Volume",  "rich_text"),
            "Issue":   get_prop(props, "Issue",   "rich_text"),
            "Year":    get_prop(props, "Year",    "number"),
            "Pages":   get_prop(props, "Pages",   "rich_text"),
            "First":   get_prop(props, "First",   "checkbox"),
        })
    result = []
    for d in sort_by_year(items):
        text = ""
        if d["Author"]:
            text += d["Author"]
        if d["URL"]:
            text += ", " + build_link(d["URL"], d["Title"])
        elif d["Title"]:
            text += ", " + d["Title"]
        if d["Journal"]:
            text += ", " + d["Journal"]
        if d["Volume"]:
            text += ", " + d["Volume"]
        if d["Issue"]:
            text += ", " + d["Issue"]
        if d["Year"]:
            text += ", " + str(d["Year"])
        if d["Pages"]:
            text += ", " + d["Pages"]
        result.append({"fitst": d["First"], "text": text})
    return result


# --- Presentations ---
def fetch_presentations():
    rows = query_database(DB_IDS["Presentations"])
    items = []
    for page in rows:
        props = page["properties"]
        items.append({
            "Invited":  get_prop(props, "Invited",  "checkbox"),
            "Author":   get_prop(props, "Author",   "rich_text"),
            "URL":      get_prop(props, "URL",      "url"),
            "Title":    get_prop(props, "Title",    "title"),
            "Event":    get_prop(props, "Event",    "rich_text"),
            "Type":     get_prop(props, "Type",     "select"),
            "Country":  get_prop(props, "Country",  "rich_text"),
            "Year":     get_prop(props, "Year",     "number"),
            "Category": get_prop(props, "Category", "select"),
            "First":    get_prop(props, "First",    "checkbox"),
        })
    result = []
    for d in sort_by_year(items):
        text = ""
        if d["Invited"]:
            text += "<b>(Invited)</b> "
        if d["Author"]:
            text += d["Author"]
        if d["URL"]:
            text += ", " + build_link(d["URL"], d["Title"])
        elif d["Title"]:
            text += ", " + d["Title"]
        if d["Event"]:
            text += ", " + d["Event"]
        if d["Type"]:
            text += ", " + d["Type"]
        if d["Country"]:
            text += ", " + d["Country"]
        if d["Year"]:
            text += ", " + str(d["Year"])
        result.append({"category": d["Category"], "fitst": d["First"], "text": text})
    return result


# --- Awards ---
def fetch_awards():
    rows = query_database(DB_IDS["Awards"])
    items = []
    for page in rows:
        props = page["properties"]
        items.append({
            "URL":    get_prop(props, "URL",    "url"),
            "Award":  get_prop(props, "Award",  "title"),
            "Author": get_prop(props, "Author", "rich_text"),
            "Title":  get_prop(props, "Title",  "rich_text"),
            "Year":   get_prop(props, "Year",   "number"),
            "First":  get_prop(props, "First",  "checkbox"),
        })
    result = []
    for d in sort_by_year(items):
        text = ""
        if d["URL"]:
            text += build_link(d["URL"], d["Award"])
        elif d["Award"]:
            text += d["Award"]
        if d["Author"]:
            text += ", " + d["Author"]
        if d["Title"]:
            text += ", " + d["Title"]
        if d["Year"]:
            text += ", " + str(d["Year"])
        result.append({"fitst": d["First"], "text": text})
    return result


# --- Articles ---
def fetch_articles():
    rows = query_database(DB_IDS["Articles"])
    items = []
    for page in rows:
        props = page["properties"]
        items.append({
            "URL":      get_prop(props, "URL",      "url"),
            "Title":    get_prop(props, "Title",    "title"),
            "Medium":   get_prop(props, "Medium",   "rich_text"),
            "Year":     get_prop(props, "Year",     "number"),
            "Category": get_prop(props, "Category", "select"),
        })
    result = []
    for d in sort_by_year(items):
        text = ""
        if d["URL"]:
            text += build_link(d["URL"], d["Title"])
        elif d["Title"]:
            text += d["Title"]
        if d["Medium"]:
            text += ", " + d["Medium"]
        if d["Year"]:
            text += ", " + str(d["Year"])
        result.append({"category": d["Category"], "text": text})
    return result


# --- Contact ---
def fetch_contact():
    rows = query_database(DB_IDS["Contact"], sorts=SORT_BY_CREATED)
    result = []
    for page in rows:
        props = page["properties"]
        text = get_prop(props, "Text", "rich_text")
        category = get_prop(props, "Category", "select")
        if text:
            result.append({"category": category, "text": text})
    return result


# --- Others ---
def fetch_others():
    rows = query_database(DB_IDS["Others"], sorts=SORT_BY_CREATED)
    result = []
    for page in rows:
        props = page["properties"]
        url = get_prop(props, "URL", "url")
        title = get_prop(props, "Title", "title")
        comment = get_prop(props, "Comment", "rich_text")
        category = get_prop(props, "Category", "select")
        text = build_link(url, title) if url else (title or "")
        if comment:
            text += ", " + comment
        result.append({"category": category, "text": text})
    return result


# --- Works ---
def fetch_works():
    rows = query_database(DB_IDS["Works"], sorts=SORT_BY_CREATED)
    result = []
    for page in rows:
        props = page["properties"]
        url = get_prop(props, "URL", "url")
        name = get_prop(props, "Name", "title")
        category = get_prop(props, "Category", "select")
        text = build_link(url, name) if url else (name or "")
        result.append({"category": category, "text": text})
    return result


def main():
    print("Fetching Notion data...")
    data = {
        "Profile":       fetch_profile(),
        "Publications ": fetch_publications(),
        "Presentations": fetch_presentations(),
        "Awards":        fetch_awards(),
        "Articles":      fetch_articles(),
        "Contact":       fetch_contact(),
        "Others":        fetch_others(),
        "Works":         fetch_works(),
    }
    out_path = "data/notion_data.json"
    os.makedirs("data", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"Saved to {out_path}")
    for key, items in data.items():
        print(f"  {key}: {len(items)} items")


if __name__ == "__main__":
    main()
