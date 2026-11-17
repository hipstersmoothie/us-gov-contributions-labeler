# Automated posts from @contributions.fyi

Plan for posting to Bluesky on our own, to grow the account.

**Status:** series 1 is built in `posts/` but not deployed yet. The rest are
plans. How to run it is in the main README, under "Posts".

Series, in build order:

1. **Meet the member-elect** (now through Dec. 15), which turns into
   **New on Bluesky** after Jan. 3
2. **"Who funds this?" replies** to mentions
3. **Bills that passed, and who lobbied on them**
4. **After the election** (outside spending now, post-general money once the
   FEC has it)
5. **The lobbying quarter** (2026 Q3 to try it out, Q4 when it's due Jan. 21)
6. **State spotlights**, weekly

## How it runs

A new `posts/` service on Railway, laid out like `feeds/`. It's long-running
rather than a cron, because the mention replies need to come within a minute.

- **Data:** it reads `data/*.json` from `main` on GitHub with ETags, the way
  `feeds/server.ts` reads `members.json`. That covers `members`, `accounts`,
  `races-2026`, `race-results-2026`, `elections-2026`, `legislation`,
  `organizations`, and later `lobbying-quarters`. So a push to `main` (a weekly
  refresh, or `pnpm race-results add`) reaches the posts without a redeploy.
- **Database:** SQLite on a volume at `/data`, with three tables:
  - `posts(key unique, series, status, text, embed, uri, created_at, posted_at)`
  - `replies(mention_uri unique, subject_did, reply_uri, at)`
  - `state(key, value)`, which holds the notification cursor
- **Keys and catch-up:** every post has a stable key:
  `member-elect:H6WY00217`, `bsky:<did>`, `vote:h2026-312`, `quarter:2026-Q3`,
  `state:tx:2026-11-22`. Each series is a function from the data to the posts
  it wants, so a restart or rerun never posts twice. A series switched on late
  catches up on the backlog at its normal pace rather than in a burst.
- **Pacing:**
  - at most 2 scheduled posts in any 24 hours, across every series
    (`MAX_PER_DAY`)
  - at least 4 hours between them, so it's one in the morning and one in the
    afternoon
  - a smaller daily cap for some series, so one series can't take both slots
    every day
  - posting only between 8 a.m. and 9 p.m. Eastern
  - mention replies are exempt from all three
- **Modes:** each series is `on`, `off` or `dry` (`POSTS_<SERIES>=dry`). In
  `dry`, it logs what it would post and records nothing. Series post on their
  own from the start. What stands in front of them:
  - `pnpm posts preview` before a series is switched on
  - the refresh's data checks, which stop bad data before it reaches `main`
  - the pacing limits
  - a sanity check in each series: no $0 totals, no empty lists, and no
    single post about more than 10 races or bills
- **Text:** templates only, with no LLM text. Each post is checked against the
  300-grapheme limit before it's queued, and money is written as on the site
  (`compact()`, "$2.2M").
- **Embeds:** a link card to the page, using that page's OG image as the
  thumbnail (`/og/<version>/<type>/<id>.png`, uploaded with `uploadBlob`). The
  card server renders the current card for any hex version, so the version can
  come from the page's `og:image` meta tag. The OG images exist for every
  member, race, candidate, bill, state and organization.
- **Login:** a new app password just for this service (`POSTS_APP_PASSWORD`).
  It can be revoked on its own without touching `LABELER_PASSWORD`.
  - A post costs 3 points out of the account's 5,000 an hour, which
    `sync-lists` shares.
- **Local preview:** `pnpm posts preview [series]` prints what each series
  would post from the local `data/`, with the text, the link and the card URL.
  This is how a template gets reviewed before it's switched on.

Code it can reuse:
- the post text: `memberLabels()` and `labelName()` from `src/lib/labels.ts`
- `shortSeat()` and `compact()` from `site/src/lib/bluesky-hub.ts`
- the list and feed links from `site/src/lib/bluesky.ts`
- mention facets from `richText()` in `src/sync-lists.ts`

The site helpers should move into `src/lib` so `posts/` can import them
without reaching into `site/`.

## 1. Meet the member-elect → New on Bluesky

Built: `posts/series/member-elect.ts` and `posts/series/new-on-bluesky.ts`.

**Trigger.** A race's `result` in `data/races-2026.json` is `certified` (or
`sworn-in`). That's after `pnpm race-results add` *and* the races step, which
checks each entry against its official source and against the FEC's results.
Winners are never inferred from anything else (see design/races/README.md).
Each post also waits until its page on the site says "won, as certified", so
a post never beats the site's deploy.

