# Class feed

A spare WhatsApp number sits silently in your class groups. It reads what teachers post
(text, photos, PDFs), works out the deadlines, exams and changes, and keeps one shared feed.
Classmates open a link, type a class code once, and see everything. Nothing to upload.

```
spare SIM ──> listener ──> filters (free) ──> AI reads the rest ──> shared feed ──> everyone's phone
                                                                        └──> CR page to fix mistakes
```

Everything is one program (Node.js 22.5 or newer). The feed is stored in SQLite; there is no separate database service to set up.

## 1. Before you start

| You need | Notes |
|---|---|
| A spare SIM with WhatsApp | Register WhatsApp on it, name it "Class deadlines (read-only)", and add it to the class groups. Never send messages from it. |
| A computer that stays on | Your laptop is fine to start. See step 5 for a proper home. |
| Node.js 22.5 or newer | https://nodejs.org (use a release that meets the minimum required by `package.json`) |
| A Gemini API key | https://aistudio.google.com/apikey. Available quotas and billing requirements depend on your account and can change. |

## 2. Run it on your computer

```
cd class-feed
npm install
cp .env.example .env        (on Windows: copy .env.example .env)
```

Open `.env` in any text editor and fill in:

- `CLASS_CODE`: a short word you tell classmates.
- `ADMIN_CODE`: a different word only you know (the CR controls).
- `GEMINI_API_KEY`: the key from step 1.
- `GROUPS`: words from your group names, for example `MAIC 209,MAIC 205`. It only reads groups whose name contains one of them. If this is empty it reads nothing.
- `SUBJECTS`: course code to subject, for example `MAIC 209=Linear Algebra;MAIC 205=Probability`.
- `SENDERS` (optional): part of a teacher's saved name or phone number, comma separated. If you fill this in, everyone else is ignored. Leave empty to read everyone (chatter is still filtered out).

Then:

```
npm start
```

A QR code appears in the window. On the spare phone: WhatsApp, Linked devices, Link a device,
scan it. Only once. The program then prints every group the number is in and marks the ones it
is reading. If a group is missing, add a word from its name to `GROUPS` and restart.

Open http://localhost:3000, type your class code, and you are looking at what students will see.

## 3. Fill it with what you already have (optional)

Export a group from WhatsApp (with media), unzip it, then:

```
npm run replay -- "path/to/unzipped/folder" --group "MAIC 209 AI&DS 2026-27" --since 2026-08-01
```

The group name must match the WhatsApp group exactly. Running it twice does not duplicate anything.

## 4. The CR page

Open `/admin.html` on your link. Enter both codes. You see:

- whether the WhatsApp number is connected (if it says logged out, see Troubleshooting),
- cards the reader was unsure about, or that classmates flagged with "This is wrong". Fix and save, or delete, and everyone gets the fix within a minute,
- photos and files it skipped, with the reason, so you can tell if something useful was missed,
- wrong-answer reports from Ask, including the question, answer and any cards used. Fix or delete a card if it caused the wrong answer, then clear the report,
- re-file by subject, and Start a new semester (clears every card for everyone, so it asks twice).

Your fixes are remembered and shown to the AI as examples, so it makes the same mistake less often.

## Ask

Classmates can ask about deadlines, classes, exams or notes using the **Ask** tab. Answers use the feed's cards, timetable and academic calendar; available source messages and files are shown so students can check the answer. If an answer is wrong, a student can report it with **This answer is wrong**. The report appears on the CR page; it is for review, not automatic card approval.

## 5. Let classmates reach it

Phones need a secure (https) address for the home-screen app and for alerts.

**Quick, for a demo (free).** Install `cloudflared` (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/),
keep `npm start` running, and in a second window run:

```
cloudflared tunnel --url http://localhost:3000
```

It prints an address ending in `trycloudflare.com`. Send that and the class code to your class.
The address changes each time you restart it, and it stops when your laptop sleeps.

**Permanent.** Rent a small always-on Linux server (any provider's smallest plan; Oracle Cloud
and others have offered free small servers, but check what is available to you and whether they
ask for a card). Then, on the server (Ubuntu):

```
sudo apt update && sudo apt install -y git caddy
# install Node 22.5 or newer from https://nodejs.org (or your provider's instructions)
# copy this folder to the server, then inside it:
npm install
cp .env.example .env     # fill it in as in step 2
npm start                # scan the QR once, then stop it with Ctrl+C
```

Then use the two files in `deploy/`:
- `class-feed.service` keeps it running and restarts it after a reboot (instructions are inside it).
- `Caddyfile` gives it https on your own address. You need a name that points to the server. A cheap
  domain works, and free dynamic-DNS names (for example from duckdns.org) work too.

Keep the `data` folder safe. It holds the feed and the WhatsApp login. If you lose it you only need to scan the QR again.

## 6. What it costs

