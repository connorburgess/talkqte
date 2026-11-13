# Notes from other note-takers, by file

Roadmap item **N4** asks TalkQTE to support other note-takers through common file formats, adding a dedicated adapter only for a demonstrated use case. The first slice reads one Markdown (`.md`) or plain-text (`.txt`) note per file, through the same chooser and [context contract](architecture.md) as the TalkQTE JSON notes file. Nothing connects to an account. This page records what other note-takers document about their exports, how TalkQTE turns a file into a note, and what is still unverified.

## What other note-takers export — checked 14 November 2026

From each provider's own help pages. Plans, formats and menus change; recheck before relying on an entry.

- **Fireflies.** Summaries download as DOCX, PDF, JSON or MD, on Pro plans and higher; transcripts as PDF, DOCX, SRT, CSV, JSON or MD ([download guide](https://guide.fireflies.ai/articles/3319752033-how-to-download-transcripts-summaries-and-meeting-recordings-from-fireflies)). An account data export gives summaries and transcripts as TXT, with metadata as JSON ([account export](https://guide.fireflies.ai/articles/8915664468-how-to-export-your-fireflies-account-data)). Structure: not documented. Options add timestamps, AI Skills output or branding, and a workspace summary template can change the structure.
- **Otter.** Conversations export as TXT, DOCX or PDF, and SRT on paid plans; Basic plan users are limited to TXT ([export conversations](https://help.otter.ai/hc/en-us/articles/360047733634-Export-conversations)). The summary (Overview, Action items, Insights, Outline and a custom prompt, depending on the template) can be exported or copied ([export summary](https://help.otter.ai/hc/en-us/articles/39503855767191-Export-Summary)). Export to OneDrive offers DOCX, TXT or MD ([OneDrive](https://help.otter.ai/hc/en-us/articles/42474585463959-Export-to-Microsoft-OneDrive)); to Google Drive, Google Docs or TXT ([Google Drive](https://help.otter.ai/hc/en-us/articles/42385276728727-Export-to-Google-Drive)). Structure: section names depend on the template; title, date and layout in the file are not documented.
- **Fathom.** No file download of notes or transcripts. **Copy Summary** copies a formatted summary, with or without links, for pasting elsewhere ([copy your summary](https://help.fathom.video/en/articles/7975105)); transcripts are copied, as they "can't be downloaded directly" ([transcript](https://help.fathom.video/en/articles/296000)). Structure: not documented, including whether the copy is Markdown or rich text.
- **Notion.** A page exports as Markdown, HTML or PDF; Markdown and HTML arrive as a zip file, and callout blocks are exported as HTML ([export your content](https://www.notion.com/help/export-your-content)). The page does not mention AI Meeting Notes. Structure: not documented, including whether the page title becomes a heading and how a date property appears.
- **Apple Notes.** On Mac, **File > Export To** exports a note as PDF or Markdown, and **Edit > Copy as Markdown** copies selected content ([import, export, and print notes on Mac](https://support.apple.com/guide/notes/import-export-and-print-notes-not201900c07/mac)). Structure: not documented. The iPhone export page did not load and was not checked.
- **Plain files.** Any Markdown or plain-text file a person writes or saves.

Otter's help pages refuse automated reading (HTTP 403). Its entry comes from the search-engine excerpts of those official pages and needs a manual read.

None of these pages documents where a title or date appears in an exported file, so TalkQTE does not depend on any provider's layout and has no provider-specific adapter.

## How a file becomes a note

- **Which files.** The chooser offers `.json`, `.md`, `.markdown` and `.txt`. A `.json` file is read as a TalkQTE notes file, as before. Any other file is refused with a message naming the formats TalkQTE reads; DOCX, PDF, HTML, RTF and zip files are not opened. Subtitle and captions files (`.srt`, `.vtt`) are refused as transcripts: a transcript is a past conversation, not notes, and needs its own decision.
- **One note per file.** A Markdown or plain-text file is one note, whatever headings it contains.
- **Title.** A `title:` in the front matter of a Markdown file (a block of single-word `key: value` lines between `---` lines at the very top), or else a level-one heading (`# Title`) on its first line, or else the file name without its extension. Plain text has no heading syntax, so its title is always the file name. The engine matches the title's words for a context reminder, so a descriptive title or file name matters.
- **Date.** Only an explicit `YYYY-MM-DD` date: a `date:` in Markdown front matter (a time after it is ignored), or a `Date:` or `Meeting date:` line among the note's first 10 non-blank lines and before any heading other than the title, also as a list item or in bold. A dated item under a later heading, such as an event under **Decisions**, is about something else and is not read. Dates written any other way, such as `10/21/2026` or `21 October 2026`, are not read, because their order or language would have to be guessed. When the file gives no date, the chooser shows **No date in the file** and a **Date** field, and the note cannot be imported until the person enters a date from 1900 on. A date from the file is never replaced and cannot be changed in the chooser; TalkQTE never invents one. A TalkQTE JSON notes file is unchanged: it states each note's date, and a note without a real one is skipped.
- **Text.** The rest of the file, as written: front matter and a heading used as the title are left out, and Markdown is shown as plain characters, not formatted. As for every source, the first 2,000 characters are kept.
- **Choosing the same file again.** The note keeps one copy: an unchanged file reports **already imported**, and a file saved again since is a newer revision, by its modification time, that replaces its copy, even if its text did not change. Another file with the same name is a separate note. The identifier is a hash of where the file is, under a key made once per session and held in memory; the path itself is not kept or shown. A copy that carries an older modification time is reported as **already imported**, and so is a different date entered for a note already imported; remove the note and choose the file again.
- **Limits and refusals.** Files over 1 MB, files containing binary data (such as a renamed PDF or Word file), files that are not UTF-8 text, and files with no note text are refused with a plain message that includes no path or file content. At most 20 imported notes are kept per session.
- **Privacy.** Unchanged from the JSON file: TalkQTE reads only the file the person picks, once, into memory; nothing is written or sent; imported notes can be removed and are never exported, and they are labeled as not from this conversation ([PRIVACY.md](../PRIVACY.md)).

## Bringing notes in from each tool

These steps follow the documentation above. None has been tried with a real export.

- **Fireflies:** download the summary as MD (Pro plan or higher), or use the TXT summaries in an account data export.
- **Otter:** use Export Summary, or Copy summary and save the copy as a `.txt` file. A conversation export is the transcript, which TalkQTE does not bring in as notes.
- **Fathom:** use **Copy Summary**, paste into a text editor, and save it as a `.md` or `.txt` file.
- **Notion:** export the page as Markdown, unzip the download, and choose the `.md` file inside.
- **Apple Notes on Mac:** choose **File > Export To**, then Markdown.

## Evidence and remaining gaps

Fictional checks only, run on 14 November 2026:

- Rust tests in `src-tauri/src/notes_file.rs` and `src-tauri/src/context_import.rs`: title and date rules, including front matter, a byte-order mark, ambiguous dates, and dates that are misplaced or under a later heading; text kept when rules or other lines only look like front matter; an entered date filling, through the import attempt, only a Markdown or text note without one, and never a JSON note or a date from the file; the excerpt, title and preview limits; refusal of unsupported, transcript, oversized, empty, binary and non-UTF-8 files with their exact messages; repeat imports, a saved change and a same-named file; and, in a separate process with its home and temporary folders redirected, reading and importing a file leaves no file and prints none of the note.
- Chromium and WebKit tests in `tests/note-files.spec.ts`, against the browser preview's fictional files: entering a missing date before import, clearing it, cancelling, a dated plain-text note, the repeat notice, refusal messages, removal, the reminder carrying the entered date, and export exclusion.

Not verified:

- A real export from any of the tools above: its title line, date format, encoding and how its Markdown reads as an excerpt.
- The native file chooser on macOS and Windows offering `.md` and `.txt` files; the browser tests use a simulated chooser.
- Whether notes brought in this way help anyone in a conversation.

Next readiness check: in the desktop app, import one fictional summary exported from each of two of these tools, and confirm its title, date (found or entered), excerpt, removal and export exclusion. Add a provider-specific rule only if such an export shows a documented, stable title or date that these rules miss.
