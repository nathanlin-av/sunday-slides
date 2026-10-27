# Sunday Slides

Sunday Slides makes ProPresenter song slides from your Planning Center plans. Every week it looks at your next few
plans in Planning Center Services. For each song that has no ProPresenter file yet, it drafts slides from the lyrics,
shows them to you in a Google Sheet, and, once you approve, attaches a ProPresenter file to the song. On Sunday your
team pulls the plan into ProPresenter and the slides are there. It runs in your own Google account and needs no
server. It costs nothing to run.

This is a hobby project with no warranty and no promise of support (see the end). Read "Status" before you rely on it
for a Sunday.

## What you need

- **Planning Center Services**, with a login that is allowed to edit songs and to create a personal access token.
- **ProPresenter 21 or later** on the computers that run your services.
- **A free Google account.** The script lives there. A shared account for the church works well.
- **A CCLI license and SongSelect**, if you want lyrics to arrive on their own. Planning Center can import lyrics from
  SongSelect for songs that have a CCLI number. Without them, paste lyrics into Planning Center by hand.

Sunday Slides never contains song lyrics. Each church brings its own, under its own CCLI license.

## Setting it up (about 20 minutes)

You do not need to write any code. You copy some files and fill in a table.

### 1. Create the Apps Script project

1. Sign in to your Google account and open [script.google.com](https://script.google.com).
2. Click **New project**. Name it "Sunday Slides".

### 2. Put the files in

Choose one way.

**Copy and paste (no tools needed).**

1. For each file in the `apps-script` folder of this project, make a script file with the same name in the editor
   (click the **+** next to Files, choose Script, type the name without `.js`) and paste the contents in. The files
   are: Assets, Proto, ProWriter, CmgWidths, ArialWidths, Layout, Drafter, Template, Settings, Control, Pco, Job, Main.
   Delete the empty `Code` file the project starts with.
2. Open **Project Settings** (the gear) and turn on **Show "appsscript.json" manifest file in editor**. Open
   `appsscript.json` and replace its contents with the `appsscript.json` from this project. Save.

**clasp (for people who use the command line).** `clasp` is Google's own tool for Apps Script. From inside the
`apps-script` folder run `clasp login`, then `clasp create` with the standalone option, then `clasp push`.

### 3. Run the setup

1. In the editor, pick **setupSundaySlides** in the function list at the top and click **Run**.
2. Google asks you to review permissions. Click **Review permissions**, choose your account, and approve. Google may say
   the app is not verified. That is expected for your own script: click **Advanced**, then **Go to Sunday Slides
   (unsafe)**. The script asks for access to Drive and Sheets (to make its control sheet), to send you email, to talk
   to Planning Center, and to run on a timer.
3. Setup makes a Google Sheet called **Sunday Slides Control** in a Drive folder called **Sunday Slides**, and a timer
   that wakes the script every 15 minutes. The result is written to the log at the bottom of the editor, with a link to
   the sheet.

### 4. Make a Planning Center token and paste it in

1. In Planning Center, open the developer page for personal access tokens (search "Planning Center personal access
   token" if the page has moved; it is under the API pages at `api.planningcenteronline.com`).
2. Create a personal access token. Planning Center shows two values: an **Application ID** and a **Secret**. Copy both.
   The token works with the permissions of the person who made it, so make it while signed in as someone who can edit
   songs in Services.
3. Back in the Apps Script editor, open **Project Settings** and scroll to **Script Properties**. Add two properties:
   `PCO_APP_ID` with the Application ID, and `PCO_SECRET` with the Secret. Save.

The two values stay inside your Google project. Nothing else is stored in the code.

### 5. Fill in the Settings tab

Open the control sheet and go to the **Settings** tab. One row per setting. Leave a value blank to use the default.

| Setting | Default | What it means |
| --- | --- | --- |
| SERVICE_TYPE_ID | none (required) | The number in the web address of your service type in Planning Center Services (`.../service_types/NUMBER`). Nothing runs until this is filled in. |
| PLAN_COUNT | 3 | How many upcoming plans to look at (1 to 10). |
| ALERT_EMAIL | the account that owns the script | Where the weekly "songs need a look" email goes. Type `none` to turn emails off. |
| TIME_ZONE | the script's time zone, if you set one | Required unless the script's own time zone (Project Settings in the Apps Script editor) is already yours. A name such as `America/Chicago` or `Europe/London`, with the capitals as shown. A new Apps Script project starts on UTC, and while TIME_ZONE is blank and the script is on UTC or GMT the job refuses to run and says so. |
| FREEZE_DAY | Sunday | The day slides are locked in. |
| FREEZE_TIME | 08:00 | The time (24 hour clock, in TIME_ZONE) when the freeze starts. |
| MODE | dry-run | `dry-run` makes drafts and reports but changes nothing in Planning Center. `live` attaches approved slides. |
| APPROVAL_REQUIRED | yes | `yes`: new slides wait for you to mark them APPROVED. |
| PAUSED | no | `yes` stops every run. |

A value the script cannot understand (for example `MODE` set to `lvie`) is reported on the Log tab and by email, and
the script refuses to run. A typo can never switch on live mode.

Fill in **SERVICE_TYPE_ID** and **TIME_ZONE** (the job will not run without them). Leave **MODE** on `dry-run` for now.

The Value column is plain text, so `08:00` stays `08:00`. If you type `8:45` it is understood too.

### 6. Optional: use your own look

Skip this and your slides use the built-in look: white Arial Bold text, centered, on black. To use your church's look
instead, see "Your own look" below. You can do it now or later.

### 7. Check it

1. In the editor, run **runSelfTest**. It builds a public-domain test song and compares it with reference bytes. You
   should see "Self-test passed" in the log.
2. Run **runSundaySlidesNow**. This does a real pass over your next plans. Because MODE is `dry-run`, nothing changes in
   Planning Center.
3. Open the control sheet:
   - **This Sunday** lists each song in the next plan and what, if anything, needs doing.
   - **Approvals** has one row per song that would get slides, with a preview of every slide.
   - **Log** has one line per run, and a line whenever the template changes.
4. When the drafts look right (leave it a week if you like), change **MODE** to `live`. Then, on the Approvals tab,
   set the Status of each row you are happy with to **APPROVED**. The next run attaches that song's ProPresenter file.

Songs with no lyrics need a one-time **Import from SongSelect (Lyrics)** on the arrangement in Planning Center. In live
mode the script asks for this itself, at most once a day per song, and never after the freeze time.

## Every Sunday: what your volunteers do in ProPresenter

ProPresenter has a built-in Planning Center connection. Volunteers use only that; nothing runs on their computers.

**One time on each computer**

1. Open ProPresenter, then Settings, Integrations, Planning Center, and sign in.
2. On that page, set it up like this:
   - Automatically Check for Plan Updates: on
   - Automatically Download Presentations and Media: on
   - **Download Library: a new, empty library made just for this.** Never your main library or any library that holds
     songs you made by hand. ProPresenter can overwrite a song of the same name in the download library without asking.
   - **Automatically Upload Presentations and Media: off, always.** Never turn this on.
   - Match Presentations in Library: off
   - Make Arrangements from Sequences: off
3. Close Settings.

**Each week**

1. In the left sidebar, click the **+** next to **Playlist** and choose the Planning Center option.
2. In the window that opens, click the arrow next to the service, pick this Sunday's date (plans are listed by date),
   and click **Select**.
3. A playlist named after the plan appears and the songs download into it, in the plan's order.
4. If ProPresenter asks **File already exists**, choose **New Version**. Leave "Apply to All" unchecked.
5. If the playlist shows **Update Available**, click it. ProPresenter notices plan changes by itself but waits for that
   click before it downloads them.
6. Use Next to go through the service.

These steps were tried on a Mac with ProPresenter 21.4. **Not tested on Windows:** the Settings menu path, the window
layouts, and how the Windows version of ProPresenter treats the generated files. The wording may differ there.

## Your own look

Every song is made by copying one slide. You choose that slide.

1. In ProPresenter, make a new presentation with **one slide and one text box**. Style it the way you want your songs
   to look: font, size, colors, position, background. Type any placeholder words in the box.
2. Export it as a plain ProPresenter file (right-click the presentation in the library and choose Export; pick the
   `.pro` format, not a bundle with media).
3. Rename the file to exactly **template.pro** and drop it in the **Sunday Slides** folder in Google Drive, the one setup
   made (the script remembers that folder). If you moved the control sheet somewhere else, still use that folder. Only if
   that folder has been deleted does the script look in the folder the control sheet is in now.

On its next run the script reads the first slide that has a text box and uses it for every song. It keeps the font,
size, colors, position and background. Your placeholder words are never copied into a song.

The file `templates/default-template.pro` is the built-in look as a ProPresenter file. You can open it, restyle it and
export your version if that is easier than starting from nothing.

Rules for the template:

- One slide with one text box is best. If the first slide with text has two text boxes, the template is refused (the
  second box's words would repeat in every song).
- Keep it simple. A template with pictures or video points at files on one computer. Use colors for the background.
- If you type the placeholder words in capitals, the songs come out in capitals. A font with a CAPS name, or
  ProPresenter's All Caps setting, also gives capitals.

If `template.pro` is missing, the built-in look is used and the Log tab says so. If the file is there but cannot be
used (damaged, wrong kind of file, two text boxes), the built-in look is used, the Log tab explains the reason in plain
words, and the weekly email mentions it.

**How lines are broken.** Each sung line becomes one slide, split into two short lines at the natural breath. To do
that it has to guess how wide the text will be:

- Arial and Arial Bold (the built-in look): exact widths, read from the Arial font files by `tools/build_arial_widths.js`.
- CMG Sans: exact widths of CMG Sans Medium Caps, if your template uses that font.
- Any other font: a simple rule that gives every character the same width, on the generous side. Lines may break a
  little early, but they should not run off the slide.

If the text looks too tight or too loose in your look, shorten or lengthen the box in the template, or edit the slide in
ProPresenter. Generated slides can always be edited by hand.

### Optional: the CMG Sans look

Many churches use the CMG Sans font from Church Motion Graphics. It is not included here. It is a paid or separately
licensed font that you download yourself from the Church Motion Graphics font page,
<https://www.churchmotiongraphics.com/>. Install it on every computer that runs ProPresenter, make your template with
it, and the script will use CMG Sans widths for the line breaks. Nothing here depends on it.

## How approval and dry run work

- **dry-run** (the starting mode) reads Planning Center, drafts slides and fills in the sheet. It never writes to
  Planning Center.
- **live** attaches ProPresenter files to the song arrangements, and only for songs you have approved (or all songs if
  you set APPROVAL_REQUIRED to `no`).
- The **Approvals** tab shows what each draft looks like. Set Status to **APPROVED** to allow it or **REJECTED** to
  stop it. If the lyrics change in Planning Center, or you change `template.pro`, the draft changes and needs a fresh
  approval. Keys on the Approvals tab start with the letter `a` so Sheets cannot turn them into numbers.
- **The freeze.** From FREEZE_TIME on FREEZE_DAY (Sunday 08:00 by default) the script only reads. It attaches nothing
  and imports nothing until the next day, so a slide never changes under your team during the service.
- The weekly email goes out on the evening before the freeze day if any song needs a look.

## What it never does

- It never deletes or replaces a file that is already attached to a song. If a song already has a ProPresenter file,
  it is left alone, even if the lyrics change later (you get a note, nothing more).
- It never shares or stores lyrics outside your own Planning Center and Google account.
- It talks only to Planning Center and Google. No other server, no tracking, no accounts.
- It never changes anything in Planning Center unless MODE is `live`.

## Staying safe

- Get it only from this page: `github.com/nathanlin-av/sunday-slides`. If someone sends you a copy, a zip, or a
  "faster" version from anywhere else, do not use it.
- There is nothing to install. It has no outside packages or libraries; the copy and paste setup uses only Google's
  own script editor.
- You can check where it is allowed to connect. Open `appsscript.json`: the `urlFetchWhitelist` lists only the two
  Planning Center addresses. Google enforces that list, so the script cannot send anything anywhere else. If you
  ever see another address there, stop and do not run it.
- If you use clasp, install Google's official package (`@google/clasp`) and nothing with a similar name.
- Found a security problem? Please report it privately with the **Report a vulnerability** button under this
  project's **Security** tab instead of opening a public issue.

## If something looks wrong

| What you see | What to do |
| --- | --- |
| Nothing happens | Check SERVICE_TYPE_ID is filled in, PAUSED is `no`, and the Log tab. Settings problems appear there and by email. |
| "TIME_ZONE is empty" or "wrong capitals" | Type your time zone on the Settings tab exactly as `America/Chicago` (capitals and underscore matter). |
| A run failed | The email and the Log tab say why. It tries again about once an hour, and every 15 minutes from the evening before the freeze until the freeze time. |
| "The Planning Center key is not set" | Add `PCO_APP_ID` and `PCO_SECRET` in Project Settings, Script Properties. |
| A song says "needs lyrics" | Import lyrics from SongSelect on the arrangement in Planning Center, or paste them in. |
| A song says "removed by user" | The script attached a file before and someone removed it. It will not add it again. Make that one by hand, or see "A run was cut off" below to let it try again. |
| A song says "attach-unconfirmed" | An earlier run may have been cut off while attaching. The script checks again, and if Planning Center still shows no file after 30 minutes it tries again by itself. |
| Slides use the wrong look | Read the **TEMPLATE** lines on the Log tab. They say which file was used and why a file was refused. |
| ProPresenter says "File already exists" | Choose New Version. |
| Lines are too wide or break oddly | Check the font and box width in your template, or edit the slide in ProPresenter. |
| Self-test fails | See the next section. |

### A run was cut off while attaching

Apps Script stops any run after a few minutes. If that happens right in the middle of an upload, the script has already
written a note that it is attaching that song. The next runs see the note, wait 30 minutes in case the upload is still
landing, and then, only if Planning Center shows no ProPresenter file on that arrangement, attach the slides again. If
the file did arrive, nothing more is done. It never adds a second file.

The notes live in Script Properties (Project Settings, Script Properties in the Apps Script editor), one per arrangement,
named `ss:att:` plus the arrangement number (the number after `/arrangements/` in the song's Planning Center address; it is
also the digits after the `a` in the Key on the Approvals tab). To make the script treat a song as never handled, for
example after you removed its file on purpose and want it back, make sure the song has no ProPresenter file in Planning
Center, then delete that one property. A song that has a file must never have its property deleted.

## After ProPresenter updates

The writer copies a real slide and edits it, so a big ProPresenter update could change the file format. After any
ProPresenter update, run **runSelfTest** in the Apps Script editor. It only proves the code still behaves as it did when
this version was published. It cannot tell you whether a new ProPresenter still likes the files, so also pull one plan
into ProPresenter the first Sunday after an update and look at the slides before the service.

## Status

This is an early version. Here is what has and has not been checked:

- The tests (below) compare the file writer byte for byte with reference files from a separate writer, for the
  built-in look and for several different templates.
- So far only the person who wrote it has used it. Start in `dry-run` and keep your usual way of making slides as a
  backup for the first few weeks.
- Generated files have not been checked in ProPresenter on Windows.

## For developers

You need Node 20 or newer and nothing else.

```
npm test
```

The tests load the exact Apps Script files into a Node `vm` and use only public-domain hymns as song data.
`tests/fixtures/golden/*.pro` are reference files the writer must match byte for byte. They came from a separate writer
built on the ProPresenter protobuf definitions, not from the code under test. The
template tests use small synthetic templates in `tests/fixtures/templates/`.

Tools (all plain Node, no dependencies):

- `node tools/build_default_template.js` writes `apps-script/Assets.js` and `templates/default-template.pro`. IDs are
  derived from names, so the output is the same every time. It also has a check option that reports whether the
  committed files are current.
- `node tools/build_arial_widths.js` rewrites `apps-script/ArialWidths.js` from the Arial files already on your computer.
- `node tools/make_test_templates.js` rewrites the synthetic test templates.
- `node tools/make_golden_drafts.js` rewrites the draft files that feed the golden songs. Review the change, then rebuild
  the golden `.pro` files with a reference writer.

Entry points you can run from the editor: `setupSundaySlides`, `runSundaySlidesNow`, `runSelfTest`, `showStatus`.

## Credits and notices

- The ProPresenter file format definitions come from the
  [ProPresenter7-Proto](https://github.com/greyshirtguy/ProPresenter7-Proto) project (MIT license).
- Sunday Slides is **not affiliated with, endorsed by, or supported by Renewed Vision (ProPresenter), Planning Center,
  or CCLI.** Those names belong to their owners.
- CMG Sans belongs to Church Motion Graphics and is not included.
- The sample songs in the tests are public-domain hymns.

## License and warranty

MIT License, see the `LICENSE` file. The software is provided as it is, with no warranty of any kind. You are
responsible for checking your slides before they are used in a service.
