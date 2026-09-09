import re
import subprocess
import httpx
from bs4 import BeautifulSoup

try:
    from duckduckgo_search import DDGS
    _ddgs_available = True
except ImportError:
    _ddgs_available = False

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
}


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


def _extract_main_content(html: str) -> str:
    """Extract clean readable text from HTML, preserving tables and structure."""
    soup = BeautifulSoup(html, "html.parser")
    # Remove noise elements
    for tag in soup(["script", "style", "nav", "footer", "aside", "header",
                     "noscript", "iframe", "form", "button", "input", "select"]):
        tag.decompose()
    # Preserve table structure as text
    for table in soup.find_all("table"):
        rows = []
        for tr in table.find_all("tr"):
            cells = [td.get_text(strip=True) for td in tr.find_all(["td", "th"])]
            if cells:
                rows.append(" | ".join(cells))
        table.replace_with("\n".join(rows))
    text = soup.get_text(separator="\n", strip=True)
    # Collapse excessive blank lines
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def fetch_url(url: str) -> dict:
    try:
        with httpx.Client(timeout=20, follow_redirects=True, headers=_HEADERS) as client:
            resp = client.get(url)
            resp.raise_for_status()
        content = _extract_main_content(resp.text)
        return {"url": url, "content": content[:10000], "status": resp.status_code}
    except Exception as e:
        return {"error": str(e), "url": url}


def fetch_url_js(url: str) -> dict:
    """Fetch a JS-heavy page using Playwright (requires playwright in venv)."""
    script = f"""
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.set_extra_http_headers({{"User-Agent": "Mozilla/5.0"}})
    page.goto("{url}", wait_until="networkidle", timeout=20000)
    content = page.content()
    browser.close()
    print(content[:50000])
"""
    try:
        result = subprocess.run(
            ["python", "-c", script],
            capture_output=True, text=True, timeout=30, cwd="/tmp"
        )
        if result.returncode != 0:
            return fetch_url(url)  # fallback
        content = _extract_main_content(result.stdout)
        return {"url": url, "content": content[:10000], "method": "playwright"}
    except Exception:
        return fetch_url(url)  # fallback to basic


def scrape_page(url: str, use_js: bool = False) -> dict:
    """Scrape a page and return clean structured content."""
    result = fetch_url_js(url) if use_js else fetch_url(url)
    if "error" in result:
        return result
    return {
        "url": url,
        "content": result["content"],
        "word_count": len(result["content"].split()),
        "method": result.get("method", "http"),
    }


def deep_research(topic: str, max_urls: int = 5) -> dict:
    """Research a topic: search + fetch top pages + return synthesized content."""
    # Step 1: search
    search = search_web(topic, max_results=max_urls + 3)
    if "error" in search:
        return search
    urls = [r["url"] for r in search["results"] if r.get("url")][:max_urls]
    # Step 2: fetch each page
    pages = []
    for url in urls:
        result = fetch_url(url)
        if "content" in result:
            pages.append({
                "url": url,
                "content": result["content"][:3000],
            })
    return {
        "topic": topic,
        "sources": len(pages),
        "pages": pages,
        "note": "Content from top search results — use this to synthesize your answer",
    }


def crawl_domain(start_url: str, max_pages: int = 10) -> dict:
    """Crawl pages within the same domain, following internal links."""
    from urllib.parse import urlparse, urljoin
    base = urlparse(start_url)
    domain = f"{base.scheme}://{base.netloc}"
    visited = set()
    queue = [start_url]
    results = []

    with httpx.Client(timeout=15, follow_redirects=True, headers=_HEADERS) as client:
        while queue and len(visited) < max_pages:
            url = queue.pop(0)
            if url in visited:
                continue
            visited.add(url)
            try:
                resp = client.get(url)
                if "text/html" not in resp.headers.get("content-type", ""):
                    continue
                soup = BeautifulSoup(resp.text, "html.parser")
                content = _extract_main_content(resp.text)
                results.append({"url": url, "content": content[:2000]})
                # Find more internal links
                for a in soup.find_all("a", href=True):
                    href = urljoin(domain, a["href"])
                    if href.startswith(domain) and href not in visited:
                        queue.append(href)
            except Exception:
                continue

    return {"start_url": start_url, "pages_crawled": len(results), "pages": results}


def lookup_carrier_fmcsa(dot_number: str = "", mc_number: str = "") -> dict:
    """Look up a carrier on FMCSA SAFER system by DOT# or MC#."""
    if dot_number:
        url = f"https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string={dot_number}"
    elif mc_number:
        clean_mc = mc_number.replace("MC-", "").replace("MC", "").strip()
        url = f"https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=MC_MX&query_string={clean_mc}"
    else:
        return {"error": "Provide dot_number or mc_number"}

    result = fetch_url(url)
    if "error" in result:
        return result

    content = result["content"]
    # Extract key fields from SAFER response
    safety_match = re.search(r"Safety Rating[:\s]+(\w+)", content, re.IGNORECASE)
    insurance_match = re.search(r"Insurance.*?(\$[\d,]+)", content, re.IGNORECASE)
    authority_match = re.search(r"Operating Authority Status[:\s]+(\w+)", content, re.IGNORECASE)
    ooo_match = re.search(r"Out of Service[^\n]*(\d+(?:\.\d+)?%)", content, re.IGNORECASE)

    return {
        "dot_number": dot_number,
        "mc_number": mc_number,
        "safety_rating": safety_match.group(1) if safety_match else "Not found",
        "authority_status": authority_match.group(1) if authority_match else "Not found",
        "insurance": insurance_match.group(1) if insurance_match else "Not found",
        "out_of_service_rate": ooo_match.group(1) if ooo_match else "Not found",
        "raw_content": content[:3000],
        "source_url": url,
    }


def extract_freight_rates(origin: str, destination: str, equipment: str = "van") -> dict:
    """Research freight market rates for a lane via web search."""
    query = f"freight rate {origin} to {destination} {equipment} per mile 2025"
    search = search_web(query, max_results=6)
    if "error" in search:
        return search

    # Also fetch DAT and FreightWaves public data
    pages = []
    for r in search.get("results", [])[:4]:
        url = r.get("url", "")
        if url:
            page = fetch_url(url)
            if "content" in page:
                pages.append({"url": url, "snippet": page["content"][:1500]})

    return {
        "lane": f"{origin} → {destination}",
        "equipment": equipment,
        "search_results": search.get("results", []),
        "rate_sources": pages,
        "note": "Synthesize rate data from sources above. Look for $/mile figures.",
    }


def summarize_url(url: str) -> dict:
    result = fetch_url(url)
    if "error" in result:
        return result
    return {"url": url, "summary_content": result["content"][:3000]}
