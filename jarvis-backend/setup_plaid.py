"""
One-time Plaid setup to connect bank accounts. Run this on your Mac mini.

Requirements:
  1. Sign up at https://dashboard.plaid.com/signup (free account)
  2. Go to Team Settings → Keys → copy Client ID and Sandbox/Production secret
  3. Add to your .env:
       PLAID_CLIENT_ID=your_client_id
       PLAID_SECRET=your_secret
       PLAID_ENV=sandbox   (for testing) or production (for real accounts)
  4. Run: python setup_plaid.py
     This starts a local web page to connect your bank accounts.
  5. After connecting, copy the access token(s) to .env:
       PLAID_ACCESS_TOKENS=access-production-xxx,access-production-yyy

Note: Plaid sandbox works with test credentials (username: user_good, password: pass_good).
      Production requires a paid Plaid plan for most banks.
      Alternative: many banks support CSV export — ask Axel to process your bank CSV files.
"""

import os
import sys
import json


def main():
    client_id = os.environ.get("PLAID_CLIENT_ID")
    secret = os.environ.get("PLAID_SECRET")
    env_name = os.environ.get("PLAID_ENV", "sandbox")

    if not client_id or not secret:
        print("ERROR: PLAID_CLIENT_ID and PLAID_SECRET must be set in .env")
        print("Sign up at https://dashboard.plaid.com/signup to get them.")
        sys.exit(1)

    try:
        import plaid
        from plaid.api import plaid_api
        from plaid.model.link_token_create_request import LinkTokenCreateRequest
        from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser
        from plaid.model.products import Products
        from plaid.model.country_code import CountryCode
        from plaid.model.item_public_token_exchange_request import ItemPublicTokenExchangeRequest
    except ImportError:
        print("Installing Plaid...")
        os.system("pip install plaid-python")
        import plaid
        from plaid.api import plaid_api
        from plaid.model.link_token_create_request import LinkTokenCreateRequest
        from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser
        from plaid.model.products import Products
        from plaid.model.country_code import CountryCode
        from plaid.model.item_public_token_exchange_request import ItemPublicTokenExchangeRequest

    env_map = {
        "sandbox": plaid.Environment.Sandbox,
        "development": plaid.Environment.Development,
        "production": plaid.Environment.Production,
    }
    config = plaid.Configuration(
        host=env_map.get(env_name.lower(), plaid.Environment.Sandbox),
        api_key={"clientId": client_id, "secret": secret}
    )
    plaid_client = plaid_api.PlaidApi(plaid.ApiClient(config))

    # Create a Link token
    request = LinkTokenCreateRequest(
        user=LinkTokenCreateRequestUser(client_user_id="sher"),
        client_name="Axel",
        products=[Products("transactions")],
        country_codes=[CountryCode("US"), CountryCode("CA")],
        language="en",
    )
    response = plaid_client.link_token_create(request)
    link_token = response.link_token

    # Serve a minimal HTML page with Plaid Link
    html = f"""<!DOCTYPE html>
<html>
<head><title>Connect Bank to Axel</title></head>
<body>
<h2>Connect Your Bank Account to Axel</h2>
<button id="link-button">Connect Bank</button>
<div id="result"></div>
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
<script>
var handler = Plaid.create({{
  token: '{link_token}',
  onSuccess: function(public_token, metadata) {{
    document.getElementById('result').innerHTML =
      '<h3>Success!</h3><p>Public token: <b>' + public_token + '</b></p>' +
      '<p>Copy this token and run: python setup_plaid.py --exchange ' + public_token + '</p>';
    fetch('/exchange?public_token=' + public_token);
  }},
  onExit: function(err, metadata) {{
    if (err) document.getElementById('result').innerHTML = 'Error: ' + JSON.stringify(err);
  }}
}});
document.getElementById('link-button').onclick = function() {{ handler.open(); }};
</script>
</body>
</html>"""

    # Check if --exchange flag provided
    if len(sys.argv) > 2 and sys.argv[1] == "--exchange":
        public_token = sys.argv[2]
        exchange_req = ItemPublicTokenExchangeRequest(public_token=public_token)
        exchange_res = plaid_client.item_public_token_exchange(exchange_req)
        access_token = exchange_res.access_token
        item_id = exchange_res.item_id

        print(f"\n✅ Bank connected!")
        print(f"Access token: {access_token}")
        print(f"Item ID: {item_id}")
        print(f"\nAdd to your .env:")
        print(f"PLAID_ACCESS_TOKENS={access_token}")
        print(f"\nIf adding multiple banks, comma-separate them:")
        print(f"PLAID_ACCESS_TOKENS=access-xxx,access-yyy")
        return

    import http.server
    import urllib.parse
    import webbrowser
    import threading

    access_tokens = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path == "/exchange":
                params = urllib.parse.parse_qs(parsed.query)
                public_token = params.get("public_token", [None])[0]
                if public_token:
                    exchange_req = ItemPublicTokenExchangeRequest(public_token=public_token)
                    exchange_res = plaid_client.item_public_token_exchange(exchange_req)
                    access_tokens.append(exchange_res.access_token)
                self.send_response(200)
                self.end_headers()
            else:
                self.send_response(200)
                self.send_header("Content-type", "text/html")
                self.end_headers()
                self.wfile.write(html.encode())

        def log_message(self, *args):
            pass

    port = 8765
    server = http.server.HTTPServer(("localhost", port), Handler)
    print(f"\nOpening browser at http://localhost:{port}")
    print("Connect your bank account through the Plaid interface.")
    print("After connecting, this script will print your access token.\n")

    webbrowser.open(f"http://localhost:{port}")

    try:
        while not access_tokens:
            server.handle_request()
    except KeyboardInterrupt:
        pass

    if access_tokens:
        print(f"\n✅ Bank connected!")
        print(f"\nAdd to your .env:")
        print(f"PLAID_ACCESS_TOKENS={','.join(access_tokens)}")
    else:
        print("No bank connected.")


if __name__ == "__main__":
    main()
