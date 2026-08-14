"""
Microsoft tools: Outlook email via Microsoft Graph API.

SETUP (one-time):
  1. Go to portal.azure.com → Azure Active Directory → App registrations → New
  2. Supported account types: "Personal Microsoft accounts only" (for Outlook.com)
     OR "Accounts in any organizational directory" (for work/school)
  3. Note the Application (client) ID
  4. Certificates & secrets → New client secret → copy the value
  5. API permissions → Add → Microsoft Graph → Delegated:
     Mail.Read, Mail.Send, Mail.ReadWrite, User.Read
  6. Run: python setup_microsoft_auth.py
  7. Add MS_CLIENT_ID, MS_TENANT_ID, MS_TOKEN_PATH to .env

For personal Outlook.com: MS_TENANT_ID = "consumers"
For work/school: MS_TENANT_ID = your tenant ID from Azure
"""

import json
import logging
import os

import requests

log = logging.getLogger(__name__)

MS_CLIENT_ID = os.environ.get("MS_CLIENT_ID", "")
MS_CLIENT_SECRET = os.environ.get("MS_CLIENT_SECRET", "")
MS_TENANT_ID = os.environ.get("MS_TENANT_ID", "consumers")
MS_TOKEN_PATH = os.environ.get("MS_TOKEN_PATH", "ms_token.json")

GRAPH = "https://graph.microsoft.com/v1.0"
SCOPES = ["Mail.Read", "Mail.Send", "Mail.ReadWrite", "User.Read", "offline_access"]


def _get_token():
    if not MS_CLIENT_ID:
        raise ValueError(
            "Microsoft not configured. Set MS_CLIENT_ID and run setup_microsoft_auth.py"
        )

    if os.path.exists(MS_TOKEN_PATH):
        with open(MS_TOKEN_PATH) as f:
            token_data = json.load(f)

        # Try refresh if we have a refresh token
        if "refresh_token" in token_data:
            import time
            # Check expiry (with 5 min buffer)
            expires_at = token_data.get("expires_at", 0)
            if expires_at and time.time() < expires_at - 300:
                return token_data["access_token"]

            # Refresh
            resp = requests.post(
                f"https://login.microsoftonline.com/{MS_TENANT_ID}/oauth2/v2.0/token",
                data={
                    "client_id": MS_CLIENT_ID,
                    "client_secret": MS_CLIENT_SECRET,
                    "refresh_token": token_data["refresh_token"],
                    "grant_type": "refresh_token",
                    "scope": " ".join(SCOPES),
                }
            )
            if resp.is_success:
                import time as t
                new_data = resp.json()
                new_data["expires_at"] = t.time() + new_data.get("expires_in", 3600)
                new_data.setdefault("refresh_token", token_data["refresh_token"])
                with open(MS_TOKEN_PATH, "w") as f:
                    json.dump(new_data, f)
                return new_data["access_token"]

        if "access_token" in token_data:
            return token_data["access_token"]

    raise FileNotFoundError(
        "Microsoft not authorized. On Mac mini run: python setup_microsoft_auth.py\n"
        "This completes the OAuth2 device code flow in your terminal."
    )


def _graph(method, path, **kwargs):
    token = _get_token()
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        **kwargs.pop("extra_headers", {})
    }
    resp = getattr(requests, method)(f"{GRAPH}{path}", headers=headers, timeout=30, **kwargs)
    resp.raise_for_status()
    if resp.content:
        return resp.json()
    return {}


def _ms_check():
    if not MS_CLIENT_ID:
        return (
            "Microsoft/Outlook not configured.\n"
            "Setup: register app at portal.azure.com, run setup_microsoft_auth.py\n"
            "Then add MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT_ID to .env"
        )
    return None


# ── Outlook Email ──────────────────────────────────────────────────────────────

