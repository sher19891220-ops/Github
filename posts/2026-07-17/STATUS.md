# 2026-07-17 — NOT POSTED

Telegram publish failed: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` were not
present as environment variables in this routine run, so
`scripts/post_to_telegram.sh` exited immediately with:

```
scripts/post_to_telegram.sh: line 10: TELEGRAM_BOT_TOKEN: TELEGRAM_BOT_TOKEN is not set
```

No message or photo was sent to the Founder Hub channel (-1003816081838)
today. The content below is fully prepared and ready to post as soon as the
routine's environment variables are fixed — re-run:

```
bash scripts/post_to_telegram.sh posts/2026-07-17/card.png "<headline>" posts/2026-07-17/post.txt
```

Files in this directory:
- `post.txt` — full Telegram post text
- `card.png` — stat graphic (stat: "2.47M TEU")