- Server software: free.
- AI: Gemini is the default provider. Google imposes model- and account-specific limits in addition to the app's own daily cap; check the current limits for your key. `/admin.html` shows app call usage.
- To use Anthropic instead, set `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY=...`. This switches providers; it is not an automatic fallback from Gemini, and Anthropic usage is billed separately.
- `DAILY_CALL_CAP` (default 300) is the app's hard limit. Every AI request attempt counts, including failed requests and retries or model fallbacks. Google or Anthropic may impose a lower limit.
- Cheap rules throw away stickers, videos, voice notes, "ok sir" and repeats before any AI is used.

Google says content sent on the free tier may be used to improve its products. Keep anything private out of the groups it reads.

### Current live deployment (26 Nov 2026)

These are the current production overrides, not the defaults for a new installation:

| Setting | Live value |
|---|---|
| `GEMINI_MODEL` | `gemini-3.1-flash-lite` |
| `GEMINI_LITE_MODEL` | `gemini-3.1-flash-lite` |
| `GEMINI_FALLBACK_MODEL` | `gemini-3-flash-preview,gemini-3.8-flash,gemini-3.6-flash,gemini-4-hydrogen` |
| `AI_RPM` | `15` |
| `DAILY_CALL_CAP` | `450` |
| `HISTORY_DAILY_CALLS` | `100` |

These values do not include credentials. Keep API keys and access codes in the server's private `.env`; do not commit them. Google quotas vary by key and model, so the app cap and `AI_RPM` must not be mistaken for Google's limits.

## 7. Troubleshooting

- **"Logged out"**: delete the `data/wa-auth` folder, start again, scan the QR again.
- **Stopped working after a while**: WhatsApp changes now and then and the library used here is unofficial. Run `npm update @whiskeysockets/baileys`, restart.
- **A photo did not become a card**: check "Photos and files it skipped" on the CR page. WhatsApp only gives the reader a photo it can download; very old photos are not available.
- **Number banned**: this is a real risk with any unofficial library. It is lower for a number that only listens, but not zero. Keep the weekly export as a fallback and `npm run replay` it.
- **Nothing is being read**: `GROUPS` in `.env` is empty or does not match the group name (case does not matter; part of the name is enough).
- **Alerts on iPhone**: the app must be added to the home screen first, then opened from there.

## 8. For developers

- `src/reader.js` is the pipeline: messages wait in SQLite, get read in batches, retry on failure, and survive restarts.
- `src/ai.js` is the only place that knows about the AI provider.
- `EXPORT_DIR=path/to/unzipped/export npm test` runs the pipeline with a pretend AI (filters, routing, updates, retries, reminders, server).
- `python3 build_app.py` rebuilds `public/index.html` from the app source.

## Importing old chats (CR page)
Open `/admin.html`, connect, and use **Import old chats**: pick the group, set the date the semester started, and upload the zip from WhatsApp (group name, then Export chat, Include media). Messages before that date are ignored. The import runs only when no live messages are waiting, uses at most `HISTORY_DAILY_CALLS` AI request attempts a day (default 120), and stops when the global daily cap has `HISTORY_RESERVE` (default 80) or fewer calls remaining. This is a stop threshold, not a guarantee that those calls remain available for live reading: Ask, fixes, polls, and urgent reads share the same global cap. Imports send no alerts. Uploading the same zip twice adds nothing. Past deadlines go under "Earlier" in the app. Optional `.env` settings: `HISTORY_DAILY_CALLS`, `HISTORY_RESERVE`, `HISTORY_MAX_MB` (default 200), `HISTORY_MAX_FILES` (default 400).

## Keeping PDF reading cheap
- A PDF whose name looks like course material (lecture, notes, slides, unit, chapter, `L-3`, `Part-II`) is filed under its subject **without any AI call**, unless its name, caption or the messages around it mention a deadline, test, assignment, notice or similar. Deadlines said in chat are still read from the chat text.
- Any other PDF longer than `PDF_AI_PAGES` pages (default 3, set 0 for the whole file) is sent to the AI as its first pages only. Short PDFs are sent whole.
- Needs `pdf-lib` (`npm install`). Without it, long PDFs are sent whole and nothing breaks.

## Fewer AI calls
- **Signal filter:** a batch of messages with no digits, weekday or month names, or deadline words (English and Hinglish) is not sent to the AI. If any message in a batch has a signal, the whole batch is read together, so chatter keeps its context. A file always counts.
- **CR review:** the CR page lists the longer skipped messages from the last week. "Read this" sends one to the AI and can add a word to the filter; "Fine to skip" clears it.
- **Shared backoff:** after retryable provider failures exhaust the available attempts, the app pauses AI calls with an increasing backoff (2, 4, 8 ... up to 30 minutes). If processing does not resume, check the logs and CR page.
- **Batching:** `BATCH_WAIT_MS` (default 7.5 minutes of quiet) and `BATCH_MAX_MS` (default 20 minutes, so a busy group is not held longer).