def outlook_list(folder="inbox", max_results=20, filter_unread=False, search=None):
    """
    List Outlook emails.
    folder: inbox, sentitems, drafts, deleteditems, junkemail
    filter_unread: only show unread emails
    search: keyword search in subject/body
    """
    err = _ms_check()
    if err:
        return err
    try:
        params = {
            "$top": max_results,
            "$orderby": "receivedDateTime desc",
            "$select": "id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,hasAttachments,importance"
        }
        if filter_unread:
            params["$filter"] = "isRead eq false"
        if search:
            params["$search"] = f'"{search}"'

        data = _graph("get", f"/me/mailFolders/{folder}/messages", params=params)
        emails = data.get("value", [])

        if not emails:
            return f"No emails in {folder}."

        unread_count = sum(1 for e in emails if not e.get("isRead"))
        lines = [f"📧 Outlook {folder.title()} — {len(emails)} emails ({unread_count} unread)\n"]

        for email in emails:
            sender = email.get("from", {}).get("emailAddress", {})
            read_marker = "🔵 " if not email.get("isRead") else "   "
            attach_marker = "📎 " if email.get("hasAttachments") else ""
            importance = " ⚡" if email.get("importance") == "high" else ""
            lines.append(
                f"{read_marker}{attach_marker}ID: {email['id'][:20]}...\n"
                f"   From: {sender.get('name', '')} <{sender.get('address', 'N/A')}>\n"
                f"   Subject: {email.get('subject', 'N/A')}{importance}\n"
                f"   Date: {email.get('receivedDateTime', 'N/A')}\n"
                f"   Preview: {email.get('bodyPreview', '')[:300]}"
            )

        return "\n\n".join(lines)
    except FileNotFoundError as e:
        return str(e)
    except Exception as e:
        return f"Outlook list error: {e}"


def outlook_read(message_id):
    """Read full Outlook email by ID. Returns all headers, body, and attachment info."""
    err = _ms_check()
    if err:
        return err
    try:
        email = _graph("get", f"/me/messages/{message_id}", params={
            "$select": "subject,from,toRecipients,ccRecipients,bccRecipients,replyTo,receivedDateTime,body,hasAttachments,importance,categories,conversationId"
        })

        sender = email.get("from", {}).get("emailAddress", {})
        to = ", ".join(r["emailAddress"]["address"] for r in email.get("toRecipients", []))
        cc = ", ".join(r["emailAddress"]["address"] for r in email.get("ccRecipients", []))

        body = email.get("body", {})
        body_content = body.get("content", "(no body)")
        # Strip HTML tags for plain text
        if body.get("contentType") == "html":
            import re
            body_content = re.sub(r"<[^>]+>", "", body_content)
            body_content = re.sub(r"\s+", " ", body_content).strip()

        result = (
            f"📧 EMAIL\n"
            f"From: {sender.get('name', '')} <{sender.get('address', 'N/A')}>\n"
            f"To: {to}\n"
        )
        if cc:
            result += f"CC: {cc}\n"
        result += (
            f"Subject: {email.get('subject', 'N/A')}\n"
            f"Date: {email.get('receivedDateTime', 'N/A')}\n"
            f"Importance: {email.get('importance', 'normal')}\n"
            f"Has attachments: {email.get('hasAttachments', False)}\n"
            f"Conversation ID: {email.get('conversationId', 'N/A')}\n"
        )

        if email.get("hasAttachments"):
            attachments = _graph("get", f"/me/messages/{message_id}/attachments",
                                 params={"$select": "name,size,contentType"})
            att_list = [
                f"  - {a['name']} ({a.get('size', 0):,} bytes, {a.get('contentType', 'unknown')})"
                for a in attachments.get("value", [])
            ]
            if att_list:
                result += "Attachments:\n" + "\n".join(att_list) + "\n"

        result += f"\nBODY:\n{body_content}"
        return result
    except FileNotFoundError as e:
        return str(e)
    except Exception as e:
        return f"Outlook read error: {e}"


def outlook_send(to, subject, body, cc="", importance="normal"):
    """
    Send an Outlook email.
    importance: normal, high, low
    """
    err = _ms_check()
    if err:
        return err
    try:
        to_list = [to] if isinstance(to, str) else to
        message = {
            "subject": subject,
            "importance": importance,
            "body": {"contentType": "Text", "content": body},
            "toRecipients": [{"emailAddress": {"address": addr}} for addr in to_list],
        }
        if cc:
            cc_list = [cc] if isinstance(cc, str) else cc
            message["ccRecipients"] = [{"emailAddress": {"address": addr}} for addr in cc_list]

        _graph("post", "/me/sendMail", json={"message": message})
        return f"✅ Email sent\nTo: {', '.join(to_list)}\nSubject: {subject}"
    except FileNotFoundError as e:
        return str(e)
    except Exception as e:
        return f"Outlook send error: {e}"


def outlook_reply(message_id, body):
    """Reply to an Outlook email by message ID."""
    err = _ms_check()
    if err:
        return err
    try:
        _graph("post", f"/me/messages/{message_id}/reply",
               json={"message": {}, "comment": body})
        return f"✅ Reply sent to message {message_id[:20]}..."
    except FileNotFoundError as e:
        return str(e)
    except Exception as e:
        return f"Outlook reply error: {e}"