**No post per state.** Most would only say "returning" (Delaware, Vermont and
the Northern Mariana Islands so far), and the states with news already get
member-elect posts. Certification shows up in those instead.

**Member-elect posts** (`member-elect:2026:<FEC id>`) are one per certified
winner who isn't a current member of that chamber:
- A winner with no `bioguide` is new to Congress.
- A member moving chambers (Hageman, House → Senate) counts too, and links to
  the race instead of the candidate page.

> Meet Chuck Gray (R), Wyoming's representative-elect. Certified Nov. 10.
>
> The campaign raised $2M through Oct. 14, including $1.6M of the candidate's
> own money.
> Top contributors: Visa, Continental Resources, Phillips 66.
> Outside groups spent $1.9M supporting Gray and $724K opposing.

How the post is put together:
- Who certified the result is on the link card ("Chuck Gray won, as
  certified by the Wyoming State Canvassing Board"), so the post just gives
  the date.
- The own-money note shows at 20% of receipts and $50K or more.
- The contributor, outside spending and industry lines are optional. They're
  dropped from the end until the post fits, so contributors stay longest.
- Winners with no campaign money on file get no post.
- No pronouns: "the campaign", "the candidate's", the surname.
- Capped at 2 a day, which is every slot when there's nothing else.

There are 14 races certified so far, which makes a backlog of 6 posts:
- new to Congress: Annie Andrews, Nancy LaCore, Wes Climer, Janelle Sarauw
  and Chuck Gray
- moving chambers: Hageman

**New on Bluesky** (`bsky:<bioguide>`) is posted when a member has an account
in `members.json` and the service hasn't seen them before.
- On first run it records the 249 already there without posting.
- It's one post per member, however many accounts they add.
- It's skipped while the account's handle doesn't resolve (`handle.invalid`).
- Member-elects aren't matched to accounts, so freshmen turn up after Jan. 3,
  when they join `members.json`.

> Welcome to Bluesky, @handle!
>
> Rep. Name (D-TX-30) makes 250 members of Congress here.
> Top industries: A, B, C.
> Top contributors: D, E, F.

"Welcome to Bluesky" is only for accounts less than 30 days old, by the
profile's `createdAt`. Otherwise:

> Rep. Name (D-TX-30) is on Bluesky: @handle
>
> That makes 250 members of Congress here, all in our lists and feeds.

A newly *matched* account is often an old one. The industries and
contributors are the member's labels.

Expect these to lean heavily one way: on the Bluesky card, Republicans are 1
of 274 on Bluesky. That's the data, and the template doesn't change for it.

## 2. "Who funds this?" replies

**Trigger.** The service polls `app.bsky.notification.listNotifications`
every 30 seconds as @contributions.fyi, for reasons `mention` and `reply`.
That avoids reading the whole firehose. A mention is answered when either:
- it's in a reply whose **parent post** is by a member's account, or
- it names a member's handle directly ("who funds @rep.house.gov?").

To find the member, the service looks the DID up in `members.json` in memory.
`fyi.contributions.account` on the PDS answers the same question for anyone
else.

**The reply.** It's threaded under the mention, with the member card attached:

> Rep. Name (D, TX-30), 2022–2026: $X raised. Top funding sectors: A, B, C.
> Top contributors: D, E, F. contributions.fyi/members/<bioguide>/

**Limits:**
- One answer per parent post. A later ask in the same thread gets a reply
  linking the first answer.
- Ten answers per asker per hour.
- No replies to accounts that block us.
- A mention under a post that isn't a member's gets no reply, unless it names
  a member.

**Rollout.** It's `on` from the start, like the scheduled series. Every reply
is logged in `replies`, and `POSTS_MENTIONS=dry` turns replies off while
leaving the log running.

## 3. Bills that passed, and who lobbied on them

**Data.** Every bill in `legislation.json` has `votes` (each with `yes`, `no`
and `other` bioguide lists and party tallies) and `lobbying` (organizations,
their quarters, and sometimes a `stance`).

**The post** (`vote:<vote id>`) is one post per passage vote or new law:

> H.R. 1 passed the House 215–214 (party-line). 2,675 organizations lobbied
> on it, including 3M, … Members who voted yes got an average of $X from
> them; no votes, $Y.

It uses averages per voter, not totals, so the bigger party doesn't look
bought by headcount. When organizations have a `stance`, the post splits the
money by stance. Without stance, it says "lobbied on it", never "for it".
Each post has the bill card, and there's a cap of 1 a day, with the most
lobbied bills first.

**Timing.** Weekly: `legislation` runs only in the Tuesday refresh, so the
posts go out Tuesday and Wednesday for the week before. Nothing new needs
building.

Same-day posts would come later, if the weekly ones do well. The posts
service would poll the House Clerk and Senate vote XML itself every 30
minutes, reusing `legislation.ts`'s fetchers. That costs more:
`legislation.json` only includes bills that *already* had a passage vote, so a
bill's first vote has no lobbying data yet. The legislation step would need to
publish a small index of every bill mentioned in LD-2s (bill → organizations),
which it already parses and then drops.

## 4. After the election

**Now.** Outside spending is current through election day: the 24/48-hour
notices are in each race's `outside`. One thread
(`after:outside-2026`) covers:
- the 10 House races and 5 Senate races with the most outside spending
- the races where outside money was more than the candidates raised

**Later.** Candidates' money is all from `weball` and runs through Oct. 14
(`money.through`). Post-general reports (30G) are due Dec. 3 and reach
`weball` a few weeks after that. The thread on the most expensive races
(`after:money-2026`) waits until 80% of general-election candidates have
`money.through` after Nov. 3.

Cost per vote isn't possible: we don't have vote counts, and the FEC results
stay empty for about a year.

## 5. The lobbying quarter

**What it needs that doesn't exist yet.** No per-quarter numbers are stored.
`organizations.json` has spending by year, and `revolving-door.json` has
running totals. A new step, `lobbying-quarters`, would read the LD-1/LD-2
cache (`.cache/legis/ld2/<year>-<period>.json`) and write
`data/lobbying-quarters.json` with, for each quarter:
- the top spenders (income plus expenses, by organization)
- new registrations (LD-1s)
- registrants new to us whose lobbyists list former congressional jobs
- the most lobbied bills

It runs in the Railway `refresh-lobbying` cron, which has the cache on its
volume, and is pushed to `main` with the rest.

**The post** (`quarter:2026-Q4`) is a thread posted the week after filings
are due (the 21st of the month after the quarter ends, so Jan. 21 for Q4):
- the top 10 spenders
- the bills most lobbied on
- how many former Hill staff newly registered

2026 Q3 is already in the cache, so it's the test run.

## 6. State spotlights

**Cadence.** Weekly, on Sunday afternoons Eastern (`state:<slug>:<date>`).

**Order.** States rotate in a shuffled order that's fixed for each run
through all 50. The territories come after the states.

**The post:**
- the delegation's top funding sectors together
- the member who raised the most
- how many members are on Bluesky
- the state's list, if there is one (2+ members on Bluesky), as a link to
  subscribe
- the state card

At one a week, a full run through the states takes about a year.

## What it needs from Railway

- a new `posts` service built from `posts/Dockerfile`
- a volume at `/data`
- `POSTS_APP_PASSWORD`, which needs creating in Bluesky settings

The service is created the same way as `sync-lists`. See the Railway notes in
the main README.

## Not doing

- **Quote-posting members' posts with their funding.** It reads as
  harassment and invites reports against the labeler account. The mention
  replies reach the same threads only when someone asks.
- **Stock trades.** Holdings is still a prototype, with open legal questions
  and no Senate data.
