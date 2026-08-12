"""
One-time Microsoft/Outlook OAuth2 setup. Run this on your Mac mini.

Requirements:
  1. Go to portal.azure.com → Azure Active Directory → App registrations → New registration
  2. Name: anything (e.g. "Axel")
  3. Supported account types:
     - "Personal Microsoft accounts only" → for Outlook.com / Hotmail / Live accounts
     - "Accounts in any org directory + personal Microsoft accounts" → for work + personal
  4. Redirect URI: leave blank for now
  5. Register → note the Application (client) ID
  6. Certificates & secrets → New client secret → copy the Value (not the ID)
  7. API permissions → Add a permission → Microsoft Graph → Delegated permissions:
     Mail.Read, Mail.ReadWrite, Mail.Send, User.Read, offline_access → Grant admin consent
  8. Add to your .env:
       MS_CLIENT_ID=your_application_id
       MS_CLIENT_SECRET=your_client_secret_value
       MS_TENANT_ID=consumers   (for personal) or your_tenant_id (for work)
  9. Run: python setup_microsoft_auth.py

Uses device code flow — no browser automation needed, just copy a code into your browser.
"""

import json
import os
import sys


def main():
    client_id = os.environ.get("MS_CLIENT_ID")
    tenant_id = os.environ.get("MS_TENANT_ID", "consumers")
    token_path = os.environ.get("MS_TOKEN_PATH", "ms_token.json")

    if not client_id:
        print("ERROR: MS_CLIENT_ID not set in .env")
        print("Follow the setup steps at the top of this file.")
        sys.exit(1)

    try:
        import msal
    except ImportError:
        print("Installing MSAL...")
        os.system("pip install msal")
        import msal

    SCOPES = ["Mail.Read", "Mail.Send", "Mail.ReadWrite", "User.Read", "offline_access"]

    app = msal.PublicClientApplication(
        client_id,
        authority=f"https://login.microsoftonline.com/{tenant_id}"
    )

    flow = app.initiate_device_flow(scopes=SCOPES)
    if "user_code" not in flow:
        print(f"Failed to create device flow: {flow}")
        sys.exit(1)

    print("=" * 60)
    print("Microsoft Authorization")
    print("=" * 60)
    print(f"\n1. Open this URL: {flow['verification_uri']}")
    print(f"2. Enter code: {flow['user_code']}")
    print("\nSign in with the Microsoft account you want Axel to access.")
    print("Waiting for authorization...")

    result = app.acquire_token_by_device_flow(flow)

    if "access_token" not in result:
        print(f"\nAuthorization failed: {result.get('error_description', result)}")
        sys.exit(1)

    import time
    result["expires_at"] = time.time() + result.get("expires_in", 3600)

    with open(token_path, "w") as f:
        json.dump(result, f, indent=2)

    print(f"\n✅ Authorization successful! Token saved to {token_path}")
    print()
    print("Axel can now access:")
    print("  • Outlook inbox, sent, drafts, folders")
    print("  • Read and search emails")
    print("  • Send and reply to emails")
    print()
    print("Token refreshes automatically. No need to run this again.")


if __name__ == "__main__":
    main()
