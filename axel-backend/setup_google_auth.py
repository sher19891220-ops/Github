"""
One-time Google OAuth2 setup. Run this on your Mac mini.

Requirements:
  1. Go to console.cloud.google.com
  2. Create a project (or select existing)
  3. Enable these APIs: Gmail API, Google Sheets API, Google Drive API, Google Calendar API
  4. Go to Credentials → Create Credentials → OAuth 2.0 Client ID
  5. Application type: Desktop app
  6. Download the JSON file → save it as credentials.json in the axel-backend/ folder
  7. Run: python setup_google_auth.py

A browser will open asking you to authorize. After you approve, token.json is created
and Axel can use all Google tools without you needing to auth again.
"""

import os
import sys


def main():
    credentials_path = os.environ.get("GOOGLE_CREDENTIALS_PATH", "credentials.json")
    token_path = os.environ.get("GOOGLE_TOKEN_PATH", "token.json")

    if not os.path.exists(credentials_path):
        print(f"ERROR: {credentials_path} not found.")
        print()
        print("Steps to get it:")
        print("1. Go to https://console.cloud.google.com")
        print("2. Create/select a project")
        print("3. Enable APIs: Gmail, Sheets, Drive, Calendar")
        print("4. Credentials → Create → OAuth 2.0 Client ID → Desktop app")
        print(f"5. Download JSON → save as {credentials_path}")
        sys.exit(1)

    try:
        from google.auth.transport.requests import Request  # noqa: F401  (availability probe)
        from google_auth_oauthlib.flow import InstalledAppFlow
    except ImportError:
        print("Installing Google auth libraries...")
        os.system("pip install google-api-python-client google-auth-httplib2 google-auth-oauthlib")
        from google_auth_oauthlib.flow import InstalledAppFlow

    SCOPES = [
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/calendar",
    ]

    print("Opening browser for Google authorization...")
    print("Sign in with the Google account you want Axel to access.")
    print()

    flow = InstalledAppFlow.from_client_secrets_file(credentials_path, SCOPES)
    creds = flow.run_local_server(port=0)

    with open(token_path, "w") as f:
        f.write(creds.to_json())

    print(f"✅ Authorization successful! Token saved to {token_path}")
    print()
    print("Axel can now access:")
    print("  • Gmail (read, search, send)")
    print("  • Google Sheets (read, write)")
    print("  • Google Calendar (view, create events)")
    print("  • Google Drive (browse, read files)")
    print()
    print("No need to run this again unless you revoke access.")


if __name__ == "__main__":
    main()
