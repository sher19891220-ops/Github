"""
Google Workspace tools: Gmail, Google Sheets, Calendar, Drive.

Setup (one-time on Mac mini):
  1. Go to console.cloud.google.com → Create project → Enable APIs:
     Gmail API, Sheets API, Drive API, Calendar API
  2. Credentials → OAuth 2.0 Client ID (Desktop app) → Download JSON
  3. Save as credentials.json in jarvis-backend/
  4. Run: python setup_google_auth.py
     This opens a browser, you authorize, and token.json is created.
  After that, Axel can use all Google tools without re-auth.
"""

import os
import base64
import logging
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

log = logging.getLogger(__name__)

CREDENTIALS_PATH = os.environ.get("GOOGLE_CREDENTIALS_PATH", "credentials.json")
TOKEN_PATH = os.environ.get("GOOGLE_TOKEN_PATH", "token.json")

SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/calendar",
]


def _get_creds():
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials

    if os.path.exists(TOKEN_PATH):
        creds = Credentials.from_authorized_user_file(TOKEN_PATH, SCOPES)
        if creds.valid:
            return creds
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            with open(TOKEN_PATH, "w") as f:
                f.write(creds.to_json())
            return creds

    raise FileNotFoundError(
        "Google not authorized. On Mac mini run: python setup_google_auth.py\n"
        f"Needs credentials.json at: {CREDENTIALS_PATH}"
    )


def _service(name, version):
    from googleapiclient.discovery import build
    return build(name, version, credentials=_get_creds())


# ── Gmail ─────────────────────────────────────────────────────────────────────

def gmail_list(query="", max_results=20):
    """List emails. query uses Gmail search syntax: from:x, is:unread, subject:y, after:2024/1/1"""
    try:
        svc = _service("gmail", "v1")
        res = svc.users().messages().list(userId="me", q=query, maxResults=max_results).execute()
        messages = res.get("messages", [])
        if not messages:
            return f"No emails found. Query: '{query}'"

        output = [f"Found {len(messages)} emails (query: '{query}'):\n"]
        for msg in messages:
            detail = svc.users().messages().get(
                userId="me", id=msg["id"], format="metadata",
                metadataHeaders=["From", "To", "Subject", "Date"]
            ).execute()
            h = {x["name"]: x["value"] for x in detail["payload"]["headers"]}
            snippet = detail.get("snippet", "")
            labels = detail.get("labelIds", [])
            output.append(
                f"📧 ID: {msg['id']}\n"
                f"   From: {h.get('From', 'N/A')}\n"
                f"   Subject: {h.get('Subject', 'N/A')}\n"
                f"   Date: {h.get('Date', 'N/A')}\n"
                f"   Labels: {', '.join(labels)}\n"
                f"   Preview: {snippet[:300]}"
            )
        return "\n\n".join(output)
    except FileNotFoundError as e:
        return str(e)
    except Exception as e:
        return f"Gmail list error: {e}"


def gmail_read(message_id):
    """Read full email content including all headers and body."""
    try:
        svc = _service("gmail", "v1")
        msg = svc.users().messages().get(userId="me", id=message_id, format="full").execute()

        headers = {x["name"]: x["value"] for x in msg["payload"]["headers"]}
        labels = msg.get("labelIds", [])

        # Extract body (prefer text/plain, fall back to text/html stripped)
        body = _extract_body(msg["payload"])

        attachments = []
        if "parts" in msg["payload"]:
            for part in msg["payload"]["parts"]:
                if part.get("filename"):
                    size = part["body"].get("size", 0)
                    attachments.append(f"{part['filename']} ({size} bytes)")

        result = (
            f"📧 EMAIL — ID: {message_id}\n"
            f"From: {headers.get('From', 'N/A')}\n"
            f"To: {headers.get('To', 'N/A')}\n"
            f"CC: {headers.get('Cc', 'None')}\n"
            f"Subject: {headers.get('Subject', 'N/A')}\n"
            f"Date: {headers.get('Date', 'N/A')}\n"
            f"Labels: {', '.join(labels)}\n"
        )
        if attachments:
            result += f"Attachments: {', '.join(attachments)}\n"
        result += f"\nBODY:\n{body}"
        return result
    except FileNotFoundError as e:
        return str(e)
    except Exception as e:
        return f"Gmail read error: {e}"


def gmail_send(to, subject, body, cc=""):
    """Send an email from your Gmail account."""
    try:
        svc = _service("gmail", "v1")
        msg = MIMEMultipart()
        msg["to"] = to
        msg["subject"] = subject
        if cc:
            msg["cc"] = cc
        msg.attach(MIMEText(body, "plain"))
        raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
        sent = svc.users().messages().send(userId="me", body={"raw": raw}).execute()
        return f"✅ Email sent — ID: {sent['id']}\nTo: {to}\nSubject: {subject}"
    except FileNotFoundError as e:
        return str(e)
    except Exception as e:
        return f"Gmail send error: {e}"