## How a file is read with its chat
A photo or PDF is sent to the AI with the 6 messages nearest to it in time (the sender's own messages first, up to 250 characters each, labelled "1 min after" and so on). The AI is told to use them for the title, subject and summary, and that names like "Adobe Scan" are never a title. A short message from the file's sender a few minutes later ("this is the Unit 3 worksheet, due Monday") updates that file's card.

## How cards are filed by group
- **A group named after a subject** (for example "Software Engineering", or "MAIC 209 ..." with a code in `SUBJECTS`) files every card under that subject, including notices and class changes. Only a message that names a different course code moves a card to that other subject.
- **The main group of the whole class**: list words from its name in `MAIN_GROUPS` (for example `MAIN_GROUPS=AIDS 2026`). Each message, photo or PDF is filed by what it says: a course code, a subject name, the teacher's name or the file name. Anything meant for everyone (college notices, holidays, fees, forms, events) stays under **General** as a notice.
- Every group in `GROUPS` that is not in `MAIN_GROUPS` is treated as a subject group. The CR page shows how each group is filed under Status.
- After changing `MAIN_GROUPS`, use **Re-file cards by subject** on the CR page to fix cards made earlier (cards the CR has edited are left alone).

## Sections and the CR check list

The class has sections (`SECTIONS`, default `AD-01,AD-02`). Everyone picks theirs once (people who joined earlier are asked too). Lectures are for everyone; a lab or notice can be for one section, and each phone shows its own section, with a switch to show the other. A group set to a section on the CR page marks everything it reads as that section. A message that names one section is filed for that section; one that names both is for everyone.

When the AI is unsure about a deadline, exam or class change, the card waits under **Needs your check** on the CR page. The CR can fix it and press **Publish** (phones are alerted then) or throw it away. If nobody checks it within `HOLD_HOURS` (default 12) it goes live anyway. Old-chat imports are never held.

The CR's **Needs your check** list also holds cards classmates flagged and cards the AI was unsure about. For any of them the CR can type what is wrong ("only AD-02, due Friday 5 pm"): the AI redoes the card with that note and the original messages, and it goes to everyone's feed. Or the CR edits the boxes, publishes as it is, or throws it away. Google's free AI quota resets at midnight Pacific time (1:30 pm in India), and the app counts its day the same way.

## Polls

A poll in a class group is saved with its votes. After `POLL_WAIT_MIN` minutes (default 90), it is considered only if at least `POLL_MIN_VOTES` people voted, one option has `POLL_MAJORITY` percent or more, and the question or options pass the signal filter. The AI then decides whether the winning option is a class, exam or deadline. Fallback models or retries can mean more than one request attempt. A resulting card goes live straight away and also appears under **Needs your check**, marked as not confirmed by the teacher, so the CR can approve or remove it. Polls below the vote threshold, without a clear winner, or without a signal do not use AI. When the teacher confirms in a normal message, that message updates the card like any other. Votes are only counted while the number is connected.

## AI speed limit

The app spaces AI request attempts using `AI_RPM` (default 5, about one request every 12.5 seconds) and queues the rest. Set it no higher than the effective per-minute limit for the model and key; quotas vary by model, account and tier. The live deployment uses `AI_RPM=15`. Raising this setting does not raise Google's own quota.

## Making the AI calls last the whole day

The app does not read messages the second they arrive. Ordinary messages wait for 7.5 quiet minutes (`BATCH_WAIT_MS`) and are read in text batches of up to 25; each photo or PDF that needs AI is a separate request. A busy group is read no later than 20 minutes (`BATCH_MAX_MS`). Every AI request attempt counts against `DAILY_CALL_CAP`, including provider rejections, retries, and fallback-model attempts.

Ordinary live reading is paced through Google's quota day (midnight Pacific; its India time shifts with daylight saving). By default, it can use up to 25% of its 80%-of-cap share at the start of the day, then more as the day progresses. `ASK_RESERVE` (default 0.2) limits this ordinary reading allowance; it does not reserve a guaranteed pool for Ask, fixes, or polls. Those features share the global cap with urgent reads, and urgent reads can use calls beyond the ordinary reading allowance. Calls that do not fit ordinary pacing wait for a later window. After a restart, startup processing only flushes messages at least `BATCH_MAX_MS` old. Set `DAILY_CALL_CAP` below the actual quota for your key, with a margin.

**Urgent messages bypass the normal wait and pacing.** A cancellation, postponement, reschedule, move, extra/make-up class, "no class", "class off", venue change, or message marked urgent is processed after one quiet minute (`URGENT_WAIT_MS`). Other waiting messages in that group are processed in the same pass. Cards trigger alerts when created. Urgent processing is still subject to the app's global hard cap, AI cooldown, model availability, and provider limits or errors; it is not guaranteed to succeed immediately.

## Timetable and sections on Today

Today's class list shows every lecture and every lab. Labs carry their section (Lab AD-01), your own section's labs are outlined, and a cancelled class has a red label and is struck through. The greeting at the top is written from your own section. Cards for the other section are not shown to you. When the CR's timetable is read, a block of 100 minutes or more is a lab and a shorter one is a lecture; two separate classes in a row are never joined. Only the CR sees the Add timetable button.
