# Composio Social

Post to Instagram, LinkedIn, Twitter/X, and WhatsApp via Composio. Works from Axel (Telegram) and Claude Code.

## Triggers
- /composio-social
- /composio-social:instagram
- /composio-social:linkedin
- /composio-social:twitter
- /composio-social:whatsapp
- "post to Instagram"
- "post on LinkedIn"
- "tweet this"
- "WhatsApp driver"
- "send via WhatsApp"

## Setup

User has Instagram + Vercel connected in Composio. Other apps need to be connected at composio.io.

For Axel to use Composio tools, set in `axel-backend/.env`:
```
COMPOSIO_API_KEY=<from composio.io/settings>
```

## Instagram (`INSTAGRAM_*`)

### Post a photo/video
1. `INSTAGRAM_GET_USER` — get user ID and check publish quota
2. `INSTAGRAM_POST_IG_USER_MEDIA` — create media container with image URL
3. `INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH` — publish the container

Requirements:
- Image must be a publicly accessible HTTPS URL (host on Supabase Storage or S3 first)
- Formats: JPG (images), MP4 (videos, max 60s for Feed, 15s for Stories)
- Caption max: 2200 chars

### Content strategy
- Driver spotlights, load delivered photos, team photos
- Freight market insights (rate trends, lane maps)
- Behind-the-scenes dispatch operations

## LinkedIn (`LINKEDIN_*`)

### Post to profile or company page
1. `LINKEDIN_GET_MY_INFO` — get author URN (`urn:li:person:{id}`)
2. Optional: `LINKEDIN_GET_USER_ORGANIZATIONS` — get company page URN
3. Optional: `LINKEDIN_REGISTER_IMAGE_UPLOAD` — upload native image, get asset URN
4. `LINKEDIN_CREATE_SHARE` or `LINKEDIN_CREATE_UGC_POST` — create post

Post types:
- Text only: `"shareMediaCategory": "NONE"`
- Article link: `"shareMediaCategory": "ARTICLE"` + url
- Image: `"shareMediaCategory": "IMAGE"` + uploaded asset URN

### Content strategy (freight industry)
- Market intelligence (lane rates, capacity trends)
- Regulatory updates (FMCSA, HOS, ELD)
- Company milestones, client wins
- Thought leadership on freight technology

## Twitter/X (`TWITTER_*`)

### Post a tweet
1. Optional: `TWITTER_USER_LOOKUP` — verify authenticated account
2. Optional: `TWITTER_UPLOAD_MEDIA` + `TWITTER_GET_MEDIA_UPLOAD_STATUS` — for images
3. `TWITTER_CREATE_TWEET` — post with `text` (280 chars max)

Thread: post first tweet, then reply with `reply.in_reply_to_tweet_id` for each subsequent tweet.

### Content strategy
- Real-time market updates
- Industry news commentary
- Carrier alerts (avoid naming specific carriers publicly)
- Quick freight tips

## WhatsApp (`WHATSAPP_*`)

### Send a message to a driver or contact
1. `WHATSAPP_GET_PHONE_NUMBERS` — list verified sender phone numbers
2. `WHATSAPP_SEND_MESSAGE` — send text message

```
phone_number_id: <sender ID from step 1>
to_number: "15551234567"  # international format, no + or spaces
text: "Load available: Chicago → Dallas, pickup tomorrow 8am, $2,100 all-in"
```

Requirements:
- Recipient must have WhatsApp installed
- Number in international format (country code + number, digits only)
- Use for driver dispatch, load offers, delivery confirmations

## Axel Integration (Telegram → Social Media)

Axel handles social media via Composio tools registered in tool_registry.py:

```
"Post on Instagram: [caption]" 
  → Axel calls composio_post_instagram(caption, image_url)

"LinkedIn post about freight rates this week"
  → Axel drafts content → composio_post_linkedin(text)

"WhatsApp John Smith: load offer Chicago to Dallas tomorrow"
  → Axel formats message → composio_send_whatsapp(phone, message)
```

## Content Calendar (via /social-media skill)

- Monday: Market rates + capacity trends (LinkedIn + Twitter)
- Wednesday: Driver/team spotlight (Instagram)
- Friday: Week recap + wins (LinkedIn)
- Daily: Engagement replies (Twitter)

## Cross-posting Pattern

For maximum reach, post the same content across platforms with format adaptations:
1. Long-form on LinkedIn (full article, 1300+ chars)
2. Thread on Twitter (split into 280-char chunks)
3. Visual on Instagram (create graphic, post with condensed caption)