def _extract_body(payload):
    """Recursively extract text/plain body from Gmail payload."""
    if payload.get("mimeType") == "text/plain":
        data = payload.get("body", {}).get("data", "")
        if data:
            return base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")

    if "parts" in payload:
        # Prefer plain text
        for part in payload["parts"]:
            if part.get("mimeType") == "text/plain":
                data = part.get("body", {}).get("data", "")
                if data:
                    return base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")
        # Fall back to any part
        for part in payload["parts"]:
            result = _extract_body(part)
            if result:
                return result

    # Try body directly
    data = payload.get("body", {}).get("data", "")
    if data:
        return base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")

    return "(No readable body)"


# ── Google Sheets ──────────────────────────────────────────────────────────────

def sheets_read(spreadsheet_id, range_notation=""):
    """
    Read data from a Google Sheet.
    spreadsheet_id: the ID from the sheet URL.
    range_notation: e.g. 'Sheet1!A1:Z100' or just 'Sheet1'. Defaults to all data.
    """
    try:
        svc = _service("sheets", "v4")
        if not range_notation:
            # Get sheet names first
            meta = svc.spreadsheets().get(spreadsheetId=spreadsheet_id).execute()
            sheet_name = meta["sheets"][0]["properties"]["title"]
            range_notation = sheet_name

        res = svc.spreadsheets().values().get(
            spreadsheetId=spreadsheet_id, range=range_notation
        ).execute()

        values = res.get("values", [])
        if not values:
            return f"Sheet '{range_notation}' is empty."

        # Format as aligned table
        col_widths = []
        for row in values:
            for i, cell in enumerate(row):
                if i >= len(col_widths):
                    col_widths.append(0)
                col_widths[i] = max(col_widths[i], len(str(cell)))

        lines = [f"📊 {range_notation} — {len(values)} rows × {max(len(r) for r in values)} cols\n"]
        for i, row in enumerate(values):
            cells = []
            for j, cell in enumerate(row):
                width = col_widths[j] if j < len(col_widths) else 10
                cells.append(str(cell).ljust(width))
            lines.append(" | ".join(cells))
            if i == 0:  # Header separator
                lines.append("-" * sum(w + 3 for w in col_widths))

        return "\n".join(lines)
    except FileNotFoundError as e:
        return str(e)
    except Exception as e:
        return f"Sheets read error: {e}"


def sheets_write(spreadsheet_id, range_notation, values):
    """
    Write data to a Google Sheet.
    values: list of rows, each row is a list of values.
    Example: [['Name', 'Amount'], ['Invoice 1', '500']]
    """
    try:
        svc = _service("sheets", "v4")
        body = {"values": values}
        res = svc.spreadsheets().values().update(
            spreadsheetId=spreadsheet_id,
            range=range_notation,
            valueInputOption="USER_ENTERED",
            body=body
        ).execute()
        return (
            f"✅ Sheet updated\n"
            f"Range: {res.get('updatedRange')}\n"
            f"Cells updated: {res.get('updatedCells')}\n"
            f"Rows: {res.get('updatedRows')} | Columns: {res.get('updatedColumns')}"
        )
    except FileNotFoundError as e:
        return str(e)
    except Exception as e:
        return f"Sheets write error: {e}"


def sheets_list(query=""):
    """List all Google Sheets in your Drive, optionally filtered by name."""
    try:
        svc = _service("drive", "v3")
        q = "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false"
        if query:
            q += f" and name contains '{query}'"
        res = svc.files().list(
            q=q,
            fields="files(id, name, modifiedTime, createdTime)",
            orderBy="modifiedTime desc",
            pageSize=30
        ).execute()
        files = res.get("files", [])
        if not files:
            return "No spreadsheets found."
        lines = [f"📊 Google Sheets ({len(files)} found):\n"]
        for f in files:
            lines.append(
                f"• {f['name']}\n"
                f"  ID: {f['id']}\n"
                f"  Modified: {f['modifiedTime']}"
            )
        return "\n\n".join(lines)
    except FileNotFoundError as e:
        return str(e)
    except Exception as e:
        return f"Sheets list error: {e}"


# ── Google Calendar ────────────────────────────────────────────────────────────

