"""
Composio integration — Instagram, LinkedIn, Twitter/X, WhatsApp via Composio SDK.
Requires: pip install composio-core
Requires: COMPOSIO_API_KEY in .env
"""

import os

try:
    from composio import ComposioToolSet, Action
    _composio_available = True
except ImportError:
    _composio_available = False


def _toolset():
    api_key = os.environ.get("COMPOSIO_API_KEY", "")
    if not api_key:
        return None
    return ComposioToolSet(api_key=api_key)


def _unavailable(reason: str) -> dict:
    return {"error": reason}


# ── Instagram ──────────────────────────────────────────────────────────────────

def instagram_get_user() -> dict:
    """Get Instagram user info and publish quota."""
    ts = _toolset()
    if not ts:
        return _unavailable("COMPOSIO_API_KEY not set")
    if not _composio_available:
        return _unavailable("composio-core not installed")
    try:
        result = ts.execute_action(Action.INSTAGRAM_GET_USER, {})
        return result
    except Exception as e:
        return {"error": str(e)}


def instagram_post(image_url: str, caption: str = "", media_type: str = "IMAGE") -> dict:
    """
    Post a photo or video to Instagram Feed.
    image_url: publicly accessible HTTPS URL (JPG for images, MP4 for video)
    media_type: IMAGE | VIDEO | REELS
    """
    ts = _toolset()
    if not ts:
        return _unavailable("COMPOSIO_API_KEY not set")
    if not _composio_available:
        return _unavailable("composio-core not installed")
    try:
        # Step 1: get user to find ig_user_id
        user_result = ts.execute_action(Action.INSTAGRAM_GET_USER, {})
        ig_user_id = (user_result.get("data") or {}).get("id")
        if not ig_user_id:
            return {"error": "Could not get Instagram user ID", "user_result": user_result}

        # Step 2: create media container
        container = ts.execute_action(Action.INSTAGRAM_POST_IG_USER_MEDIA, {
            "ig_user_id": ig_user_id,
            "image_url": image_url,
            "caption": caption,
            "media_type": media_type,
        })
        container_id = (container.get("data") or {}).get("id")
        if not container_id:
            return {"error": "Could not create media container", "container": container}

        # Step 3: publish
        publish = ts.execute_action(Action.INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH, {
            "ig_user_id": ig_user_id,
            "creation_id": container_id,
        })
        return {"success": True, "media_id": (publish.get("data") or {}).get("id"), "caption": caption}
    except Exception as e:
        return {"error": str(e)}


# ── LinkedIn ───────────────────────────────────────────────────────────────────

def linkedin_post(text: str, url: str = "", image_url: str = "") -> dict:
    """
    Post to LinkedIn profile. Optionally include a link or image.
    text: post content (supports newlines)
    url: optional link to share
    image_url: optional image (publicly accessible HTTPS URL)
    """
    ts = _toolset()
    if not ts:
        return _unavailable("COMPOSIO_API_KEY not set")
    if not _composio_available:
        return _unavailable("composio-core not installed")
    try:
        me = ts.execute_action(Action.LINKEDIN_GET_MY_INFO, {})
        author_urn = (me.get("data") or {}).get("id")
        if not author_urn:
            return {"error": "Could not get LinkedIn author URN", "me": me}

        if not author_urn.startswith("urn:li:"):
            author_urn = f"urn:li:person:{author_urn}"

        payload = {"author": author_urn, "text": text}
        if url:
            payload["share_url"] = url
        if image_url:
            payload["image_url"] = image_url

        result = ts.execute_action(Action.LINKEDIN_CREATE_SHARE, payload)
        return {"success": True, "result": result}
    except Exception as e:
        return {"error": str(e)}


# ── Twitter/X ──────────────────────────────────────────────────────────────────

def twitter_post(text: str) -> dict:
    """
    Post a tweet (max 280 chars). For threads, call multiple times with reply_to_id.
    """
    ts = _toolset()
    if not ts:
        return _unavailable("COMPOSIO_API_KEY not set")
    if not _composio_available:
        return _unavailable("composio-core not installed")
    if len(text) > 280:
        return {"error": f"Tweet too long ({len(text)} chars, max 280)"}
    try:
        result = ts.execute_action(Action.TWITTER_CREATE_TWEET, {"text": text})
        tweet_id = ((result.get("data") or {}).get("data") or {}).get("id")
        return {"success": True, "tweet_id": tweet_id, "text": text}
    except Exception as e:
        return {"error": str(e)}


# ── WhatsApp ───────────────────────────────────────────────────────────────────

def whatsapp_send(phone_number: str, message: str, sender_id: str = "") -> dict:
    """
    Send a WhatsApp message.
    phone_number: international format, digits only (e.g. '15551234567')
    sender_id: Composio phone_number_id — auto-detected if blank
    """
    ts = _toolset()
    if not ts:
        return _unavailable("COMPOSIO_API_KEY not set")
    if not _composio_available:
        return _unavailable("composio-core not installed")
    try:
        # Clean phone number
        clean_phone = "".join(c for c in phone_number if c.isdigit())

        if not sender_id:
            numbers = ts.execute_action(Action.WHATSAPP_GET_PHONE_NUMBERS, {})
            phone_numbers = (numbers.get("data") or {}).get("data", [])
            if not phone_numbers:
                return {"error": "No WhatsApp sender numbers found — connect WhatsApp in Composio"}
            sender_id = phone_numbers[0]["id"]

        result = ts.execute_action(Action.WHATSAPP_SEND_MESSAGE, {
            "phone_number_id": sender_id,
            "to_number": clean_phone,
            "text": message,
        })
        return {"success": True, "to": phone_number, "message": message, "result": result}
    except Exception as e:
        return {"error": str(e)}


def whatsapp_list_senders() -> dict:
    """List available WhatsApp sender phone numbers."""
    ts = _toolset()
    if not ts:
        return _unavailable("COMPOSIO_API_KEY not set")
    if not _composio_available:
        return _unavailable("composio-core not installed")
    try:
        result = ts.execute_action(Action.WHATSAPP_GET_PHONE_NUMBERS, {})
        return result
    except Exception as e:
        return {"error": str(e)}
