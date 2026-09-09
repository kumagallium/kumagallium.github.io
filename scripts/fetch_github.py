"""GitHub の公開アクティビティを取得して data/github_data.json に書き出す。

- REST API: ユーザー情報 / リポジトリ一覧（トークン無しでも動くがレート制限が厳しい）
- GraphQL API: コントリビューション統計・カレンダー（トークン必須）

トークンは環境変数 GH_TOKEN / GITHUB_TOKEN から読む。
GraphQL が失敗した場合は contributions を空にして処理を続行する
（フロント側は contributions が空ならヒートマップ等を非表示にする）。
"""

import os
import json
import datetime
import requests

USER = os.environ.get("GH_USER", "kumagallium")
TOKEN = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")

# 一覧から除外するリポジトリ（練習用・チュートリアル等）
EXCLUDE_REPOS = {
    "test",
    "next_tutorial_docker",
    "get_pixcel_color",
    "kumagallium.github.io",
}

REST = "https://api.github.com"
GRAPHQL = "https://api.github.com/graphql"


def rest_headers():
    h = {"Accept": "application/vnd.github+json"}
    if TOKEN:
        h["Authorization"] = f"Bearer {TOKEN}"
    return h


def get_json(url, params=None):
    res = requests.get(url, headers=rest_headers(), params=params, timeout=30)
    res.raise_for_status()
    return res.json()


def graphql(query, variables=None):
    if not TOKEN:
        raise RuntimeError("GraphQL にはトークンが必要です")
    res = requests.post(
        GRAPHQL,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        json={"query": query, "variables": variables or {}},
        timeout=30,
    )
    res.raise_for_status()
    data = res.json()
    if "errors" in data:
        raise RuntimeError(data["errors"])
    return data["data"]


# --- ユーザー情報 -----------------------------------------------------------
def fetch_user():
    u = get_json(f"{REST}/users/{USER}")
    return {
        "login": u["login"],
        "name": u.get("name") or u["login"],
        "avatar_url": u["avatar_url"],
        "html_url": u["html_url"],
        "bio": u.get("bio"),
        "followers": u.get("followers", 0),
        "public_repos": u.get("public_repos", 0),
        "created_at": u.get("created_at"),
    }


# --- リポジトリ一覧 ---------------------------------------------------------
def fetch_repos():
    repos = []
    page = 1
    while True:
        batch = get_json(
            f"{REST}/users/{USER}/repos",
            params={"per_page": 100, "page": page, "sort": "pushed"},
        )
        if not batch:
            break
        repos.extend(batch)
        if len(batch) < 100:
            break
        page += 1

    result = []
    for r in repos:
        if r.get("fork") or r.get("archived") or r.get("private"):
            continue
        if r["name"] in EXCLUDE_REPOS:
            continue
        result.append({
            "name": r["name"],
            "description": r.get("description"),
            "html_url": r["html_url"],
            "homepage": r.get("homepage") or None,
            "language": r.get("language"),
            "stars": r.get("stargazers_count", 0),
            "forks": r.get("forks_count", 0),
            "topics": r.get("topics", []),
            "created_at": (r.get("created_at") or "")[:10],
            "pushed_at": (r.get("pushed_at") or "")[:10],
        })
    # 更新の新しい順
    result.sort(key=lambda x: x["pushed_at"], reverse=True)
    return result


# --- コントリビューション ---------------------------------------------------
CONTRIB_QUERY = """
query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      totalCommitContributions
      totalPullRequestContributions
      totalIssueContributions
      totalPullRequestReviewContributions
      totalRepositoryContributions
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}
"""


def fetch_contributions(start_year):
    """年ごとの集計と、直近1年の日別カレンダーを返す。"""
    today = datetime.date.today()
    yearly = []
    calendar = []

    for year in range(start_year, today.year + 1):
        frm = f"{year}-01-01T00:00:00Z"
        to_date = min(datetime.date(year, 12, 31), today)
        to = f"{to_date.isoformat()}T23:59:59Z"
        data = graphql(CONTRIB_QUERY, {"login": USER, "from": frm, "to": to})
        c = data["user"]["contributionsCollection"]
        cal = c["contributionCalendar"]
        yearly.append({
            "year": year,
            "commits": c["totalCommitContributions"],
            "pull_requests": c["totalPullRequestContributions"],
            "issues": c["totalIssueContributions"],
            "reviews": c["totalPullRequestReviewContributions"],
            "repositories": c["totalRepositoryContributions"],
            "total": cal["totalContributions"],
        })
        # 当年分だけ日別カレンダーを保持（ヒートマップ用に直近365日を後段で切り出す）
        if year >= today.year - 1:
            for w in cal["weeks"]:
                for d in w["contributionDays"]:
                    calendar.append({"date": d["date"], "count": d["contributionCount"]})

    # 直近365日に絞る
    since = (today - datetime.timedelta(days=364)).isoformat()
    calendar = sorted([d for d in calendar if d["date"] >= since], key=lambda x: x["date"])

    return {"yearly": yearly, "calendar": calendar}


def main():
    print("Fetching GitHub data...")
    user = fetch_user()
    repos = fetch_repos()

    start_year = int((user.get("created_at") or "2013")[:4])
    contributions = {"yearly": [], "calendar": []}
    try:
        contributions = fetch_contributions(start_year)
    except Exception as e:  # トークン無し・権限不足でも他のデータは出す
        print(f"  [warn] contributions を取得できませんでした: {e}")

    # 言語別のリポジトリ数
    languages = {}
    for r in repos:
        if r["language"]:
            languages[r["language"]] = languages.get(r["language"], 0) + 1
    languages = [{"name": k, "count": v}
                 for k, v in sorted(languages.items(), key=lambda x: -x[1])]

    data = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "user": user,
        "repos": repos,
        "languages": languages,
        "contributions": contributions,
        "totals": {
            "repos": len(repos),
            "stars": sum(r["stars"] for r in repos),
            "contributions": sum(y["total"] for y in contributions["yearly"]),
        },
    }

    os.makedirs("data", exist_ok=True)
    out_path = "data/github_data.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"Saved to {out_path}")
    print(f"  repos: {len(repos)}, stars: {data['totals']['stars']}, "
          f"contributions: {data['totals']['contributions']}")


if __name__ == "__main__":
    main()