def calendar_list(days_ahead=7, max_results=20, calendar_id="primary"):
    """List upcoming calendar events for the next N days."""
    try:
        from datetime import datetime, timezone, timedelta
        svc = _service("calendar", "v3")
        now = datetime.now(timezone.utc)
        end = now + timedelta(days=days_ahead)

        res = svc.events().list(
            calendarId=calendar_id,
            timeMin=now.isoformat(),
            timeMax=end.isoformat(),
            maxResults=max_results,
            singleEvents=True,
            orderBy="startTime"
        ).execute()

        events = res.get("items", [])
        if not events:
            return f"No events in the next {days_ahead} days."

        lines = [f"📅 Next {days_ahead} days — {len(events)} events:\n"]
        for ev in events:
            start = ev["start"].get("dateTime", ev["start"].get("date", "?"))
            end_time = ev["end"].get("dateTime", ev["end"].get("date", "?"))
            attendees = [a["email"] for a in ev.get("attendees", [])]
            lines.append(
                f"📌 {ev.get('summary', 'Untitled')}\n"
                f"   Start: {start}\n"
                f"   End: {end_time}\n"
                f"   Location: {ev.get('location', 'N/A')}\n"
                f"   Attendees: {', '.join(attendees) if attendees else 'None'}\n"
                f"   Description: {(ev.get('description') or 'N/A')[:300]}\n"
                f"   ID: {ev['id']}"
            )
        return "\n\n".join(lines)
    except FileNotFoundError as e:
        return str(e)
    except Exception as e:
        return f"Calendar list error: {e}"


def calendar_create(summary, start_datetime, end_datetime, description="", location="", attendees=None):
    """
    Create a calendar event.
    datetime format: '2024-01-15T10:00:00' (local time — UTC assumed if no timezone).
    attendees: list of email strings.
    """
    try:
        svc = _service("calendar", "v3")
        event = {
            "summary": summary,
            "location": location,
            "description": description,
            "start": {"dateTime": start_datetime, "timeZone": "UTC"},
            "end": {"dateTime": end_datetime, "timeZone": "UTC"},
        }
        if attendees:
            event["attendees"] = [{"email": e} for e in (attendees if isinstance(attendees, list) else [attendees])]

        result = svc.events().insert(calendarId="primary", body=event, sendUpdates="all").execute()
        return (
            f"✅ Event created\n"
            f"Title: {result.get('summary')}\n"
            f"Start: {result['start'].get('dateTime', result['start'].get('date'))}\n"
            f"End: {result['end'].get('dateTime', result['end'].get('date'))}\n"
            f"Link: {result.get('htmlLink')}\n"
            f"ID: {result.get('id')}"
        )
    except FileNotFoundError as e:
        return str(e)
    except Exception as e:
        return f"Calendar create error: {e}"


# ── Google Drive ───────────────────────────────────────────────────────────────

def drive_list(query="", max_results=20, mime_filter=""):
    """List files in Google Drive. query: filename search. mime_filter: e.g. 'application/pdf'"""
    try:
        svc = _service("drive", "v3")
        q_parts = ["trashed=false"]
        if query:
            q_parts.append(f"name contains '{query}'")
        if mime_filter:
            q_parts.append(f"mimeType='{mime_filter}'")

        res = svc.files().list(
            q=" and ".join(q_parts),
            fields="files(id, name, mimeType, size, modifiedTime, owners)",
            orderBy="modifiedTime desc",
            pageSize=max_results
        ).execute()

        files = res.get("files", [])
        if not files:
            return "No files found."

        lines = [f"📁 Google Drive — {len(files)} files:\n"]
        for f in files:
            size = f.get("size", "N/A")
            if size != "N/A":
                size = f"{int(size):,} bytes"
            lines.append(
                f"• {f['name']}\n"
                f"  Type: {f['mimeType']}\n"
                f"  Size: {size}\n"
                f"  Modified: {f['modifiedTime']}\n"
                f"  ID: {f['id']}"
            )
        return "\n\n".join(lines)
    except FileNotFoundError as e:
        return str(e)
    except Exception as e:
        return f"Drive list error: {e}"


def drive_read(file_id):
    """Read content of a Google Drive file (Docs, Sheets, text files, PDFs)."""
    try:
        svc = _service("drive", "v3")
        meta = svc.files().get(fileId=file_id, fields="mimeType,name,size").execute()
        mime = meta["mimeType"]
        name = meta["name"]

        if "google-apps.document" in mime:
            content = svc.files().export(fileId=file_id, mimeType="text/plain").execute()
            return f"📄 {name}\n\n{content.decode('utf-8')}"
        elif "google-apps.spreadsheet" in mime:
            return sheets_read(file_id)
        elif "google-apps" in mime:
            # Other Google Workspace types (Slides, Forms, etc.)
            content = svc.files().export(fileId=file_id, mimeType="text/plain").execute()
            return f"📄 {name}\n\n{content.decode('utf-8', errors='replace')}"
        else:
            # Binary files (PDF, images, etc.) — download raw bytes
            content = svc.files().get_media(fileId=file_id).execute()
            if isinstance(content, bytes):
                try:
                    return f"📄 {name}\n\n{content.decode('utf-8', errors='replace')}"
                except Exception:
                    return f"📄 {name} — binary file ({len(content):,} bytes), cannot display as text."
            return f"📄 {name}\n\n{content}"
    except FileNotFoundError as e:
        return str(e)
    except Exception as e:
        return f"Drive read error: {e}"
