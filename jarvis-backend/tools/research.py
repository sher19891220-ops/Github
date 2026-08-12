import httpx
from bs4 import BeautifulSoup

try:
    from duckduckgo_search import DDGS
    _ddgs_available = True
except ImportError:
    _ddgs_available = False


def search_web(query: str, max_results: int = 8) -> dict:
    if not _ddgs_available:
        return {"error": "duckduckgo-search not installed"}
    try:
        with DDGS() as ddgs:
            results = list(ddgs.text(query, max_results=max_results))
        return {
            "results": [
                {"title": r.get("title"), "url": r.get("href"), "snippet": r.get("body")}
                for r in results
            ],
            "count": len(results),
        }
    except Exception as e:
        return {"error": str(e)}


def search_news(topic: str, max_results: int = 8) -> dict:
    if not _ddgs_available:
        return {"error": "duckduckgo-search not installed"}
    try:
        with DDGS() as ddgs:
            results = list(ddgs.news(topic, max_results=max_results))
        return {
            "results": [
                {"title": r.get("title"), "url": r.get("url"), "date": r.get("date"), "snippet": r.get("body")}
                for r in results
            ],
            "count": len(results),
        }
    except Exception as e:
        return {"error": str(e)}


def fetch_url(url: str) -> dict:
    try:
        with httpx.Client(timeout=15, follow_redirects=True) as client:
            resp = client.get(url, headers={"User-Agent": "Mozilla/5.0"})
            resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
        # Remove script/style noise
        for tag in soup(["script", "style", "nav", "footer", "aside"]):
            tag.decompose()
        text = soup.get_text(separator="\n", strip=True)
        # Trim to reasonable size
        return {"url": url, "content": text[:8000], "status": resp.status_code}
    except Exception as e:
        return {"error": str(e), "url": url}


def summarize_url(url: str) -> dict:
    result = fetch_url(url)
    if "error" in result:
        return result
    # Return first 3000 chars as summary context
    return {"url": url, "summary_content": result["content"][:3000]}
