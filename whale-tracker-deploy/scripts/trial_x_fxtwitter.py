"""Minimal free trial: FxTwitter profile + single tweet (no API key)."""
import json
import urllib.request

UA = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}


def get_json(url: str):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=25) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    profile = get_json("https://api.fxtwitter.com/elonmusk")
    user = profile.get("user") or {}
    print("=== profile elonmusk ===")
    print(
        json.dumps(
            {
                "name": user.get("name"),
                "screen_name": user.get("screen_name"),
                "followers": user.get("followers"),
                "tweets": user.get("tweets"),
                "description": user.get("description"),
            },
            ensure_ascii=False,
            indent=2,
        )
    )

    tweet = get_json("https://api.fxtwitter.com/status/20")
    tw = tweet.get("tweet") or {}
    print("\n=== sample tweet id=20 ===")
    print(
        json.dumps(
            {
                "id": tw.get("id"),
                "url": tw.get("url"),
                "text": tw.get("text"),
                "author": (tw.get("author") or {}).get("screen_name"),
                "likes": tw.get("likes") or tw.get("like_count"),
                "retweets": tw.get("retweets") or tw.get("retweet_count"),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    print("\nNOTE: free FxTwitter can do profile + known tweet URL/id;")
    print("full timeline usually needs a free-tier paid API key (Sorsa/SociaVault) or scraper login.")


if __name__ == "__main__":
    main()
